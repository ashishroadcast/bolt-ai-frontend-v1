import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Builds `<bolt-ai-ask>` — one self-contained file that embeds Ask in any
 * host, React or not. See `src/ask/element.tsx` for why a custom element
 * rather than an iframe or a second Angular implementation.
 *
 *     npm run build:element   ->   packages/ask-element/dist/bolt-ai-ask.js
 *
 * Separate from `vite.config.ts` (which builds the console) because the two
 * are different products from one source tree: the console is an app with an
 * index.html and a router, this is a library with one global side effect.
 */

/**
 * Folds the bundle's CSS into its JS, retargeted for a shadow root.
 *
 * Two problems, one plugin:
 *
 * 1. **The CSS has to be a STRING at runtime.** The element injects it into
 *    its shadow root, and a shadow root cannot see a `<link>` in the host's
 *    head. CSS-module output does not exist until after bundling, so there
 *    is nothing to `import` at authoring time — hence the placeholder in
 *    `element.tsx` and this substitution.
 *
 * 2. **`:root` does not match inside a shadow root.** All 200-odd design
 *    tokens are declared on `:root` in `styles/tokens.css`, which inside a
 *    shadow tree matches nothing at all — every colour, font and spacing
 *    value would resolve to its initial value and the widget would render
 *    unstyled. `:host` is the shadow-root equivalent, so the selector is
 *    rewritten on the way through.
 *
 * Rewritten HERE rather than by editing `tokens.css`, because that file is
 * also the console's, where `:root` is correct. One build target's quirk
 * does not get to change the source both targets share.
 */
function inlineShadowStyles(): Plugin {
  return {
    name: "inline-shadow-styles",
    // Vite's own CSS plugin emits the stylesheet asset in ITS generateBundle;
    // without this the hook below runs first and finds nothing (observed: the
    // placeholder was replaced with an empty string and the widget rendered
    // unstyled).
    enforce: "post",
    // After the CSS asset exists, before it is written out.
    generateBundle(_options, bundle) {
      let css = "";
      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type === "asset" && fileName.endsWith(".css")) {
          css += typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8");
          // Dropped from the output: nothing loads it, and shipping a
          // stylesheet a host might helpfully add to its head is how the
          // isolation this whole approach exists for gets undone.
          delete bundle[fileName];
        }
      }

      // Word-boundary-free on purpose: `:root` cannot be a prefix of a
      // longer valid selector, so a plain global replace is exact.
      css = css.replaceAll(":root", ":host");

      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk" && chunk.code.includes("__ASK_SHADOW_STYLES__")) {
          chunk.code = chunk.code.replace(
            /"__ASK_SHADOW_STYLES__"|'__ASK_SHADOW_STYLES__'/,
            JSON.stringify(css),
          );
        }
      }
    },
  };
}

/**
 * The package's own version, baked into the bundle as `__ASK_ELEMENT_VERSION__`
 * and sent as `X-Ask-Element-Version` (see `src/ask/config.tsx`).
 *
 * Read from `package.json` at build time rather than imported by the source:
 * nothing under `src/ask/` may import from outside it, and the version belongs
 * to this build target, not to the code — the console built from the same
 * source is not version 1.3.x of anything.
 */
const elementVersion = (
  JSON.parse(readFileSync(new URL("./packages/ask-element/package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export default defineConfig({
  plugins: [react(), inlineShadowStyles()],
  // React (and several of its dependencies) branch on `process.env.NODE_ENV`
  // at RUNTIME. An app build gets this defined for free; a LIBRARY build does
  // not, so the bundle threw `ReferenceError: process is not defined` on load
  // and the element mounted nothing — an empty tag and one console error.
  // Caught by actually loading it in a page; no test would have.
  //
  // Pinned to "production" rather than following `mode`: this artifact only
  // ever exists to be embedded in someone else's app, and shipping React's
  // development build into a host drags its whole warning apparatus along
  // (and, here, 540kB of it — the bundle halved when this was set).
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __ASK_ELEMENT_VERSION__: JSON.stringify(elementVersion),
  },
  // No `public/`. That directory is the CONSOLE's — its favicon was being
  // copied into the package and published as though the widget had one, which
  // a widget cannot: it has no document of its own.
  publicDir: false,
  build: {
    // Into the npm package, not a bare `dist-element/`. The artifact used to
    // be copied by hand into each consumer's own static assets, which meant a
    // checked-in duplicate per host and a hand-bumped `?v=` query to defeat
    // the cache. As a package it is a versioned dependency instead: consumers
    // `npm install` it, their bundler hashes it, and `packages/ask-element`'s
    // `version` is the only thing to bump.
    outDir: "packages/ask-element/dist",
    // Only `dist/` — the package's `package.json`, README and `index.d.ts`
    // are hand-written sources that live beside it and must survive a build.
    emptyOutDir: true,
    lib: {
      entry: "src/ask/element-entry.ts",
      name: "BoltAiAsk",
      // ES only. Every host that can render a custom element can load a
      // module, and a UMD build would additionally need a global name for a
      // library whose entire public surface is a side effect.
      formats: ["es"],
      fileName: () => "bolt-ai-ask.js",
    },
    // One file. React and every dependency are BUNDLED IN, deliberately: the
    // host is Angular and has no React to share, and a peer dependency that
    // the host cannot satisfy is not a dependency, it is a runtime error.
    rollupOptions: { external: [] },
    // One stylesheet for the plugin above to find, rather than one per
    // dynamic chunk.
    cssCodeSplit: false,
    // Readable enough to debug inside a host app's devtools without a
    // sourcemap hunt, and the widget is not on a latency budget where the
    // last few kilobytes matter.
    minify: true,
    sourcemap: true,
    target: "es2022",
  },
});
