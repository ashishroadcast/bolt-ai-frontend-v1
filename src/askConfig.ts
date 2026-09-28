import { GATEWAY_URL } from "./api/config.ts";
import type { AskConfig } from "./ask/index.ts";
import { getFreshCredential, onCredentialRefused, refreshCredential } from "./auth/credential.ts";
import { getOrganisationId, getSession } from "./auth/session.ts";

/**
 * The console's answers to what the Ask package asks of every host.
 *
 * A module-level constant rather than a `useMemo` in a component, because
 * `AskProvider` rebuilds its HTTP client whenever this object's identity
 * changes — and every function here reads the session store at CALL time, so
 * there is nothing per-render to capture. A new object each render would
 * throw away the client (and its connection reuse) on every keystroke.
 *
 * bolt-v2's frontend will supply a different object of the same shape: its
 * own credential, its own organisation, its own idea of what a refusal
 * means. That is the entire interface between them.
 */
export const consoleAskConfig: AskConfig = {
  baseUrl: GATEWAY_URL,
  auth: {
    // Read per request, never captured: the operator can switch organisation
    // from the top bar mid-conversation, and a value taken once at mount
    // would keep addressing the previous one.
    getCredential: getFreshCredential,
    getOrganisationId,
    // A signed-in user's token is renewed and the request retried; an API
    // key cannot be, so a refused one is final.
    refreshCredential: async () =>
      (await refreshCredential()) ? (getSession()?.credential ?? null) : null,
    // What is left after renewal fails is a sign-out, with the reason kept
    // so the sign-in screen can say why it is back.
    onUnauthorized: onCredentialRefused,
  },
  // A plain href, not a react-router `<Link>`: the package must not depend
  // on the console's router, or it could not run in Angular's.
  setupAgentsHref: "/agents",
};
