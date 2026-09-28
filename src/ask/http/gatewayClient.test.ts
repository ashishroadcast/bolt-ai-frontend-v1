import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApiError, GatewayClient } from "./gatewayClient.ts";
import {
  describeHttpError,
  ForbiddenError,
  GatewayError,
  NetworkError,
  parseRetryAfter,
  RateLimitedError,
  UnauthorizedError,
} from "./errors.ts";

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

    const error = await client.agentFetch("/agent/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedError);
    // Not "your session ended": a 401 is also agent-service failing to reach
    // bolt-v2, or a credential mid-refresh, and neither is fixed by signing in.
    expect((error as UnauthorizedError).message).toBe("Couldn't verify your sign-in.");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  // DELIBERATE DEVIATION from Requirement 4's "401/403 ... returns the user to
  // sign-in", for the 403 half only.
  //
  // Under POS a 403 was an anomaly, so bouncing to sign-in was harmless. Under
  // bolt-v2 it is a normal, persistent state: bolt-ai's permission names
  // (`agent.agents`, `agent.chat.use`) are not seeded in bolt-v2's RBAC, so a
  // perfectly valid operator gets 403 on every gated route. Signing them out
  // for it is unrecoverable — sign in, first call 403s, straight back to
  // sign-in — which is exactly what happened the first time this console was
  // pointed at a real bolt-v2 token. A 403 must surface as "not permitted"
  // while the session stays intact — and as its own class, so nothing that
  // reacts to an `UnauthorizedError` can mistake one for the other.
  it("keeps the session on a 403 from /agent/* and throws ForbiddenError instead", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "missing permission agent.chat.use/can_create" }, 403),
    );
    const client = new GatewayClient({
      baseUrl: "http://gateway.test",
      getToken: () => "jwt-without-permission",
      onUnauthorized,
    });

    const error = await client.agentFetch("/agent/me").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
    const forbidden = error as ForbiddenError;
    expect(forbidden.message).toBe(
      "You don't have permission to use the assistant. Ask an admin for access.",
    );
    // The server's wording is for whoever fixes it — kept, not printed.
    expect(forbidden.detail).toBe("missing permission agent.chat.use/can_create");
    expect(forbidden.retryable).toBe(false);
    expect(onUnauthorized).not.toHaveBeenCalled();
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
    expect(structuredDetailError.message).toBe("The assistant couldn't accept that request.");
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
    expect(error.message).toBe("The assistant is temporarily unavailable.");
    expect(error.retryable).toBe(true);
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

      await expect(client.agentFetch("/agent/me")).rejects.toThrow(ForbiddenError);
      expect(refresh).not.toHaveBeenCalled();
      // Nor is the session cleared — see the 403 test above. A new token would
      // not help, but neither would making the operator fetch one.
      expect(onUnauthorized).not.toHaveBeenCalled();
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
      // shared one in-flight promise instead of each firing their own. A
      // macrotask, not a counted run of microtasks: how many awaits sit
      // between a call and its refresh is an implementation detail.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 0));
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

/**
 * Every error's `.message` is shown as it is — the failed-run card, the
 * picker's error bar and the answer form print it with nothing around it —
 * so each of these pins the sentence a reader actually sees, and whether a
 * Retry could help.
 */
