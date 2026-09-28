import { BOLTV2_APP_URL } from "../api/config.ts";
import { GatewayError } from "../ask/http/errors.ts";

/**
 * "Continue with Bolt": borrow the sign-in of a Bolt tab already open in
 * this browser, instead of typing a password.
 *
 * bolt-v2 has no SSO or token-exchange operation, so this is a handover
 * between the two web apps. The console opens bolt-v2's `/auth/connect` in
 * a popup; bolt-v2 signs the person in if it needs to, asks "Continue as
 * <name>?", and posts its current access token back with `postMessage` to
 * this exact origin — bolt-v2 keeps the list of origins it will answer
 * (`connect.component.ts` there). This side accepts an answer only from
 * bolt-v2's origin, only from the popup it opened, and only carrying the
 * random `state` it sent, so no other page or window can plant a token.
 *
 * What comes back is an access token and nothing else. bolt-v2 rotates its
 * refresh token on every use, so sharing one between two apps would sign
 * one of them out; the console's session instead lasts as long as the token
 * does, and reconnecting is the same button (bolt-v2 remembers the yes).
 */

export interface ConnectResult {
  token: string;
}

const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 640;

function randomState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The URL `connectWithBolt` opens, exported for tests. */
export function connectUrl(state: string): string {
  const url = new URL("/auth/connect", `${BOLTV2_APP_URL}/`);
  url.searchParams.set("client", "bolty");
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Opens the popup and resolves with the handed-over token. Must be called
 * straight from a click handler, or the browser blocks the popup.
 *
 * Rejects with a `GatewayError` whose message is a finished sentence: popup
 * blocked, window closed, or the person said no. `signal` abandons the
 * wait (the screen unmounted) and closes the popup.
 */
export function connectWithBolt(signal?: AbortSignal): Promise<ConnectResult> {
  const state = randomState();
  const boltOrigin = new URL(BOLTV2_APP_URL).origin;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2));
  const popup = window.open(
    connectUrl(state),
    "bolt-connect",
    `popup,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`,
  );

  if (popup === null) {
    return Promise.reject(
      new GatewayError(
        "Your browser blocked the Bolt window. Allow pop-ups for this site, then try again — or sign in with your email below.",
      ),
    );
  }

  return new Promise<ConnectResult>((resolve, reject) => {
    let settled = false;

    function finish(outcome: () => void) {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(watch);
      signal?.removeEventListener("abort", onAbort);
      outcome();
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== boltOrigin || event.source !== popup) return;
      const data = event.data as Record<string, unknown> | null;
      if (typeof data !== "object" || data === null || data.type !== "bolt-connect") return;
      if (data.state !== state) return;
      if (data.status === "approved" && typeof data.token === "string" && data.token !== "") {
        const token = data.token;
        finish(() => resolve({ token }));
      } else {
        finish(() => reject(new GatewayError("Sign-in with Bolt was cancelled.")));
      }
    }

    function onAbort() {
      finish(() => {
        popup?.close();
        reject(new DOMException("Aborted", "AbortError"));
      });
    }

    // A popup closed with its own ✕ sends nothing. Polling `closed` is the
    // only way to learn of it; the message, when there is one, arrives first.
    const watch = window.setInterval(() => {
      if (popup.closed) {
        finish(() => reject(new GatewayError("The Bolt window was closed before you finished signing in.")));
      }
    }, 400);

    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort);
  });
}
