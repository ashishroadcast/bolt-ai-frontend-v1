import { decodeExpiry } from "../auth/jwt.ts";
import { getSession, getToken, setSession, type Session } from "../auth/session.ts";
import { AUTH_URL, GATEWAY_URL } from "./config.ts";
import { GatewayClient } from "./gatewayClient.ts";

/**
 * Sign-in's client. Identical wiring, different origin — see AUTH_URL.
 * When VITE_AUTH_URL is unset this points at the same place as
 * `gatewayClient`, so the split costs nothing in the ordinary case.
 *
 * Declared before `gatewayClient` (and before `refreshAccessToken`, which
 * calls it below) because `performRefresh` needs it. This is fine despite
 * `refreshAccessToken` being passed to `gatewayClient`'s own constructor
 * further down: nothing *invokes* `refreshAccessToken` during module
 * evaluation, only later, by which point every binding in this file is
 * set — a plain top-level ordering issue, not a circular import.
 */
export const authClient = new GatewayClient({
  baseUrl: AUTH_URL,
  getToken,
  onUnauthorized: () => setSession(null),
});

// No GraphQL argument — the schema's `refreshToken: TokenResponse!` takes
// none. The refresh token travels as `Authorization: Bearer <refresh>`.
//
// NOT `X-Refresh-Token`, which the auth service also accepts and which this
// used to send: the POS gateway sits in front, and its CORS preflight does
// not list `x-refresh-token` in Access-Control-Allow-Headers. The browser
// therefore blocked the refresh outright — "Request header field
// x-refresh-token is not allowed" — so an expired session could never renew
// itself and every user was silently signed out at token expiry. Fixing the
// gateway's allowlist would mean rebuilding and redeploying a live POS
// service for a header only this console sends.
//
// `Authorization` needs no such change: it is on every request already. And
// this is the auth service's own documented second path, not a trick —
// `RefreshToken`'s resolver reads the cookie first, then falls back to
// `extractToken`, whose comment reads "for non-SSO API clients that send the
// refresh token as a Bearer token." That is exactly this console.
//
// `auth: false` so GatewayClient does not overwrite the header below with
// the (expired) access token — that branch runs after `options.headers`.
const REFRESH_MUTATION = `
  mutation ConsoleRefreshToken {
    refreshToken {
      accessToken
      refreshToken
    }
  }
`;

interface RefreshPayload {
  refreshToken: {
    accessToken: string;
    refreshToken: string;
  };
}

/**
 * A minute of headroom before the access token's own `exp`. Access
 * tokens here are issued with an hours-scale lifetime (auth's
 * `expiryHours` config) — a minute is a small fraction of that, so this
 * costs nothing in refresh frequency, and it's comfortably more than one
 * slow request needs to land before the token it carried would have
 * lapsed anyway.
 */
const REFRESH_MARGIN_MS = 60_000;

function isStale(session: Session): boolean {
  return session.expiresAt !== null && Date.now() >= session.expiresAt - REFRESH_MARGIN_MS;
}

/**
 * The dedup guard behind `refreshAccessToken`: every caller within one
 * refresh cycle awaits the same promise instead of each firing its own
 * mutation. Module-level (not per-GatewayClient-instance) so it also
 * covers `gatewayClient` and `authClient` racing each other, on top of
 * the per-instance dedup `GatewayClient.runRefresh` already does for
 * concurrent callers of a single instance.
 */
let inFlightRefresh: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const session = getSession();
  const refreshToken = session?.refreshToken;
  if (session === null || refreshToken === undefined || refreshToken === null || refreshToken === "") {
    // Nothing to refresh with (dev token-paste session, or already
    // signed out) — the caller (GatewayClient.onUnauthorized, or
    // getFreshToken finding no token to hand back) is what actually
    // clears the session; this just reports "couldn't."
    return false;
  }

  try {
    const data = await authClient.graphql<RefreshPayload>(REFRESH_MUTATION, undefined, {
      auth: false,
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    setSession({
      token: data.refreshToken.accessToken,
      refreshToken: data.refreshToken.refreshToken,
      user: session.user,
      expiresAt: decodeExpiry(data.refreshToken.accessToken),
    });
    return true;
  } catch {
    // The rejected refresh token is never retried — see this module's
    // report for "a failed refresh must not loop". Session is left as-is
    // here; the caller that asked for this refresh is responsible for
    // deciding what "no fresh token" means for it (onUnauthorized, or
    // getFreshToken returning null), not this function.
    return false;
  }
}

/**
 * Attempts one token refresh, sharing an in-flight attempt across every
 * concurrent caller. Used two ways: reactively, as `gatewayClient`'s
 * `refresh` option (GatewayClient calls this after a 401, once, before
 * giving up); and proactively, from `getFreshToken` below, ahead of the
 * token's own expiry so an operator mid-task rarely hits that reactive
 * path at all.
 */
export function refreshAccessToken(): Promise<boolean> {
  if (inFlightRefresh === null) {
    const attempt = performRefresh();
    inFlightRefresh = attempt;
    void attempt.finally(() => {
      if (inFlightRefresh === attempt) inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

/**
 * `gatewayClient`'s `getToken` — proactive half of the refresh strategy.
 * Hands back the current token untouched when it isn't close to expiry;
 * otherwise refreshes first (deduped, see `refreshAccessToken`) and hands
 * back whatever the session holds afterward — the fresh token on success,
 * or null on failure, at which point `GatewayClient` treats "no token" the
 * same as it always has (`onUnauthorized`, no network round trip).
 *
 * Reading `exp` here is scheduling, not verification — see jwt.ts and
 * session.ts's own docstrings. The gateway and agent-service are still
 * the only parties that check the signature.
 *
 * Exported for `chat/runStream.ts`, the one `/agent/*` caller that cannot
 * go through `GatewayClient` (it reads an SSE body incrementally rather
 * than buffering JSON) and so has to reproduce this half of the contract
 * itself. Nothing else should import it — every other caller gets it for
 * free as `gatewayClient`'s own `getToken`.
 */
export async function getFreshToken(): Promise<string | null> {
  const session = getSession();
  if (session === null) return null;
  if (!isStale(session)) return session.token;

  const refreshed = await refreshAccessToken();
  return refreshed ? getToken() : null;
}

/**
 * The app's single GatewayClient for `/agent/*` and the gateway's proxied
 * GraphQL, wired to the real session store. Every component and hook
 * imports this rather than constructing its own — see gatewayClient.ts
 * for why the class itself stays framework/session agnostic (so tests can
 * point a fresh instance at a fake token instead).
 */
export const gatewayClient = new GatewayClient({
  baseUrl: GATEWAY_URL,
  getToken: getFreshToken,
  onUnauthorized: () => setSession(null),
  refresh: refreshAccessToken,
});
