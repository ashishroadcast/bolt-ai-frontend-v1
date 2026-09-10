import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { GATEWAY_URL } from "../api/config.ts";
import { GatewayError } from "../ask/http/errors.ts";
import {
  getSession,
  setOrganisation,
  setSession,
  subscribeSession,
  type Session,
} from "./session.ts";

/**
 * One organisation the caller may act as, as agent-service reports it.
 *
 * Comes from `GET /agent/organisations`, not from bolt-v2. The console used to
 * ask bolt-v2's `myOrganisations` with the signed-in user's own token; it has
 * no bolt-v2 token any more, and agent-service has already resolved the same
 * subtree in order to scope the request, so the question moved to where the
 * answer already was.
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

export interface AuthContextValue {
  session: Session | null;
  /**
   * Start a session from an API key.
   *
   * The console's only sign-in path. It used to have three — bolt-v2 password
   * login, POS's `login` mutation, and pasting a bolt-v2 access token — and
   * all three existed to obtain a bearer token agent-service would verify
   * against a shared JWT secret. agent-service issues and verifies its own
   * keys now (`app.auth.api_keys`), so none of those can produce a working
   * credential and none of them remain.
   *
   * Throws GatewayError carrying operator-facing text on failure.
   */
  signInWithApiKey: (apiKey: string) => Promise<void>;
  /**
   * Every organisation this key may act as — the top-bar picker's source.
   *
   * Returns `[]` when there is no session. Throws GatewayError on failure.
   */
  loadActingOrganisations: () => Promise<ActingOrganisation[]>;
  /**
   * Switches the organisation every subsequent `/agent/*` call acts as, by
   * changing the `Organisation` header the client sends.
   *
   * Purely local, and deliberately so: nothing is re-authenticated and the
   * key is untouched. agent-service re-validates the header against the key's
   * own subtree on every request and refuses anything outside it, so choosing
   * wrongly here fails closed rather than widening anything.
   */
  actAsOrganisation: (organisationId: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * A "Root › Child › Leaf" label, walking parents.
 *
 * `seen` guards against a cycle in the parent chain. That should be impossible
 * in a tree, but this walks data from another service and an infinite loop
 * here would hang the picker rather than show a wrong label. A parent outside
 * the caller's own subtree simply stops the walk, so the label is partial
 * rather than absent — which is the common case for a non-root key, whose
 * subtree does not include its own ancestors.
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSession);

  /**
   * Verify a key by ASKING THE BACKEND, then build the session from what it
   * answers.
   *
   * Deliberately not trusted from the input. A `boltai_`-prefixed string is
   * not a session — only agent-service can say whether the key exists, has
   * been revoked, and which organisation it speaks for. A 200 from
   * `/agent/me` proves the key works before the operator is navigated into a
   * console that would otherwise 401 on every call.
   *
   * A plain `fetch`, not `gatewayClient`: that client signs requests with the
   * STORED credential and clears the session on 401. The key under test is
   * neither stored yet nor related to any current session, so a rejection
   * here must be reported, never acted on.
   */
  const signInWithApiKey = useCallback(async (rawKey: string) => {
    // Tolerate a paste that brought "Bearer " along from a devtools header
    // view, or stray whitespace from a terminal — the two places an operator
    // is most likely to have copied a key from.
    const apiKey = rawKey.trim().replace(/^Bearer\s+/i, "");
    if (apiKey === "") {
      throw new GatewayError("Paste an API key first.");
    }

    let response: Response;
    try {
      response = await fetch(`${GATEWAY_URL}/agent/me`, {
        headers: { "X-Api-Key": apiKey },
      });
    } catch {
      throw new GatewayError(
        "Couldn't reach agent-service. Check that it is running and try again.",
      );
    }

    if (response.status === 401) {
      // agent-service answers every auth failure with one status and one body,
      // on purpose (app/auth/dependency.py) — an unknown key and a revoked one
      // are deliberately indistinguishable from out here. It DOES name the
      // reason in its own log, which is where an operator should look next, so
      // say that rather than guessing between causes the response cannot
      // support.
      throw new GatewayError(
        "agent-service rejected this key. It may be mistyped or revoked — its log names the exact reason.",
      );
    }
    if (!response.ok) {
      throw new GatewayError(`agent-service returned ${response.status}.`);
    }

    const principal = (await response.json()) as {
      user_id: string;
      username: string;
      email: string;
      tenant_id: string;
      permissions?: { name: string; can_read: boolean }[];
    };

    setSession({
      apiKey,
      // The key's label and id, not a person's name — a key has nobody behind
      // it, and the top bar showing "bolt-v2 production" is honest where a
      // fabricated name would not be.
      user: {
        id: principal.user_id,
        email: principal.email,
        name: principal.username,
      },
      // The organisation the key resolved to, so the first request carries the
      // same one `/agent/me` just reported rather than no header at all.
      organisationId: principal.tenant_id,
      // Only the names the caller can READ. That is the question every reader
      // asks ("should I bother fetching this?"), so the narrowing happens once
      // here rather than at each call site.
      permissions: (principal.permissions ?? []).filter((p) => p.can_read).map((p) => p.name),
    });
  }, []);

  const loadActingOrganisations = useCallback(async (): Promise<ActingOrganisation[]> => {
    // Read through the store rather than the `session` closure: the picker can
    // open moments after a sign-out and a stale credential here would spend a
    // round trip getting a 401 back.
    const apiKey = getSession()?.apiKey;
    if (apiKey === undefined || apiKey === "") return [];

    let response: Response;
    try {
      response = await fetch(`${GATEWAY_URL}/agent/organisations`, {
        headers: { "X-Api-Key": apiKey },
      });
    } catch {
      throw new GatewayError("Couldn't reach agent-service.");
    }
    if (!response.ok) {
      throw new GatewayError(`agent-service returned ${response.status}.`);
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
    // Nothing to revoke server-side: a key outlives a browser tab by design,
    // and signing out of this console must never disable a credential other
    // callers may be using. Clearing local state (which also clears whatever
    // was persisted — see session.ts) IS "signed out" here. Revoking a key is
    // a deliberate, separate act (`scripts/issue_api_key.py revoke`).
    setSession(null);
  }, []);

  const value: AuthContextValue = {
    session,
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
