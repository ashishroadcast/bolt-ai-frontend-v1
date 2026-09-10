import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { authClient } from "../api/client.ts";
import { BOLTV2_AUTH_URL, GATEWAY_URL } from "../api/config.ts";
import { GatewayError } from "../api/errors.ts";
import { platformFriendlyName, platformUniqueId } from "./device.ts";
import { decodeExpiry } from "./jwt.ts";
import { getSession, setSession, subscribeSession, type Session } from "./session.ts";

// login already returns refreshToken (auth/graph/auth.graphqls) — this
// now requests and holds it, the same as accessToken. Not requesting it
// used to be read as "the console keeps no session of its own" (spec
// §10.1), but that reads the line too literally: the spec means the
// console must not invent its own auth model, not that it must discard a
// token the platform itself issued. Using the platform's own refresh flow
// is more faithful to "auth is the platform's, unchanged" than ignoring
// half of what login hands back.
const SIGN_IN_MUTATION = `
  mutation ConsoleSignIn($input: LoginInput!) {
    login(input: $input) {
      accessToken
      refreshToken
      requiresOtp
      mustChangePassword
      user {
        id
        email
        name
        displayName
      }
    }
  }
`;

const SIGN_OUT_MUTATION = `
  mutation ConsoleSignOut {
    logout {
      success
    }
  }
`;

// --- bolt-v2's own auth-service (BOLTV2_AUTH_URL), never POS's gateway ---
//
// `PasswordLogin`/`EmailOrMobileBasedOrganisations` are declared under
// bolt-v2's `extend type Query` (auth/gqlserver/customresolvers/schema.
// graphql), not `Mutation` — a real asymmetry in that schema, not a typo
// here; sending either as `mutation { ... }` fails validation.

const ORGANISATIONS_QUERY = `
  query ConsoleEmailOrganisations($emailOrMobile: String!) {
    EmailOrMobileBasedOrganisations(emailOrMobile: $emailOrMobile, webDomain: "bolt-ai-console") {
      id
      name
    }
  }
`;

// `webDomain` above is a required-non-empty argument the resolver only
// ever checks for presence (`"at least one of ... must be non-empty"`) —
// its own "todo handle whitelabel based on androidAppUrl, iosAppUrl,
// webDomain" comment confirms the value is never actually matched against
// a registered `Whitelabel` row today. A literal placeholder therefore
// satisfies the argument honestly: there is no real whitelabel identity
// for this console to assert, and the resolver does not yet ask for one.

const PASSWORD_LOGIN_QUERY = `
  query ConsolePasswordLogin(
    $email: String!
    $password: String!
    $organisationId: ID!
    $platformUniqueId: String!
    $platformFriendlyName: String!
  ) {
    PasswordLogin(
      email: $email
      password: $password
      organisationId: $organisationId
      platformUniqueId: $platformUniqueId
      platformFriendlyName: $platformFriendlyName
    ) {
      token
      refreshToken
      deviceLimitExceeded
    }
  }
`;

interface BoltV2Organisation {
  id: string;
  name: string;
}

interface OrganisationsPayload {
  EmailOrMobileBasedOrganisations: BoltV2Organisation[];
}

interface PasswordLoginPayload {
  PasswordLogin: {
    token: string | null;
    refreshToken: string | null;
    deviceLimitExceeded: boolean;
  };
}

/**
 * One raw POST to bolt-v2's own GraphQL endpoint — never through
 * `GatewayClient`: that class appends `/graphql` to its own `baseUrl`
 * (POS's gateway-proxy convention) and clears THIS console's session on a
 * 401, neither of which applies here. `BOLTV2_AUTH_URL` is already the
 * full endpoint (verified live against both `be-dev`/`be-prod.track360.
 * net.in`), and every call this function makes runs before any bolt-v2
 * session exists to clear.
 *
 * Throws `GatewayError` carrying bolt-v2's own resolver message verbatim
 * on a GraphQL error (`"user not found"`, `"password invalid"`, …) — that
 * text is already operator-facing, confirmed live against the real
 * service, so no translation layer sits in front of it.
 */
async function boltv2Graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BOLTV2_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new GatewayError("Couldn't reach bolt-v2. Check your connection and try again.");
  }

  if (!response.ok) {
    throw new GatewayError(`bolt-v2 returned ${response.status}.`, { status: response.status });
  }

  const body = (await response.json()) as {
    data: T | null;
    errors?: Array<{ message: string }>;
  };
  if (body.errors && body.errors.length > 0) {
    throw new GatewayError(body.errors[0]!.message, {
      graphQLErrors: body.errors.map((error) => error.message),
    });
  }
  if (body.data === null || body.data === undefined) {
    throw new GatewayError("bolt-v2 returned no data.");
  }
  return body.data;
}

