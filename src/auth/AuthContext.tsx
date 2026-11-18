import { whitelightLogin } from "./whitelight.ts";
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { GATEWAY_URL } from "../api/config.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { connectWithBolt } from "./boltConnect.ts";
import {
  findOrganisations,
  logoutDevice,
  otpLogin,
  passwordLogin,
  sendMobileCode,
  type ActiveDevice,
  type BoltV2Organisation,
  type LoginResult,
} from "./boltv2.ts";
import { getFreshCredential } from "./credential.ts";
import { platformUniqueId } from "./device.ts";
import { tokenExpiresAt } from "./jwt.ts";
import {
  getSession,
  setOrganisation,
  setSession,
  subscribeSession,
  type Session,
} from "./session.ts";

/**
 * One organisation the caller may act as, as agent-service reports it
 * (`GET /agent/organisations`) — the top-bar picker's rows.
 */
export interface ActingOrganisation {
  id: string;
  name: string;
  parentId: string | null;
  /** True for the organisation this session is currently acting as. */
  current: boolean;
  /** Root → leaf, built from `parentId`, so siblings are distinguishable. */
  path: string;
}

interface OrganisationRow {
  id: string;
  name: string;
  parent_id: string | null;
  current: boolean;
}

export type { ActiveDevice, BoltV2Organisation };

/**
 * How a sign-in attempt ended when it did not throw: signed in, or stopped
 * at bolt-v2's device limit with the devices to choose from. The pre-auth
 * token is what `signOutDevice` spends; it is null when bolt-v2 sent none
 * (its code sign-in does not), and then only a password sign-in can make
 * room.
 */
export type SignInOutcome =
  | { kind: "signed-in" }
  | { kind: "device-limit"; devices: ActiveDevice[]; preAuthToken: string | null };

export interface AuthContextValue {
  session: Session | null;
  /**
   * Step one of signing in with a Bolt account: the organisations this email
   * or mobile number can sign in to. Throws `GatewayError` with a sentence
   * for the screen when bolt-v2 knows no such account.
   */
  findAccount: (identifier: string) => Promise<BoltV2Organisation[]>;
  /** Email or mobile number, and password, into one organisation. */
  signInWithPassword: (input: {
    identifier: string;
    password: string;
    organisation: BoltV2Organisation;
  }) => Promise<SignInOutcome>;
  /** Texts a six-digit code for `signInWithCode`. Mobile numbers only —
   * bolt-v2 has no emailed code. */
  sendCode: (input: { mobileNumber: string; organisation: BoltV2Organisation }) => Promise<void>;
  signInWithCode: (input: {
    mobileNumber: string;
    code: string;
    organisation: BoltV2Organisation;
  }) => Promise<SignInOutcome>;
  /** Ends one of the account's other sessions to get under bolt-v2's
   * device limit. The caller then signs in again. */
  signOutDevice: (deviceId: string, preAuthToken: string) => Promise<void>;
  /**
   * "Continue with Bolt": borrows the sign-in of the Bolt web app in this
   * browser (`./boltConnect.ts`). Must be called from a click. Throws
   * `GatewayError` when the popup is blocked, closed or declined.
   */
  signInWithBolt: (signal?: AbortSignal) => Promise<void>;
  /**
   * Start a session from an API key — for a service account, not a person.
   * Throws `GatewayError` carrying operator-facing text on failure.
   */
  signInWithApiKey: (apiKey: string) => Promise<void>;
  /** A Whitelight (WFM) username and password, relayed by Bolty to WFM's own login. */
  signInWithWhitelight: (input: { username: string; password: string }) => Promise<void>;
  /**
   * Every organisation this session may act as — the top-bar picker's
   * source. Returns `[]` when there is no session. Throws `GatewayError`.
   */
  loadActingOrganisations: () => Promise<ActingOrganisation[]>;
  /**
   * Switches the organisation every subsequent `/agent/*` call acts as, by
   * changing the `Organisation` header. Purely local: agent-service
   * re-validates the header on every request and refuses anything outside
   * the caller's own subtree, so choosing wrongly fails closed.
   */
  actAsOrganisation: (organisationId: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * A "Root › Child › Leaf" label, walking parents. `seen` guards against a
 * cycle in data from another service; a parent outside the caller's subtree
 * simply stops the walk.
 */
function pathOf(id: string, byId: Map<string, OrganisationRow>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parent_id === null ? undefined : byId.get(current.parent_id);
  }
  return names.join(" › ");
}

interface Principal {
  user_id: string;
  username: string;
  email: string;
  tenant_id: string;
  permissions?: { name: string; can_read: boolean }[];
}

/**
 * Ask agent-service who a credential belongs to, before the console accepts
 * it.
 *
 * Deliberately not trusted from the sign-in answer or decoded locally: only
 * agent-service can say whether it will accept the credential, and a 200
 * from `/agent/me` proves it will before anyone is navigated into a console
 * that would otherwise 401 on every call.
 *
 * A plain `fetch`, not `gatewayClient`: that client signs requests with the
 * STORED credential and ends the session on a 401. The credential under test
 * is neither stored yet nor related to any current session, so a rejection
 * here must be reported, never acted on.
 */
async function whoIs(credential: string, kind: Session["kind"]): Promise<Principal> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_URL}/agent/me`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
  } catch {
    throw new GatewayError("Couldn't reach Bolty's server. Check your connection and try again.", {
      retryable: true,
    });
  }

  if (response.status === 401) {
    // agent-service answers every auth failure with one status and one body,
    // on purpose (app/auth/dependency.py). Its log names the exact reason.
    throw new GatewayError(
      kind === "apiKey"
        ? "Bolty's server rejected this key. It may be mistyped or revoked — its log names the exact reason."
        : "Bolt signed you in, but Bolty's server couldn't confirm the session. Try again in a moment; if it keeps happening, your account may not be set up for Bolty yet.",
    );
  }
  if (!response.ok) {
    throw new GatewayError(`Bolty's server is having trouble right now (${response.status}). Try again in a moment.`, {
      status: response.status,
      retryable: true,
    });
  }
  return (await response.json()) as Principal;
}

