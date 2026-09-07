/**
 * Decodes the `exp` claim out of a JWT payload without verifying the
 * signature. This is NOT authentication — nothing here checks that the
 * token is genuine. Per the agent-service spec (§10.1), "the console
 * verifies nothing itself"; the gateway is the only party that validates
 * the token before anything reaches `/agent/*`.
 *
 * The one legitimate use of the result is deciding *when to prompt for
 * sign-in again* (a stale token is worth clearing before firing a request
 * that will only 401). Never use it to decide *what a signed-in user may
 * do* — that question has exactly one authority, and it isn't this file.
 */
export function decodeExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1]!));
    if (
      typeof payload === "object" &&
      payload !== null &&
      "exp" in payload &&
      typeof (payload as { exp: unknown }).exp === "number"
    ) {
      return (payload as { exp: number }).exp * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return atob(padded);
}
