import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { fetchSettings, type SettingsSnapshot } from "./settingsApi.ts";

const SNAPSHOT: SettingsSnapshot = {
  sandbox: {
    max_executions_per_run: 4,
    max_concurrent_executions_per_user: 0,
    concurrent_slot_ttl_seconds: 45,
    concurrency_configured: false,
  },
  ask: { show_reasoning: false, show_query_results: false },
  agents: [{ id: 1, name: "Analytics", code_execution: "interpreter" }],
};

describe("fetchSettings", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("routes through the real gatewayClient and returns the snapshot verbatim", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(SNAPSHOT), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const snapshot = await fetchSettings();

    expect(snapshot).toEqual(SNAPSHOT);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toContain("/agent/settings");
    expect(request.headers.get("Authorization")).toBe("Bearer tok");
  });
});
