import { getApiKey, getOrganisationId, setSession } from "../auth/session.ts";
import { GATEWAY_URL } from "./config.ts";
import { GatewayClient } from "../ask/http/gatewayClient.ts";

/**
 * The app's single GatewayClient for `/agent/*`, wired to the real session
 * store. Every component and hook imports this rather than constructing its
 * own — see gatewayClient.ts for why the class itself stays framework and
 * session agnostic (so tests can point a fresh instance at a fake credential
 * instead).
 *
 * **What used to be in this file, and why none of it is left.** This module
 * held a token-refresh apparatus: a `refreshToken` mutation, a staleness
 * margin, a module-level single-flight guard, and a `getFreshToken` that
 * renewed ahead of expiry so an operator mid-task never hit a reactive 401.
 * All of it existed because the credential was a short-lived JWT — bolt-v2
 * issues fifteen-minute ones — and because the mutation it called was POS's,
 * against a different service from the one that minted the token, so it could
 * only ever fail.
 *
 * agent-service issues and verifies its own API keys now
 * (`app.auth.api_keys`). A key does not expire, so there is no staleness to
 * anticipate; it is not refreshable, so there is nothing to single-flight;
 * and it is not a JWT, so there is no `exp` to decode. A key that stops
 * working has been revoked, which is a 401, which is a sign-out — the one
 * path left, and `GatewayClient` already had it.
 *
 * No `refresh` option is passed for the same reason. `GatewayClient` treats
 * its absence as "a 401 is final", which is exactly right: retrying a revoked
 * key would only revoke it again.
 */
export const gatewayClient = new GatewayClient({
  baseUrl: GATEWAY_URL,
  getToken: getApiKey,
  onUnauthorized: () => setSession(null),
  // The acting organisation, read fresh per request so switching it in the
  // picker takes effect on the very next call. agent-service validates it —
  // see `getOrganisationId` on GatewayClientOptions for why a client-side
  // value is safe here.
  getOrganisationId,
});
