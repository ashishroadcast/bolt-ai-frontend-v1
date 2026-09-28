import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectUrl, connectWithBolt } from "./boltConnect.ts";

const BOLT_ORIGIN = "https://bolt-v2.roadcast.net";

interface FakePopup {
  closed: boolean;
  close: () => void;
}

describe("connectWithBolt", () => {
  let popup: FakePopup;
  let openedUrl: string;

  beforeEach(() => {
    vi.useFakeTimers();
    popup = { closed: false, close: vi.fn(() => (popup.closed = true)) };
    vi.spyOn(window, "open").mockImplementation((url) => {
      openedUrl = String(url);
      return popup as unknown as Window;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function stateSent(): string {
    return new URL(openedUrl).searchParams.get("state")!;
  }

  function answer(data: unknown, options: { origin?: string; source?: unknown } = {}) {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        origin: options.origin ?? BOLT_ORIGIN,
        source: (options.source ?? popup) as MessageEventSource,
      }),
    );
  }

  it("opens bolt-v2's connect page naming this console and a random state", () => {
    void connectWithBolt().catch(() => {});
    const url = new URL(openedUrl);
    expect(url.origin + url.pathname).toBe(`${BOLT_ORIGIN}/auth/connect`);
    expect(url.searchParams.get("client")).toBe("bolty");
    expect(url.searchParams.get("origin")).toBe(window.location.origin);
    expect(stateSent()).toMatch(/^[0-9a-f]{48}$/);
    expect(connectUrl("abc")).toContain("state=abc");
  });

  it("resolves with the token bolt-v2 posts back for this request", async () => {
    const pending = connectWithBolt();
    answer({ type: "bolt-connect", version: 1, state: stateSent(), status: "approved", token: "jwt" });
    await expect(pending).resolves.toEqual({ token: "jwt" });
  });

  it("ignores answers from any other origin, window or request", async () => {
    const pending = connectWithBolt();
    const state = stateSent();
    const token = { type: "bolt-connect", state, status: "approved", token: "planted" };

    answer(token, { origin: "https://evil.example" });
    answer(token, { source: window });
    answer({ ...token, state: "someone-elses" });
    answer("not an object");

    answer({ type: "bolt-connect", state, status: "approved", token: "real" });
    await expect(pending).resolves.toEqual({ token: "real" });
  });

  it("rejects when the person cancels in bolt-v2", async () => {
    const pending = connectWithBolt();
    answer({ type: "bolt-connect", state: stateSent(), status: "cancelled" });
    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it("rejects when the popup is closed without an answer", async () => {
    const pending = connectWithBolt();
    popup.closed = true;
    vi.advanceTimersByTime(500);
    await expect(pending).rejects.toThrow(/window was closed/i);
  });

  it("says how to fix a blocked popup", async () => {
    vi.mocked(window.open).mockReturnValueOnce(null);
    await expect(connectWithBolt()).rejects.toThrow(/allow pop-ups/i);
  });

  it("closes the popup when the screen gives up waiting", async () => {
    const controller = new AbortController();
    const pending = connectWithBolt(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(popup.close).toHaveBeenCalled();
  });
});
