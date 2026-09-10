/**
 * The console's session: one module-level variable, mirrored into
 * `sessionStorage` so it survives a reload. Nothing outside this file may
 * read or write `current` directly — the gateway client and every React
 * component go through the functions below, so there is exactly one place
 * a token can end up.
 *
 * sessionStorage, not localStorage: a reload is what was actually breaking
 * (Saurabh: "keeps on logging out") and sessionStorage fixes that — it
 * survives a reload because it's scoped to the tab, not to a single
 * in-memory variable. localStorage would also survive a browser restart,
 * which is what most consoles do, but this one holds an operator's bearer
 * token for a multi-tenant POS backend, and the codebase's existing
 * posture here is already cautious (memory-only was the previous call,
 * Turnstile gates production sign-in, tokens are independently re-verified
 * by every service). Capping exposure at the tab's lifetime is the more
 * conservative of two defensible choices, and it's the one consistent
 * with that posture. Both options are equally readable by injected
 * script — persistence was never the XSS mitigation, verification on the
 * server is.
 *
 * Restoring on boot is defensive by construction: `loadPersisted()` below
 * treats a missing key, a `JSON.parse` failure, a wrong-shaped value, and
 * a `sessionStorage` access that throws outright (private browsing, site
 * data blocked) all the same way — fall back to signed out. A corrupt
 * stored value must land the user on sign-in, never crash the app on
 * boot.
 */
export interface SessionUser {
  id: string;
  email: string;
  /** Display name if the account has one, else the internal name. */
  name: string;
}

export interface Session {
  token: string;
  /**
   * Optional so every existing call site that builds a Session without
   * knowing a refresh token (test fixtures across the app, the dev
   * token-paste path) keeps compiling. `null`/`undefined` both mean "no
   * refresh available" — a token that expires becomes an unrecoverable
   * sign-out, same as before this file grew a refresh flow.
   */
  refreshToken?: string | null;
  user: SessionUser;
  /**
   * What the backend said this caller may do, captured from `/agent/me` at
   * sign-in. Optional: a session restored from a value stored by an older
   * build, or built by the POS password path, carries none — so every reader
   * must treat "absent" as "unknown", not as "nothing".
   *
   * Read ONLY to avoid firing requests that are certain to be refused. The
   * Agents screen fans out one `GET /agent/agents/{id}` per agent for its
   * wiring line, and every one of those 403s for a caller without
   * `agent.agents` — five guaranteed-refused requests per page load, each
   * paying the full auth cost.
   *
   * NEVER read to decide what a user may do. agent-service re-checks every
   * request against the real principal; this is a hint for avoiding pointless
   * traffic, not a boundary. A stale or forged value here can only make the
   * console ask for less, never get more.
   */
  permissions?: string[];
  /**
   * Decoded `exp` claim in ms epoch, or null if the token carried none.
   * Read only to decide *when to refresh* — see jwt.ts for why decoding a
   * claim locally is never a security decision. The gateway and
   * agent-service each verify the signature themselves; nothing here
   * substitutes for that.
   */
  expiresAt: number | null;
}

type Listener = () => void;

const STORAGE_KEY = "agent-console.session.v1";

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    // The getter itself can throw (Safari private mode historically,
    // site data blocked by policy) — this is the one place that needs
    // the try/catch, every caller below just gets `null` back.
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isSessionUser(value: unknown): value is SessionUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  // `id` accepts number too, not just this interface's declared `string`:
  // auth's `User.id` is an ent int id, and neither the login GraphQL
  // response nor AuthContext.tsx's signIn() ever coerces it — `id: user.id`
  // passes whatever JSON type the server actually sent straight through.
  // This caught a real bug live: a freshly persisted session (id: 1, a
  // JSON number) failed this check on the very next reload and silently
  // signed the operator back out — exactly the bug this task exists to
  // fix, reintroduced by validating against the aspirational type instead
  // of the one that actually flows through the app.
  return (
    (typeof user.id === "string" || typeof user.id === "number") &&
    typeof user.email === "string" &&
    typeof user.name === "string"
  );
}

/** Structural check on whatever `JSON.parse` handed back — storage holds
 * plain text an injected script or a stale app version could have written
 * in any shape, so this never trusts the parsed value just because it
 * parsed. */
function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.token !== "string" || candidate.token === "") return false;
  if (candidate.refreshToken !== undefined && candidate.refreshToken !== null && typeof candidate.refreshToken !== "string") {
    return false;
  }
  if (candidate.expiresAt !== null && typeof candidate.expiresAt !== "number") return false;
  return isSessionUser(candidate.user);
}

function loadPersisted(): Session | null {
  const storage = getStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persist(session: Session | null): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    if (session === null) {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // Best effort: a write failure (quota, blocked site data) costs
    // persistence across the next reload, never the live session in this
    // tab — `current` below is still the source of truth for it.
  }
}

let current: Session | null = loadPersisted();
const listeners = new Set<Listener>();

export function getSession(): Session | null {
  return current;
}

/**
 * The bearer token for the next request, or null if there is no session
 * at all. Deliberately does *not* check `expiresAt` — that used to make
 * an expired session look identical to "never signed in" and silently
 * sign the operator out on the next call. Staleness is now the caller's
 * problem to solve by refreshing (see `src/api/client.ts`'s
 * `getFreshToken`, which checks `expiresAt` before deciding whether to
 * hand this token out or refresh first) or by reacting to a 401
 * (`GatewayClient`'s retry-once-then-give-up). This function just
 * reports what the session currently holds.
 */
export function getToken(): string | null {
  return current?.token ?? null;
}

export function setSession(next: Session | null): void {
  current = next;
  persist(next);
  for (const listener of listeners) listener();
}

/** Subscribed by React via useSyncExternalStore; returns an unsubscribe function. */
export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
