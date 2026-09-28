/**
 * How this browser introduces itself to bolt-v2 when it signs in.
 *
 * bolt-v2 counts active sessions per account against a device limit and lists
 * them under Settings › Security by these two values, so they have to be
 * stable (one entry per browser, not one per sign-in) and recognisable (a
 * person deciding which session to end has to be able to tell this one
 * apart from their phone).
 *
 * The id lives in `localStorage` under the console's own name, not bolt-v2's
 * `platformUniqueId`: the two apps run on different origins, so they could
 * not share one anyway, and signing out of either must never end the
 * other's session.
 */
const DEVICE_ID_KEY = "agent-console.device-id";

let fallbackId: string | null = null;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function platformUniqueId(): string {
  try {
    const stored = window.localStorage.getItem(DEVICE_ID_KEY);
    if (stored !== null && stored !== "") return stored;
    const id = newId();
    window.localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // Storage blocked: stable for this page's life, which is the most that
    // can be promised without it.
    fallbackId ??= newId();
    return fallbackId;
  }
}

function browserName(userAgent: string): string {
  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("Firefox/")) return "Firefox";
  if (userAgent.includes("Chrome/")) return "Chrome";
  if (userAgent.includes("Safari/")) return "Safari";
  return "Browser";
}

function osName(userAgent: string): string {
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Android/i.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "";
}

/** e.g. "Bolty console · Chrome on Windows". */
export function platformFriendlyName(): string {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = osName(userAgent);
  return `Bolty console · ${browserName(userAgent)}${os ? ` on ${os}` : ""}`;
}
