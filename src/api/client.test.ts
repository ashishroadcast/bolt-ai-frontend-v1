import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSession, setSession } from "../auth/session.ts";
import { gatewayClient } from "./client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const user = { id: "1", email: "a@b.com", name: "A" };

// Exercises the real production wiring (client.ts's exported
// `gatewayClient`, not a bare GatewayClient instance) end to end, so a
// mistake in the refresh mutation's name, its Authorization header, or
// the response shape it expects would fail here even though
// gatewayClient.test.ts's unit tests (which inject their own fake
// `refresh`) can't catch it.
describe("client.ts refresh wiring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("refreshes via the refreshToken mutation using Authorization, then retries and succeeds", async () => {
    // expiresAt: null keeps getFreshToken's proactive check from firing,
    // so this exercises the *reactive* path — the server rejecting a
    // token the client didn't think was stale (clock skew, a revoke) —
    // rather than the proactive one covered by the test below.
    setSession({ token: "expired", refreshToken: "refresh-1", user, expiresAt: null });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ data: { refreshToken: { accessToken: "fresh", refreshToken: "refresh-2" } } }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await gatewayClient.agentFetch<{ ok: boolean }>("/agent/me");

    expect(result).toEqual({ ok: true });
    expect(getSession()).toEqual({
      token: "fresh",
      refreshToken: "refresh-2",
      user,
      expiresAt: null,
    });

    const refreshRequest = fetchMock.mock.calls[1]![0] as Request;
    expect(refreshRequest.url).toBe("http://localhost:8080/graphql");
    // Authorization, not X-Refresh-Token: the POS gateway's CORS preflight
    // does not allow the custom header, so sending it blocked every refresh
    // in the browser. See client.ts for the full note.
    expect(refreshRequest.headers.get("Authorization")).toBe("Bearer refresh-1");
    expect(refreshRequest.headers.get("X-Refresh-Token")).toBeNull();
    // The bearer is the REFRESH token, never the expired access token — the
    // old assertion here was `has("Authorization") === false`, correct while
    // the refresh authenticated itself with the custom header. `auth: false`
    // is still what keeps GatewayClient from overwriting it, which is the
    // part that would break silently if that option were ever dropped.
    expect(refreshRequest.headers.get("Authorization")).not.toBe("Bearer stale");
    const refreshBody = JSON.parse(await refreshRequest.clone().text()) as { query: string };
    expect(refreshBody.query).toContain("refreshToken");

    const retryRequest = fetchMock.mock.calls[2]![0] as Request;
    expect(retryRequest.headers.get("Authorization")).toBe("Bearer fresh");
  });

  it("proactively refreshes ahead of expiry instead of sending a request known to be stale", async () => {
    // Within the 60s margin, not yet past expiresAt itself.
    setSession({ token: "about-to-expire", refreshToken: "refresh-1", user, expiresAt: Date.now() + 5_000 });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: { refreshToken: { accessToken: "fresh", refreshToken: "refresh-2" } } }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await gatewayClient.agentFetch<{ ok: boolean }>("/agent/me");

    expect(result).toEqual({ ok: true });
    // Only two calls total: the refresh, then the one real request — no
    // doomed first attempt with the stale token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]![0] as Request;
    expect(request.headers.get("Authorization")).toBe("Bearer fresh");
  });

  it("does not attempt a refresh when the session has no refresh token (dev token-paste)", async () => {
    setSession({ token: "expired", refreshToken: null, user, expiresAt: null });
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(gatewayClient.agentFetch("/agent/me")).rejects.toThrow();

    // One request (the doomed original) and no refresh mutation attempt —
    // performRefresh bails out immediately with no refreshToken to send.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSession()).toBeNull();
  });
});
