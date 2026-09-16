import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PhaseSegment } from "./chat/phaseTimeline.ts";
import { GatewayClient } from "./http/gatewayClient.ts";

/**
 * Everything Ask needs from whoever is embedding it — and nothing more.
 *
 * **Why this exists.** Ask used to be a screen of the admin console, wired
 * straight into it: it read the credential from the console's session module,
 * built its HTTP calls from the console's module-level client, pushed phase
 * selections into the console's inspector panel, and rendered a react-router
 * `<Link>` when no agents were set up. Four couplings, each invisible until
 * you try to mount Ask anywhere else — at which point it needs a session
 * store, a router and an inspector it has no business requiring.
 *
 * Every one of those is now an input. Ask imports nothing from outside
 * `src/ask/`, which is what makes it embeddable in bolt-v2's frontend, in
 * `bolt-v2-web`, or in the console — all three supply the same object.
 *
 * Deliberately the same shape the Angular library settled on
 * (`FleetAIChatConfig` in `bolt-ai-angular/projects/fleet-ai-chat`), because
 * it had already worked out the right seams against the same backend: the
 * host owns the credential, the widget owns the conversation.
 */
export interface AskConfig {
  /**
   * agent-service's origin, e.g. `https://ai.restrologic.com`. No trailing
   * slash needed. Never a hardcoded default: an embeddable widget that
   * guesses its own backend is one that silently talks to the wrong
   * environment.
   */
  baseUrl: string;
  auth: AskAuthProvider;
  /**
   * `X-Client`, sent on every call. Defaults to `web`. bolt-v2's own services
   * read this on every operation, so Ask sends it too rather than being the
   * one client that goes quiet.
   */
  clientType?: string;
  /**
   * Words this widget says, for a host whose domain is not the default.
   *
   * The defaults talk about a restaurant business, because that is what the
   * Bolty console is for and that copy was written deliberately. Embedded
   * in bolt-v2's fleet platform the same sentences are simply wrong — an
   * operator looking at vehicles and trips is not asking about discounts at
   * Bandra — and wrong copy reads as a broken integration even when every
   * request succeeds.
   *
   * Overridable rather than neutralised: a generic empty state that mentions
   * nothing concrete is worse than either specific one, because the whole job
   * of this screen before the first question is to show what kind of question
   * to ask.
   */
  copy?: AskCopy;
  /**
   * Where to send someone who has no agents configured yet.
   *
   * A URL rather than a router link, because Ask must not depend on the
   * host's router — the console's is react-router, bolt-v2's is Angular's,
   * and a widget that imports either cannot run in the other. Omitted, the
   * empty state says what is wrong without offering a link that goes nowhere.
   */
  setupAgentsHref?: string;
  /**
   * Pins how much of a run this embed shows, overriding the tenant's own
   * setting in agent-service.
   *
   * Omitted — the normal case — Ask asks agent-service
   * (`/agent/settings/ask`) and uses the tenant's answer, so the same
   * choice holds in bolt-v2's panel and in the console without either
   * being configured twice.
   *
   * Set it only for an embed whose audience differs from the tenant's
   * default: a debugging surface that always wants the machinery, or a
   * customer-facing page that must never show it whatever the tenant
   * chose. A pinned value is never overruled by the server.
   */
  disclosure?: { showReasoning: boolean; showQueryResults: boolean };
}

/**
 * How the host proves who is calling. Ask never stores, decodes, refreshes or
 * persists a credential — it asks for one per request and sends what it gets.
 *
 * Per request, not once at mount: a host may rotate its credential or switch
 * organisation mid-session, and a value captured at construction would keep
 * addressing the previous one.
 */
export interface AskAuthProvider {
  /**
   * The credential for the next request, or null when the host has none.
   *
   * agent-service accepts it as either `X-Api-Key` or `Authorization: Bearer`;
   * Ask sends the latter, which is what its HTTP client already does for
   * every other caller. What the string IS — an API key today — is the host's
   * business, not Ask's.
   */
  getCredential: () => string | null | Promise<string | null>;
  /**
   * The organisation the host is acting as, sent as `Organisation`.
   *
   * A hint, never a grant: agent-service validates it against the caller's
   * real access on every request and refuses anything outside it, which is
   * why it is safe for this to come from the host at all. Omitted, no header
   * is sent and agent-service uses the credential's own organisation.
   */
  getOrganisationId?: () => string | null | undefined;
  /**
   * Called when agent-service refuses the credential. The host decides what
   * that means — the console signs out; an app with its own session may
   * refresh and carry on. Ask does not decide, because only the host knows
   * where the credential came from.
   */
  onUnauthorized?: () => void;
}

