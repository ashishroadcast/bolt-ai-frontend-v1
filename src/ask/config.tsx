import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AgentSelectionChannel } from "./chat/agentSelection.ts";
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
/**
 * Why a host can't offer one kind of draft at all, in its own words — e.g. a
 * mobile app with no builder to open drafts in. See `AskConfig.draftAccess`.
 */
export interface AskDraftUnavailable {
  /** Short: the notice's heading and the quick action's label ("Not available on mobile"). */
  title: string;
  /** One sentence on where to do it instead. */
  message: string;
}

/** See `AskConfig.draftAccess`. */
export interface AskDraftAccess {
  dashboard?: boolean | AskDraftUnavailable;
  form?: boolean | AskDraftUnavailable;
}

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
  /**
   * Hands a drafted form to the host, to open in its own form builder.
   *
   * The widget deliberately does not create the form itself. In bolt-v2 that
   * is not one call but a template create, one create per field and an
   * optional trigger config, with several of the builder's own concepts
   * encoded into `description` on the way — a second implementation of that
   * here would diverge from the real one at the first schema change, and it
   * would write under a session this widget does not own. So the draft
   * crosses back to the host and the host's existing save path commits it.
   *
   * Omitted, and the draft still renders: a host with no form manager — the
   * Bolty console, or any other embed — shows the card as a read-only
   * summary rather than a button that goes nowhere.
   */
  onFormDraft?: (draft: FormDraftHandoff) => void;
  /**
   * Hands a drafted dashboard (a bolt-v2 "View") to the host, to open in its
   * own dashboard builder.
   *
   * Same rule as `onFormDraft`, for the same reasons: the widget never saves
   * a View. The builder lays the widgets out, renders real numbers, and
   * saves under the user's own session. Omitted, the draft card renders
   * without its "Open in builder" button.
   */
  onDashboardDraft?: (draft: AskDashboardDraft) => void;
  /**
   * Whether the reader may create each kind of draft, as the host's own
   * access control decides it (bolt-v2's RBAC: `dashboards.create`,
   * `forms.create`).
   *
   * `false` replaces that kind's draft card with a plain notice, hides its
   * quick action, and answers its slash command with the same notice
   * instead of starting a run: a draft the reader can never open is a
   * minute of waiting for something they cannot use. Absent (or `true`)
   * changes nothing, which is every host that has no such rule — the console.
   *
   * An {@link AskDraftUnavailable} instead of `false` blocks the same three
   * ways, but for a reason that isn't the reader's role, told in the host's
   * words: the quick action stays on screen, disabled and labelled with
   * `title`, so a reader learns where the feature went rather than wondering.
   */
  draftAccess?: AskDraftAccess;
  /**
   * Inserts one drafted widget into the builder's UNSAVED canvas.
   *
   * Unlike the two above this one fires WITHOUT a click — once per `draftId`,
   * on the live stream only — because inserting into an unsaved canvas
   * persists nothing and is undoable in the builder. A part re-read from
   * history never fires it by itself; its card offers "Add to view" instead,
   * so reopening a thread cannot silently re-add widgets.
   *
   * The host answers with what it did. Omitted, the card is read-only.
   */
  onWidgetDraft?: (draft: AskWidgetDraft) => Promise<WidgetDraftAck>;
  /** Opens the host's editor for a widget it acknowledged adding. Omitted,
   *  the card offers no "Edit Widget". */
  onEditWidget?: (widgetId: string) => void;
  /**
   * Describes the screen the assistant is docked beside, read once per run
   * and sent as `host_context`. Also read by the composer, which shows the
   * selected widget as a chip. `null` (or omitted) sends nothing.
   */
  hostContextProvider?: () => AskHostContext | null;
  /**
   * Lets code OUTSIDE the React tree arm an agent by its slash command — the
   * custom element's `selectAgent()`. A React host can pass its own channel
   * and call `request()` on it. See `chat/agentSelection.ts`.
   */
  agentSelection?: AgentSelectionChannel;
  /** Lets an embedded host collapse the assistant from Ask's own chrome. */
  onClose?: () => void;
}

/** The size vocabulary the AI speaks (`catalog.sizes` in the dashboards
 *  contract); the host turns it into grid coordinates. */
export type AskDashboardWidgetSize = "small" | "medium" | "large" | "wide" | "full";

