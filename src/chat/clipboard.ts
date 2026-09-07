/**
 * The one place that calls `navigator.clipboard.writeText` — every copy
 * affordance in this console (per-message Copy, the history panel's Share
 * link) goes through this instead of calling the browser API directly, so
 * "what counts as a copy failure" is answered once.
 *
 * The async Clipboard API fails two ways that are not exceptional at all in
 * this app's real usage: a non-secure context (plain `http://`, common for
 * a local console reached over the LAN rather than `localhost`) drops
 * `navigator.clipboard` entirely in most browsers rather than exposing a
 * rejecting method, and a user who denied the clipboard permission gets a
 * `NotAllowedError` rejection from `writeText` itself. Both collapse to the
 * same `false` here rather than two call sites each guessing at their own
 * error handling — a caller that gets `false` shows a visible fallback
 * (task brief: "a copy button that does nothing is worse than none"), and
 * doesn't need to know which of the two happened to do that.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
