import { GATEWAY_URL } from "../api/config.ts";
import { GatewayError } from "../ask/http/errors.ts";

/**
 * Sign-in with a Whitelight (WFM) account — the console's sign-in on a Whitelight
 * build (`VITE_SIGN_IN=whitelight`). Bolty relays the username and password to the
 * WFM deployment's own login (`POST /agent/whitelight/login`), chosen by this page's
 * origin, and hands back WFM's own access and refresh tokens. The access token is
 * then the session's credential, judged by WFM on every request.
 */

export const WHITELIGHT_SIGN_IN = import.meta.env.VITE_SIGN_IN === "whitelight";

export interface WhitelightTokens {
  token: string;
  refreshToken: string;
}

async function post(path: string, body: unknown): Promise<WhitelightTokens> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GatewayError("Couldn't reach Bolty's server. Check your connection and try again.", {
      retryable: true,
    });
  }
  const data = (await response.json().catch(() => ({}))) as {
    token?: string;
    refresh_token?: string;
    detail?: string;
  };
  if (!response.ok || !data.token) {
    const retryable = response.status >= 500;
    const message =
      response.status === 403
        ? "This site is not set up for a Whitelight account."
        : typeof data.detail === "string" && data.detail
          ? data.detail
          : "Couldn't sign in. Try again.";
    throw new GatewayError(message, { retryable });
  }
  return { token: data.token, refreshToken: data.refresh_token ?? "" };
}

export function whitelightLogin(username: string, password: string): Promise<WhitelightTokens> {
  return post("/agent/whitelight/login", { username, password });
}

export function whitelightRefresh(refreshToken: string): Promise<WhitelightTokens> {
  return post("/agent/whitelight/refresh", { refresh_token: refreshToken });
}
