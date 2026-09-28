const UNAUTHORIZED_MESSAGE = "Couldn't verify your sign-in.";
const FORBIDDEN_MESSAGE = "You don't have permission to use the assistant. Ask an admin for access.";

/**
 * One error shape for everything the gateway client throws, so a caller
 * can catch `GatewayError` once and get a message fit to show an operator
 * — never a raw fetch/JSON exception leaking through.
 *
 * **Every `.message` here is a finished sentence.** The failed-run card, the
 * agent picker's error bar and the answer form all print `error.message` as
 * it is, with nothing around it, so a message that only makes sense next to
 * a status code ("Asking failed (429).") or a browser's own wording ("Failed
 * to fetch") reaches the reader as exactly that. The status, the server's
 * body and the original exception stay on the error for anyone debugging.
 */
export class GatewayError extends Error {
  readonly status?: number;
  readonly graphQLErrors?: readonly string[];
  /**
   * Whether sending the same request again could plausibly work — a dropped
   * connection, a restarting service, a rate limit. False for a refusal that
   * a second try would only repeat (a missing permission, a spent usage
   * limit, a request the server rejected as malformed). The UI offers Retry
   * only where this is true, because a Retry button that can only fail again
   * is worse than none.
   */
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: {
      status?: number;
      graphQLErrors?: readonly string[];
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayError";
    this.status = options?.status;
    this.graphQLErrors = options?.graphQLErrors;
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * A non-2xx from an `/agent/*` call, carrying whatever JSON the server
 * actually sent — most importantly FastAPI's own `detail` field, which is
 * how a validation refusal or the promotion gate's own `{reason,
 * regressed_cases}` refusal (`app.learning.gate`, surfaced through
 * `app.api.admin`'s `POST /agent/admin/promote` as `HTTPException(422,
 * detail={"reason": ..., "regressed_cases": [...]})`) reaches a caller at
 * all.
 *
 * Lives here now rather than in `gatewayClient.ts` (which still re-exports
 * it, so no import changes): `errorFromResponse` below builds one, and the
 * error types belong in one file.
 */
export class AgentApiError extends GatewayError {
  /** The parsed JSON error body (typically `{detail: ...}`), or
   * `undefined` when the response body was not valid JSON at all (an
   * upstream proxy's own error page, an empty body, …) — a caller that
   * wants FastAPI's `detail` reads it off here (`error.body?.detail`)
   * rather than re-parsing `message`. */
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown, options?: { retryable?: boolean }) {
    super(message, { status, retryable: options?.retryable ?? isRetryableStatus(status) });
    this.name = "AgentApiError";
    this.body = body;
  }
}

/**
 * A 401: agent-service could not tell who is asking.
 *
 * Deliberately not "your session ended". A 401 from agent-service covers a
 * revoked key, but also agent-service failing to reach bolt-v2 to verify a
 * perfectly good token, and a credential caught mid-refresh — and in the
 * last two, "sign in again" sends someone off to fix a problem that is not
 * theirs. The message says what is known and no more.
 *
 * Retryable for the same reason: most of those causes pass on their own.
 * The console still signs out on a 401, through `onUnauthorized`, not
 * through this class — `instanceof UnauthorizedError` is how a caller
 * recognises the case, and a 403 is never one (see `ForbiddenError`).
 */
export class UnauthorizedError extends GatewayError {
  constructor(status = 401) {
    super(UNAUTHORIZED_MESSAGE, { status, retryable: true });
    this.name = "UnauthorizedError";
  }
}

/**
 * A 403: agent-service knows exactly who is asking, and they may not do this.
 *
 * Its own class, and NOT an `UnauthorizedError`, because the two call for
 * opposite responses. A 401 may end a session; a 403 must never, or a
 * missing permission becomes a sign-in loop — sign in, first call 403s,
 * straight back out. That is what happened the first time this console met
 * a bolt-v2 token whose RBAC had no `agent.chat.use` seeded.
 *
 * The message speaks to the person in front of the screen. The server's own
 * `detail` ("missing permission agent.chat.use/can_create") is for whoever
 * fixes it, so it is kept on `detail` for a tooltip or a debug panel rather
 * than printed.
 */
export class ForbiddenError extends GatewayError {
  /** FastAPI's `detail` when it was a string, else `null`. */
  readonly detail: string | null;
  readonly body: unknown;

  constructor(detail: string | null = null, body?: unknown) {
    super(FORBIDDEN_MESSAGE, { status: 403, retryable: false });
    this.name = "ForbiddenError";
    this.detail = detail;
    this.body = body;
  }
}

/**
 * The request never got an HTTP answer: the service is down or restarting,
 * the network dropped, or a proxy refused the connection. `fetch` reports all
 * of those as a bare `TypeError("Failed to fetch")`, which is the browser
 * talking to a developer, not to the person asking.
 *
 * The original exception is kept as `cause`.
 */
export class NetworkError extends GatewayError {
  constructor(cause?: unknown) {
    super("Couldn't reach the assistant. It may be restarting; try again in a moment.", {
      retryable: true,
      cause,
    });
    this.name = "NetworkError";
  }
}

/**
 * A 429. Typed so a caller can count down to `retryAfterSeconds` instead of
 * parsing it back out of the message.
 */
export class RateLimitedError extends AgentApiError {
  /** From `Retry-After`, or `null` when the server did not say. */
  readonly retryAfterSeconds: number | null;

  constructor(body: unknown, retryAfterSeconds: number | null) {
    super(rateLimitMessage(retryAfterSeconds), 429, body, { retryable: true });
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** FastAPI's `detail` when it is a plain string — the common case
 * (`detail="artifact not found"`) — usable directly as an error message.
 * A structured `detail` (the promotion gate's `{reason,
 * regressed_cases}`) is not a message on its own; a caller that wants it
 * reads `error.body` instead, so this returns `null` for that shape
 * rather than `JSON.stringify`-ing something not meant to be read as
 * prose. */
export function stringDetailMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("detail" in body)) return null;
  const detail = (body as { detail: unknown }).detail;
  return typeof detail === "string" ? detail : null;
}

/**
 * FastAPI's request-validation `detail` — a list of `{loc, msg}` — as one
 * readable line: `"Field required (message); Input should be a valid
 * integer (session_id)."`. `null` for anything else.
 *
 * `body`/`query`/`path` are dropped from the location because they name the
 * part of the request, not the field, and mean nothing to a reader.
 */
function validationMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("detail" in body)) return null;
  const detail = (body as { detail: unknown }).detail;
  if (!Array.isArray(detail)) return null;
  const parts: string[] = [];
  for (const item of detail) {
    if (typeof item !== "object" || item === null) continue;
    const { msg, loc } = item as { msg?: unknown; loc?: unknown };
    if (typeof msg !== "string" || msg.trim() === "") continue;
    const text = msg.trim().replace(/\.+$/, "");
    const field = Array.isArray(loc)
      ? loc
          .filter((part) => part !== "body" && part !== "query" && part !== "path")
          .map(String)
          .join(".")
      : "";
    parts.push(field === "" ? text : `${text} (${field})`);
  }
  return parts.length === 0 ? null : `${parts.join("; ")}.`;
}

