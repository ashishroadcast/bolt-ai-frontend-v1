import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError, UnauthorizedError } from "../api/errors.ts";
import { AgentApiError } from "../api/gatewayClient.ts";
import { getSession, setSession } from "../auth/session.ts";
import { postAgentRun } from "./runStream.ts";

// `../api/client.ts` builds two GatewayClients at import time and owns the
// module-level refresh dedup, none of which this file is testing. The stub
// keeps `getFreshToken` honest — it really does hand back whatever the
// session holds, so the tests below that never touch refresh behave exactly
// as they did against the real one — while making `refreshAccessToken`
// something a test can steer.
const mocked = vi.hoisted(() => ({ refreshAccessToken: vi.fn(async () => false) }));

vi.mock("../api/client.ts", async () => {
  const session = await import("../auth/session.ts");
  return {
    getFreshToken: async () => session.getToken(),
    refreshAccessToken: mocked.refreshAccessToken,
  };
});

function jsonErrorResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamingResponse(status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"start","messageId":"1"}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe("postAgentRun", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocked.refreshAccessToken.mockReset();
    mocked.refreshAccessToken.mockResolvedValue(false);
    setSession({ token: "the-jwt", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("attaches the same Authorization: Bearer header agentFetch uses, to POST /agent/run", async () => {
    fetchMock.mockResolvedValue(streamingResponse());

    await postAgentRun({ message: "top items last week" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/agent/run");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer the-jwt");
    expect(JSON.parse(init.body as string)).toEqual({ message: "top items last week" });
  });

  it("clears the session and throws, with no network call, when there is no token", async () => {
    setSession(null);

    await expect(postAgentRun({ message: "hello" })).rejects.toThrow(UnauthorizedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the session and throws UnauthorizedError on a 401", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(postAgentRun({ message: "hello" })).rejects.toThrow(UnauthorizedError);
    expect(getSession()).toBeNull();
  });

  it("throws GatewayError on a non-2xx, non-auth status", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(postAgentRun({ message: "hello" })).rejects.toThrow(GatewayError);
  });

  // The gap this closes: postAgentRun used to discard the response body on
  // any non-2xx, the same information loss gatewayClient.ts's agentFetch
  // had — a caller asking with an unknown agent name (app.api.run._load_
  // agent's own 404, detail="no active agent named ... for this tenant")
  // saw only "Asking failed (404)." This reuses gatewayClient.ts's own
  // AgentApiError/stringDetailMessage rather than a second copy of the
  // same parsing — this test would fail against the old bare-GatewayError
  // behaviour (no .body, wrong .message).
  it("preserves the parsed JSON error body (FastAPI's detail) on a non-2xx", async () => {
    fetchMock.mockResolvedValue(
      jsonErrorResponse({ detail: "no active agent named 'Nope' for this tenant" }, 404),
    );

    const error = await postAgentRun({ message: "hello", agent: "Nope" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentApiError);
    const apiError = error as AgentApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.message).toBe("no active agent named 'Nope' for this tenant");
    expect(apiError.body).toEqual({ detail: "no active agent named 'Nope' for this tenant" });
  });

  it("falls back to a generic message, without throwing a second error, when the non-2xx body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("upstream timeout", { status: 504 }));

    const error = await postAgentRun({ message: "hello" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentApiError);
    const apiError = error as AgentApiError;
    expect(apiError.message).toBe("Asking failed (504).");
    expect(apiError.body).toBeUndefined();
  });

  it("returns the raw Response so the caller can read its body incrementally", async () => {
    fetchMock.mockResolvedValue(streamingResponse());

    const response = await postAgentRun({ message: "hello" });
    expect(response.body).not.toBeNull();
  });

  it("forwards an AbortSignal so navigating away can cancel the request", async () => {
    fetchMock.mockResolvedValue(streamingResponse());
    const controller = new AbortController();

    await postAgentRun({ message: "hello" }, { signal: controller.signal });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  // --- token refresh on the streaming path -------------------------------
  //
  // /agent/run is the longest-lived request the console makes and the one
  // the operator is watching. Before this, it read the token once and gave
  // up on a 401 — an answer half-streamed, then "please sign in".

  it("refreshes once and retries the run when the token has expired", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonErrorResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(streamingResponse());
    mocked.refreshAccessToken.mockImplementation(async () => {
      setSession({ token: "fresh-jwt", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
      return true;
    });

    const response = await postAgentRun({ message: "hello" });

    expect(response.status).toBe(200);
    expect(mocked.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry must carry the NEW token; resending the stale one would
    // 401 again and look like a refresh that silently did nothing.
    const retryHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer fresh-jwt");
    // The session survives — the whole point.
    expect(getSession()).not.toBeNull();
  });

  it("gives up after one failed refresh rather than retrying forever", async () => {
    fetchMock.mockResolvedValue(jsonErrorResponse({ detail: "expired" }, 401));
    mocked.refreshAccessToken.mockResolvedValue(false);

    await expect(postAgentRun({ message: "hello" })).rejects.toBeInstanceOf(UnauthorizedError);

    expect(mocked.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSession()).toBeNull();
  });

  it("never refreshes on a 403", async () => {
    // A permission the role does not have is not fixed by a newer token,
    // and retrying would just spend a refresh to be told 403 again.
    fetchMock.mockResolvedValue(jsonErrorResponse({ detail: "forbidden" }, 403));

    await expect(postAgentRun({ message: "hello" })).rejects.toBeInstanceOf(UnauthorizedError);

    expect(mocked.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