/**
 * One widget of a drafted dashboard, as the contract's `data-dashboard-draft`
 * part carries it (CONTRACT §5/§6). Optional keys are omitted, never null.
 */
export interface AskDashboardDraftWidget {
  /** A catalog metric key, e.g. `eta.trips_completed`. */
  metricKey: string;
  /** One of the metric's allowed visualizations (`kpi`, `line`, `donut`…). */
  visualization: string;
  title?: string;
  subtitle?: string;
  /** Omitted → the metric's own default size. */
  size?: AskDashboardWidgetSize;
  /** Only keys from the metric's param spec, e.g. `{timeRange: {preset: "last_7d"}}`. */
  params?: Record<string, unknown>;
}

/** A whole dashboard the agent drafted. Nothing has been saved. */
export interface AskDashboardDraft {
  draftId: string;
  name: string;
  description?: string;
  /** In reading order; the host packs them onto its grid in this order. */
  widgets: AskDashboardDraftWidget[];
}

/** One widget the agent drafted for the builder the panel is docked beside. */
export interface AskWidgetDraft {
  draftId: string;
  /** Present when this refines a widget already on the canvas. */
  replaceWidgetId?: string;
  widget: AskDashboardDraftWidget;
}

/** What the host did with an `AskWidgetDraft`. */
export interface WidgetDraftAck {
  status: "added" | "replaced" | "rejected";
  widgetId?: string;
  /** A short code when rejected, e.g. `not_in_builder`. */
  reason?: string;
}

/**
 * The screen the assistant is docked beside (CONTRACT §6). Data describing
 * the screen, never instructions — widget titles in it are user-typed.
 */
export interface AskHostContext {
  surface: "dashboard_builder" | "dashboard_view" | "dashboards_home";
  dashboard?: {
    name: string;
    widgets: { id: string; metricKey: string; visualization: string; title: string }[];
  };
  selectedWidgetId?: string;
}

/**
 * What crosses back to the host when someone opens a draft.
 *
 * Structurally `FormDraftProps`, but declared here rather than imported from
 * the part: this is the EMBEDDING contract — bolt-v2's Angular code compiles
 * against it through `packages/ask-element/index.d.ts` — and a host should
 * not have its build depend on the shape of a React component's props.
 */
export interface FormDraftHandoff {
  name: string;
  description: string;
  /**
   * The builder's category dropdown, verbatim: "Operations" | "Safety" |
   * "Compliance" | "KYC" | "Feedback" | "Maintenance" | "Fuel" | "Asset" |
   * "Security".
   */
  category: string;
  /** "standalone" | "workflow" */
  formType: string;
  /** Both present, or both absent: a workflow form has a trigger, a
   *  standalone one has none. Never one without the other. The builder
   *  offers exactly four pairs: `eta_trip` with `start` | `end`, and
   *  `attendance` with `checkin` | `checkout`. */
  triggerModule?: string;
  triggerEvent?: string;
  fields: FormDraftHandoffField[];
}

