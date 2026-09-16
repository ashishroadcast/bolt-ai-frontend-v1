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
