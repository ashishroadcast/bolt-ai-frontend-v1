import { BOLTV2_GRAPHQL_URL } from "../api/config.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { platformFriendlyName, platformUniqueId } from "./device.ts";

/**
 * bolt-v2's sign-in, called straight from the browser against bolt-v2's own
 * GraphQL endpoint — the same operations, arguments and order bolt-v2's web
 * app uses (`public/auth/service/auth.service.ts` there), so an account that
 * can sign in to Bolt can sign in here, with nothing new to provision.
 *
 * The flow, as bolt-v2 runs it:
 *
 * 1. `EmailOrMobileBasedOrganisations` — which organisations this email or
 *    mobile number belongs to. Sign-in happens INTO one of them, so a person
 *    in several picks one.
 * 2. `PasswordLogin` (email) or `SendOtp` + `OtpLogin` (mobile), against that
 *    organisation. Either returns an access token (minutes) and a refresh
 *    token, or — when the account is already signed in on as many devices as
 *    it is allowed — the list of those devices and a short-lived token that
 *    can only sign one of them out (`LogoutDevice`).
 * 3. `RefreshToken` renews the access token later (`./credential.ts`).
 *
 * Why not through agent-service: nothing it could add. It verifies the token
 * that comes back by asking bolt-v2 anyway (`app.auth.dependency`), and a
 * proxy would put a person's password through one more service.
 *
 * Every error is a `GatewayError` whose message is a finished sentence for
 * the sign-in screen. bolt-v2's own resolver text is terse and lower-case
 * ("user not found"), so the common ones are reworded (`friendlyMessage`)
 * and anything else is passed through as bolt-v2 said it.
 */

export interface BoltV2Organisation {
  id: string;
  name: string;
}

export interface ActiveDevice {
  id: string;
  name: string;
  loginTime: string | null;
  lastActiveAt: string | null;
}

export interface SignedInUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export type LoginResult =
  | {
      kind: "signed-in";
      token: string;
      refreshToken: string | null;
      user: SignedInUser | null;
      organisationId: string | null;
    }
  | {
      kind: "device-limit";
      devices: ActiveDevice[];
      /** Good only for `LogoutDevice`; null when bolt-v2 sent none. */
      preAuthToken: string | null;
    };

interface GraphQLBody<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

/** bolt-v2's words, reworded where they would read as a fault in this
 * screen rather than as an answer. Matched loosely: the resolvers are not
 * consistent about case or punctuation. */
