import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSession, getToken, setSession, subscribeSession } from "./session.ts";

const user = { id: "1", email: "a@b.com", name: "A B" };
const STORAGE_KEY = "agent-console.session.v1";

beforeEach(() => {
  setSession(null);
});

describe("session store", () => {
  it("starts signed out", () => {
    expect(getSession()).toBeNull();
    expect(getToken()).toBeNull();
  });

  it("holds what setSession is given", () => {
    setSession({ token: "tok", user, expiresAt: null });
    expect(getSession()).toEqual({ token: "tok", user, expiresAt: null });
    expect(getToken()).toBe("tok");
  });

  it("notifies subscribers on every change, including sign-out", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSession(listener);

    setSession({ token: "tok", user, expiresAt: null });
    setSession(null);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setSession({ token: "tok2", user, expiresAt: null });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // This used to silently turn an expired session into "not signed in" —
  // exactly the bug this task fixes. getToken() now hands the token out
  // regardless of expiry; staleness is handled by refreshing (client.ts's
  // getFreshToken, checked against getSession().expiresAt) or by reacting
  // to the 401 a stale token eventually draws, never by pretending the
  // session doesn't exist.
  it("keeps handing out the token past expiresAt instead of silently signing out", () => {
    setSession({ token: "tok", user, expiresAt: Date.now() - 1000 });
    expect(getToken()).toBe("tok");
    expect(getSession()).not.toBeNull();
  });

  it("keeps handing out the token before expiresAt", () => {
    setSession({ token: "tok", user, expiresAt: Date.now() + 60_000 });
    expect(getToken()).toBe("tok");
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
    setSession({ token: "tok", refreshToken: "refresh-1", user, expiresAt: null });

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toEqual({ token: "tok", refreshToken: "refresh-1", user, expiresAt: null });
    expect(reloaded.getToken()).toBe("tok");
  });

  it("boots signed out when storage holds unparseable JSON, rather than throwing", async () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).toBeNull();
    expect(reloaded.getToken()).toBeNull();
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
      JSON.stringify({ token: "tok", refreshToken: "refresh-1", user: { id: 1, email: "a@b.com", name: "A" }, expiresAt: null }),
    );

    vi.resetModules();
    const reloaded = await import("./session.ts");

    expect(reloaded.getSession()).not.toBeNull();
    expect(reloaded.getToken()).toBe("tok");
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
    setSession({ token: "tok", refreshToken: "refresh-1", user, expiresAt: null });
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();

    setSession(null);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
