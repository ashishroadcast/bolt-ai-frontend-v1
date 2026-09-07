import { GatewayError, UnauthorizedError } from "./errors.ts";

/**
 * A non-2xx from an `/agent/*` call, carrying whatever JSON the server
 * actually sent — most importantly FastAPI's own `detail` field, which is
 * how a validation refusal, a permission denial, or the promotion gate's
 * own `{reason, regressed_cases}` refusal (`app.learning.gate`, surfaced
 * through `app.api.admin`'s `POST /agent/admin/promote` as
 * `HTTPException(422, detail={"reason": ..., "regressed_cases": [...]})`)
 * reaches a caller at all. Before this, `agentFetch` below discarded the
 * response body entirely on a non-2xx — a caller had a status code and
 * nothing else, so the four distinct promotion refusals were
 * indistinguishable from the client.
 *
 * A `GatewayError` subclass, not a change to `GatewayError` itself
 * (`./errors.ts` is out of this task's file list, and its own
 * constructor only takes `status`/`graphQLErrors`) — every existing
 * `catch (GatewayError)` / `instanceof GatewayError` call site still
 * matches an `AgentApiError`, and the `UnauthorizedError`/`onUnauthorized`
 * 401/403 path below is untouched, so auth behaviour does not change.
 */
export class AgentApiError extends GatewayError {
  /** The parsed JSON error body (typically `{detail: ...}`), or
   * `undefined` when the response body was not valid JSON at all (an
   * upstream proxy's own error page, an empty body, …) — a caller that
   * wants FastAPI's `detail` reads it off here (`error.body?.detail`)
   * rather than re-parsing `message`. */
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message, { status });
    this.name = "AgentApiError";
    this.body = body;
  }
}

/** FastAPI's `detail` when it is a plain string — the common case
 * (`detail="artifact not found"`) — usable directly as an error message.
 * A structured `detail` (the promotion gate's `{reason,
 * regressed_cases}`) is not a message on its own; a caller that wants it
 * reads `error.body` instead, so this returns `null` for that shape
 * rather than `JSON.stringify`-ing something not meant to be read as
 * prose. Exported so `../chat/runStream.ts`'s own non-2xx handling (it
 * cannot route through `agentFetch` below at all — see that module's own
 * docstring for why) can reuse this exact extraction instead of a second,
 * independent copy of it. */
export function stringDetailMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("detail" in body)) return null;
  const detail = (body as { detail: unknown }).detail;
  return typeof detail === "string" ? detail : null;
}

export interface GatewayClientOptions {
  /** The gateway's origin, e.g. http://localhost:8080 — no trailing slash required. */
  baseUrl: string;
  /**
   * Reads the current bearer token (or null); session.ts owns the real
   * one. May return a Promise — the real wiring (client.ts's
   * getFreshToken) checks the token's own expiry first and refreshes
   * ahead of it before handing one back, so this needs to be awaitable.
   * A plain synchronous return (every existing test) still works: `await`
   * on a non-Promise value just resolves to it.
   */
  getToken: () => string | null | Promise<string | null>;
  /** Called once whenever a request comes back 401/403 and no configured
   * refresh recovered it, or finds no token to send. */
  onUnauthorized: () => void;
  /**
   * Attempts one token refresh, resolving true if the session now has a
   * fresh token worth retrying with, false if refresh failed (in which
   * case the caller is responsible for treating this the same as any
   * other unauthorized response). Optional — omitted, a 401/403 behaves
   * exactly as before this option existed.
   *
   * GatewayClient dedupes concurrent calls to this itself (see
   * `runRefresh` below): three requests that all 401 around the same time
   * share one in-flight refresh rather than firing three. This is on top
   * of whatever dedup the injected function does on its own (client.ts's
   * `refreshAccessToken` also dedupes, so the two authenticated clients —
   * `gatewayClient` and `authClient`, two different GatewayClient
   * instances — collapse into one refresh even when they 401 in the same
   * window; this class's own dedup only covers calls through the same
   * instance).
   */
  refresh?: () => Promise<boolean>;
}

export interface GraphQLRequestOptions {
  /** Set false for requests that must not carry a bearer — login, register. Default true. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Extra headers to merge in on top of Content-Type/Authorization — the
   * refresh flow uses this to send `X-Refresh-Token` on an otherwise
   * unauthenticated call (see auth/graph/auth_helpers.go's
   * extractRefreshTokenFromCookie: a non-SSO API client sends its refresh
   * token this way, not as a GraphQL argument — the schema's own
   * `refreshToken: TokenResponse!` takes none). */
  headers?: Record<string, string>;
}

interface GraphQLResponseBody<T> {
  data: T | null;
  errors?: Array<{ message: string }>;
}

/**
 * The one place that owns the gateway's base URL, attaches the bearer
 * token, and turns a fetch response into either typed data or a
 * GatewayError. Every later surface — streaming chat, documents, test
 * suites — is meant to go through this, not construct its own fetch call.
 *
 * Framework-agnostic on purpose: it takes getToken/onUnauthorized as
 * plain functions rather than reading React context, so it can be
 * constructed once (src/api/client.ts, wired to auth/session.ts) and used
 * anywhere, and so tests can point it at a fake token/callback without a
 * React tree.
 */
