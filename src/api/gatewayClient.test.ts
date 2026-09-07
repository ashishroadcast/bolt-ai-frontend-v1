import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApiError, GatewayClient } from "./gatewayClient.ts";
import { GatewayError, UnauthorizedError } from "./errors.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GatewayClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let onUnauthorized: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    onUnauthorized = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // This is the load-bearing test for task 2's requirement 2: "the JWT
  // held in memory, sent as Authorization: Bearer on every /agent/* call."
  // It captures the actual Request object handed to fetch() and reads its
  // header, so the test fails if the header is ever dropped, renamed, or
  // only attached conditionally — not just if some helper stops being
  // called.
  it("attaches Authorization: Bearer <token> to every /agent/* request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "the-jwt",
      onUnauthorized,
    });

    await client.agentFetch("/agent/me");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toBe("http://gateway.test/agent/me");
    expect(request.headers.get("Authorization")).toBe("Bearer the-jwt");
  });

  it("does not attach a bearer to an unauthenticated GraphQL call (login)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { ok: true } }));
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "should-not-be-sent",
      onUnauthorized,
    });

    await client.graphql("mutation { login { accessToken } }", undefined, { auth: false });

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.has("Authorization")).toBe(false);
  });

  it("attaches the bearer to an authenticated GraphQL call by default", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { ok: true } }));
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "the-jwt",
      onUnauthorized,
    });

    await client.graphql("mutation { logout { success } }");

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get("Authorization")).toBe("Bearer the-jwt");
  });

  // Requirement 4: "401/403 handling that returns the user to sign-in."
  it("clears the session (via onUnauthorized) and throws on a 401 from /agent/*", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "expired-jwt",
      onUnauthorized,
    });

    await expect(client.agentFetch("/agent/me")).rejects.toThrow(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("clears the session and throws on a 403 from /agent/*", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "jwt-without-permission",
      onUnauthorized,
    });

    await expect(client.agentFetch("/agent/me")).rejects.toThrow(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("calls onUnauthorized without a network round-trip when there is no token", async () => {
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => null,
      onUnauthorized,
    });

    await expect(client.agentFetch("/agent/me")).rejects.toThrow(UnauthorizedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("refuses a path outside /agent/ rather than silently sending it bearer-less", async () => {
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "the-jwt",
      onUnauthorized,
    });

    await expect(client.agentFetch("/graphql")).rejects.toThrow(GatewayError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a GraphQL error's message rather than throwing a generic failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: null, errors: [{ message: "invalid credentials" }] }));
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => null,
      onUnauthorized,
    });

    await expect(
      client.graphql("mutation { login { accessToken } }", undefined, { auth: false }),
    ).rejects.toThrow("invalid credentials");
  });

  it("treats a GraphQL-level 401 (gateway JWT check) the same as a REST 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "expired-jwt",
      onUnauthorized,
    });

    await expect(client.graphql("query { me { id } }")).rejects.toThrow(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  // The gap this closes: agentFetch used to build a generic
  // `GatewayError` on any non-2xx and never look at the response body at
  // all, so the promotion gate's four distinct refusals (app.learning.gate
  // via POST /agent/admin/promote, a 422 carrying
  // `{detail: {reason, regressed_cases}}`) were indistinguishable from the
  // client — this test would have failed against that old behaviour
  // (`error.body` would be `undefined`, `error instanceof AgentApiError`
  // would be `false`).
  it("preserves the parsed JSON error body on a non-2xx from /agent/*", async () => {
    const regression = {
      test_case_id: 7,
      question: "how did sales do",
      baseline_verdict: "pass",
      candidate_verdict: "fail",
      candidate_error: null,
    };
    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: { reason: "1 case(s) regressed: how did sales do", regressed_cases: [regression] } },
        422,
      ),
    );
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "the-jwt",
      onUnauthorized,
    });

    const error = await client.agentFetch("/agent/admin/promote").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentApiError);
    expect(error).toBeInstanceOf(GatewayError);
    const apiError = error as AgentApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.body).toEqual({
      detail: { reason: "1 case(s) regressed: how did sales do", regressed_cases: [regression] },
    });
    const detail = (apiError.body as { detail: { reason: string; regressed_cases: unknown[] } }).detail;
    expect(detail.reason).toBe("1 case(s) regressed: how did sales do");
    expect(detail.regressed_cases).toEqual([regression]);
  });

  it("uses a plain-string detail as the error message, and a generic one for a structured detail", async () => {
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "the-jwt",
      onUnauthorized,
    });

    fetchMock.mockResolvedValue(jsonResponse({ detail: "artifact not found" }, 404));
    const stringDetailError = (await client
      .agentFetch("/agent/artifacts/does-not-exist")
      .catch((e: unknown) => e)) as AgentApiError;
    expect(stringDetailError.message).toBe("artifact not found");

    fetchMock.mockResolvedValue(jsonResponse({ detail: { reason: "no regressions" } }, 422));
    const structuredDetailError = (await client
      .agentFetch("/agent/admin/promote")
      .catch((e: unknown) => e)) as AgentApiError;
    expect(structuredDetailError.message).toBe("Request to /agent/admin/promote failed (422).");
  });

  it("does not throw a second error when the non-2xx body is not JSON at all", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "the-jwt",
      onUnauthorized,
    });

    const error = (await client.agentFetch("/agent/me").catch((e: unknown) => e)) as AgentApiError;
    expect(error).toBeInstanceOf(AgentApiError);
    expect(error.status).toBe(502);
    expect(error.body).toBeUndefined();
    expect(error.message).toBe("Request to /agent/me failed (502).");
  });

  // Task: "an expired access token triggers exactly one refresh and the
  // original request then succeeds." The mocked token supplier hands out
  // a different token on the second call, proving the retry actually
  // re-reads getToken() (picking up whatever `refresh` just put in the
  // session) instead of resending the stale one.
  describe("refresh-and-retry on 401", () => {
    it("refreshes exactly once and retries the original agentFetch, succeeding with the new token", async () => {
      const getToken = vi.fn<() => string | null>().mockReturnValueOnce("expired-jwt").mockReturnValue("fresh-jwt");
      const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = new GatewayClient({ baseUrl: "http://gateway.test", getToken, onUnauthorized, refresh });

      const result = await client.agentFetch<{ ok: boolean }>("/agent/me");

      expect(result).toEqual({ ok: true });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1]![0] as Request).headers.get("Authorization")).toBe("Bearer fresh-jwt");
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("refreshes exactly once and retries a graphql() call the same way", async () => {
      const getToken = vi.fn<() => string | null>().mockReturnValueOnce("expired-jwt").mockReturnValue("fresh-jwt");
      const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
        .mockResolvedValueOnce(jsonResponse({ data: { me: { id: "1" } } }));
      const client = new GatewayClient({ baseUrl: "http://gateway.test", getToken, onUnauthorized, refresh });

      const result = await client.graphql<{ me: { id: string } }>("query { me { id } }");

      expect(result).toEqual({ me: { id: "1" } });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does not refresh at all on a 403 — a valid token lacking permission isn't fixed by a new one", async () => {
      const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
      fetchMock.mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
      const client = new GatewayClient({
        baseUrl: "http://gateway.test",
        getToken: () => "the-jwt",
        onUnauthorized,
        refresh,
      });

      await expect(client.agentFetch("/agent/me")).rejects.toThrow(UnauthorizedError);
      expect(refresh).not.toHaveBeenCalled();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    // Task: "three concurrent 401s produce one refresh call, not three."
    it("collapses three concurrent 401s on the same instance into one refresh call", async () => {
      let refreshResolve!: (value: boolean) => void;
      const refresh = vi.fn<() => Promise<boolean>>(
        () => new Promise<boolean>((resolve) => (refreshResolve = resolve)),
      );
      const getToken = vi.fn<() => string | null>().mockReturnValue("expired-jwt");
      fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
      const client = new GatewayClient({ baseUrl: "http://gateway.test", getToken, onUnauthorized, refresh });

      const calls = [
        client.agentFetch("/agent/one").catch((e: unknown) => e),
        client.agentFetch("/agent/two").catch((e: unknown) => e),
        client.agentFetch("/agent/three").catch((e: unknown) => e),
      ];

      // Let all three requests reach their 401 and call runRefresh()
      // before the refresh itself resolves — this is what proves they
      // shared one in-flight promise instead of each firing their own.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(refresh).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      refreshResolve(true);
      await Promise.all(calls);

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    // Task: "a failed refresh must not loop. Clear the session and route
    // to sign-in once; do not retry the refresh with a token that was
    // just rejected."
    it("gives up after one failed refresh instead of retrying, and still routes to sign-in", async () => {
      const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
      fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
      const client = new GatewayClient({
        baseUrl: "http://gateway.test",
        getToken: () => "expired-jwt",
        onUnauthorized,
        refresh,
      });

      await expect(client.agentFetch("/agent/me")).rejects.toThrow(UnauthorizedError);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      // Only the original request's own 401 and no follow-up retry —
      // proves the failed refresh did not get resent to the server.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
