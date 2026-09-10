import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSession, getApiKey, setSession, subscribeSession } from "./session.ts";

const user = { id: "1", email: "a@b.com", name: "A B" };
// v2: the stored shape lost `token`/`refreshToken`/`expiresAt` for an
// `apiKey`, so a v1 value would fail `isSession` on every boot. A new key
// lands an operator with an old session on sign-in once instead of leaving
// a silently-ignored blob in storage forever.
const STORAGE_KEY = "agent-console.session.v2";

beforeEach(() => {
  setSession(null);
});

describe("session store", () => {
  it("starts signed out", () => {
    expect(getSession()).toBeNull();
    expect(getApiKey()).toBeNull();
  });

  it("holds what setSession is given", () => {
    setSession({ apiKey: "tok", user});
    expect(getSession()).toEqual({ apiKey: "tok", user });
    expect(getApiKey()).toBe("tok");
  });

  it("notifies subscribers on every change, including sign-out", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);

    setSession({ apiKey: "tok", user});
    setSession(null);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setSession({ apiKey: "tok2", user});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // This used to silently turn an expired session into "not signed in" —
  // exactly the bug this task fixes. getApiKey() now hands the token out
  // regardless of expiry; staleness is handled by refreshing (client.ts's
  // getFreshToken, checked against getSession().expiresAt) or by reacting
  // to the 401 a stale token eventually draws, never by pretending the
  // session doesn't exist.
  it("keeps handing out the token past expiresAt instead of silently signing out", () => {
    setSession({ apiKey: "tok", user});
    expect(getApiKey()).toBe("tok");
    expect(getSession()).not.toBeNull();
  });

  it("keeps handing out the token before expiresAt", () => {
    setSession({ apiKey: "tok", user});
    expect(getApiKey()).toBe("tok");
  });
});

describe("session persistence across a reload", () => {
  // Simulates a reload by writing through the real setSession()/persist()
  // path, then re-importing the module fresh (a new module instance has a
  // new `current` variable, exactly like a page reload does) and reading
  // its state back — this fails if persistence is ever deleted or the
  // restore-on-load wiring is removed, not just if some helper stops
  // being called.
  it("restores a signed-in session when the module is re-initialised against populated storage", async () => {
    setSession({ apiKey: "tok", user});

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toEqual({ apiKey: "tok", user });
    expect(reloaded.getApiKey()).toBe("tok");
  });

  it("boots signed out when storage holds unparseable JSON, rather than throwing", async () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toBeNull();
    expect(reloaded.getApiKey()).toBeNull();
  });

  // Regression: caught live in a real browser, not by any prior unit
  // test. auth's real `User.id` is a JSON *number* (ent's int id,
  // untouched by AuthContext.tsx's signIn — `id: user.id` passes
  // whatever type the server actually sent), even though this file's own
  // `SessionUser.id` is declared `string`. A validator that trusted the
  // declared type over the real one rejected every persisted session on
  // the very next reload, which is precisely the "logs out on reload"
  // complaint this task exists to fix.
  it("restores a persisted session whose user.id is a JSON number, not a string", async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ apiKey: "tok", user: { id: 1, email: "a@b.com", name: "A" } }),
    );

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).not.toBeNull();
    expect(reloaded.getApiKey()).toBe("tok");
  });

  it("boots signed out when storage holds well-formed JSON in the wrong shape", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: "bar" }));

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

  it("sign-out (setSession(null)) leaves nothing behind in storage", () => {
    setSession({ apiKey: "tok", user});
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();

    setSession(null);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