export class GatewayClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null | Promise<string | null>;
  private readonly onUnauthorized: () => void;
  private readonly refresh?: () => Promise<boolean>;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.refresh = options.refresh;
  }

  /**
   * Runs `refresh` at most once per overlapping wave of callers on *this*
   * instance — see the `refresh` option's own docstring on
   * GatewayClientOptions for why this exists on top of whatever dedup the
   * injected function does itself. Resolves false without calling
   * `refresh` at all when none was configured, which is exactly the old
   * (pre-refresh) behaviour for every caller that doesn't pass one.
   */
  private async runRefresh(): Promise<boolean> {
    if (this.refresh === undefined) return false;
    if (this.refreshInFlight === null) {
      const attempt = this.refresh();
      this.refreshInFlight = attempt;
      void attempt.finally(() => {
        if (this.refreshInFlight === attempt) this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  /**
   * POST /graphql — the same entry point every other POS surface uses;
   * the gateway resolves the operation's root field to a service and
   * proxies (CLAUDE.md, "Layering"). `auth: false` is for login/register,
   * the only operations that run before there is a token to send.
   */
  async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
    options: GraphQLRequestOptions = {},
    isRetry = false,
  ): Promise<T> {
    const useAuth = options.auth ?? true;
    const headers = new Headers({ "Content-Type": "application/json" });
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) headers.set(key, value);
    }
    if (useAuth) {
      const token = await this.getToken();
      if (token === null) {
        this.onUnauthorized();
        throw new UnauthorizedError(401);
      }
      headers.set("Authorization", `Bearer ${token}`);
    }

    const request = new Request(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: options.signal,
    });

    const response = await fetch(request);

    // A 401 gets exactly one refresh-and-retry; a 403 never does (a valid
    // token lacking permission isn't fixed by a new one), and a retry
    // that 401s again (isRetry) falls straight through to
    // readGraphQLResponse instead of refreshing a second time — see this
    // task's report for "a second failure means genuinely signed out".
    if (response.status === 401 && useAuth && !isRetry) {
      const refreshed = await this.runRefresh();
      if (refreshed) {
        return this.graphql<T>(query, variables, options, true);
      }
    }

    return this.readGraphQLResponse<T>(response, useAuth);
  }

  /**
   * Any `/agent/*` call — `path` must start with `/agent/`. Always
   * carries `Authorization: Bearer <token>` (spec §10.1: "sent as
   * Authorization: Bearer on every /agent/* call"); a 401/403 response,
   * or having no token to send in the first place, both end the session
   * the same way, via onUnauthorized — unless a configured `refresh`
   * recovers a 401 first (see `graphql`'s matching comment; the same
   * one-retry rule applies here).
   */
  async agentFetch<T>(path: string, init: RequestInit = {}, isRetry = false): Promise<T> {
    if (!path.startsWith("/agent/")) {
      throw new GatewayError(`agentFetch path must start with /agent/, got "${path}"`);
    }

    const token = await this.getToken();
    if (token === null) {
      this.onUnauthorized();
      throw new UnauthorizedError(401);
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Content-Type") && init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const request = new Request(`${this.baseUrl}${path}`, { ...init, headers });
    const response = await fetch(request);

    if (response.status === 401 && !isRetry) {
      const refreshed = await this.runRefresh();
      if (refreshed) {
        return this.agentFetch<T>(path, init, true);
      }
    }

    if (response.status === 401 || response.status === 403) {
      this.onUnauthorized();
      throw new UnauthorizedError(response.status);
    }
    if (!response.ok) {
      // Read the body before throwing — a non-2xx from FastAPI is almost
      // always JSON (`{"detail": ...}`), but a proxy/gateway-level failure
      // in front of it might not be, so a parse failure degrades to
      // `undefined` rather than throwing a second, unrelated error out of
      // this catch. See AgentApiError's own docstring for why the body is
      // preserved at all.
      const body: unknown = await response.json().catch(() => undefined);
      throw new AgentApiError(
        stringDetailMessage(body) ?? `Request to ${path} failed (${response.status}).`,
        response.status,
        body,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async readGraphQLResponse<T>(response: Response, wasAuthed: boolean): Promise<T> {
    // GraphQL services in this repo authenticate optionally at the HTTP
    // layer and deny via the @auth directive inside a 200 response
    // (pkg/middleware/jwt.go) — but the gateway itself can still return a
    // bare 401/403 (e.g. its own JWT check), so both are handled here.
    if (response.status === 401 || response.status === 403) {
      if (wasAuthed) this.onUnauthorized();
      throw new UnauthorizedError(response.status);
    }
    if (!response.ok) {
      throw new GatewayError(`Gateway request failed (${response.status}).`, {
        status: response.status,
      });
    }

    const body = (await response.json()) as GraphQLResponseBody<T>;
    if (body.errors && body.errors.length > 0) {
      throw new GatewayError(body.errors[0]!.message, {
        graphQLErrors: body.errors.map((error) => error.message),
      });
    }
    if (body.data === null || body.data === undefined) {
      throw new GatewayError("Gateway returned no data.");
    }
    return body.data;
  }
}
