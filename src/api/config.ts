// Falls back to the gateway's documented local port (CLAUDE.md's service
// table) so `npm run dev` works against `make local-up` with zero setup;
// a real deploy sets VITE_GATEWAY_URL (see .env.example). Never hardcode
// anything past this default — there is no credential in a base URL, but
// there's also no reason for a second place to change it.
const DEFAULT_GATEWAY_URL = "http://localhost:8080";

/**
 * Resolve a base URL to something `new Request()` accepts.
 *
 * A relative value is legitimate and is how the dev server proxies to a
 * gateway on another origin — but `new Request("/agent/x")` throws without
 * an origin, which is every test run under jsdom. Resolving here keeps that
 * detail out of every call site, and out of the test setup, where it
 * previously took down the whole suite the moment a `.env.local` set
 * VITE_GATEWAY_URL to "/".
 */
function absolute(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (!trimmed.startsWith("/")) return trimmed;
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return `${origin}${trimmed}`;
}

export const GATEWAY_URL: string = absolute(
  import.meta.env.VITE_GATEWAY_URL || DEFAULT_GATEWAY_URL,
);

/**
 * Where sign-in goes, when that is not where `/agent/*` goes.
 *
 * The two split because the AI tier is not provisioned: `agent_service`
 * does not run in production, so the agent half only works locally, while
 * a real operator identity — and the real `tenant_id` that scopes every
 * warehouse query — can only be issued by production auth. Pointing
 * VITE_AUTH_URL at the production gateway and leaving VITE_GATEWAY_URL
 * local gets a genuine token against a local agent.
 *
 * Defaults to GATEWAY_URL, so the ordinary all-local and all-deployed
 * cases need no second variable. Note the token is still validated
 * independently by the local gateway AND by agent-service
 * (app/auth/dependency.py), so both must share the issuing secret.
 */
const RAW_AUTH_URL = import.meta.env.VITE_AUTH_URL || GATEWAY_URL;

/**
 * Absolute, always. A relative value is legitimate — pointing at the dev
 * server's own proxy path is how sign-in reaches a remote gateway without
 * a preflight — but `new Request()` needs an origin, so a bare "/path"
 * throws outside a browser context (jsdom under Vitest, most obviously).
 * Resolving here keeps that detail out of every call site.
 */
export const AUTH_URL: string = absolute(RAW_AUTH_URL);

/**
 * bolt-v2's own auth-service GraphQL endpoint — where `AuthContext.
 * signInWithPassword` posts `EmailOrMobileBasedOrganisations`/
 * `PasswordLogin` directly, from the browser, rather than through
 * anything this console's own backend proxies.
 *
 * A THIRD, independent URL rather than a third fallback onto `AUTH_URL`:
 * `AUTH_URL` is POS's own gateway (`SIGN_IN_MUTATION`'s `login`), a
 * different service with a different schema — bolt-v2's `PasswordLogin`/
 * `EmailOrMobileBasedOrganisations` live only here, verified live against
 * both `be-dev.track360.net.in` and `be-prod.track360.net.in` returning
 * bolt-v2's own resolver errors verbatim ("user not found"). Defaults to
 * the dev backend: this console is developed and tested locally, and a
 * bare default pointed at prod would make "hit real production auth" the
 * silent, un-opted-into behaviour of every `npm run dev` — a real deploy
 * sets VITE_BOLTV2_AUTH_URL explicitly (see .env.example).
 *
 * No `absolute()` here: unlike `AUTH_URL`/`GATEWAY_URL`, this is never a
 * same-origin dev-proxy path — bolt-v2's auth-service is a distinct,
 * cross-origin host either way, so a relative value would only ever be a
 * misconfiguration, not a legitimate local-proxy setup worth resolving.
 */
export const BOLTV2_AUTH_URL: string =
  import.meta.env.VITE_BOLTV2_AUTH_URL || "https://be-dev.track360.net.in/graphql";
