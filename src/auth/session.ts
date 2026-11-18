/**
 * The console's session: one module-level variable, mirrored into browser
 * storage so it survives a reload. Nothing outside this file may read or
 * write `current` directly — the gateway client and every React component go
 * through the functions below, so there is exactly one place a credential can
 * end up.
 *
 * **Two kinds of credential, one shape.** Most people sign in as themselves,
 * with the same bolt-v2 account they use for Bolt (`kind: "user"`): the
 * credential is bolt-v2's own short-lived JWT, and a refresh token renews it
 * (`./credential.ts`). A service account signs in with an API key this
 * service issued (`kind: "apiKey"`), which never expires and is never
 * refreshed. agent-service tells the two apart by the credential's own shape
 * (`app.auth.dependency`), so both go out as the same `Authorization:
 * Bearer` header and nothing past this file needs to know which it is.
 *
 * **Where each is kept, and why they differ.**
 *
 * * A user session lives in `localStorage`, like bolt-v2's own. It is shared
 *   by every tab, which is what refresh needs: bolt-v2 ROTATES the refresh
 *   token on every use, so two tabs each holding a private copy would take
 *   turns spending a token the other had already retired, and one of them
 *   would be signed out. With one shared copy, a refresh in any tab is seen
 *   by all of them (the `storage` listener below). The token itself lasts
 *   minutes; what persists is the ability to renew it, and signing out ends
 *   that on the server too (`AuthContext.signOut`).
 * * An API key lives in `sessionStorage`: it is long-lived and tenant-wide,
 *   so closing the tab should not leave it on disk for the next person at
 *   the machine.
 *
 * Both are equally readable by injected script — persistence was never the
 * XSS mitigation, verification on the server is.
 *
 * Restoring on boot is defensive by construction: `loadPersisted()` treats a
 * missing value, a `JSON.parse` failure, a wrong-shaped value, and a storage
 * access that throws outright (private browsing, site data blocked) all the
 * same way — fall back to signed out. A corrupt stored value must land the
 * user on sign-in, never crash the app on boot.
 */
export interface SessionUser {
  id: string;
  email: string;
  /** Display name if the account has one, else the internal name. */
  name: string;
}

export type SessionKind = "user" | "apiKey";

export interface Session {
  /** How this session was started — see the file header. */
  kind: SessionKind;
  /**
   * What every `/agent/*` call carries as `Authorization: Bearer`: bolt-v2's
   * access token for a user, the key itself for a service account.
   */
  credential: string;
  /**
   * A user session's bolt-v2 refresh token, spent (and replaced) by
   * `./credential.ts` to renew `credential`. Null or absent when bolt-v2 did
   * not return one, and always absent for an API key — in both cases an
   * expired credential is a sign-out.
   */
  refreshToken?: string | null;
  /**
   * When `credential` expires, epoch milliseconds, read from the token's own
   * `exp` claim. Used ONLY to renew ahead of time; agent-service decides
   * whether a token is valid, never this value.
   */
  expiresAt?: number | null;
  user: SessionUser;
  /**
   * The organisation the console is ACTING AS — sent as the `Organisation`
   * header on every `/agent/*` call.
   *
   * A hint, never a grant. agent-service re-validates it against the
   * credential's own subtree on every request and refuses anything outside
   * it, so a stale or tampered value here fails closed.
   *
   * Optional: absent means "send no header", which agent-service reads as the
   * credential's own organisation.
   */
  organisationId?: string;
  /**
   * How a user signed in. `"bolt"` — handed over by a Bolt tab ("Continue
   * with Bolt") — matters at sign-out: that token is the Bolt tab's own
   * session, so signing out here must not end it in bolt-v2 too.
   */
  via?: "password" | "code" | "bolt" | "whitelight";
  /**
   * The organisation a user signed in to, named, so the top bar can say so
   * before the picker has loaded anything. Absent for an API key.
   */
  signedInOrganisation?: { id: string; name: string };
  /**
   * What the backend said this caller may do, captured from `/agent/me` at
   * sign-in. Optional: every reader must treat "absent" as "unknown", not as
   * "nothing".
   *
   * Read ONLY to avoid firing requests that are certain to be refused. NEVER
   * read to decide what a user may do — agent-service re-checks every
   * request against the real principal.
   */
  permissions?: string[];
}

/** Why the last session ended, when it was not the person's own choice —
 * shown once on the sign-in screen so a sudden return to it is explained. */
export type SignOutReason = "expired" | "rejected";

type Listener = () => void;

// Bumped from `.v2`: the stored shape gained `kind` and renamed `apiKey` to
// `credential`, so a v2 value would fail `isSession` anyway. A new key means an
// operator with an old session lands on sign-in once, rather than on a
// silently-ignored blob that stays in storage forever.
const STORAGE_KEY = "agent-console.session.v3";
const LEGACY_STORAGE_KEY = "agent-console.session.v2";
const REASON_KEY = "agent-console.signed-out-reason";

type StoreName = "localStorage" | "sessionStorage";

function getStorage(name: StoreName): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    // The getter itself can throw (Safari private mode historically, site
    // data blocked by policy) — this is the one place that needs the
    // try/catch, every caller below just gets `null` back.
    return window[name];
  } catch {
    return null;
  }
}

function storeFor(kind: SessionKind): StoreName {
  return kind === "user" ? "localStorage" : "sessionStorage";
}

