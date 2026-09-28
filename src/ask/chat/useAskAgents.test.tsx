import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestAskProvider } from "../testing.tsx";
import { useAskAgents, type AskAgent } from "./useAskAgents.ts";

/**
 * One failed load used to leave the panel dead until a reload: the list was
 * fetched once per client and never again. These pin the recovery — the
 * backoff, where it stops, what wakes it, and the one failure it must never
 * retry.
 */

const AGENTS: AskAgent[] = [{ id: 1, name: "Sales Analyst", is_active: true, slash_command: null }];

function ok(): Response {
  return new Response(JSON.stringify(AGENTS), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** A refusal with no `detail` — a proxy's page — so the fixed sentence for
 * the status is what shows. */
function status(code: number): Response {
  return new Response("<html>error</html>", { status: code });
}

function wrapper({ children }: { children: ReactNode }) {
  return <TestAskProvider>{children}</TestAskProvider>;
}

/** Runs the timers and lets every resulting fetch and state update land. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useAskAgents recovery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Only the timers the hook schedules. Faking everything would also stall
    // whatever the Response body reader waits on.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a failed load by itself, and the list arrives", async () => {
    fetchMock.mockResolvedValueOnce(status(503)).mockResolvedValue(ok());
    const { result } = renderHook(() => useAskAgents(), { wrapper });

    await advance(0);
    expect(result.current.error).toBe("The assistant is temporarily unavailable.");
    expect(result.current.canRetry).toBe(true);
    expect(result.current.loading).toBe(false);

    await advance(2_000);
    expect(result.current.error).toBeNull();
    expect(result.current.agents).toEqual(AGENTS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off 2s, 5s, 15s and then stops", async () => {
    fetchMock.mockImplementation(async () => status(502));
    renderHook(() => useAskAgents(), { wrapper });

    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never retries a 403, and offers no retry for one", async () => {
    fetchMock.mockImplementation(async () => status(403));
    const { result } = renderHook(() => useAskAgents(), { wrapper });

    await advance(0);
    expect(result.current.error).toBe(
      "You don't have permission to use the assistant. Ask an admin for access.",
    );
    expect(result.current.canRetry).toBe(false);

    await advance(60_000);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries again when the browser comes back online after the backoff gave up", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 504 }));
    const { result } = renderHook(() => useAskAgents(), { wrapper });
    await advance(0);
    // One step per retry: each schedules the next only once its own
    // response has been read.
    for (const wait of [2_000, 5_000, 15_000]) await advance(wait);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockResolvedValue(ok());
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.agents).toEqual(AGENTS);
  });

  it("tries again when the tab becomes visible, but only after a failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(ok());
    const { result } = renderHook(() => useAskAgents(), { wrapper });
    await advance(0);
    expect(result.current.error).toBe(
      "Couldn't reach the assistant. It may be restarting; try again in a moment.",
    );

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(0);
    expect(result.current.agents).toEqual(AGENTS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Loaded now: switching back to the tab must not refetch a healthy list.
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retry() fetches at once, ahead of the scheduled attempt", async () => {
    fetchMock.mockResolvedValueOnce(status(500)).mockResolvedValue(ok());
    const { result } = renderHook(() => useAskAgents(), { wrapper });
    await advance(0);
    expect(result.current.error).not.toBeNull();

    act(() => result.current.retry());
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.agents).toEqual(AGENTS);
    // The pending automatic retry was cancelled, not left to fire as well.
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
