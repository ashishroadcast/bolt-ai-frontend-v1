import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  endSession,
  getCredential,
  getSession,
  peekSignOutReason,
  setSession,
  subscribeSession,
  type Session,
} from "./session.ts";

const user = { id: "1", email: "a@b.com", name: "A B" };
// v3: the stored shape gained `kind` and renamed `apiKey` to `credential`, so
// a v2 value would fail `isSession` on every boot. A new key lands an operator
// with an old session on sign-in once instead of leaving a silently-ignored
// blob in storage forever.
const STORAGE_KEY = "agent-console.session.v3";

const keySession: Session = { kind: "apiKey", credential: "boltai_tok", user };
const userSession: Session = {
  kind: "user",
  credential: "jwt-1",
  refreshToken: "refresh-1",
  expiresAt: 1_900_000_000_000,
  via: "password",
  user,
  organisationId: "org-1",
};

beforeEach(() => {
  setSession(null);
});

describe("session store", () => {
  it("starts signed out", () => {
    expect(getSession()).toBeNull();
    expect(getCredential()).toBeNull();
  });

  it("holds what setSession is given", () => {
    setSession(keySession);
    expect(getSession()).toEqual(keySession);
    expect(getCredential()).toBe("boltai_tok");
  });

  it("notifies subscribers on every change, including sign-out", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);

    setSession(keySession);
    setSession(null);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setSession(userSession);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("where each kind of session is kept", () => {
  // A user session is shared by every tab, because bolt-v2 rotates the
  // refresh token and two private copies would retire each other's.
  it("keeps a user session in localStorage, shared by every tab", () => {
    setSession(userSession);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(userSession);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // An API key is long-lived and tenant-wide: closing the tab should not
  // leave it on disk for the next person at the machine.
  it("keeps an API key in sessionStorage, this tab's alone", () => {
    setSession(keySession);
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toEqual(keySession);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("switching kind leaves nothing of the other behind", () => {
    setSession(userSession);
    setSession(keySession);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    setSession(userSession);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("sign-out (setSession(null)) leaves nothing behind in either store", () => {
    setSession(userSession);
    setSession(null);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("another tab changing the shared session", () => {
  function fromAnotherTab(value: Session | null) {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    window.dispatchEvent(
      new StorageEvent("storage", { key: STORAGE_KEY, storageArea: localStorage }),
    );
  }

  it("adopts a token another tab renewed, keeping this tab's organisation", () => {
    setSession({ ...userSession, organisationId: "this-tabs-org" });
    fromAnotherTab({ ...userSession, credential: "jwt-2", refreshToken: "refresh-2", organisationId: "other" });

    expect(getSession()?.credential).toBe("jwt-2");
    expect(getSession()?.refreshToken).toBe("refresh-2");
    // Which organisation this tab reads is its own: only the tab that
    // switched reloads onto the new one's data.
    expect(getSession()?.organisationId).toBe("this-tabs-org");
  });

  it("signs out when another tab signs out", () => {
    setSession(userSession);
    fromAnotherTab(null);
    expect(getSession()).toBeNull();
  });

  it("leaves an API-key tab alone", () => {
    setSession(keySession);
    fromAnotherTab(userSession);
    expect(getSession()).toEqual(keySession);
  });
});

describe("why a session ended", () => {
  it("remembers a server-ended session's reason until the next sign-in", () => {
    setSession(userSession);
    endSession("expired");

    expect(getSession()).toBeNull();
    // Peeking twice sees it twice: no side effect for a double render to trip.
    expect(peekSignOutReason()).toBe("expired");
    expect(peekSignOutReason()).toBe("expired");

    setSession(userSession);
    expect(peekSignOutReason()).toBeNull();
  });

  it("gives no reason for signing out by choice", () => {
    setSession(userSession);
    setSession(null);
    expect(peekSignOutReason()).toBeNull();
  });

  it("does nothing without a session to end", () => {
    endSession("rejected");
    expect(peekSignOutReason()).toBeNull();
  });
});

describe("session persistence across a reload", () => {
  // Simulates a reload by writing through the real setSession()/persist()
  // path, then re-importing the module fresh (a new module instance has a
  // new `current` variable, exactly like a page reload does).
  it("restores a user session from the shared store", async () => {
    setSession(userSession);

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toEqual(userSession);
  });

  it("restores this tab's API key ahead of another tab's user session", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userSession));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(keySession));

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toEqual(keySession);
  });

  it("boots signed out when storage holds unparseable JSON, rather than throwing", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toBeNull();
  });

  // Regression: bolt's real `User.id` can arrive as a JSON number even though
  // `SessionUser.id` is declared `string`; a validator that trusted the
  // declared type signed every operator out on the next reload.
  it("restores a persisted session whose user.id is a JSON number, not a string", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...userSession, user: { id: 1, email: "a@b.com", name: "A" } }),
    );

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getCredential()).toBe("jwt-1");
  });

  it("boots signed out on a v2 value, which has no kind", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: "tok", user }));

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toBeNull();
  });

  it("boots signed out when a typed field has the wrong type", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...userSession, expiresAt: "soon" }));

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toBeNull();
  });

  it("boots signed out when reading storage throws outright", async () => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked site data");
    };
    try {
      vi.resetModules();
      const reloaded = await import("./session.ts");
      expect(reloaded.getSession()).toBeNull();
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  });
});
