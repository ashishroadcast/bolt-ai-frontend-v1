/**
 * When a bolt-v2 access token expires, read from its own `exp` claim.
 *
 * NEVER a security decision. The signature is not checked here and could not
 * be — this console holds no secret — so the value only schedules a renewal
 * a minute ahead of time (`./credential.ts`). Whether a token is valid is
 * agent-service's answer, which it gets by asking bolt-v2.
 *
 * Null for anything that does not decode to a numeric `exp`: a token of a
 * shape this does not know is renewed when agent-service refuses it, which
 * is the slower path, not a wrong one.
 */
export function tokenExpiresAt(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined || payload === "") return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const claims: unknown = JSON.parse(atob(padded));
    if (typeof claims !== "object" || claims === null) return null;
    const exp = (claims as Record<string, unknown>).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
