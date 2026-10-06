import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "./gatewayClient.ts";

/** The fetch page-agent gets (PAGE_ACTIONS_CONTRACT §4/§5) and the result
 * POST (§6). */
describe("GatewayClient page tasks", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const PREFIX = "http://ask.test/agent/page-tasks/abc";

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function client(overrides: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) {
    let token = "old-token";
    return new GatewayClient({
      baseUrl: "http://ask.test/",
      getToken: () => token,
      getOrganisationId: () => "org-live",
      clientType: "web",
      elementVersion: "1.4.0",
      refresh: async () => {
        token = "new-token";
        return true;
      },
      onUnauthorized: () => {},
      ...overrides,
    });
  }

  it("sends the credential, organisation, client and element version headers", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const scoped = client().scopedFetch(PREFIX, { organisationId: "org-pinned" });

    const response = await scoped(`${PREFIX}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toBe(`${PREFIX}/chat/completions`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("Authorization")).toBe("Bearer old-token");
    // Pinned to the organisation the task started in, not the live one.
    expect(request.headers.get("Organisation")).toBe("org-pinned");
    expect(request.headers.get("X-Client")).toBe("web");
    expect(request.headers.get("X-Ask-Element-Version")).toBe("1.4.0");
    expect(await request.text()).toBe('{"messages":[]}');
  });

  it("refreshes the credential once on a 401 and retries with the new one", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const onUnauthorized = vi.fn();
    const scoped = client({ onUnauthorized }).scopedFetch(PREFIX);

    const response = await scoped(`${PREFIX}/chat/completions`, { method: "POST", body: "{}" });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![0] as Request).headers.get("Authorization")).toBe("Bearer old-token");
    const retry = fetchMock.mock.calls[1]![0] as Request;
    expect(retry.headers.get("Authorization")).toBe("Bearer new-token");
    expect(await retry.text()).toBe("{}");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("retries only once, and hands back the second 401", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 401 }));
    const onUnauthorized = vi.fn();
    const scoped = client({ onUnauthorized }).scopedFetch(PREFIX);

    const response = await scoped(`${PREFIX}/chat/completions`, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("refuses a URL outside the task, without sending anything", async () => {
    const scoped = client().scopedFetch(PREFIX);

    await expect(scoped("https://evil.example/steal")).rejects.toThrow(TypeError);
    await expect(scoped("http://ask.test/agent/page-tasks/abcdef/chat/completions")).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects the caller's signal and the task's", async () => {
    fetchMock.mockImplementation(async (request: Request) => {
      if (request.signal.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    });
    const task = new AbortController();
    const scoped = client().scopedFetch(PREFIX, { signal: task.signal });

    const caller = new AbortController();
    caller.abort();
    await expect(scoped(`${PREFIX}/chat/completions`, { signal: caller.signal })).rejects.toThrow();

    task.abort();
    await expect(scoped(`${PREFIX}/chat/completions`)).rejects.toThrow();
  });

  it("posts a result, and reads a 404 as a closed task rather than a failure", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response('{"detail":"unknown task"}', { status: 404 }));
    const gateway = client();
    const result = { status: "done", summary: "Saved.", steps: [] };

    await expect(gateway.postPageTaskResult("abc", result, "org-pinned")).resolves.toBe(true);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toBe("http://ask.test/agent/page-tasks/abc/result");
    expect(request.method).toBe("POST");
    expect(request.headers.get("Organisation")).toBe("org-pinned");
    expect(JSON.parse(await request.text())).toEqual(result);

    await expect(gateway.postPageTaskResult("abc", result)).resolves.toBe(false);
  });
});
