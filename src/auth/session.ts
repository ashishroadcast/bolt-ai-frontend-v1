/**
 * The console's session: one module-level variable, mirrored into
 * `sessionStorage` so it survives a reload. Nothing outside this file may
 * read or write `current` directly — the gateway client and every React
 * component go through the functions below, so there is exactly one place
 * a credential can end up.
 *
 * **What it holds is an API KEY now, not a token.** The distinction matters
 * to this file specifically, because three of its fields existed only to
 * manage a token's lifetime and are gone with it:
 *
 * * `refreshToken` — a key is not refreshed. There is nothing to rotate and
 *   no endpoint to rotate it at; rotation is an operator issuing a second key
 *   and revoking the first.
 * * `expiresAt` — a key does not expire. The whole staleness-and-refresh
 *   machinery in `src/api/client.ts` went with it.
 * * `tokenOrganisationId` — it recorded which organisation a bolt-v2 login
 *   had minted the token against, so a refresh could not silently move the
 *   console elsewhere. No login, no refresh, nothing to guard.
 *
 * sessionStorage, not localStorage — and the reasoning CHANGED with the
 * credential, so it is worth restating rather than inheriting. It used to be
 * a balance: a 15-minute bearer token, capped at the tab's lifetime out of
 * caution. An API key is long-lived and tenant-wide, which makes the same
 * choice a stronger one, not a weaker one: closing the tab should not leave a
 * credential that outlives the session on disk for the next person at the
 * machine. It still survives a reload, which is the thing that was actually
 * breaking. Both stores are equally readable by injected script —
 * persistence was never the XSS mitigation, verification on the server is.
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
  /**
   * The credential every `/agent/*` call carries.
   *
   * Named for what it is. It was `token` while the console held a bolt-v2
   * JWT that agent-service verified against a shared secret; agent-service
   * issues and checks its own keys now, and a field called `token` would
   * keep inviting code that decodes it, checks its expiry, or tries to
   * refresh it — all three of which this credential does not support.
   */
  apiKey: string;
  user: SessionUser;
  /**
   * The organisation the console is ACTING AS — sent as the `Organisation`
   * header on every `/agent/*` call.
   *
   * A hint, never a grant. agent-service re-validates it against the key's
   * own subtree on every request and refuses anything outside it, so a stale
   * or tampered value here fails closed. It exists because a key is issued to
   * the root of a tree and the operator has to be able to say which
   * organisation beneath it they are reading.
   *
   * Optional: absent means "send no header", which agent-service reads as the
   * key's own root organisation.
   */
  organisationId?: string;
  /**
   * What the backend said this caller may do, captured from `/agent/me` at
   * sign-in. Optional: a session restored from a value stored by an older
   * build carries none — so every reader must treat "absent" as "unknown",
   * not as "nothing".
   *
   * Read ONLY to avoid firing requests that are certain to be refused. The
   * Agents screen fans out one `GET /agent/agents/{id}` per agent for its
   * wiring line, and every one of those 403s for a caller without
   * `agent.agents` — five guaranteed-refused requests per page load.
   *
   * NEVER read to decide what a user may do. agent-service re-checks every
   * request against the real principal; this is a hint for avoiding pointless
   * traffic, not a boundary. A stale or forged value here can only make the
   * console ask for less, never get more.
   */
  permissions?: string[];
}

type Listener = () => void;

// Bumped from `.v1`: the stored shape changed name and lost three fields, and
// a v1 value would fail `isSession` on every boot anyway. A new key means an
// operator with an old session lands on sign-in once, rather than on a
// silently-ignored blob that stays in storage forever.
const STORAGE_KEY = "agent-console.session.v2";

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
  // nothing coerces it on the way in, so whatever JSON type the server sent
  // passes straight through. This caught a real bug live — a freshly
  // persisted session (id: 1, a JSON number) failed this check on the very
  // next reload and silently signed the operator back out, exactly the bug
  // the check exists to prevent, reintroduced by validating against the
  // aspirational type instead of the one that actually flows through.
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
  if (typeof candidate.apiKey !== "string" || candidate.apiKey === "") return false;
  // Optional-but-typed: absent is a legitimate session, a present non-string
  // is a corrupt one. Rejecting the second matters more than it looks — a
  // non-string here would be sent verbatim as the `Organisation` header, and
  // agent-service answers a malformed header with a 401 rather than ignoring
  // it, so a bad stored value would lock the tab out of every request.
  if (candidate.organisationId !== undefined && typeof candidate.organisationId !== "string") {
    return false;
  }
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
 * The credential for the next request, or null if there is no session.
 *
 * No staleness check, and now nothing to check: an API key has no expiry, so
 * the proactive-refresh dance this used to be half of is gone. A key that
 * stops working (revoked) surfaces as a 401, which `GatewayClient` turns into
 * a sign-out — the one path that remains.
 */
export function getApiKey(): string | null {
  return current?.apiKey ?? null;
}

/**
 * The organisation to send as the `Organisation` header on the next request,
 * or null when there is no session or none was chosen.
 *
 * Omitting the header entirely already means "the key's own root
 * organisation" to agent-service, so there is no fallback to invent here.
 */
export function getOrganisationId(): string | null {
  return current?.organisationId ?? null;
}

/**
 * Switches the organisation the console acts as, in place.
 *
 * A no-op without a session, so a picker firing during sign-out cannot
 * resurrect one. Nothing else about the session changes — the key is still
 * the same key, and the backend still decides whether this organisation is
 * reachable from it.
 */
export function setOrganisation(organisationId: string): void {
  if (current === null) return;
  setSession({ ...current, organisationId });
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