function isSessionUser(value: unknown): value is SessionUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  // `id` accepts number too: nothing coerces it on the way in, and a
  // validator checking the declared type once signed every operator out on
  // the next reload.
  return (
    (typeof user.id === "string" || typeof user.id === "number") &&
    typeof user.email === "string" &&
    typeof user.name === "string"
  );
}

function optional(value: unknown, type: "string" | "number"): boolean {
  return value === undefined || value === null || typeof value === type;
}

/** Structural check on whatever `JSON.parse` handed back — storage holds
 * plain text an injected script or a stale app version could have written
 * in any shape, so this never trusts the parsed value just because it
 * parsed. */
function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "user" && candidate.kind !== "apiKey") return false;
  if (typeof candidate.credential !== "string" || candidate.credential === "") return false;
  // Optional-but-typed: a present non-string `organisationId` would be sent
  // verbatim as the `Organisation` header, and agent-service answers a
  // malformed header with a 401 — a bad stored value would lock the tab out.
  if (candidate.organisationId !== undefined && typeof candidate.organisationId !== "string") {
    return false;
  }
  if (!optional(candidate.refreshToken, "string") || !optional(candidate.expiresAt, "number")) {
    return false;
  }
  return isSessionUser(candidate.user);
}

function readFrom(name: StoreName): Session | null {
  const storage = getStorage(name);
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

function loadPersisted(): Session | null {
  // This tab's own API-key session first: a tab signed in with a key keeps
  // it even while another tab holds a user session.
  return readFrom("sessionStorage") ?? readFrom("localStorage");
}

/** The user session as another tab last wrote it — `./credential.ts` reads
 * this before spending a refresh token that tab may already have rotated. */
export function readSharedSession(): Session | null {
  return readFrom("localStorage");
}

function persist(session: Session | null): void {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const storage = getStorage(name);
    if (storage === null) continue;
    try {
      storage.removeItem(LEGACY_STORAGE_KEY);
      if (session !== null && storeFor(session.kind) === name) {
        storage.setItem(STORAGE_KEY, JSON.stringify(session));
      } else if (session === null || getStorage(storeFor(session.kind)) !== null) {
        // Signing out clears both; signing in clears the store this session
        // does not belong in, so a key session never leaves a user session
        // behind in the shared store (or the other way round).
        storage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Best effort: a write failure (quota, blocked site data) costs
      // persistence across the next reload, never the live session in this
      // tab — `current` below is still the source of truth for it.
    }
  }
}

let current: Session | null = loadPersisted();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

// Another tab refreshed the token, signed in, or signed out. Only the shared
// store is watched: a `storage` event never fires for sessionStorage across
// tabs, and an API-key session is this tab's alone.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || event.storageArea !== getStorage("localStorage")) return;
    if (current?.kind === "apiKey") return;
    const incoming = readFrom("localStorage");
    if (incoming === null) {
      if (current === null) return;
      current = null;
    } else {
      // The credential is shared; which organisation this tab is reading is
      // not. Switching organisation reloads only the tab that switched, so
      // adopting another tab's choice here would put one organisation's name
      // in this bar over the previous one's data.
      current = { ...incoming, organisationId: current?.organisationId ?? incoming.organisationId };
    }
    notify();
  });
}

export function getSession(): Session | null {
  return current;
}

/**
 * The credential as it stands, or null if there is no session — WITHOUT
 * renewing it. Requests should go through `getFreshCredential`
 * (`./credential.ts`), which renews a user's token ahead of its expiry.
 */
export function getCredential(): string | null {
  return current?.credential ?? null;
}

/**
 * The organisation to send as the `Organisation` header on the next request,
 * or null when there is no session or none was chosen.
 */
export function getOrganisationId(): string | null {
  return current?.organisationId ?? null;
}

/**
 * Switches the organisation the console acts as, in place.
 *
 * A no-op without a session, so a picker firing during sign-out cannot
 * resurrect one.
 */
export function setOrganisation(organisationId: string): void {
  if (current === null) return;
  setSession({ ...current, organisationId });
}

export function setSession(next: Session | null): void {
  current = next;
  persist(next);
  // Signed in again (or out by choice): the old explanation no longer applies.
  clearSignOutReason();
  notify();
}

/**
 * Ends the session because the server refused it rather than because the
 * person asked to leave, and remembers why so the sign-in screen can say so.
 */
export function endSession(reason: SignOutReason): void {
  if (current === null) return;
  const storage = getStorage("sessionStorage");
  try {
    storage?.setItem(REASON_KEY, reason);
  } catch {
    // The explanation is a courtesy; failing to keep it costs nothing else.
  }
  current = null;
  persist(null);
  notify();
}

/**
 * Why the last session ended, if the server ended it. Kept until the next
 * sign-in (or sign-out by choice), so a reload of the sign-in screen still
 * explains itself — and so reading it has no side effect a double render
 * could trip over.
 */
export function peekSignOutReason(): SignOutReason | null {
  try {
    const reason = getStorage("sessionStorage")?.getItem(REASON_KEY) ?? null;
    return reason === "expired" || reason === "rejected" ? reason : null;
  } catch {
    return null;
  }
}

function clearSignOutReason(): void {
  try {
    getStorage("sessionStorage")?.removeItem(REASON_KEY);
  } catch {
    // Nothing to do: an unreadable store has no stale reason in it either.
  }
}

/** Subscribed by React via useSyncExternalStore; returns an unsubscribe function. */
export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
