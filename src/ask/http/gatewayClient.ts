import {
  AgentApiError,
  errorFromResponse,
  GatewayError,
  NetworkError,
  stringDetailMessage,
  UnauthorizedError,
} from "./errors.ts";

/*
 * `AgentApiError` and `stringDetailMessage` used to be defined here, when
 * `./errors.ts` was out of bounds for the task that needed them. They live
 * with the other error types now and are re-exported so every existing
 * `import { AgentApiError } from "…/gatewayClient.ts"` keeps working.
 */
export { AgentApiError, stringDetailMessage };

/** `fetch`'s own cancellation, which must reach the caller untouched:
 * `useChat` tells a deliberate stop from a failure by exactly this shape. */
function isAbort(err: unknown, signal: AbortSignal | null | undefined): boolean {
  return (err instanceof DOMException && err.name === "AbortError") || signal?.aborted === true;
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
  /** Called once whenever a request comes back 401 and no configured
   * refresh recovered it, or finds no token to send. Never on a 403 — see
   * `GatewayClient.refusal` for why that would be a sign-in loop. */
  onUnauthorized: () => void;
  /**
   * Attempts one token refresh, resolving true if the session now has a
   * fresh token worth retrying with, false if refresh failed (in which
   * case the caller is responsible for treating this the same as any
   * other unauthorized response). Optional — omitted, a 401 is final.
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
  /**
   * The organisation the caller is currently acting as, sent as the
   * `Organisation` header.
   *
   * A hint, not a grant. agent-service validates the value against the
   * caller's real access on every request (`app.auth.dependency`, step 4)
   * and refuses anything outside their own subtree, so sending the wrong
   * organisation fails closed rather than widening anything. That is why
   * it is safe for this to come from client-side state at all.
   *
   * Read per request rather than captured once: the operator can switch
   * organisations mid-session, and a cached value would keep addressing
   * the previous one. Optional — omitted, no header is sent, which
   * agent-service reads as the token's own organisation.
   */
  getOrganisationId?: () => string | null;
  /**
   * The platform identifier for the `X-Client` header. Defaults to `web`.
   * bolt-v2's own services read it on every operation, so this console
   * sends it too rather than being the one client that does not.
   */
  clientType?: string;
  /**
   * How long to wait before asking `getToken` a second time when it returns
   * null. Omitted — the console — a null is final at once: there, no key
   * means signed out, and waiting would only delay the sign-in screen.
   *
   * Set by `AskProvider`, because a host's provider can return null for a
   * moment without the session being over: bolt-v2's does while its own token
   * refresh is in flight, and failing that request told someone who was
   * signed in that they were not. If `refresh` is configured it is tried
   * first, and the pause only happens when it does not produce a credential.
   */
  credentialRetryDelayMs?: number;
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
  private readonly getOrganisationId?: () => string | null;
  private readonly clientType: string;
  private readonly credentialRetryDelayMs?: number;
  private refreshInFlight: Promise<boolean> | null = null;
  private waitingForCredential = 0;
  private readonly reconnectingListeners = new Set<() => void>();

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.refresh = options.refresh;
    this.getOrganisationId = options.getOrganisationId;
    this.clientType = options.clientType ?? "web";
    this.credentialRetryDelayMs = options.credentialRetryDelayMs;
  }

  /**
   * True while at least one request is waiting for the host to hand back a
   * credential (see `credentialRetryDelayMs`), so the UI can say "Reconnecting
   * to your account…" instead of looking stuck for that second.
   */
  get reconnecting(): boolean {
    return this.waitingForCredential > 0;
  }

  /** `useSyncExternalStore`'s subscribe for `reconnecting`. An arrow, so it
   * can be handed over unbound. */
  readonly subscribeReconnecting = (listener: () => void): (() => void) => {
    this.reconnectingListeners.add(listener);
    return () => {
      this.reconnectingListeners.delete(listener);
    };
  };

  private markWaiting(delta: 1 | -1): void {
    const was = this.reconnecting;
    this.waitingForCredential += delta;
    if (was !== this.reconnecting) {
      for (const listener of this.reconnectingListeners) listener();
    }
  }

  /**
   * Stamps `X-Client` and, when one is chosen, `Organisation` onto an
   * outgoing request.
   *
   * One place for both so the two request paths below cannot drift: a
   * header added to `graphql` but not `agentFetch` would mean the console
   * acting as one organisation on its chat calls and another on its REST
   * ones, which is the kind of split nobody notices until the data looks
   * wrong.
   *
   * Never overwrites a header a caller set explicitly — a call that names
   * its own `Organisation` has said something more specific than the
   * ambient session state.
   */
  private applyContextHeaders(headers: Headers): void {
    if (!headers.has("X-Client")) {
      headers.set("X-Client", this.clientType);
    }
    if (headers.has("Organisation")) return;
    const organisationId = this.getOrganisationId?.();
    if (organisationId !== undefined && organisationId !== null && organisationId !== "") {
      headers.set("Organisation", organisationId);
    }
  }

  /**
   * Runs `refresh` at most once per overlapping wave of callers on *this*
   * instance — see the `refresh` option's own docstring on
   * GatewayClientOptions for why this exists on top of whatever dedup the
   * injected function does itself. Resolves false without calling
   * `refresh` at all when none was configured, which is exactly the old
   * (pre-refresh) behaviour for every caller that doesn't pass one.
   *
   * A refresh that throws counts as one that failed. It is the host's code,
   * and its exception says nothing a reader could act on.
   */
  private async runRefresh(): Promise<boolean> {
    if (this.refresh === undefined) return false;
    if (this.refreshInFlight === null) {
      const attempt = this.refresh().catch(() => false);
      this.refreshInFlight = attempt;
      void attempt.finally(() => {
        if (this.refreshInFlight === attempt) this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  /**
   * The credential for one request, or the refusal for having none.
   *
   * A null gets one more chance when `credentialRetryDelayMs` is set: the
   * host's `refresh` if it has one, else a short pause, then one more read.
   * Only then is it a refusal. A provider that throws is treated as one that
   * returned null: the exception is the host's, and "no credential" is what
   * it means here.
   */
  private async requireToken(): Promise<string> {
    let token = await this.readToken();
    if (token === null && this.credentialRetryDelayMs !== undefined) {
      const delayMs = this.credentialRetryDelayMs;
      this.markWaiting(1);
      try {
        if (!(await this.runRefresh())) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        token = await this.readToken();
      } finally {
        this.markWaiting(-1);
      }
    }
    if (token === null) {
      this.onUnauthorized();
      throw new UnauthorizedError(401);
    }
    return token;
  }

  private async readToken(): Promise<string | null> {
    try {
      return await this.getToken();
    } catch {
      return null;
    }
  }

  /**
   * `fetch`, with the one failure it reports by throwing turned into words.
   *
   * A request that never got an HTTP answer rejects with a bare
   * `TypeError("Failed to fetch")`, and before this that string was what the
   * failed-run card printed. A cancellation passes through untouched — see
   * `isAbort`.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(new Request(url, init));
    } catch (err) {
      if (isAbort(err, init.signal)) throw err;
      throw new NetworkError(err);
    }
  }

  /**
   * What a non-2xx becomes, in one place for all three request paths.
   *
   * ONLY a 401 clears the session. A 403 is "we know exactly who you are,
   * and you may not do this" — an authenticated state, not a broken one, so
   * signing the operator out on it is both wrong and unrecoverable: they
   * land on sign-in, sign in again, and the next call 403s them straight
   * back out. Observed the moment this console met bolt-v2: the token
   * authenticates fine, but bolt-ai's own permission names (`agent.agents`,
   * `agent.chat.use`) are not seeded in bolt-v2's RBAC, so every gated route
   * answers 403 and the dashboard's first call bounced the operator to
   * sign-in. It is a `ForbiddenError` now, a different class from
   * `UnauthorizedError`, so nothing that reacts to one can catch the other.
   */
  private async refusal(response: Response, authed: boolean): Promise<GatewayError> {
    if (response.status === 401 && authed) this.onUnauthorized();
    return errorFromResponse(response);
  }

  /** A 2xx body as JSON — or, when it is not JSON (a proxy's page served
   * with a 200), an error that says so instead of `SyntaxError: Unexpected
   * token '<'`. */
  private async readJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (err) {
      if (isAbort(err, null)) throw err;
      throw new GatewayError("The assistant sent a reply this screen couldn't read.", {
        status: response.status,
        retryable: true,
        cause: err,
      });
    }
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
      headers.set("Authorization", `Bearer ${await this.requireToken()}`);
    }
    this.applyContextHeaders(headers);

    const response = await this.send(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: options.signal,
    });

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
   * The front half `agentStream` and `agentFetch` share: the path check,
   * the credential, the headers, the request. One copy, so the two cannot
   * disagree about any of them.
   */
  private async sendAgent(
    method: "agentFetch" | "agentStream",
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    if (!path.startsWith("/agent/")) {
      throw new GatewayError(`${method} path must start with /agent/, got "${path}"`);
    }

    const token = await this.requireToken();

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Content-Type") && init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    this.applyContextHeaders(headers);

    return this.send(`${this.baseUrl}${path}`, { ...init, headers });
  }

  /**
   * `agentFetch`'s auth contract, but hands back the raw `Response` instead
   * of parsing it.
   *
   * `POST /agent/run` streams SSE, so its body must be read incrementally
   * and `agentFetch`'s closing `await response.json()` would buffer an
   * unbounded stream. `runStream.ts` therefore used to open a bare `fetch`
   * and hand-roll the headers — its own docstring called that out and said a
   * method here was the right home "the next time someone can touch that
   * file". This is that method, and it matters more now than it did then:
   * with Ask extracted into an embeddable package, a second copy of the auth
   * contract is a second place for the credential, the `Organisation` header
   * and `X-Client` to drift out of step with this class.
   *
   * Only the SUCCESS path is returned raw. Every refusal is classified here,
   * into the same typed errors `agentFetch` throws — a non-2xx carries a
   * small buffered JSON body, never the stream, so reading it is safe.
   *
   * `init.body` must be re-sendable (a string, as `/agent/run`'s is): a 401
   * is retried once, below.
   */
  async agentStream(path: string, init: RequestInit = {}, isRetry = false): Promise<Response> {
    const response = await this.sendAgent("agentStream", path, init);

    // One refresh-and-retry on a 401, the same rule as `agentFetch`. This
    // used to be "never", because re-sending `/agent/run` could start a second
    // agent RUN — but a 401 is answered by the auth dependency before the
    // route body runs, so the refused request started nothing and the retry
    // is the first run, not a second. Only a 401: anything past auth may
    // already have done work.
    if (response.status === 401 && !isRetry) {
      const refreshed = await this.runRefresh();
      if (refreshed) {
        return this.agentStream(path, init, true);
      }
    }

    if (!response.ok) throw await this.refusal(response, true);
    return response;
  }

  /**
   * Any `/agent/*` call — `path` must start with `/agent/`. Always
   * carries `Authorization: Bearer <token>` (spec §10.1: "sent as
   * Authorization: Bearer on every /agent/* call"); a 401 response, or
   * having no token to send in the first place, both end the session the
   * same way, via onUnauthorized — unless a configured `refresh` recovers
   * a 401 first (see `graphql`'s matching comment; the same one-retry rule
   * applies here). A 403 never does; see `refusal`.
   */
  async agentFetch<T>(path: string, init: RequestInit = {}, isRetry = false): Promise<T> {
    const response = await this.sendAgent("agentFetch", path, init);

    if (response.status === 401 && !isRetry) {
      const refreshed = await this.runRefresh();
      if (refreshed) {
        return this.agentFetch<T>(path, init, true);
      }
    }

    if (!response.ok) throw await this.refusal(response, true);
    if (response.status === 204) {
      return undefined as T;
    }
    return this.readJson<T>(response);
  }

  private async readGraphQLResponse<T>(response: Response, wasAuthed: boolean): Promise<T> {
    // GraphQL services in this repo authenticate optionally at the HTTP
    // layer and deny via the @auth directive inside a 200 response
    // (pkg/middleware/jwt.go) — but the gateway itself can still return a
    // bare 401/403 (e.g. its own JWT check), so both are handled here, by
    // the same `refusal` the REST paths use.
    if (!response.ok) throw await this.refusal(response, wasAuthed);

    const body = await this.readJson<GraphQLResponseBody<T>>(response);
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
