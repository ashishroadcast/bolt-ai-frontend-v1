/**
 * The two fields bolt-v2's `PasswordLogin`/`OtpLogin` require alongside
 * credentials: `platformUniqueId` (a stable per-device identifier the
 * session-limit check keys on — bolt-v2 tracks active sessions PER
 * DEVICE, and `PasswordLogin` refuses a login past the device limit,
 * returning `deviceLimitExceeded: true` and the caller's own current
 * devices rather than a token) and `platformFriendlyName` (what a device
 * calls itself in that same active-devices list, and in bolt-v2's own
 * session-management screens elsewhere).
 *
 * Neither has a browser-native source — a web client has no hardware
 * device id — so both are synthesised here, once, and persisted:
 * `platformUniqueId` in `localStorage` (survives a reload, the same
 * property that already justified `sessionStorage` for the session
 * itself in `session.ts` — but the DEVICE identity must outlive a tab
 * closing, unlike the session, or every new tab would look like a new
 * device and burn through the device limit on its own), and
 * `platformFriendlyName` derived fresh from `navigator.userAgent` each
 * time (nothing to persist — it is deterministic per browser/OS pair on
 * one machine, and re-deriving costs nothing).
 */

const PLATFORM_UNIQUE_ID_KEY = "agent-console.platform-unique-id.v1";

/**
 * A stable id for this browser install, minted once and reused on every
 * later sign-in. Falls back to a timestamp-based id when `localStorage`
 * is unavailable (private browsing, blocked site data) or `crypto.
 * randomUUID` does not exist (a non-HTTPS/non-localhost origin) — a
 * same-request-shape id that still lets the sign-in call succeed, at the
 * cost of counting as a "new device" every time, which is the honest
 * consequence of having nowhere to remember one.
 */
export function platformUniqueId(): string {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }

  if (storage !== null) {
    try {
      const existing = storage.getItem(PLATFORM_UNIQUE_ID_KEY);
      if (existing !== null && existing !== "") return existing;
    } catch {
      // Falls through to minting a fresh, unpersisted id below.
    }
  }

  const minted =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `console-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (storage !== null) {
    try {
      storage.setItem(PLATFORM_UNIQUE_ID_KEY, minted);
    } catch {
      // Best effort: this session still signs in with `minted`, it just
      // will not be remembered for the next one.
    }
  }
  return minted;
}

/**
 * "<browser> <platform>", matching the shape bolt-v2's own
 * `NormalizeDeviceName` (auth/gqlserver/customresolvers/resolvers.go)
 * recognises by substring — "Chrome"/"Firefox"/"Safari"/"Edge"/"Brave" —
 * so this console's sessions read as a real browser name in bolt-v2's own
 * active-devices list instead of falling through to "Unknown Browser".
 * Deliberately coarse (no version number): bolt-v2 keys the device LIMIT
 * on `platformUniqueId`, never on this string, so there is nothing riding
 * on it being precise, only legible.
 */
export function platformFriendlyName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

  let browser = "Unknown Browser";
  if (/edg/i.test(ua)) browser = "Microsoft Edge";
  else if (/brave/i.test(ua)) browser = "Brave";
  else if (/firefox/i.test(ua)) browser = "Mozilla Firefox";
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";
  else if (/chrome|chromium/i.test(ua)) browser = "Google Chrome";

  let platform = "";
  if (/windows/i.test(ua)) platform = "Windows";
  else if (/mac os|macintosh/i.test(ua)) platform = "macOS";
  else if (/android/i.test(ua)) platform = "Android";
  else if (/iphone|ipad|ios/i.test(ua)) platform = "iOS";
  else if (/linux/i.test(ua)) platform = "Linux";

  return platform === "" ? browser : `${browser} ${platform}`;
}
