import { useEffect, useState } from "react";

/**
 * Whether the browser itself currently has a network connection —
 * `navigator.onLine`, kept live via the `online`/`offline` window events.
 *
 * This is Figma's "Network connection lost" state (`AI assistant -
 * Network lost`): the composer disables and its placeholder changes to
 * "Waiting for connection…" the moment the browser reports it has none,
 * and returns to normal the moment it reconnects. It says nothing about
 * whether `agent-service` itself is reachable — that failure already
 * surfaces per-run as `runSummary.status === "error"` — only about the
 * one condition where asking a question can't even be attempted.
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    function goOnline() {
      setIsOnline(true);
    }
    function goOffline() {
      setIsOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return isOnline;
}
