import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
// Test config lives in vitest.config.ts, which takes full priority over
// a `test` block here — Vitest ignores this file's `test` field entirely
// once a standalone vitest.config.ts exists, rather than merging them.
export default defineConfig(({ mode }) => {
  // Only VITE_-prefixed vars reach client code; this reads the raw env so the
  // dev server itself can be configured without exposing the value to the app.
  const env = loadEnv(mode, process.cwd(), '')
  const authUpstream = env.AUTH_PROXY_TARGET
  const gatewayUpstream = env.GATEWAY_PROXY_TARGET

  return {
    plugins: [react()],
    server: {
      proxy: {
        ...(gatewayUpstream
          ? {
              // Same reasoning as the auth proxy below, for the local
              // gateway: it rejects a preflight from this dev origin with
              // 403 because ALLOWED_ORIGINS is not set for local dev.
              // Proxying makes /agent/* same-origin so no preflight is
              // issued and no gateway env has to be tuned per developer.
              // Vite streams responses, so SSE on /agent/run is unaffected.
              //
              // Anchored as a regex, not the bare prefix '/agent'. Vite
              // matches a string key by prefix, and the console's own page
              // routes live at /agents/:id/... — which starts with "/agent".
              // A hard reload on any agent page was therefore proxied to the
              // gateway and answered "Unknown service: config" instead of
              // serving the SPA. '^/agent/' matches the API and not /agents/,
              // because the character after "agent" has to be a slash.
              '^/agent/': { target: gatewayUpstream, changeOrigin: true },
              // Sign-in posts to `${AUTH_URL}/graphql`, which is relative
              // when AUTH_URL falls back to a relative GATEWAY_URL — so the
              // login mutation needs the same treatment as /agent/*.
              '/graphql': { target: gatewayUpstream, changeOrigin: true },
            }
          : {}),
        ...(authUpstream
        ? {
            // Sign-in against a *remote* gateway from a localhost dev server is
            // a cross-origin POST carrying Authorization, so the browser
            // preflights it and the remote refuses unless localhost is in its
            // ALLOWED_ORIGINS. Proxying here makes the request same-origin from
            // the browser's point of view, so no preflight happens and no
            // production CORS config has to change to let one laptop in.
            //
            // Dev only. A deployed console is a real origin and needs a real
            // CORS entry — this is a local convenience, not the answer for prod.
            '/auth-upstream': {
              target: authUpstream,
              changeOrigin: true,
              secure: true,
              rewrite: (path: string) => path.replace(/^\/auth-upstream/, ''),
            },
          }
        : {}),
      },
    },
  }
})
