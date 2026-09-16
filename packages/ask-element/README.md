# `@bolt-ai/ask-element`

Ask — the assistant surface from the Bolty console — as a `<bolt-ai-ask>`
custom element. One self-contained ES module: React, every dependency, and
all of the widget's CSS are bundled in.

Built from `src/ask/` in this repo by `npm run build:element`. **Do not edit
`dist/` — it is generated.**

## Install

```
npm install @bolt-ai/ask-element
```

## Use

```ts
import '@bolt-ai/ask-element';           // registers <bolt-ai-ask>
import type { BoltAiAskElement } from '@bolt-ai/ask-element';

const ask = document.createElement('bolt-ai-ask');
ask.baseUrl = 'https://bolt-ai.example.com';
ask.credentialProvider = () => tokens.fresh();   // called per request
ask.organisationProvider = () => store.orgId();
document.body.append(ask);
```

The import is a **side effect** — it defines the element and returns nothing
you need. In a host that code-splits, `await import('@bolt-ai/ask-element')`
at the moment the widget is first shown keeps ~1.1MB out of the entry chunk.

`index.d.ts` is the contract; everything settable is documented there.

## Sizing

The element is `display: block` and fills what the host gives it. Ask's
layout is a column with a scrolling middle, so **the host must give it a
definite height** — inside a flex column, that means an ancestor with
`min-height: 0`. Given no height, the thread grows instead of scrolling.

## Isolation

Styles live in a shadow root. Nothing leaks in, nothing leaks out — the host's
CSS framework cannot restyle the widget and the widget's ~200 design tokens
cannot restyle the host. The cost is that the host's webfonts do not reach
inside either, so type falls back to system faces unless the host loads the
same families.

## Releasing

1. `npm run build:element` in `bolt-ai-frontend/`
2. Bump `version` here — consumers pin it, and this is what replaced the
   hand-bumped `?v=` cache-buster the raw asset needed.
3. Publish, or `npm run pack:element` for a tarball.