export interface AskCopy {
  /** The empty state's heading. */
  emptyTitle?: string;
  /** The empty state's body — examples of what to ask. */
  emptyBody?: string;
  /** The composer's placeholder. */
  placeholder?: string;
}

/** The two things `Thread` needs from a host that has somewhere to show a
 * phase's detail. Narrower than the console's own inspector state on
 * purpose: Ask has no business opening or closing the host's panels. */
export interface AskInspector {
  selection: PhaseSegment | null;
  selectPhase: (segment: PhaseSegment) => void;
}

/**
 * A separate context from `AskConfig`, because the two are provided at
 * different heights and finding that out is what this split records.
 *
 * `AskConfig` is transport — base URL, credential — and the console provides
 * it at the app root, because `ChatProvider` has to sit above the router for
 * a run to survive navigating away from Ask. The inspector is a UI SURFACE,
 * and the console's lives inside `Shell`, below that root. Folding it into
 * the config would mean either hoisting the console's inspector above the
 * shell that owns it, or nesting a second `AskProvider` — and a second
 * provider means a second HTTP client for one page.
 *
 * Optional, and defaulted: a host with nowhere to show a phase provides
 * nothing, the rail still renders, and clicking a phase selects nothing.
 */
const AskInspectorContext = createContext<AskInspector | null>(null);

export function AskInspectorProvider({
  inspector,
  children,
}: {
  inspector: AskInspector;
  children: ReactNode;
}) {
  return (
    <AskInspectorContext.Provider value={inspector}>{children}</AskInspectorContext.Provider>
  );
}

interface AskContextValue {
  config: AskConfig;
  client: GatewayClient;
}

const AskContext = createContext<AskContextValue | null>(null);

/** Selecting nothing, for a host that gave Ask nowhere to put a selection. */
const NO_INSPECTOR: AskInspector = { selection: null, selectPhase: () => {} };

/**
 * Wraps Ask (or any part of it) with its configuration.
 *
 * Builds the HTTP client here, once per config, rather than at module scope.
 * A module-level singleton would mean two Ask instances on one page sharing
 * one base URL and one credential — fine in the console, wrong in a host that
 * embeds Ask twice, and exactly the kind of hidden global this extraction
 * exists to remove.
 */
export function AskProvider({
  config,
  children,
}: {
  config: AskConfig;
  children: ReactNode;
}) {
  const value = useMemo<AskContextValue>(() => {
    const { auth } = config;
    return {
      config,
      client: new GatewayClient({
        baseUrl: config.baseUrl,
        getToken: () => auth.getCredential(),
        getOrganisationId: () => auth.getOrganisationId?.() ?? null,
        clientType: config.clientType,
        // A no-op default rather than a required callback: a host that has
        // nothing to do about a refusal should not have to say so.
        onUnauthorized: () => auth.onUnauthorized?.(),
      }),
    };
  }, [config]);

  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}

function useAskContext(): AskContextValue {
  const ctx = useContext(AskContext);
  if (ctx === null) {
    throw new Error("Ask components must be rendered inside <AskProvider config={…}>");
  }
  return ctx;
}

export function useAskConfig(): AskConfig {
  return useAskContext().config;
}

/**
 * The HTTP client for this Ask instance.
 *
 * Every network call in `src/ask/` goes through the client this returns, so
 * there is exactly one place a base URL or a credential enters the package —
 * and no module-level state for a second instance to collide with.
 */
export function useAskClient(): GatewayClient {
  return useAskContext().client;
}

/**
 * Never throws. A missing inspector is a supported configuration — most
 * hosts have no panel to show a phase in — so this returns a no-op rather
 * than making every host wrap a provider it does not need.
 */
export function useAskInspector(): AskInspector {
  return useContext(AskInspectorContext) ?? NO_INSPECTOR;
}
