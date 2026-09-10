/**
 * The `<bolt-ai-ask>` bundle's entry point.
 *
 * Separate from `element.tsx` so this file can own the STYLE imports. The
 * element itself must not import CSS — it reads the bundled result out of a
 * build-time placeholder — but something has to pull the stylesheets into
 * the graph so Vite emits them at all, and an entry point is the honest
 * place for that.
 *
 * Order matters and is the same as `main.tsx`'s: tokens first (they define
 * the custom properties everything else reads), then the global reset, then
 * the :host rules that stand in for the body `global.css` styles, then
 * whatever the components themselves import. `vite.element.config.ts`
 * concatenates the lot into one sheet and rewrites `:root` to `:host`,
 * because a shadow root has no `:root` to match.
 */

import "../styles/tokens.css";
import "../styles/global.css";
import "./element.css";
import "./element.tsx";

export { BoltAiAskElement, defineBoltAiAsk } from "./element.tsx";
