/**
 * `<bolt-ai-ask>` — Ask as a custom element.
 *
 * These declarations are HAND-WRITTEN rather than emitted by `tsc`, and
 * deliberately: the class in `src/ask/element.tsx` has a private React root,
 * a mount point and internal render plumbing that no host may touch, so
 * emitting its full type would publish the internals as though they were the
 * contract. What is below is the contract — and it replaces the same
 * interface that every host was otherwise copying into its own source (see
 * `AskElement` in bolt-v2's `ask-panel.component.ts`, which this deleted).
 *
 * Keep in step with `observedAttributes` and the public fields in
 * `src/ask/element.tsx`. A property added there and missed here is invisible
 * to hosts; a property removed there and left here is a silent no-op, which
 * is the failure this file exists to prevent.
 */

/**
 * Answers "what credential should this request carry?", per request.
 *
 * Called on EVERY call rather than read once, so a token refresh or a
 * switched organisation on the host takes effect on the next request with
 * nothing to re-render. Return `null` to make the widget report itself as
 * unauthorized rather than send an anonymous request.
 */
export type AskCredentialProvider = () => string | null | Promise<string | null>;

/** Answers "whose data?", per request. Sent as the `Organisation` header. */
export type AskOrganisationProvider = () => string | null | undefined;

/**
 * One field of a drafted form, in the HOST BUILDER's vocabulary.
 *
 * `type` is one of `text`, `textarea`, `radio`, `select`, `url`, `number`,
 * `email`, `date`, `file`, `currency` — the ten bolt-v2's create palette
 * offers. Not the nine its database stores: the builder narrows them itself
 * on save, and handing it its own names keeps that the only lossy step.
 */
export interface AskFormDraftField {
  label: string;
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
 * A form the agent drafted, handed back for the host to open in its builder.
 *
 * **Nothing has been created.** The widget does not write: in bolt-v2 saving
 * a form is a template create plus one create per field plus an optional
 * trigger config, under a session the widget does not own. The draft comes
 * back here so the host's own save path stays the only one.
 */
export interface AskFormDraft {
  name: string;
  /**
   * The builder's category dropdown, verbatim: `"Operations"` | `"Safety"` |
   * `"Compliance"` | `"KYC"` | `"Feedback"` | `"Maintenance"` | `"Fuel"` |
   * `"Asset"` | `"Security"`.
   */
  category: string;
  description: string;
  /** `"standalone"` | `"workflow"` */
  formType: string;
  /**
   * Both present, or both absent — a workflow form fires at a moment and a
   * standalone one has none. The builder offers exactly four pairs:
   * `triggerModule` `eta_trip` with `triggerEvent` `start` | `end`, and
   * `attendance` with `checkin` | `checkout`.
   */
  triggerModule?: string;
  triggerEvent?: string;
  fields: AskFormDraftField[];
}

/** A dashboard widget size hint; the host turns it into grid cells. */
export type AskDashboardWidgetSize = 'small' | 'medium' | 'large' | 'wide' | 'full';

/**
 * One drafted widget (dashboards contract §5/§6). Optional keys are omitted,
 * never null. `size` omitted → the metric's default; `params` holds only keys
 * from the metric's param spec, e.g. `{ timeRange: { preset: 'last_7d' } }`.
 */
export interface AskDashboardDraftWidget {
  metricKey: string;
  visualization: string;
  title?: string;
  subtitle?: string;
  size?: AskDashboardWidgetSize;
  params?: Record<string, unknown>;
}

/**
 * A dashboard (View) the agent drafted, handed to the host to open in its
 * builder. **Nothing has been saved** — the host lays it out and saves it.
 */
export interface AskDashboardDraft {
  draftId: string;
  name: string;
  description?: string;
  widgets: AskDashboardDraftWidget[];
}

/** One widget drafted for the builder the panel is docked beside. */
export interface AskWidgetDraft {
  draftId: string;
  /** Present when the draft refines a widget already on the canvas. */
  replaceWidgetId?: string;
  widget: AskDashboardDraftWidget;
}

/** The host's answer to {@link AskWidgetDraft}. */
export interface WidgetDraftAck {
  status: 'added' | 'replaced' | 'rejected';
  widgetId?: string;
  /** A short code when rejected. `not_in_builder` is shown as "Open the
   *  dashboard builder to add this widget". */
  reason?: string;
}

/**
 * The screen the assistant is docked beside, sent with every run as
 * `host_context`. Data describing the screen, never instructions.
 */
export interface AskHostContext {
  surface: 'dashboard_builder' | 'dashboard_view' | 'dashboards_home';
  dashboard?: { name: string; widgets: { id: string; metricKey: string; visualization: string; title: string }[] };
  selectedWidgetId?: string;
}

/**
 * The ATTRIBUTE surface, for the values that genuinely are strings.
 *
 * Anything that is a function is a property instead (see below): an HTML
 * attribute cannot hold a callback, and putting a credential in the DOM
 * makes it readable by any script on the page.
 *
 * | Attribute            | Meaning                                            |
 * | -------------------- | -------------------------------------------------- |
 * | `base-url`           | agent-service's origin. Required.                  |
 * | `setup-agents-href`  | Where to configure agents.                         |
 * | `organisation-id`    | One fixed organisation, for a host with no store.  |
 * | `client-type`        | The `X-Client` header. Defaults to `web`.          |
 * | `empty-title`        | Empty-state heading.                               |
 * | `empty-body`         | Empty-state paragraph.                             |
 * | `placeholder`        | Composer placeholder.                              |
 *
 * All are observed, so setting or changing one after mount re-renders. The
 * three copy attributes exist so a host in another domain can change what
 * the widget says without a build of its own — the defaults talk about a
 * restaurant business, which is wrong beside a fleet.
 *
 * `organisationProvider` wins over `organisation-id`: a host with a live
 * store should not have to keep an attribute in sync with it.
 */
export declare class BoltAiAskElement extends HTMLElement {
  /**
   * Where agent-service is. **Required** — the widget renders nothing until
   * it is set, because an embeddable widget must not guess its backend. Also
   * settable as the `base-url` attribute.
   *
   * Assigning re-renders, so a host that sets this after inserting the
   * element (Angular cannot reach a `@ViewChild` any earlier) works.
   */
  baseUrl: string | null;

