# `@roadcast/ask-element`

Ask — the assistant surface from the Bolty console — as a `<bolt-ai-ask>`
custom element. One self-contained ES module: React, every dependency, and
all of the widget's CSS are bundled in.

Built from `src/ask/` in this repo by `npm run build:element`. **Do not edit
`dist/` — it is generated.**

## Install

Published to **GitHub Packages**, not the public registry — it is a
first-party, `UNLICENSED` component. A consumer therefore needs the scope
pointed at that registry once, in its own `.npmrc`:

```
@roadcast:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

then:

```
npm install @roadcast/ask-element
```

The token needs `read:packages` only. Without the scope line the install fails
against npmjs.com with a 404, which reads as "no such package" rather than
"wrong registry" — so that is the first thing to check.

## Use

```ts
import '@roadcast/ask-element';           // registers <bolt-ai-ask>
import type { BoltAiAskElement } from '@roadcast/ask-element';

const ask = document.createElement('bolt-ai-ask');
ask.baseUrl = 'https://bolt-ai.example.com';
ask.credentialProvider = () => tokens.fresh();   // called per request
ask.organisationProvider = () => store.orgId();
document.body.append(ask);
```

The import is a **side effect** — it defines the element and returns nothing
you need. In a host that code-splits, `await import('@roadcast/ask-element')`
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

**Automatic.** `.github/workflows/publish-ask-element.yml` publishes on every
push that touches `src/`, this package, or the element's vite config. A
consumer on `^1.0.0` picks the new build up with `npm install` — there is
nothing to copy by hand.

The published version is `major.minor` from the `version` field here, with the
**patch taken from the CI run number**. So `version` in this file is not what
ships: it is the source of truth for the first two numbers only. Bump it by
hand for a feature or a breaking change; leave the patch alone.

Publishing from a laptop is not the path, and `npm publish` here will be
rejected by the registry as a duplicate version more often than not. If a run
fails, re-run the workflow (`workflow_dispatch`) rather than publishing
locally — a hand-published version the workflow does not know about makes the
run number ambiguous.

`npm run pack:element` still produces a tarball, for a consumer that cannot
reach the registry at all.
