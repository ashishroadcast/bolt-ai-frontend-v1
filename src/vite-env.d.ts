/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Gateway origin, e.g. https://api.restrologic.com — see .env.example. */
  readonly VITE_GATEWAY_URL?: string;
  /** bolt-v2's GraphQL endpoint for sign-in — see src/api/config.ts. */
  readonly VITE_BOLTV2_GRAPHQL_URL?: string;
  /** bolt-v2's web app, for "Continue with Bolt" — see src/api/config.ts. */
  readonly VITE_BOLTV2_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