  /**
   * Where to send someone who has no agents configured yet. A plain URL, not
   * a router link, because Ask must not depend on the host's router. Also
   * settable as the `setup-agents-href` attribute.
   */
  setupAgentsHref: string | null;

  /** Set by the host. See {@link AskCredentialProvider}. */
  credentialProvider: AskCredentialProvider | null;

  /** Set by the host. See {@link AskOrganisationProvider}. */
  organisationProvider: AskOrganisationProvider | null;

  /**
   * Called when agent-service refuses the credential (401/403).
   *
   * Note what this should usually NOT do: sign the user out of the host app.
   * A refusal here means the AI credential is wrong, which is a different
   * fault from the host's own session expiring.
   */
  onUnauthorized: (() => void) | null;

  /** Called by the widget's own minimize control. */
  onClose: (() => void) | null;

  /**
   * Called when someone chooses to open a drafted form in the host's own
   * form builder. See {@link AskFormDraft} — nothing has been saved.
   *
   * Left `null`, the draft still renders; it just renders without the button,
   * which is right for any host that has no builder to open. Assigning or
   * clearing it re-renders, so a host that wires this after inserting the
   * element works.
   */
  onFormDraft: ((draft: AskFormDraft) => void) | null;

  /**
   * Called when someone opens a drafted dashboard in the host's builder. See
   * {@link AskDashboardDraft} — nothing has been saved. `null` (the default)
   * renders the card without its "Open in builder" button. Setting or
   * clearing it re-renders.
   */
  onDashboardDraft: ((d: AskDashboardDraft) => void) | null;

  /**
   * Inserts a drafted widget into the builder's UNSAVED canvas and says what
   * happened. Fires by itself exactly once per `draftId`, on the live stream
   * only; a thread reopened from history shows an "Add to view" button
   * instead and never inserts without a click. While the promise is pending
   * the card reads "Adding to your view…"; `added` / `replaced` enable Edit
   * Widget; `rejected` shows the reason and offers a retry. A promise that
   * rejects is treated as `rejected`. `null` (the default) renders the card
   * read-only. Setting or clearing it re-renders.
   */
  onWidgetDraft: ((d: AskWidgetDraft) => Promise<WidgetDraftAck>) | null;

  /**
   * Called from a widget card's "Edit Widget" with the id the host returned
   * in its {@link WidgetDraftAck}. `null` (the default) hides the button.
   */
  onEditWidget: ((widgetId: string) => void) | null;

  /**
   * Read at the start of every run and sent as `host_context`; also read by
   * the composer, which shows `selectedWidgetId`'s widget as a context chip
   * (re-read about once a second, since the host announces no changes).
   * Return `null` to send none. Setting or clearing it re-renders.
   */
  hostContextProvider: (() => AskHostContext | null) | null;

  /**
   * Arms the agent whose `slash_command` matches (leading `/` optional), the
   * same as picking it from the composer's `/` menu.
   *
   * Returns `false` if the agent list has loaded and no active agent has that
   * command. May be called before the element is mounted, configured, or has
   * loaded its agents: the request is then remembered and applied as soon as
   * the list arrives, and the call returns `true` ("accepted"). A remembered
   * request for a command the tenant turns out not to have is dropped with a
   * console warning. Only the latest request is remembered.
   */
  selectAgent(slashCommand: string): boolean;
}

/**
 * Registers the tag. Idempotent — a host that loads this twice (two lazy
 * routes, a hot reload) would otherwise throw `NotSupportedError`.
 *
 * Importing this package already calls it. This is exported only for a host
 * that wants a different tag name.
 */
export declare function defineBoltAiAsk(tagName?: string): void;

declare global {
  interface HTMLElementTagNameMap {
    /**
     * So `document.querySelector('bolt-ai-ask')` and Angular's
     * `ElementRef<HTMLElementTagNameMap['bolt-ai-ask']>` are typed without
     * a cast.
     */
    'bolt-ai-ask': BoltAiAskElement;
  }
}