export function friendlyMessage(raw: string): string {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (lower.includes("user not found") || lower.includes("no user")) {
    return "We couldn't find a Bolt account with that email or mobile number. Check it for typos, or ask your admin to invite you.";
  }
  if (
    lower.includes("invalid password") ||
    lower.includes("password invalid") ||
    lower.includes("incorrect password") ||
    lower.includes("wrong password") ||
    lower.includes("invalid credentials")
  ) {
    return "That password isn't right. Try again, or reset it with “Forgot password?”.";
  }
  if (lower.includes("otp") && (lower.includes("invalid") || lower.includes("incorrect") || lower.includes("wrong"))) {
    return "That code isn't right. Check the latest message we sent and try again.";
  }
  if (lower.includes("otp") && lower.includes("expired")) {
    return "That code has expired. Send a new one and try again.";
  }
  if (lower.includes("not active") || lower.includes("inactive") || lower.includes("deactivated") || lower.includes("suspended")) {
    return "This account is switched off in Bolt. Ask your admin to reactivate it.";
  }
  if (lower.includes("too many") || lower.includes("rate limit")) {
    return "Too many attempts. Wait a minute, then try again.";
  }
  if (text === "") return "Bolt couldn't sign you in. Try again.";
  // bolt-v2's message as it is, sentence-cased, rather than a vaguer guess.
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * One POST to bolt-v2's GraphQL endpoint.
 *
 * `credentials: "include"` because bolt-v2 also sets its refresh token as an
 * HttpOnly cookie on sign-in and reads it back on refresh, exactly as its own
 * web app relies on; the body carries the same token, so a browser that
 * blocks the cookie loses nothing.
 */
export async function boltv2Request<T>(
  query: string,
  variables: Record<string, unknown>,
  options: { token?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Client": "web",
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await fetch(BOLTV2_GRAPHQL_URL, {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ query, variables }),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new GatewayError("Couldn't reach Bolt. Check your connection and try again.", {
      retryable: true,
      cause: err,
    });
  }

  let body: GraphQLBody<T>;
  try {
    body = (await response.json()) as GraphQLBody<T>;
  } catch (err) {
    throw new GatewayError(
      response.ok
        ? "Bolt sent a reply this screen couldn't read. Try again."
        : `Bolt is having trouble right now (${response.status}). Try again in a moment.`,
      { status: response.status, retryable: true, cause: err },
    );
  }

  const errors = (body.errors ?? []).map((error) => error.message ?? "").filter((m) => m !== "");
  if (errors.length > 0) {
    throw new GatewayError(friendlyMessage(errors[0]!), {
      status: response.status,
      graphQLErrors: errors,
    });
  }
  if (!response.ok || body.data === null || body.data === undefined) {
    throw new GatewayError(`Bolt is having trouble right now (${response.status}). Try again in a moment.`, {
      status: response.status,
      retryable: true,
    });
  }
  return body.data;
}

// ── 1. Which organisations ───────────────────────────────────────────────

const ORGANISATIONS_QUERY = `
  query ConsoleSignInOrganisations($emailOrMobile: String!, $webDomain: String) {
    EmailOrMobileBasedOrganisations(emailOrMobile: $emailOrMobile, webDomain: $webDomain) {
      id
      name
      isActive
    }
  }
`;

/** The ACTIVE organisations an email or mobile number can sign in to,
 * sorted by name. Throws when bolt-v2 knows no such account. */
export async function findOrganisations(emailOrMobile: string): Promise<BoltV2Organisation[]> {
  const data = await boltv2Request<{
    EmailOrMobileBasedOrganisations: Array<{ id: string; name: string | null; isActive: boolean | null }> | null;
  }>(ORGANISATIONS_QUERY, {
    emailOrMobile,
    // bolt-v2 passes its own origin; a whitelabel keys on it. This console
    // is nobody's whitelabel, and its origin says so.
    webDomain: typeof window === "undefined" ? null : window.location.origin,
  });
  return (data.EmailOrMobileBasedOrganisations ?? [])
    .filter((row) => row.isActive !== false)
    .map((row) => ({ id: row.id, name: (row.name ?? "").trim() || "Unnamed organisation" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── 2. Sign in ───────────────────────────────────────────────────────────

const LOGIN_FIELDS = `
  token
  refreshToken
  deviceLimitExceeded
  activeDevice {
    platformUniqueId
    deviceName
    loginTime
    lastActiveAt
  }
  organisationUser {
    organisationID
    user {
      id
      firstName
      lastName
      email
    }
  }
`;

const PASSWORD_LOGIN_QUERY = `
  query ConsolePasswordLogin(
    $email: String!
    $password: String!
    $organisationId: ID!
    $platformUniqueId: String!
    $platformFriendlyName: String!
  ) {
    PasswordLogin(
      email: $email
      password: $password
      organisationId: $organisationId
      platformUniqueId: $platformUniqueId
      platformFriendlyName: $platformFriendlyName
    ) {
      ${LOGIN_FIELDS}
    }
  }
`;

const SEND_OTP_QUERY = `
  query ConsoleSendOtp($mobileNumber: String!, $organisationId: ID!) {
    SendOtp(mobileNumber: $mobileNumber, organisationId: $organisationId)
  }
`;

const OTP_LOGIN_QUERY = `
  query ConsoleOtpLogin(
    $mobileNumber: String!
    $otp: String!
    $organisationId: ID!
    $platformUniqueId: String!
    $platformFriendlyName: String!
  ) {
    OtpLogin(
      mobileNumber: $mobileNumber
      otp: $otp
      organisationId: $organisationId
      platformUniqueId: $platformUniqueId
      platformFriendlyName: $platformFriendlyName
    ) {
      ${LOGIN_FIELDS}
    }
  }
`;

interface RawLogin {
  token?: string | null;
  refreshToken?: string | null;
  deviceLimitExceeded?: boolean | null;
  activeDevice?: Array<{
    platformUniqueId?: string | null;
    deviceName?: string | null;
    loginTime?: string | null;
    lastActiveAt?: string | null;
  }> | null;
  organisationUser?: {
    organisationID?: string | null;
    user?: { id?: string; firstName?: string | null; lastName?: string | null; email?: string | null } | null;
  } | null;
}

/** Newer bolt-v2 answers "too many devices" with an error rather than a
 * flag, its devices spelled out Go-map style in the message
 * ("map[device_id:… device_name:… login_time:…]"). */
function deviceLimitFromError(err: unknown): LoginResult | null {
  if (!(err instanceof GatewayError)) return null;
  const message = (err.graphQLErrors ?? []).join(" ");
  if (!/device\s+limit\s+exceeded|maximum\s+\d+\s+devices\s+reached/i.test(message)) return null;
  const field = (entry: string, key: string): string | null => {
    const match = entry.match(new RegExp(`${key}:(.+?)(?=\\s+[a-z_]+:|\\]$)`));
    return match?.[1]?.trim() || null;
  };
  const devices = (message.match(/map\[[^\]]+\]/g) ?? []).map((entry) => ({
    id: field(entry, "device_id") ?? "",
    name: field(entry, "device_name") ?? "Unknown device",
    loginTime: field(entry, "login_time"),
    lastActiveAt: field(entry, "last_active_at") ?? field(entry, "login_time"),
  }));
  return { kind: "device-limit", devices: devices.filter((d) => d.id !== ""), preAuthToken: null };
}

function toResult(raw: RawLogin | null | undefined): LoginResult {
  if (raw?.deviceLimitExceeded) {
    return {
      kind: "device-limit",
      devices: (raw.activeDevice ?? [])
        .filter((device) => device.platformUniqueId)
        .map((device) => ({
          id: device.platformUniqueId!,
          name: (device.deviceName ?? "").trim() || "Unknown device",
          loginTime: device.loginTime ?? null,
          lastActiveAt: device.lastActiveAt ?? device.loginTime ?? null,
        })),
      preAuthToken: raw.token || null,
    };
  }
  if (!raw?.token) {
    throw new GatewayError("Bolt didn't return a session. Try again.", { retryable: true });
  }
  const user = raw.organisationUser?.user;
  return {
    kind: "signed-in",
    token: raw.token,
    refreshToken: raw.refreshToken || null,
    user: user?.id
      ? {
          id: user.id,
          email: user.email ?? "",
          firstName: user.firstName ?? "",
          lastName: user.lastName ?? "",
        }
      : null,
    organisationId: raw.organisationUser?.organisationID ?? null,
  };
}

async function login(field: "PasswordLogin" | "OtpLogin", query: string, variables: Record<string, unknown>): Promise<LoginResult> {
  try {
    const data = await boltv2Request<Record<string, RawLogin | null>>(query, {
      ...variables,
      platformUniqueId: platformUniqueId(),
      platformFriendlyName: platformFriendlyName(),
    });
    return toResult(data[field]);
  } catch (err) {
    const limit = deviceLimitFromError(err);
    if (limit !== null) return limit;
    throw err;
  }
}

export function passwordLogin(input: {
  email: string;
  password: string;
  organisationId: string;
}): Promise<LoginResult> {
  return login("PasswordLogin", PASSWORD_LOGIN_QUERY, input);
}

/** Texts a six-digit code to a mobile number, for `otpLogin`. */
export async function sendMobileCode(input: { mobileNumber: string; organisationId: string }): Promise<void> {
  await boltv2Request(SEND_OTP_QUERY, input);
}

export function otpLogin(input: {
  mobileNumber: string;
  otp: string;
  organisationId: string;
}): Promise<LoginResult> {
  return login("OtpLogin", OTP_LOGIN_QUERY, input);
}

// ── Too many devices ─────────────────────────────────────────────────────

const LOGOUT_DEVICE_MUTATION = `
  mutation ConsoleLogoutDevice($deviceId: String!) {
    LogoutDevice(deviceID: $deviceId)
  }
`;

/**
 * Ends one of this account's bolt-v2 sessions. With the pre-auth token from a
 * device-limit answer, it makes room to sign in; with this console's own
 * token and its own device id, it IS signing out (`AuthContext.signOut`), so
 * the session stops counting against the account's limit.
 */
export async function logoutDevice(deviceId: string, token: string | null): Promise<void> {
  const data = await boltv2Request<{ LogoutDevice: unknown }>(
    LOGOUT_DEVICE_MUTATION,
    { deviceId },
    { token },
  );
  if (data.LogoutDevice === false || data.LogoutDevice === null) {
    throw new GatewayError("Bolt didn't sign that device out. Try again.", { retryable: true });
  }
}

// ── 3. Renew ─────────────────────────────────────────────────────────────

const REFRESH_TOKEN_QUERY = `
  query ConsoleRefreshToken($refreshToken: String) {
    RefreshToken(refreshToken: $refreshToken) {
      token
      refreshToken
    }
  }
`;

/**
 * A new access token for a refresh token. The refresh token ROTATES: the
 * one passed in is spent, and the returned one replaces it. Throws a
 * non-retryable `GatewayError` when bolt-v2 refuses it (signed out
 * elsewhere, expired, already spent) and a retryable one when bolt-v2 could
 * not be reached.
 */
export async function refreshTokens(
  refreshToken: string | null,
): Promise<{ token: string; refreshToken: string | null }> {
  let data: { RefreshToken: { token?: string | null; refreshToken?: string | null } | null };
  try {
    data = await boltv2Request(REFRESH_TOKEN_QUERY, { refreshToken });
  } catch (err) {
    // Another tab spent this token a moment ago and bolt-v2's answer to it
    // is not cached yet: a retry shortly will get the new pair. Not a
    // refusal, so not a sign-out.
    if (err instanceof GatewayError && (err.graphQLErrors ?? []).some((m) => /already in progress/i.test(m))) {
      throw new GatewayError("Bolt is renewing this session. Try again in a moment.", {
        retryable: true,
        cause: err,
      });
    }
    throw err;
  }
  const token = data.RefreshToken?.token;
  if (!token) throw new GatewayError("Bolt didn't renew the session.");
  return { token, refreshToken: data.RefreshToken?.refreshToken || refreshToken };
}
