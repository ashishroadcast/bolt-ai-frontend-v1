import { useEffect, useRef, useState, type RefObject } from "react";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileGlobal {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  /** Tears a rendered widget down by the id `render` returned. Without this
      the widget outlives the React tree that owned it — see the effect. */
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("turnstile script failed to load"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileState {
  /** Ref to hand to the container element the widget renders into. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The captcha token to send with login — "" until solved (or always, if unconfigured). */
  token: string;
  /** True once there is a token to send (or immediately, when no site key is configured). */
  ready: boolean;
  error: string | null;
  /** Present only when a widget should be rendered at all. */
  siteKey: string | undefined;
}

/**
 * Cloudflare Turnstile. `login`'s `captchaToken` is a required field
 * (auth/graph/auth.graphqls) enforced by pkg/turnstile/verify.go — it
 * accepts an empty token outside APP_ENVIRONMENT=production (or whenever
 * TURNSTILE_SECRET is unset), which is why this is a no-op returning ""
 * when VITE_TURNSTILE_SITE_KEY is unset: local/staging sign-in works with
 * no widget. A production deploy needs the site key set here *and* the
 * matching secret set on auth — setting only one fails sign-in closed
 * with a visible "invalid captcha" error rather than silently.
 */
export function useTurnstile(): TurnstileState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(!SITE_KEY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!SITE_KEY) return;
    const siteKey = SITE_KEY;
    let cancelled = false;
    let widgetId: string | undefined;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || containerRef.current === null || !window.turnstile) return;
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (solvedToken) => {
            setToken(solvedToken);
            setReady(true);
          },
          "expired-callback": () => {
            setToken("");
            setReady(false);
          },
          "error-callback": () => {
            setError("The verification widget failed. Reload the page and try again.");
          },
        });
      })
      .catch(() => {
        if (!cancelled) setError("The verification widget failed to load. Reload the page and try again.");
      });

    return () => {
      cancelled = true;
      // Remove the widget, do not just stop listening. Cloudflare's script
      // keeps its own registry keyed by the id `render` returned, and a
      // widget left in it outlives the React tree that owned it. The next
      // mount then renders a SECOND widget into the same container, and the
      // orphan is what produces "Cannot find Widget cf-chl-widget-…,
      // consider using turnstile.remove() to clean up a widget" — its
      // callback never fires again, so `token` stays "" and sign-in can
      // never be submitted.
      //
      // This route remounts far more than it looks: every 401 that ends a
      // session sends the user back here, so the second sign-in of any
      // session was the broken one. A hard reload cleared it, which is what
      // made it look intermittent rather than a lifecycle bug.
      if (widgetId !== undefined) {
        try {
          window.turnstile?.remove(widgetId);
        } catch {
          // Already gone (the script tore it down with the container, or a
          // reload replaced the registry). Nothing to clean up, and throwing
          // out of a cleanup would take the unmount down with it.
        }
      }
    };
  }, []);

  return { containerRef, token, ready, error, siteKey: SITE_KEY };
}
