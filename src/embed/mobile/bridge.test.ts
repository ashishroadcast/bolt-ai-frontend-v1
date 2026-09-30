import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBridge, NativeRequestError, detectTransport, type NativeTransport } from "./bridge.ts";
import { embedLang } from "./copy.ts";

/** A transport whose "app" is the test: it records what the page sends and can answer. */
function fakeTransport() {
  const sent: Array<Record<string, unknown>> = [];
  let deliver: (message: string) => void = () => {};
  const transport: NativeTransport = {
    platform: "android",
    send: (message) => sent.push(JSON.parse(message)),
    listen: (onMessage) => {
      deliver = onMessage;
    },
  };
  return {
    transport,
    sent,
    reply: (message: object) => deliver(JSON.stringify(message)),
    deliverRaw: (raw: string) => deliver(raw),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("detectTransport", () => {
  it("returns null in a plain browser", () => {
    expect(detectTransport({})).toBeNull();
  });

  it("uses the Android object and its message events", () => {
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const native = {
      postMessage: vi.fn(),
      addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener),
    };
    const transport = detectTransport({ BoltAskNative: native })!;
    const received: string[] = [];
    transport.listen((message) => received.push(message));

    transport.send('{"type":"ready"}');
    listeners[0]({ data: '{"id":1,"value":"x"}' });

    expect(transport.platform).toBe("android");
    expect(native.postMessage).toHaveBeenCalledWith('{"type":"ready"}');
    expect(received).toEqual(['{"id":1,"value":"x"}']);
  });

  it("uses WKWebView's message handler on iOS, answered through BoltAskHost.receive", () => {
    const handler = { postMessage: vi.fn() };
    const win: Record<string, unknown> = { webkit: { messageHandlers: { boltAskNative: handler } } };
    const transport = detectTransport(win)!;
    const received: string[] = [];
    transport.listen((message) => received.push(message));

    transport.send("{}");
    (win.BoltAskHost as { receive(m: string): void }).receive('{"type":"org"}');

    expect(transport.platform).toBe("ios");
    expect(handler.postMessage).toHaveBeenCalledWith("{}");
    expect(received).toEqual(['{"type":"org"}']);
  });

  it("uses ReactNativeWebView in React Native", () => {
    const rn = { postMessage: vi.fn() };
    expect(detectTransport({ ReactNativeWebView: rn })!.platform).toBe("react-native");
  });

  it("prefers Android when an Android host also exposes something else", () => {
    const win = {
      BoltAskNative: { postMessage: vi.fn(), addEventListener: vi.fn() },
      ReactNativeWebView: { postMessage: vi.fn() },
    };
    expect(detectTransport(win)!.platform).toBe("android");
  });
});

describe("NativeBridge", () => {
  it("matches each answer to its request by id", async () => {
    const app = fakeTransport();
    const bridge = new NativeBridge(app.transport);

    const hello = bridge.request("hello");
    const token = bridge.request("token");
    expect(app.sent).toEqual([
      { id: 1, type: "hello" },
      { id: 2, type: "token" },
    ]);

    app.reply({ id: 2, value: "jwt" });
    app.reply({ id: 1, value: { bridge: 1 } });

    await expect(token).resolves.toBe("jwt");
    await expect(hello).resolves.toEqual({ bridge: 1 });
  });

  it("resolves null when the app answers with no value", async () => {
    const app = fakeTransport();
    const token = new NativeBridge(app.transport).request("token");
    app.reply({ id: 1, value: null });
    await expect(token).resolves.toBeNull();
  });

  it("rejects when the app says it can't do that (an older app)", async () => {
    const app = fakeTransport();
    const request = new NativeBridge(app.transport).request("dictate");
    app.reply({ id: 1, error: "unsupported" });
    await expect(request).rejects.toThrow(NativeRequestError);
  });

  it("rejects when the app never answers, and ignores a late answer", async () => {
    vi.useFakeTimers();
    const app = fakeTransport();
    const request = new NativeBridge(app.transport).request("hello", 5_000);
    const outcome = expect(request).rejects.toThrow(/within 5000ms/);

    vi.advanceTimersByTime(5_000);
    await outcome;
    expect(() => app.reply({ id: 1, value: "late" })).not.toThrow();
  });

  it("hands messages without an id to push handlers", () => {
    const app = fakeTransport();
    const bridge = new NativeBridge(app.transport);
    const pushes: unknown[] = [];
    bridge.onPush((push) => pushes.push(push));

    app.reply({ type: "org", orgId: "o-2" });

    expect(pushes).toEqual([{ type: "org", orgId: "o-2" }]);
  });

  it("ignores messages that aren't JSON objects", () => {
    const app = fakeTransport();
    const bridge = new NativeBridge(app.transport);
    const pushes: unknown[] = [];
    bridge.onPush((push) => pushes.push(push));

    app.deliverRaw("not json");
    app.deliverRaw("[]");
    app.deliverRaw("42");
    expect(pushes).toEqual([]);
  });

  it("sends one-way messages with their type", () => {
    const app = fakeTransport();
    new NativeBridge(app.transport).post("conversation", { value: 42 });
    expect(app.sent).toEqual([{ value: 42, type: "conversation" }]);
  });
});

describe("embedLang", () => {
  it.each([
    ["hi", "hi"],
    ["hi-IN", "hi"],
    ["en", "en"],
    ["vi", "en"],
    [undefined, "en"],
    [null, "en"],
  ])("%s → %s", (requested, expected) => {
    expect(embedLang(requested)).toBe(expected);
  });
});
