import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { elementDefine, inlineShadowStyles } from "./vite.element.config.ts";

/**
 * Builds `/embed/mobile/` — Ask for native apps' WebViews (Android, iOS,
 * React Native) — into the console's `dist/`, so a console deploy ships it:
 *
 *     npm run build   ->   dist/embed/mobile/index.html
 *                          dist/embed/mobile/assets/ask-<hash>.js
 *
 * It bundles the same `<bolt-ai-ask>` as `vite.element.config.ts` (and uses
 * its plugin and constants) plus `src/embed/mobile/main.ts`, the native
 * bridge. See `src/embed/mobile/bridge.ts` for the protocol apps implement.
 *
 * Runs AFTER the console build, into the same `dist/`, so it must not empty it.
 */

const OUT = "embed/mobile";

/**
 * Names the bundle after its FINAL content and writes the page around it.
 *
 * Rollup hashes a chunk before `inlineShadowStyles` swaps the stylesheet into
 * it, so its own `[hash]` misses CSS-only changes — and this file is served
 * `immutable`, so a stale name would pin every app to old styles. Hashing the
 * finished code here is what makes the long cache safe.
 */
function embedPage(gatewayUrl: string): Plugin {
  const gatewayOrigin = new URL(gatewayUrl, "http://localhost").origin;
  return {
    name: "embed-mobile-page",
    enforce: "post",
    generateBundle: {
      // After every other plugin's generateBundle — inlineShadowStyles'
      // included, or this would publish the bundle before its styles are in.
      order: "post",
      handler(_options, bundle) {
        const entries = Object.values(bundle).filter(
          (file) => file.type === "chunk" && file.isEntry,
        );
        const chunks = Object.values(bundle).filter(
          (file) => file.type === "chunk",
        );
        if (entries.length !== 1 || chunks.length !== 1) {
          this.error(
            `expected one self-contained chunk, got ${chunks.length} (${entries.length} entries)`,
          );
        }
        const chunk = entries[0];
        if (chunk.type !== "chunk") return;
        if (chunk.code.includes("__ASK_SHADOW_STYLES__")) {
          this.error(
            "the widget's styles were not inlined (inlineShadowStyles did not run first)",
          );
        }

        const hash = createHash("sha256")
          .update(chunk.code)
          .digest("hex")
          .slice(0, 10);
        const fileName = `${OUT}/assets/ask-${hash}.js`;
        delete bundle[chunk.fileName];
        this.emitFile({ type: "asset", fileName, source: chunk.code });

        const csp = [
          "default-src 'self'",
          `connect-src ${gatewayOrigin}`,
          "script-src 'self'",
          // The page's own <style>, and the widget's <style> fallback where
          // adoptedStyleSheets is missing.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; ");
        const html = readFileSync("src/embed/mobile/index.html", "utf8")
          .replace(/<!--[\s\S]*?-->\n/, "")
          .replaceAll("%ENTRY%", `/${fileName}`)
          .replaceAll("%GATEWAY_ORIGIN%", gatewayOrigin)
          .replaceAll("%CSP%", csp);
        this.emitFile({
          type: "asset",
          fileName: `${OUT}/index.html`,
          source: html,
        });
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  // Same source as the console's `src/api/config.ts` (GATEWAY_URL), which the
  // page itself uses; read here only to scope the CSP and the preconnect.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const gatewayUrl = env.VITE_GATEWAY_URL || "http://localhost:8080";

  return {
    plugins: [react(), inlineShadowStyles(), embedPage(gatewayUrl)],
    define: elementDefine,
    publicDir: false,
    build: {
      outDir: "dist",
      emptyOutDir: false,
      // One stylesheet for inlineShadowStyles to fold into the one chunk.
      cssCodeSplit: false,
      target: "es2022",
      sourcemap: false,
      rollupOptions: {
        input: "src/embed/mobile/main.ts",
        output: { entryFileNames: `${OUT}/assets/[name].js` },
      },
    },
  };
});
