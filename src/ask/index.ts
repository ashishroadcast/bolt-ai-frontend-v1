/**
 * The Ask package's public surface — everything a host may import, and
 * nothing else.
 *
 * **The rule that makes this package embeddable:** nothing under `src/ask/`
 * imports from outside `src/ask/`. Check that before adding an import, not
 * after — the couplings this extraction removed (a session module, a
 * router, an inspector panel, a shared HTTP singleton) were each invisible
 * until someone tried to mount Ask somewhere else.
 *
 * Hosts today:
 *
 * * the admin console (`src/routes/AskRoute.tsx`), which supplies its own
 *   session, its inspector and a react-router link;
 * * `bolt-v2-web` (Next 16 / React 19), which can import this directly;
 * * `bolt-v2-frontend` (Angular 20), through the custom element in
 *   `element.tsx` — Angular cannot import React, so the component is wrapped
 *   in a `<bolt-ai-ask>` tag instead.
 *
 * The dependency arrow points one way: the console imports the package, the
 * package imports nothing of the console. `GatewayClient` and the error
 * types live here for the same reason — they are generic HTTP plumbing Ask
 * cannot do without, so the console imports them back rather than the
 * package reaching out for them.
 */

export { Ask, AskScreen, type AskProps } from "./Ask.tsx";
export { AgentIcon, type AgentIconProps } from "./AgentIcon.tsx";
// The conversation, separately from the screen. A host that needs a run to
// survive navigation (the console does) mounts this above its router and
// renders `AskScreen` at the route; a host that does not use `Ask`.
export { ChatProvider, useChatContext } from "./chat/ChatContext.tsx";
export {
  AskInspectorProvider,
  AskProvider,
  useAskClient,
  useAskConfig,
  useAskInspector,
  type AskAuthProvider,
  type AskConfig,
  type AskInspector,
} from "./config.tsx";

// The HTTP core. Exported because the console builds its own client from it
// for its admin screens — the package owns the class, not the instance.
export {
  AgentApiError,
  GatewayClient,
  stringDetailMessage,
  type GatewayClientOptions,
} from "./http/gatewayClient.ts";
export {
  describeHttpError,
  ForbiddenError,
  GatewayError,
  NetworkError,
  RateLimitedError,
  UnauthorizedError,
} from "./http/errors.ts";

// Types a host may need to talk about what Ask reports. `PhaseSegment` in
// particular is what `AskConfig.inspector` hands back, so a host that shows
// phase detail has to be able to name it.
export type { PhaseSegment } from "./chat/phaseTimeline.ts";
export type { AskAgent } from "./chat/useAskAgents.ts";
