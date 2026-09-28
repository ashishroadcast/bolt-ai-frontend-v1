import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreshCredential, onCredentialRefused, refreshCredential } from "./credential.ts";
import { getSession, peekSignOutReason, setSession, type Session } from "./session.ts";

const STORAGE_KEY = "agent-console.session.v3";
const user = { id: "u1", email: "a@b.com", name: "A" };

/** A JWT-shaped string whose payload carries `exp` (seconds). */
function jwt(expSeconds: number, tag = "x"): string {
  const payload = btoa(JSON.stringify({ exp: expSeconds, tag }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig-${tag}`;
}

function userSession(overrides: Partial<Session> = {}): Session {
  return {
    kind: "user",
    credential: "old-token",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 30_000, // inside the one-minute renewal window
    via: "password",
    user,
    organisationId: "org-1",
    ...overrides,
  };
}

function refreshAnswer(token: string, refreshToken = "refresh-2"): Response {
  return new Response(JSON.stringify({ data: { RefreshToken: { token, refreshToken } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("credential renewal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("hands an API key out as it is, with no renewal", async () => {
    setSession({ kind: "apiKey", credential: "boltai_k", user });
    expect(await getFreshCredential()).toBe("boltai_k");
    expect(await refreshCredential()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands a user token out as it is while it has more than a minute left", async () => {
    setSession(userSession({ expiresAt: Date.now() + 10 * 60_000 }));
    expect(await getFreshCredential()).toBe("old-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews a token about to expire before handing it out, and stores the rotated pair", async () => {
    const renewed = jwt(Math.floor(Date.now() / 1000) + 3600, "new");
    fetchMock.mockResolvedValueOnce(refreshAnswer(renewed));
    setSession(userSession());

    expect(await getFreshCredential()).toBe(renewed);

    const session = getSession()!;
    expect(session.refreshToken).toBe("refresh-2");
    expect(session.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
    // The organisation this tab was reading is untouched by a renewal.
    expect(session.organisationId).toBe("org-1");

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(init.body as string).variables).toEqual({ refreshToken: "refresh-1" });
  });

  it("renews once for requests that all find the token expiring at the same moment", async () => {
    fetchMock.mockResolvedValueOnce(refreshAnswer(jwt(Math.floor(Date.now() / 1000) + 3600)));
    setSession(userSession());

    await Promise.all([getFreshCredential(), getFreshCredential(), getFreshCredential()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renews after a 401 even when the token's own expiry says it is fine", async () => {
    const renewed = jwt(Math.floor(Date.now() / 1000) + 3600, "new");
    fetchMock.mockResolvedValueOnce(refreshAnswer(renewed));
    setSession(userSession({ expiresAt: Date.now() + 10 * 60_000 }));

    expect(await refreshCredential()).toBe(true);
    expect(getSession()?.credential).toBe(renewed);
  });

  it("adopts a token another tab already renewed instead of spending the retired refresh token", async () => {
    setSession(userSession());
    // Another tab renewed first; its write is in the shared store, the
    // storage event not yet delivered here.
    const theirs = userSession({
      credential: "their-token",
      refreshToken: "refresh-2",
      expiresAt: Date.now() + 60 * 60_000,
      organisationId: "their-org",
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theirs));

    expect(await getFreshCredential()).toBe("their-token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSession()?.organisationId).toBe("org-1");
  });

  it("signs out, saying why, when bolt-v2 refuses the refresh token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "invalid refresh token" }], data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    setSession(userSession({ expiresAt: Date.now() + 10 * 60_000 }));

    expect(await refreshCredential()).toBe(false);
    expect(getSession()).toBeNull();
    expect(peekSignOutReason()).toBe("expired");
  });

  it("keeps the session when bolt-v2 could not be reached — a dropped connection is not a refusal", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    setSession(userSession());

    expect(await getFreshCredential()).toBe("old-token");
    expect(getSession()).not.toBeNull();
  });

  it("keeps the session while another tab's renewal of the same token is still settling", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ errors: [{ message: "refresh already in progress, please retry" }], data: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    setSession(userSession());

    await getFreshCredential();
    expect(getSession()).not.toBeNull();
  });

  it("cannot renew a session with no refresh token (Continue with Bolt), and says so", async () => {
    setSession(userSession({ refreshToken: null, via: "bolt" }));

    expect(await refreshCredential()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    onCredentialRefused();
    expect(getSession()).toBeNull();
    expect(peekSignOutReason()).toBe("expired");
  });

  it("calls a refused API key rejected, not expired", () => {
    setSession({ kind: "apiKey", credential: "boltai_k", user });
    onCredentialRefused();
    expect(peekSignOutReason()).toBe("rejected");
  });
});
