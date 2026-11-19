# `whitelight-bolty`

## Whitelight (WFM) build

Published publicly on npm as `whitelight-bolty` (an unscoped name: no npm org), so
`npm install whitelight-bolty` needs no token. The bundle holds no hosts or keys: the
Bolty URL and the user's token are given at runtime by the host page.

Publish (the npm account that owns the package): bump `version` here, then
`npm run build:element && cd packages/ask-element && npm publish`.

Wiring that WFM depends on (see whitelight-angular `src/app/pages/bolty-panel/`):

- `base-url` is Bolty's URL. bolt-ai-v1 picks the WFM deployment from the request's
  `Origin` (or `Referer`), so the web app's origin must be listed in its
  `WHITELIGHT_DEPLOYMENTS_JSON`, and allowed by its CORS setting when it differs.
- `credentialProvider` returns the user's token; a leading `Bearer ` and `""` are handled.
- `organisationProvider` returns `String(selectedUserId)`, the acting user; call
  `resetScope()` when it changes.
- `onUnauthorized` must not log the user out of WFM.
- `draftAccess = { dashboard: false, form: false }`: bolt-v2's drafting is not in WFM.
- A 403 means: site not configured, user outside the caller's tree, or Bolty switched off
  (`user_configuration.more.enable_bolty`).

Ask — the assistant surface from the Bolty console — as a `<bolt-ai-ask>`
custom element. One self-contained ES module: React, every dependency, and
all of the widget's CSS are bundled in.

Built from `src/ask/` in this repo by `npm run build:element`. **Do not edit
`dist/` — it is generated.**

## Install

```
npm install @roadcast/whitelight-bolty
```

## Use

```ts
import '@roadcast/whitelight-bolty';           // registers <bolt-ai-ask>
import type { BoltAiAskElement } from '@roadcast/whitelight-bolty';

const ask = document.createElement('bolt-ai-ask');
ask.baseUrl = 'https://bolt-ai.example.com';
ask.credentialProvider = () => tokens.fresh();   // called per request
ask.organisationProvider = () => store.orgId();
document.body.append(ask);
```

The import is a **side effect** — it defines the element and returns nothing
you need. In a host that code-splits, `await import('@roadcast/whitelight-bolty')`
at the moment the widget is first shown keeps ~1.1MB out of the entry chunk.

`index.d.ts` is the contract; everything settable is documented there.

## Credential refresh

```ts
ask.refreshCredential = () => tokenRefresh.forceRefresh(); // resolves the new token, or null
```

Called after a 401, and when `credentialProvider` returns null. The refused
request is retried once, reading `credentialProvider` again. A 403 (a missing
permission) is never retried and never reaches `onUnauthorized`; the widget
says "You don't have permission to use the assistant" itself.

## Conversation and organisation

```ts
// Restore the open conversation after a reload.
ask.addEventListener('conversationchange', (e) => store.save(e.detail.conversationId));
ask.setAttribute('conversation-id', String(store.load()));

ask.newConversation(); // same as the header's "New conversation"
ask.clearAgent();      // disarm a slash-armed agent, keep the thread
ask.resetScope();      // after an organisation switch: drop thread, agents, settings
```

Changing the `organisation-id` attribute calls `resetScope()` by itself. A
host that uses `organisationProvider` must call it, since the element cannot
see a function's answer change.

## Keyboard

Keys typed into the widget's own fields stop at its shadow root, so host
shortcuts (Ctrl+Z, arrow keys) do not fire while someone is typing a question.
Escape still reaches the host.

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

1. `npm run build:element` in `bolt-ai-frontend/`. The bundle sends its
   version as `X-Ask-Element-Version`, which agent-service's CORS
   `allow_headers` must list. Until it does, the widget's first request fails
   its preflight and is re-sent without the header, so it works but logs one
   CORS error per page load.
2. Bump `version` here — consumers pin it, and this is what replaced the
   hand-bumped `?v=` cache-buster the raw asset needed.
3. Publish, or `npm run pack:element` for a tarball.