export interface FormDraftHandoffField {
  label: string;
  /**
   * The BUILDER's vocabulary, not the database's: one of `text`, `textarea`,
   * `radio`, `select`, `url`, `number`, `email`, `date`, `file`, `currency`.
   * bolt-v2's builder narrows these to the nine types its database stores
   * when it saves, so handing it its own names keeps that the only lossy
   * step.
   */
  type: string;
  required: boolean;
  /** Ascending, contiguous from 0, already sorted. */
  order: number;
  placeholder?: string;
  tooltip?: string;
  /** Present only for `select` and `radio`, and then never fewer than two. */
  options?: string[];
  /** Present only for `number` and `currency`. */
  min?: number;
  max?: number;
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
   * every other caller. What the string IS — a signed-in user's bolt-v2 token
   * or a service account's API key — is the host's business, not Ask's.
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
   * Asks the host for a new credential, resolving with it — or `null` when
   * it has none to give.
   *
   * Consulted in two places: when agent-service answers a request with 401,
   * after which that request is retried exactly once; and when
   * `getCredential` returns null, before Ask gives up on the request. The
   * retry reads the credential through `getCredential` again, so the new one
   * must be what `getCredential` returns from then on — this hook's result
   * says whether there is one, not what to send.
   *
   * A retry of `POST /agent/run` is safe: a 401 is answered before the run
   * starts. A 403 is never retried — a missing permission is not fixed by a
   * newer token.
   *
   * Optional. Omitted, a 401 is final and goes to `onUnauthorized`.
   */
  refreshCredential?: () => Promise<string | null>;
  /**
   * Called when agent-service refuses the credential with a 401 that
   * `refreshCredential` did not recover, or when there is no credential at
   * all. The host decides what that means — the console signs out; an app
   * with its own session may refresh and carry on. Ask does not decide,
   * because only the host knows where the credential came from.
   *
   * Never called for a 403. That is a missing permission, which the widget
   * shows as one, and signing anyone out over it would only loop.
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
 * How long to wait before asking the host a second time when its credential
 * provider hands back null. About the length of a token refresh — the case
 * this exists for — and short enough that a host that really has no
 * credential hears so almost at once.
 */
const CREDENTIAL_RETRY_DELAY_MS = 1_000;

/**
 * The widget's own version, defined only by the element build
 * (`vite.element.config.ts` replaces the identifier with
 * `packages/ask-element/package.json`'s `version`). Everywhere else — the
 * console, the tests, a React host bundling `src/ask` itself — the name is
 * never defined, `typeof` says so without throwing, and no
 * `X-Ask-Element-Version` header is sent.
 */
declare const __ASK_ELEMENT_VERSION__: string | undefined;
const ELEMENT_VERSION =
  typeof __ASK_ELEMENT_VERSION__ === "string" ? __ASK_ELEMENT_VERSION__ : undefined;

/**
 * Wraps Ask (or any part of it) with its configuration.
 *
 * Builds the HTTP client here rather than at module scope. A module-level
 * singleton would mean two Ask instances on one page sharing one base URL and
 * one credential — fine in the console, wrong in a host that embeds Ask
 * twice, and exactly the kind of hidden global this extraction exists to
 * remove.
 *
 * **One client per backend, not per config object.** The client is rebuilt
 * only when `baseUrl` or `clientType` changes — the two things it is actually
 * made from. It used to be rebuilt whenever the config's identity changed,
 * and the custom element builds a fresh config on every attribute change, so
 * bolt-v2 entering or leaving a dashboards screen (which swaps the copy
 * attributes) threw the client away. Everything keyed on the client — the
 * agent list, the disclosure settings — fetched again, and the picker flashed
 * "Finding agents…" over a change of placeholder text. Copy and callbacks
 * still reach their readers through the context value, which follows the
 * config; they just no longer take the client with them.
 */
export function AskProvider({
  config,
  children,
}: {
  config: AskConfig;
  children: ReactNode;
}) {
  // Every callback the client holds reads the CURRENT `auth` through this
  // ref, so a host that hands over a new auth object — or the element's
  // fresh config — is honoured on the next request without a new client.
  const authRef = useRef(config.auth);
  authRef.current = config.auth;

  const client = useMemo(
    () =>
      new GatewayClient({
        baseUrl: config.baseUrl,
        getToken: () => authRef.current.getCredential(),
        getOrganisationId: () => authRef.current.getOrganisationId?.() ?? null,
        clientType: config.clientType,
        refresh: async () => {
          const refreshCredential = authRef.current.refreshCredential;
          if (refreshCredential === undefined) return false;
          return (await refreshCredential()) !== null;
        },
        credentialRetryDelayMs: CREDENTIAL_RETRY_DELAY_MS,
        elementVersion: ELEMENT_VERSION,
        // A no-op default rather than a required callback: a host that has
        // nothing to do about a refusal should not have to say so.
        onUnauthorized: () => authRef.current.onUnauthorized?.(),
      }),
    [config.baseUrl, config.clientType],
  );

  const value = useMemo<AskContextValue>(() => ({ config, client }), [config, client]);

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
 * Whether a request is waiting for the host to hand back a credential — the
 * second or so after a credential provider returned null. The agent picker
 * says "Reconnecting to your account…" for it rather than looking stuck.
 */
export function useAskReconnecting(): boolean {
  const client = useAskClient();
  return useSyncExternalStore(client.subscribeReconnecting, () => client.reconnecting);
}

/**
 * Never throws. A missing inspector is a supported configuration — most
 * hosts have no panel to show a phase in — so this returns a no-op rather
 * than making every host wrap a provider it does not need.
 */
export function useAskInspector(): AskInspector {
  return useContext(AskInspectorContext) ?? NO_INSPECTOR;
}
