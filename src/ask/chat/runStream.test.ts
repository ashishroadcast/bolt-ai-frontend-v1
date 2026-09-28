import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError, UnauthorizedError } from "../http/errors.ts";
import { AgentApiError } from "../http/gatewayClient.ts";
import { isMissingConversationError, isUnknownAgentError, postAgentRun } from "./runStream.ts";
import { GatewayClient } from "../http/gatewayClient.ts";

// No `../api/client.ts` stub any more, and nothing left to stub: that module
// used to own a token-refresh apparatus this file had to steer, and
// `postAgentRun` now reads the credential straight from `auth/session.ts`.
// The real module is not imported by the code under test at all.

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

// A client per file, with `onUnauthorized` observable.
//
// These tests used to assert `getSession()` is null after a refusal — the
// console's module-level store, reached from inside the package. The package
// has no store: a refusal calls the HOST's `onUnauthorized`, and the console
// is the thing that decides that means sign out. So the assertion moves from
// "global state was cleared" to "the host was told", which is the actual
// contract and the one a non-console host also relies on.
const unauthorized = vi.fn();
const client = new GatewayClient({
  baseUrl: "http://ask.test",
  getToken: () => credential,
  getOrganisationId: () => null,
  onUnauthorized: unauthorized,
});
let credential: string | null = "boltai_test-credential";

// `postAgentRun` goes through `GatewayClient.agentStream` now, which calls
// `fetch(new Request(url, init))` — one argument, exactly as `agentFetch`
// has always done. So these read the Request rather than an `(url, init)`
// pair. A `Request` built from an init carries its `signal`, so the abort
// wiring is still observable, just one property deeper.

describe("postAgentRun", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    unauthorized.mockClear();
    credential = "boltai_test-credential";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the same Authorization: Bearer header agentFetch uses, to POST /agent/run", async () => {
    fetchMock.mockResolvedValue(streamingResponse());

    await postAgentRun(client, { message: "top items last week" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toContain("/agent/run");
    const headers = new Headers(request.headers);
    expect(headers.get("Authorization")).toBe("Bearer boltai_test-credential");
    expect(await request.json()).toEqual({ message: "top items last week" });
  });

  it("tells the host and throws, with no network call, when there is no credential", async () => {
    // Was "clears the session": the package has no session to clear. A host
    // that hands back nothing is told, and decides for itself what that
    // means.
    credential = null;

    await expect(postAgentRun(client, { message: "hello" })).rejects.toThrow(UnauthorizedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unauthorized).toHaveBeenCalled();
  });

  it("clears the session and throws UnauthorizedError on a 401", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(postAgentRun(client, { message: "hello" })).rejects.toThrow(UnauthorizedError);
    expect(unauthorized).toHaveBeenCalled();
  });

  it("throws GatewayError on a non-2xx, non-auth status", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(postAgentRun(client, { message: "hello" })).rejects.toThrow(GatewayError);
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

    const error = await postAgentRun(client, { message: "hello", agent: "Nope" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentApiError);
    const apiError = error as AgentApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.message).toBe("no active agent named 'Nope' for this tenant");
    expect(apiError.body).toEqual({ detail: "no active agent named 'Nope' for this tenant" });
  });

  it("falls back to a generic message, without throwing a second error, when the non-2xx body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("upstream timeout", { status: 504 }));

    const error = await postAgentRun(client, { message: "hello" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentApiError);
    const apiError = error as AgentApiError;
    expect(apiError.message).toBe("Asking failed (504).");
    expect(apiError.body).toBeUndefined();
  });

  it("returns the raw Response so the caller can read its body incrementally", async () => {
    fetchMock.mockResolvedValue(streamingResponse());

    const response = await postAgentRun(client, { message: "hello" });
    expect(response.body).not.toBeNull();
  });

  it("forwards an AbortSignal so navigating away can cancel the request", async () => {
    fetchMock.mockResolvedValue(streamingResponse());
    const controller = new AbortController();

    await postAgentRun(client, { message: "hello" }, { signal: controller.signal });

    // Identity, not equality: `new Request(url, { signal })` wraps the
    // caller's signal rather than holding it, so what matters is that
    // aborting the caller's aborts the request's.
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  // --- token refresh on the streaming path -------------------------------
  //
  // /agent/run is the longest-lived request the console makes and the one
  // the operator is watching. Before this, it read the token once and gave
  // up on a 401 — an answer half-streamed, then "please sign in".

  it("does not retry a refused key — there is no newer credential to try", async () => {
    // Under tokens this retried once after a refresh, because /agent/run is
    // the longest-lived request the console makes and the one the operator is
    // watching: a token expiring mid-answer meant "please sign in" halfway
    // through. An API key does not expire, so a 401 here means it was
    // REVOKED — and presenting it again is the only thing a second attempt
    // could achieve.
    fetchMock.mockResolvedValue(jsonErrorResponse({ detail: "Not authenticated" }, 401));

    await expect(postAgentRun(client, { message: "hello" })).rejects.toBeInstanceOf(UnauthorizedError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unauthorized).toHaveBeenCalled();
  });

  it("signs out on a 403 without retrying", async () => {
    // A permission the caller lacks is not granted by presenting the same
    // credential again. This was never retried even under tokens.
    fetchMock.mockResolvedValue(jsonErrorResponse({ detail: "forbidden" }, 403));

    await expect(postAgentRun(client, { message: "hello" })).rejects.toBeInstanceOf(UnauthorizedError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

describe("telling postAgentRun's two 404s apart", () => {
  const conversationGone = new AgentApiError("no conversation 57 for this user", 404, {
    detail: "no conversation 57 for this user",
  });
  const agentGone = new AgentApiError("no active agent named 'Report' available to this tenant", 404, {
    detail: "no active agent named 'Report' available to this tenant",
  });

  it("recognises a conversation this user cannot continue", () => {
    expect(isMissingConversationError(conversationGone)).toBe(true);
    expect(isUnknownAgentError(conversationGone)).toBe(false);
  });

  it("recognises an agent that is gone, even one with 'conversation' in its name", () => {
    const oddlyNamed = new AgentApiError(
      "no active agent named 'Conversation-Bot' available to this tenant",
      404,
      undefined,
    );
    expect(isUnknownAgentError(agentGone)).toBe(true);
    expect(isMissingConversationError(agentGone)).toBe(false);
    expect(isMissingConversationError(oddlyNamed)).toBe(false);
  });

  it("is neither for another status or another error", () => {
    expect(isMissingConversationError(new AgentApiError("no conversation 57 for this user", 422, undefined))).toBe(false);
    expect(isMissingConversationError(new GatewayError("no conversation 57"))).toBe(false);
    expect(isUnknownAgentError(new TypeError("Failed to fetch"))).toBe(false);
  });
});
