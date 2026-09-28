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
 * bolt-v2's GraphQL endpoint — where sign-in asks bolt-v2 who someone is
 * (`EmailOrMobileBasedOrganisations`), signs them in (`PasswordLogin`,
 * `OtpLogin`) and renews their token (`RefreshToken`), straight from the
 * browser, exactly as bolt-v2's own web app does (`src/auth/boltv2.ts`).
 *
 * Production by default, deliberately. agent-service verifies a signed-in
 * user's token by asking bolt-v2 (its `BOLTV2_AUTH_URL`), and the deployed
 * one asks production — a token from any other bolt-v2 would be refused on
 * the first request. Point this elsewhere only together with an
 * agent-service that verifies against the same bolt-v2.
 */
export const BOLTV2_GRAPHQL_URL: string =
  import.meta.env.VITE_BOLTV2_GRAPHQL_URL || "https://be-prod.track360.net.in/graphql";

/**
 * bolt-v2's web app, for the two things sign-in hands off to it: "Continue
 * with Bolt" (an account already signed in there) and resetting a forgotten
 * password. Must be the web app that signs in against `BOLTV2_GRAPHQL_URL`.
 */
export const BOLTV2_APP_URL: string = (
  import.meta.env.VITE_BOLTV2_APP_URL || "https://bolt-v2.roadcast.net"
).replace(/\/+$/, "");
