/**
 * The page ↔ native channel for Ask embedded in a mobile app's WebView
 * (`/embed/mobile/`). One protocol, three transports, so the same deployed
 * page serves every native host:
 *
 * | Host                         | page → app                                        | app → page                                  |
 * | ---------------------------- | ------------------------------------------------- | ------------------------------------------- |
 * | Android (androidx.webkit)    | `BoltAskNative.postMessage(json)`                 | `replyProxy.postMessage(json)`              |
 * | iOS (WKWebView)              | `webkit.messageHandlers.boltAskNative.postMessage(json)` | `evaluateJavaScript("BoltAskHost.receive(<json string>)")` |
 * | React Native (react-native-webview) | `ReactNativeWebView.postMessage(json)`     | `injectJavaScript("BoltAskHost.receive(<json string>)")`   |
 *
 * Android's object comes from `WebViewCompat.addWebMessageListener`, which
 * only injects it into allowlisted origins — that allowlist, not this code,
 * is what keeps the session token away from any other page.
 *
 * Every message is a JSON string. A request carries a positive `id`, and the
 * app answers it with `{id, value}` or `{id, error}`. Messages without an id
 * are one-way. Bridge v1:
 *
 * | type              | direction    | payload / reply                                                     |
 * | ----------------- | ------------ | ------------------------------------------------------------------- |
 * | `hello`           | request      | `{bridge, appVersion, flavor, lang, orgId, conversationId}`         |
 * | `token`           | request      | the session JWT, refreshed first if it is about to expire; or null  |
 * | `refresh`         | request      | a forced refresh's new JWT, or null                                 |
 * | `ready`           | page → app   | the widget is configured (hide the native spinner)                  |
 * | `close`           | page → app   | the widget's own ✕ (close the sheet or screen)                      |
 * | `conversation`    | page → app   | `{value}`: the conversation on screen, to reopen after a reload     |
 * | `org`             | app → page   | `{orgId}` after an organisation switch                              |
 * | `newConversation` | app → page   | start a fresh thread                                                |
 * | `selectAgent`     | app → page   | `{slash}`: fresh thread with that agent armed                       |
 *
 * Installed apps keep the bridge they shipped with while this page always runs
 * the latest deploy. So the page must feature-detect on `hello.bridge`, and an
 * app answers any request it doesn't know with `{id, error: "unsupported"}`.
 */

export type NativePlatform = "android" | "ios" | "react-native";

export interface NativeTransport {
  platform: NativePlatform;
  send(message: string): void;
  listen(onMessage: (message: string) => void): void;
}

/** The app's answer to `hello`. Every field is optional: older apps send less. */
export interface NativeHello {
  bridge?: number;
  appVersion?: string;
  flavor?: string;
  lang?: string;
  orgId?: string | null;
  conversationId?: number | null;
}

/** A message the app sent without being asked (`org`, `newConversation`, …). */
export interface NativePush {
  type: string;
  [key: string]: unknown;
}

interface AndroidNativeObject {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

interface MessageHandler {
  postMessage(message: string): void;
}

interface NativeWindow {
  BoltAskNative?: AndroidNativeObject;
  webkit?: { messageHandlers?: { boltAskNative?: MessageHandler } };
  ReactNativeWebView?: MessageHandler;
  BoltAskHost?: { receive(message: string): void };
}

/**
 * Finds the host app's channel, or `null` when the page is open in a plain
 * browser. Checked once at startup: every transport is in place before the
 * page's scripts run.
 */
export function detectTransport(win: object = window): NativeTransport | null {
  const w = win as NativeWindow;

  const android = w.BoltAskNative;
  if (android && typeof android.postMessage === "function") {
    return {
      platform: "android",
      send: (message) => android.postMessage(message),
      listen: (onMessage) => android.addEventListener("message", (event) => onMessage(String(event.data))),
    };
  }

  // iOS and React Native have no reply channel of their own: the app calls
  // `BoltAskHost.receive(json)` through evaluateJavaScript / injectJavaScript.
  const listenOnHost = (onMessage: (message: string) => void) => {
    w.BoltAskHost = { receive: (message) => onMessage(String(message)) };
  };

  const ios = w.webkit?.messageHandlers?.boltAskNative;
  if (ios) {
    return { platform: "ios", send: (message) => ios.postMessage(message), listen: listenOnHost };
  }

  const reactNative = w.ReactNativeWebView;
  if (reactNative) {
    return { platform: "react-native", send: (message) => reactNative.postMessage(message), listen: listenOnHost };
  }

  return null;
}

export class NativeRequestError extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NativeBridge {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly pushHandlers: Array<(push: NativePush) => void> = [];

  private readonly transport: NativeTransport;

  constructor(transport: NativeTransport) {
    this.transport = transport;
    transport.listen((message) => this.receive(message));
  }

  get platform(): NativePlatform {
    return this.transport.platform;
  }

  /**
   * Asks the app and resolves with its `value`. Rejects with
   * {@link NativeRequestError} when the app answers with an error (an older
   * app says "unsupported") or doesn't answer within `timeoutMs`.
   */
  request<T>(type: string, timeoutMs = 20_000): Promise<T | null> {
    const id = ++this.seq;
    return new Promise<T | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeRequestError(`no answer to "${type}" within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.transport.send(JSON.stringify({ id, type }));
    });
  }

  /** A one-way message to the app. */
  post(type: string, payload: Record<string, unknown> = {}): void {
    this.transport.send(JSON.stringify({ ...payload, type }));
  }

  onPush(handler: (push: NativePush) => void): void {
    this.pushHandlers.push(handler);
  }

  private receive(message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // not ours
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as { id?: unknown; value?: unknown; error?: unknown; type?: unknown };

    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return; // timed out already
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined) pending.reject(new NativeRequestError(String(msg.error)));
      else pending.resolve(msg.value ?? null);
      return;
    }

    if (typeof msg.type === "string") {
      for (const handler of this.pushHandlers) handler(msg as NativePush);
    }
  }
}
