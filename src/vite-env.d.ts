/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Gateway origin, e.g. https://api.restrologic.com — see .env.example. */
  readonly VITE_GATEWAY_URL?: string;
  /** Cloudflare Turnstile site key — see src/auth/useTurnstile.ts. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
