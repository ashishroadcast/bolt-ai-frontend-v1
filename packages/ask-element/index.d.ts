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
  /** `"checklist"` | `"survey"` | `"inspection"` */
  category: string;
  description: string;
  /** `"standalone"` | `"workflow"` */
  formType: string;
  /**
   * Both present, or both absent — a workflow form fires at a moment and a
   * standalone one has none. `triggerModule` is one of `eta_trip`,
   * `fleet_trip`, `fleet_yard_trip`, `attendance`, `alert`; `triggerEvent` is
   * one of `start`, `end`, `checkin`, `checkout`, `resolve`.
   */
  triggerModule?: string;
  triggerEvent?: string;
  fields: AskFormDraftField[];
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