function readable(principal: Principal): string[] {
  // Only the names the caller can READ — the question every reader asks
  // ("should I bother fetching this?"), narrowed once here.
  return (principal.permissions ?? []).filter((p) => p.can_read).map((p) => p.name);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSession);

  /** A bolt-v2 token → a verified user session. */
  const startUserSession = useCallback(
    async (input: {
      token: string;
      refreshToken: string | null;
      organisation: BoltV2Organisation | null;
      via: NonNullable<Session["via"]>;
    }) => {
      const principal = await whoIs(input.token, "user");
      setSession({
        kind: "user",
        credential: input.token,
        refreshToken: input.refreshToken,
        expiresAt: tokenExpiresAt(input.token),
        via: input.via,
        user: {
          id: principal.user_id,
          email: principal.email,
          name: principal.username || principal.email,
        },
        organisationId: principal.tenant_id,
        signedInOrganisation:
          input.organisation !== null && input.organisation.id === principal.tenant_id
            ? input.organisation
            : undefined,
        permissions: readable(principal),
      });
    },
    [],
  );

  const settle = useCallback(
    async (
      result: LoginResult,
      organisation: BoltV2Organisation,
      via: "password" | "code",
    ): Promise<SignInOutcome> => {
      if (result.kind === "device-limit") return result;
      await startUserSession({
        token: result.token,
        refreshToken: result.refreshToken,
        organisation,
        via,
      });
      return { kind: "signed-in" };
    },
    [startUserSession],
  );

  const findAccount = useCallback(async (identifier: string) => {
    const trimmed = identifier.trim();
    if (trimmed === "") throw new GatewayError("Enter your email or mobile number first.");
    // bolt-v2 matches email exactly and stores it lower-case, so "A@b.com"
    // must be sent as "a@b.com" or it is "not found" — its own app does the
    // same.
    const value = trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
    return findOrganisations(value);
  }, []);

  const signInWithPassword = useCallback<AuthContextValue["signInWithPassword"]>(
    async ({ identifier, password, organisation }) => {
      if (password === "") throw new GatewayError("Enter your password.");
      const trimmed = identifier.trim();
      // `PasswordLogin`'s `email` argument also matches a mobile number, so
      // one call covers both.
      const result = await passwordLogin({
        email: trimmed.includes("@") ? trimmed.toLowerCase() : trimmed,
        password,
        organisationId: organisation.id,
      });
      return settle(result, organisation, "password");
    },
    [settle],
  );

  const sendCode = useCallback<AuthContextValue["sendCode"]>(async ({ mobileNumber, organisation }) => {
    await sendMobileCode({ mobileNumber, organisationId: organisation.id });
  }, []);

  const signInWithCode = useCallback<AuthContextValue["signInWithCode"]>(
    async ({ mobileNumber, code, organisation }) => {
      const otp = code.replace(/\D/g, "");
      if (otp.length !== 6) throw new GatewayError("Enter all six digits of the code.");
      const result = await otpLogin({ mobileNumber, otp, organisationId: organisation.id });
      return settle(result, organisation, "code");
    },
    [settle],
  );

  const signOutDevice = useCallback(async (deviceId: string, preAuthToken: string) => {
    await logoutDevice(deviceId, preAuthToken);
  }, []);

  const signInWithBolt = useCallback(
    async (signal?: AbortSignal) => {
      const { token } = await connectWithBolt(signal);
      await startUserSession({ token, refreshToken: null, organisation: null, via: "bolt" });
    },
    [startUserSession],
  );

  const signInWithWhitelight = useCallback(
    async (input: { username: string; password: string }) => {
      const tokens = await whitelightLogin(input.username.trim(), input.password);
      await startUserSession({
        token: tokens.token,
        refreshToken: tokens.refreshToken || null,
        organisation: null,
        via: "whitelight",
      });
    },
    [startUserSession],
  );

  const signInWithApiKey = useCallback(async (rawKey: string) => {
    // Tolerate a paste that brought "Bearer " along from a devtools header
    // view, or stray whitespace from a terminal.
    const apiKey = rawKey.trim().replace(/^Bearer\s+/i, "");
    if (apiKey === "") throw new GatewayError("Paste an API key first.");

    const principal = await whoIs(apiKey, "apiKey");
    setSession({
      kind: "apiKey",
      credential: apiKey,
      // The key's label, not a person's name — a key has nobody behind it,
      // and the top bar showing "bolt-v2 production" is honest where a
      // fabricated name would not be.
      user: { id: principal.user_id, email: principal.email, name: principal.username },
      organisationId: principal.tenant_id,
      permissions: readable(principal),
    });
  }, []);

  const loadActingOrganisations = useCallback(async (): Promise<ActingOrganisation[]> => {
    const credential = await getFreshCredential();
    if (credential === null) return [];

    let response: Response;
    try {
      // No `Organisation` header, deliberately: agent-service scopes the list
      // to the ACTING organisation's subtree, and sending the current choice
      // would leave no way back up to the organisation signed in to.
      response = await fetch(`${GATEWAY_URL}/agent/organisations`, {
        headers: { Authorization: `Bearer ${credential}` },
      });
    } catch {
      throw new GatewayError("Couldn't reach Bolty's server.");
    }
    if (!response.ok) {
      throw new GatewayError(`Bolty's server returned ${response.status}.`);
    }

    const rows = (await response.json()) as OrganisationRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parent_id,
        current: row.current,
        path: pathOf(row.id, byId),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, []);

  const actAsOrganisation = useCallback((organisationId: string) => {
    setOrganisation(organisationId);
  }, []);

  const signOut = useCallback(() => {
    const current = getSession();
    // A signed-in user's bolt-v2 session is ended on the server too, so it
    // stops counting against the account's device limit and its refresh
    // token is dead. Best effort: leaving must never wait on, or fail
    // because of, a network call. Not for "Continue with Bolt" — that token
    // is the Bolt tab's own session, and ending it would sign that tab out.
    // Nothing to revoke for an API key: it outlives a browser tab by design
    // (revoking one is `scripts/issue_api_key.py revoke`).
    if (current?.kind === "user" && current.via !== "bolt") {
      void logoutDevice(platformUniqueId(), current.credential).catch(() => {});
    }
    setSession(null);
  }, []);

  const value: AuthContextValue = {
    session,
    findAccount,
    signInWithPassword,
    sendCode,
    signInWithCode,
    signOutDevice,
    signInWithBolt,
    signInWithWhitelight,
    signInWithApiKey,
    loadActingOrganisations,
    actAsOrganisation,
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
