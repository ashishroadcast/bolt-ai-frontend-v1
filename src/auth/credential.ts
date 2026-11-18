import { whitelightRefresh } from "./whitelight.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { refreshTokens } from "./boltv2.ts";
import { tokenExpiresAt } from "./jwt.ts";
import { endSession, getSession, readSharedSession, setSession, type Session } from "./session.ts";

/**
 * Keeping a signed-in user's bolt-v2 token current.
 *
 * An API key never needs this — it does not expire — so everything below is
 * a pass-through for one. A user's access token does expire, and bolt-v2
 * renews it with `RefreshToken`, which ROTATES the refresh token: the one
 * spent is retired and a new one comes back. Two things follow.
 *
 * * **Renew ahead of time, not after a refusal.** A request made with a token
 *   a few seconds from expiry can be refused mid-flight — worst of all a
 *   streaming Ask run. `getFreshCredential` renews a minute early, so the
 *   401-then-retry path (`refreshCredential`) is the exception.
 * * **One renewal at a time, across every tab.** The session is shared
 *   through localStorage (`./session.ts`), so two tabs can reach expiry
 *   together. Each renews under a Web Lock and, once it holds it, first
 *   checks whether another tab already did — adopting that token instead of
 *   spending a refresh token that tab has just retired. bolt-v2 forgives a
 *   reused token for a few minutes (its rotation grace window), so a browser
 *   without Web Locks degrades to "usually fine", not "signed out".
 *
 * A session with no refresh token (bolt-v2 sent none, or it was handed over
 * by "Continue with Bolt", which never shares one) cannot be renewed: it
 * lasts as long as its access token, and then the person signs in again.
 */

/** How long before expiry a token is renewed. */
const RENEW_AHEAD_MS = 60_000;
const LOCK_NAME = "agent-console.refresh";

let inFlight: Promise<boolean> | null = null;

function needsRenewal(session: Session, now = Date.now()): boolean {
  return (
    session.kind === "user" &&
    typeof session.expiresAt === "number" &&
    session.expiresAt - now <= RENEW_AHEAD_MS
  );
}

async function withLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined || typeof locks.request !== "function") return work();
  return locks.request(LOCK_NAME, work) as Promise<T>;
}

/**
 * Renews the current user session. Resolves true when a usable credential
 * is now in place, false when there is none to be had — the caller decides
 * what that means (a sign-out, after a refusal; nothing, ahead of time).
 *
 * `force` renews even a token that has not reached its renewal window:
 * agent-service just refused it, so its own `exp` is not to be believed.
 */
async function renew(force: boolean): Promise<boolean> {
  const started = getSession();
  if (started === null || started.kind !== "user") return started !== null;

  return withLock(async () => {
    // Another tab may have renewed while this one waited for the lock.
    const shared = readSharedSession();
    const current = getSession();
    if (current === null || current.kind !== "user") return current !== null;
    if (
      shared !== null &&
      shared.kind === "user" &&
      shared.credential !== started.credential &&
      !needsRenewal(shared)
    ) {
      setSession({ ...shared, organisationId: current.organisationId });
      return true;
    }
    if (!force && !needsRenewal(current)) return true;

    const refreshToken = (shared?.kind === "user" ? shared.refreshToken : null) ?? current.refreshToken ?? null;
    if (refreshToken === null) return false;

    try {
      // A Whitelight session renews through Bolty's relay to WFM's own refresh.
      const renewed =
        current.via === "whitelight" ? await whitelightRefresh(refreshToken) : await refreshTokens(refreshToken);
      const latest = getSession();
      // Signed out (or switched to an API key) while the request was out:
      // the answer belongs to a session that no longer exists.
      if (latest === null || latest.kind !== "user") return false;
      setSession({
        ...latest,
        credential: renewed.token,
        refreshToken: renewed.refreshToken,
        expiresAt: tokenExpiresAt(renewed.token),
      });
      return true;
    } catch (err) {
      // A retryable failure (bolt-v2 unreachable) is not a refusal: the token
      // in hand may still have a minute left, and signing someone out over a
      // dropped connection is the wrong answer to it.
      if (err instanceof GatewayError && err.retryable) return false;
      endSession("expired");
      return false;
    }
  });
}

function renewOnce(force: boolean): Promise<boolean> {
  inFlight ??= renew(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The credential for the next request, renewed first when a user's token is
 * about to expire. Null when signed out. What `GatewayClient` and Ask call
 * before every request.
 */
export async function getFreshCredential(): Promise<string | null> {
  const session = getSession();
  if (session === null) return null;
  if (needsRenewal(session)) {
    await renewOnce(false);
  }
  return getSession()?.credential ?? null;
}

/**
 * Renews after agent-service refused the credential (a 401). Resolves true
 * when there is a new one worth retrying with. An API key cannot be renewed,
 * so a refused key resolves false and the caller signs out.
 */
export async function refreshCredential(): Promise<boolean> {
  const session = getSession();
  if (session === null || session.kind !== "user") return false;
  const before = session.credential;
  const ok = await renewOnce(true);
  return ok && getSession()?.credential !== before;
}

/** What a 401 that renewal could not recover means for this session. */
export function onCredentialRefused(): void {
  endSession(getSession()?.kind === "apiKey" ? "rejected" : "expired");
}
