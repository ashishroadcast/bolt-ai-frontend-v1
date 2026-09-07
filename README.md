# agent-console

React SPA for the agent console: Vite + React + TypeScript, strict mode. Static bundle only —
no Next.js, no Node tier at runtime. See `docs/superpowers/plans/2026-08-27-agent-console-design-and-build.md`
for the design direction and build order.

```bash
npm install
npm run dev      # local dev server
npm run build    # tsc -b && vite build -> dist/
```

Design tokens (palette, type, layout scale) live in `src/styles/tokens.css` — components read
these custom properties, never a literal colour or font stack.
