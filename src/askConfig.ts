import { GATEWAY_URL } from "./api/config.ts";
import type { AskConfig } from "./ask/index.ts";
import { getApiKey, getOrganisationId, setSession } from "./auth/session.ts";

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
    getCredential: getApiKey,
    getOrganisationId,
    // The console's answer to a refused credential is to sign out. A host
    // with its own session might instead refresh and carry on, which is why
    // the package does not decide this.
    onUnauthorized: () => setSession(null),
  },
  // A plain href, not a react-router `<Link>`: the package must not depend
  // on the console's router, or it could not run in Angular's.
  setupAgentsHref: "/agents",
};
