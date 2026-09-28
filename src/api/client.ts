import { getFreshCredential, onCredentialRefused, refreshCredential } from "../auth/credential.ts";
import { getOrganisationId } from "../auth/session.ts";
import { GATEWAY_URL } from "./config.ts";
import { GatewayClient } from "../ask/http/gatewayClient.ts";

/**
 * The app's single GatewayClient for `/agent/*`, wired to the real session
 * store. Every component and hook imports this rather than constructing its
 * own — see gatewayClient.ts for why the class itself stays framework and
 * session agnostic (so tests can point a fresh instance at a fake credential
 * instead).
 *
 * The credential is whichever the session holds (`../auth/session.ts`): a
 * signed-in user's bolt-v2 token, renewed a minute before it expires and
 * again after any 401 (`../auth/credential.ts`), or an API key, which never
 * expires and so is never renewed — a refused key is simply a sign-out.
 */
export const gatewayClient = new GatewayClient({
  baseUrl: GATEWAY_URL,
  getToken: getFreshCredential,
  refresh: refreshCredential,
  onUnauthorized: onCredentialRefused,
  // The acting organisation, read fresh per request so switching it in the
  // picker takes effect on the very next call. agent-service validates it —
  // see `getOrganisationId` on GatewayClientOptions for why a client-side
  // value is safe here.
  getOrganisationId,
});