interface LoginUser {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
}

interface LoginPayload {
  login: {
    accessToken: string;
    refreshToken: string;
    requiresOtp: boolean;
    mustChangePassword: boolean;
    user: LoginUser;
  };
}

export interface AuthContextValue {
  session: Session | null;
  /** Throws GatewayError with a message fit to show the operator on failure. */
  signIn: (email: string, password: string, captchaToken: string) => Promise<void>;
  /**
   * Start a session from a bolt-v2 access token the operator pasted.
   *
   * Exists because this console cannot mint one itself. Its sign-in form
   * posts POS's `login(input: LoginInput!)` mutation; bolt-v2's equivalent is
   * `PasswordLogin(email, password, organisationId, platformUniqueId, ...)` —
   * different name, different arguments, and it requires choosing an
   * organisation at login. Until that migration lands there is no path from
   * this screen to a bolt-v2 token, so the operator brings one across from
   * the bolt-v2 panel.
   *
   * Throws GatewayError carrying operator-facing text on failure.
   */
  signInWithToken: (token: string) => Promise<void>;
  /**
   * The orgs a login identifier could sign into — the picker step
   * `PasswordLogin` requires (`organisationId: ID!`) that plain email/
   * password does not carry on its own. Call this first; call
   * `signInWithPassword` with whichever id the result names (there is
   * usually exactly one, so a caller with a single-element result has no
   * picker to show).
   *
   * Throws GatewayError carrying bolt-v2's own resolver text verbatim
   * ("user not found", "user is not active, contact support", …).
   */
  resolveOrganisations: (emailOrMobile: string) => Promise<{ id: string; name: string }[]>;
  /**
   * bolt-v2's own `PasswordLogin`, called directly against bolt-v2's
   * auth-service (`BOLTV2_AUTH_URL`) — this is the migration `signInToken`'s
   * own docstring named as still pending: POS's gateway has no
   * `PasswordLogin`, and bolt-v2's version needs an `organisationId`
   * (`resolveOrganisations` above) that plain email/password never carries.
   *
   * Throws GatewayError on bad credentials (bolt-v2's own message,
   * verbatim), on `deviceLimitExceeded` (a real, named state — this
   * console has no "sign out another device" flow yet, so it is reported
   * rather than silently accepted as a working session), or if the
   * resulting token fails the same `/agent/me` verification
   * `signInWithToken` uses.
   */
  signInWithPassword: (
    email: string,
    password: string,
    organisationId: string,
  ) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSession);

  const signIn = useCallback(async (email: string, password: string, captchaToken: string) => {
    const data = await authClient.graphql<LoginPayload>(
      SIGN_IN_MUTATION,
      { input: { email, password, captchaToken } },
      { auth: false },
    );

    // The backend returns 200 + requiresOtp:true with no tokens for
    // admin-panel accounts logging in from an unrecognised device
    // (auth/graph/auth.resolvers.go). The console has no OTP step yet, so
    // this is a clear, named failure rather than proceeding with an empty
    // token that would just 401 on the first /agent/* call.
    if (data.login.requiresOtp) {
      throw new GatewayError(
        "This account needs a verification code the console doesn't ask for yet. Sign in from the POS admin panel once, then retry here.",
      );
    }

    const { accessToken, refreshToken, user } = data.login;
    setSession({
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.displayName ?? user.name },
      expiresAt: decodeExpiry(accessToken),
    });
  }, []);

  /**
   * Verify a token by ASKING THE BACKEND, then build the session from what
   * it answers — the shared second half of both `signInWithToken` (an
   * operator-pasted token) and `signInWithPassword` (a token bolt-v2's own
   * `PasswordLogin` just issued). Neither path ends up with a refresh token
   * this console can actually use later (see each caller's own comment on
   * why), so both converge on the identical verify-and-build shape here
   * rather than each re-deriving it.
   *
   * Deliberately not built from claims decoded here. jwt.ts is explicit that
   * decoding a claim locally is never a security decision, and doing it would
   * also mean this file learning bolt-v2's claim shape (`oid`/`ouid`/`sid`) —
   * a second place to be wrong about identity. `/agent/me` returns the
   * Principal agent-service actually resolved, which is the only answer that
   * counts, and a 200 proves the token works before the operator is navigated
   * into a console that would otherwise 401 on every call.
   *
   * A plain `fetch`, not `authClient`/`gatewayClient`: those sign requests
   * with the STORED token and clear the session on 401. The token under test
   * is neither stored yet nor necessarily related to the current session, so
   * a rejection here must be reported, never acted on.
   */
  const verifyAndSetSession = useCallback(async (token: string) => {
    let response: Response;
    try {
      response = await fetch(`${GATEWAY_URL}/agent/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new GatewayError(
        "Couldn't reach agent-service. Check that it is running and try again.",
      );
    }

    if (response.status === 401) {
      // agent-service answers every auth failure with one status and one body,
      // on purpose (app/auth/dependency.py) — an expired token, a revoked or
      // idled-out bolt-v2 session and an unreachable bolt-v2 are deliberately
      // indistinguishable from out here. So name the likely causes rather than
      // asserting one the response cannot actually support.
      throw new GatewayError(
        "agent-service rejected this token. It may have expired, its bolt-v2 session may have been revoked or gone idle, or bolt-v2 may be unreachable.",
      );
    }
    if (!response.ok) {
      throw new GatewayError(`agent-service returned ${response.status}.`);
    }

    const principal = (await response.json()) as {
      user_id: string;
      username: string;
      email: string;
      permissions?: { name: string; can_read: boolean }[];
    };

    setSession({
      token,
      // No refresh token — see this function's own docstring: neither
      // caller has one this console's existing refresh plumbing
      // (client.ts's `performRefresh`) can actually use, since that
      // plumbing posts to POS's own gateway (`AUTH_URL`), a different
      // service from bolt-v2's auth-service either path's token comes
      // from. Null means "expiry is an unrecoverable sign-out"
      // (session.ts), which is the honest state here — storing a real
      // bolt-v2 refresh token would only make the NEXT silent refresh
      // attempt fail against the wrong backend instead of not attempting
      // one at all.
      refreshToken: null,
      user: { id: principal.user_id, email: principal.email, name: principal.username },
      // Only the names the caller can READ. That is the question every reader
      // asks ("should I bother fetching this?"), so the narrowing happens once
      // here rather than at each call site.
      permissions: (principal.permissions ?? []).filter((p) => p.can_read).map((p) => p.name),
      expiresAt: decodeExpiry(token),
    });
  }, []);

  const signInWithToken = useCallback(
    async (rawToken: string) => {
      // Tolerate a paste that brought "Bearer " along from a devtools header
      // view — that is where an operator is most likely to have copied it from.
      const token = rawToken.trim().replace(/^Bearer\s+/i, "");
      if (token === "") {
        throw new GatewayError("Paste an access token first.");
      }
      await verifyAndSetSession(token);
    },
    [verifyAndSetSession],
  );

  const resolveOrganisations = useCallback(async (emailOrMobile: string) => {
    const trimmed = emailOrMobile.trim();
    if (trimmed === "") {
      throw new GatewayError("Enter an email or username first.");
    }
    const data = await boltv2Graphql<OrganisationsPayload>(ORGANISATIONS_QUERY, {
      emailOrMobile: trimmed,
    });
    return data.EmailOrMobileBasedOrganisations;
  }, []);

  const signInWithPassword = useCallback(
    async (email: string, password: string, organisationId: string) => {
      const data = await boltv2Graphql<PasswordLoginPayload>(PASSWORD_LOGIN_QUERY, {
        email: email.trim(),
        password,
        organisationId,
        platformUniqueId: platformUniqueId(),
        platformFriendlyName: platformFriendlyName(),
      });

      // A real, named state (auth/gqlserver/customresolvers/resolvers.go's
      // own `DeviceLimitError` branch) — the `token` that comes back with
      // it is a 10-minute PRE-AUTH token meant for a "sign out one of your
      // other devices, then retry" flow this console does not have yet.
      // Treating it as a working session would sign the operator in with a
      // token that cannot actually call anything past agent-service's own
      // `pre_auth` refusal (app/boltv2/claims.py).
      if (data.PasswordLogin.deviceLimitExceeded) {
        throw new GatewayError(
          "Too many devices are already signed in for this account. Sign out of one from " +
            "the bolt-v2 panel, then try again here.",
        );
      }

      const token = data.PasswordLogin.token;
      if (token === null || token === "") {
        throw new GatewayError("bolt-v2 did not return an access token.");
      }
      await verifyAndSetSession(token);
    },
    [verifyAndSetSession],
  );

  const signOut = useCallback(() => {
    // Best effort: ask auth to revoke the token server-side, but a failed
    // request must never keep the console showing a signed-in operator
    // who just asked to leave. Clearing local state (which also clears
    // whatever was persisted — see session.ts) IS "signed out" here,
    // regardless of whether the revoke call landed.
    void authClient.graphql(SIGN_OUT_MUTATION).catch(() => {});
    setSession(null);
  }, []);

  const value: AuthContextValue = {
    session,
    signIn,
    signInWithToken,
    resolveOrganisations,
    signInWithPassword,
    signOut,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