describe("GatewayClient error messages", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = new GatewayClient({
    baseUrl: "http://gateway.test",
    getToken: () => "the-jwt",
    onUnauthorized: () => {},
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function failure(response: Response | Error): Promise<GatewayError> {
    if (response instanceof Error) fetchMock.mockRejectedValue(response);
    else fetchMock.mockResolvedValue(response);
    const error = await client.agentFetch("/agent/agents").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }

  it("turns the browser's 'Failed to fetch' into words, keeping the original as the cause", async () => {
    const raw = new TypeError("Failed to fetch");
    const error = await failure(raw);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toBe(
      "Couldn't reach the assistant. It may be restarting; try again in a moment.",
    );
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(raw);
  });

  it("lets a cancellation through untouched, so a stopped run is not reported as a failure", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));

    const error = await client.agentStream("/agent/run", { method: "POST", body: "{}" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("names the wait on a 429, from Retry-After", async () => {
    const error = await failure(
      new Response(null, { status: 429, headers: { "Retry-After": "12" } }),
    );

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.message).toBe("Too many questions at once. Try again in 12 seconds.");
    expect((error as RateLimitedError).retryAfterSeconds).toBe(12);
    expect(error.retryable).toBe(true);
  });

  it("says 'in a minute' on a 429 that gives no Retry-After", async () => {
    const error = await failure(jsonResponse({ detail: "rate limited" }, 429));
    expect(error.message).toBe("Too many questions at once. Try again in a minute.");
  });

  it("points a spent usage limit (402) at an admin, and offers no retry", async () => {
    const error = await failure(jsonResponse({ detail: "credits exhausted" }, 402));
    expect(error.message).toBe("The assistant's usage limit has been reached. Ask an admin.");
    expect(error.retryable).toBe(false);
  });

  it.each([502, 503, 504])("calls a %i temporary, whatever the proxy's page says", async (status) => {
    const error = await failure(new Response("<html>Bad Gateway</html>", { status }));
    expect(error.message).toBe("The assistant is temporarily unavailable.");
    expect(error.retryable).toBe(true);
  });

  it("keeps agent-service's own words on a 5xx that carries them", async () => {
    // A proxy's 502 is an HTML page; one with a JSON `detail` is agent-service
    // explaining itself — the Models screen shows "OpenRouter is unreachable".
    const error = await failure(jsonResponse({ detail: "OpenRouter is unreachable" }, 502));
    expect(error.message).toBe("OpenRouter is unreachable");
    expect(error.retryable).toBe(true);
  });

  it("joins FastAPI's validation messages into one readable line", async () => {
    const error = await failure(
      jsonResponse(
        {
          detail: [
            { loc: ["body", "message"], msg: "Field required", type: "missing" },
            { loc: ["body", "session_id"], msg: "Input should be a valid integer.", type: "int_parsing" },
          ],
        },
        422,
      ),
    );

    expect(error.message).toBe(
      "Field required (message); Input should be a valid integer (session_id).",
    );
    expect(error.retryable).toBe(false);
  });

  it("gives a 500 with no usable detail a sentence, not a status code", async () => {
    const error = await failure(new Response("Internal Server Error", { status: 500 }));
    expect(error.message).toBe("Something went wrong on the assistant's side. Try again in a moment.");
    expect(error.retryable).toBe(true);
  });

  it("says so when a 2xx body is not JSON, instead of leaking a SyntaxError", async () => {
    const error = await failure(new Response("<html>login</html>", { status: 200 }));
    expect(error.message).toBe("The assistant sent a reply this screen couldn't read.");
  });

  it("uses the same words on the streaming path", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const error = await client.agentStream("/agent/run", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    expect((error as GatewayError).message).toBe("The assistant is temporarily unavailable.");
  });

  it("treats a gateway 403 on graphql as a ForbiddenError too", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    await expect(client.graphql("query { me { id } }")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("parseRetryAfter", () => {
  it("reads both forms RFC 9110 allows", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
    expect(parseRetryAfter(inTwoMinutes)).toBeGreaterThan(100);
  });

  it("rounds a long wait up to minutes", () => {
    expect(describeHttpError(429, undefined, "540").message).toBe(
      "Too many questions at once. Try again in 9 minutes.",
    );
    expect(describeHttpError(429, undefined, "1").message).toBe(
      "Too many questions at once. Try again in 1 second.",
    );
  });
});

/**
 * `Organisation` and `X-Client`, the two headers bolt-v2's own clients send
 * on every operation and this console did not send at all.
 *
 * `Organisation` is what makes the acting organisation switchable: agent-service
 * has always read it (`app.auth.dependency`, step 4) and validated it against
 * the caller's real subtree, so nothing was unsafe about the omission — every
 * operator was simply pinned to whichever organisation their token was minted
 * against, with no way to look at a child.
 */
describe("GatewayClient context headers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // A fresh Response per call (a body reads once), and a body that satisfies
    // both paths: `agentFetch` wants any JSON, `graphql` wants a `data` key.
    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, data: { x: 1 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function clientWith(organisationId: string | null) {
    return new GatewayClient({
      baseUrl: "http://gw",
      getToken: () => "t",
      onUnauthorized: () => {},
      getOrganisationId: () => organisationId,
    });
  }

  it("sends Organisation and X-Client on agentFetch", async () => {
    await clientWith("org-7").agentFetch("/agent/me");
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get("Organisation")).toBe("org-7");
    expect(request.headers.get("X-Client")).toBe("web");
  });

  it("sends them on graphql too, so the two paths cannot address different organisations", async () => {
    await clientWith("org-7").graphql("query { x }");
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get("Organisation")).toBe("org-7");
    expect(request.headers.get("X-Client")).toBe("web");
  });

  it("omits Organisation entirely when none is chosen", async () => {
    // Absent means "the token's own organisation" to agent-service, which is
    // the right default — an empty header would be a malformed one, and that
    // is a 401 rather than an ignored value.
    await clientWith(null).agentFetch("/agent/me");
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.has("Organisation")).toBe(false);
  });

  it("never overrides an Organisation a caller set explicitly", async () => {
    await clientWith("ambient").graphql("query { x }", undefined, {
      headers: { Organisation: "explicit" },
    });
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get("Organisation")).toBe("explicit");
  });
});