/** Seconds under a minute are counted; anything longer is rounded up to
 * minutes, because "Try again in 540 seconds" makes the reader do arithmetic. */
function rateLimitMessage(retryAfterSeconds: number | null): string {
  const prefix = "Too many questions at once. Try again in";
  if (retryAfterSeconds === null) return `${prefix} a minute.`;
  if (retryAfterSeconds < 60) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    return `${prefix} ${seconds} second${seconds === 1 ? "" : "s"}.`;
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes === 1 ? `${prefix} a minute.` : `${prefix} ${minutes} minutes.`;
}

/**
 * `Retry-After` in seconds. The header is either a count of seconds or an
 * HTTP date; both are allowed by RFC 9110 and proxies do send the date form.
 */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Statuses a second attempt can outlive: a timeout, a rate limit, and the
 * whole 5xx range (a restart, a crashed worker, an upstream the proxy could
 * not reach). Every other 4xx is the server saying no, and it will say it
 * again.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * What to tell someone about an HTTP refusal, and whether trying again could
 * help. The single place status codes turn into words, so the console's admin
 * screens, the chat and the widget all say the same thing about the same
 * failure.
 *
 * 401, 402, 403 and 429 always get their fixed sentence: each means one thing
 * to the reader whatever the body says, and the body is written for whoever
 * fixes it. Otherwise a plain-string `detail` is used as it is, because
 * agent-service writes those to be read ("no active agent named 'X' for this
 * tenant", "OpenRouter is unreachable") and the console's screens have always
 * shown them. That includes a 5xx: a gateway's or proxy's own 502 is an HTML
 * page with no `detail`, so one that carries a `detail` is agent-service
 * explaining itself, and says more than "temporarily unavailable" could.
 */
export function describeHttpError(
  status: number,
  body: unknown,
  retryAfter: string | null = null,
): { message: string; retryable: boolean } {
  const retryable = isRetryableStatus(status);
  if (status === 401) return { message: UNAUTHORIZED_MESSAGE, retryable: true };
  if (status === 403) return { message: FORBIDDEN_MESSAGE, retryable: false };
  if (status === 402) {
    return { message: "The assistant's usage limit has been reached. Ask an admin.", retryable: false };
  }
  if (status === 429) return { message: rateLimitMessage(parseRetryAfter(retryAfter)), retryable };

  const detail = stringDetailMessage(body) ?? validationMessage(body);
  if (detail !== null) return { message: detail, retryable };

  if (status === 502 || status === 503 || status === 504) {
    return { message: "The assistant is temporarily unavailable.", retryable };
  }

  if (status === 404) {
    return { message: "The assistant couldn't find that. It may have been removed.", retryable };
  }
  if (status === 408) return { message: "The assistant took too long to answer. Try again.", retryable };
  if (status >= 500) {
    return {
      message: "Something went wrong on the assistant's side. Try again in a moment.",
      retryable,
    };
  }
  return { message: "The assistant couldn't accept that request.", retryable };
}

/**
 * The typed error for a non-2xx `Response`. Reads the body first — a
 * non-2xx from FastAPI is almost always JSON, but a proxy in front of it
 * might not be, so a parse failure degrades to `undefined` rather than
 * throwing a second, unrelated error.
 *
 * Deliberately does NOT call anyone's `onUnauthorized`: whether a 401 ends
 * a session is the client's decision, not the error's.
 */
export async function errorFromResponse(response: Response): Promise<GatewayError> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 401) return new UnauthorizedError(401);
  if (response.status === 403) return new ForbiddenError(stringDetailMessage(body), body);
  if (response.status === 429) {
    return new RateLimitedError(body, parseRetryAfter(response.headers.get("Retry-After")));
  }
  const { message, retryable } = describeHttpError(response.status, body);
  return new AgentApiError(message, response.status, body, { retryable });
}
