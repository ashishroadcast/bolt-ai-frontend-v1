import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (rather than merged into it) so the app
// build stays untouched by test-only concerns. CSS Modules are left
// unprocessed (default `css: false`): Vitest's identity mock means
// `styles.foo === "foo"` on both sides of a test, which is enough to
// assert a component applied the right class — tests that need to prove
// a *rule* still exists read the .module.css source directly instead of
// relying on jsdom's limited CSS engine to compute it.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // `.env.local` sets VITE_GATEWAY_URL=/ so the Vite dev server can proxy
    // /agent and /graphql same-origin (vite.config.ts's own comment on
    // gatewayUpstream) — correct for `vite dev`, wrong here: Vitest still
    // picks up `.env.local` despite Vite's docs describing test mode as
    // exempt, so every gatewayClient-backed test saw `GATEWAY_URL` resolve
    // to "" (a relative path `new Request()` cannot parse with no document
    // origin) instead of `src/api/config.ts`'s documented localhost
    // fallback. Forced back to that fallback here rather than in
    // config.ts, which must keep reading `import.meta.env` for the real
    // app to work — this is a test-environment-only correction.
    env: { VITE_GATEWAY_URL: "http://localhost:8080" },
  },
});
