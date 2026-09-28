import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AskScreen } from "./Ask.tsx";
import { AgentSelectionChannel } from "./chat/agentSelection.ts";
import { ChatProvider, useChatContext } from "./chat/ChatContext.tsx";
import {
  AskProvider,
  type AskConfig,
  type AskDashboardDraft,
  type AskHostContext,
  type AskWidgetDraft,
  type FormDraftHandoff,
  type WidgetDraftAck,
} from "./config.tsx";

/**
 * `<bolt-ai-ask>` — Ask as a custom element, for hosts that are not React.
 *
 * **Why this exists.** `bolt-v2-frontend` is Angular 20 and cannot import a
 * React component. Its options were an iframe (no shared theme, awkward
 * sizing, postMessage for the credential), a second Ask written in Angular
 * (two chat UIs to keep in step forever), or one React build wrapped in a
 * tag every framework can already render. This is the third.
 *
 * Angular renders it with `CUSTOM_ELEMENTS_SCHEMA`; Next, Vue and plain HTML
 * render the same tag with no adapter at all.
 *
 * **Styles live in a shadow root, and that is the whole reason there is
 * one.** Ask's CSS is 22 stylesheets of design tokens and CSS modules, and
 * bolt-v2's frontend ships Tailwind plus its own resets. Loaded into the
 * same document those two would each quietly restyle the other. A shadow
 * root makes that impossible in both directions — nothing leaks in, nothing
 * leaks out — which is what makes this safe to drop into a 1236-file app
 * nobody wants to re-test.
 *
 * The cost is that the host's stylesheets genuinely do not reach inside, so
 * the widget carries its own tokens (see `vite.element.config.ts`, which
 * rewrites `:root` to `:host` for exactly this) and its font stacks fall
 * back to system faces unless the host happens to load the same webfonts.
 *
 * **Configuration is by PROPERTY, not attribute, for anything that is a
 * function.** HTML attributes are strings, and the credential is not a
 * string — it is a callback the host answers per request, so a rotated
 * token or a switched organisation is picked up without re-rendering. An
 * attribute would force the host to re-set it on every change and would put
 * the credential in the DOM where any script can read it. So:
 *
 *     const ask = document.createElement('bolt-ai-ask');
 *     ask.baseUrl = 'https://ai.example.com';
 *     ask.credentialProvider = () => tokenService.fresh();
 *     ask.organisationProvider = () => store.orgId();
 *     host.appendChild(ask);
 *
 * `base-url` and `setup-agents-href` are also readable as attributes, since
 * those genuinely are strings and a plain-HTML host should not need script
 * to set them.
 *
 * **The conversation is the widget's, but the host can steer it.** It can
 * open one (`conversation-id`), hear which one is open (the
 * `conversationchange` event — enough to restore the panel after a reload),
 * start a fresh one (`newConversation()`), let go of an armed agent
 * (`clearAgent()`), and throw the whole scope away when it switches
 * organisation (`resetScope()`, or a changed `organisation-id`).
 */

// Replaced at build time with the bundle's own CSS. See the
// `inlineShadowStyles` plugin in `vite.element.config.ts` for why this is a
// placeholder rather than an import: CSS-module output does not exist until
// after bundling, so there is nothing to import at authoring time.
const SHADOW_STYLES = "__ASK_SHADOW_STYLES__";

type CredentialProvider = () => string | null | Promise<string | null>;
type CredentialRefresher = () => Promise<string | null>;
type OrganisationProvider = () => string | null | undefined;
type DashboardDraftHandler = (draft: AskDashboardDraft) => void;
type WidgetDraftHandler = (draft: AskWidgetDraft) => Promise<WidgetDraftAck>;
type EditWidgetHandler = (widgetId: string) => void;
type HostContextProvider = () => AskHostContext | null;

/**
 * The key events kept inside the widget while someone is typing in it. All
 * three, because a host shortcut may listen on any of them.
 */
const CONTAINED_KEY_EVENTS = ["keydown", "keyup", "keypress"] as const;

/** A field that takes typing: where Ctrl+Z, arrows and letters belong to
 * the text, not to whatever page the widget sits on. */
function isEditable(target: EventTarget | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  // `isContentEditable` where the platform computes it; the attribute walk
  // for where it does not (jsdom), and for an editable ancestor.
  return (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

/** What the element can do to the conversation from outside the React tree. */
interface ChatHandle {
  newConversation: () => void;
  clearAgent: () => void;
}

/** A conversation the host asked for, through `conversation-id` or a
 * reconnect. A fresh object per request, so asking for the same id twice is
 * still two requests. */
interface OpenRequest {
  conversationId: number;
}

interface ElementBridgeProps {
  /** Hands the element its way into the chat; the returned function takes
   * it back, and only if it is still the current one. */
  connect: (handle: ChatHandle) => () => void;
  /** Every change of the conversation on screen, after the first render. */
  onConversationChange: (conversationId: number | null) => void;
  open: OpenRequest | null;
  /** The request has been taken, so a later render must not repeat it. */
  onOpenTaken: () => void;
  onOpenFailed: (conversationId: number) => void;
}

/**
 * The element's way into `ChatContext`. Renders nothing.
 *
 * The element is a class outside React, and the conversation lives in a hook
 * inside it, so anything the host does to the conversation — open one, start
 * a new one, disarm an agent — and anything it is told about it, has to
 * cross here. Mounted by `render()` beside `AskScreen`, inside the same
 * `ChatProvider`, rather than inside `Ask.tsx`: this is the element's
 * business, not the screen's, and a React host has `useChatContext` itself.
 */
function ElementBridge({
  connect,
  onConversationChange,
  open,
  onOpenTaken,
  onOpenFailed,
}: ElementBridgeProps): null {
  const { activeConversationId, clearConversation, setSelectedAgent, loadConversation } =
    useChatContext();
  const activeRef = useRef(activeConversationId);
  activeRef.current = activeConversationId;
  const reportedRef = useRef(activeConversationId);

  useEffect(
    () => connect({ newConversation: clearConversation, clearAgent: () => setSelectedAgent(null) }),
    [connect, clearConversation, setSelectedAgent],
  );

  // Changes only. The first value is the empty thread every mount starts
  // with, which is not news; a reset that clears a conversation reports that
  // itself (`resetScope`).
  useEffect(() => {
    if (reportedRef.current === activeConversationId) return;
    reportedRef.current = activeConversationId;
    onConversationChange(activeConversationId);
  }, [activeConversationId, onConversationChange]);

  useEffect(() => {
    if (open === null) return;
    onOpenTaken();
    if (open.conversationId === activeRef.current) return;
    loadConversation(open.conversationId).catch(() => onOpenFailed(open.conversationId));
  }, [open, loadConversation, onOpenTaken, onOpenFailed]);

  return null;
}

/** A positive integer id, or null for anything else (absent, empty, junk). */
function parseConversationId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const id = Number(value.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export class BoltAiAskElement extends HTMLElement {
  /** Observed so a host that sets them late (or changes them) still works. */
  static get observedAttributes(): string[] {
    return [
      "base-url",
      "setup-agents-href",
      "organisation-id",
      "client-type",
      // Copy, so a host in another domain can say what this widget says
      // without a build of its own. Genuinely strings, so genuinely
      // attributes — unlike the credential, which is a callback.
      "empty-title",
      "empty-body",
      "placeholder",
      // Opens that conversation — on mount, or whenever it changes. See
      // `conversationchange` for the other direction.
      "conversation-id",
    ];
  }

  private root: Root | null = null;
  private mountPoint: HTMLDivElement | null = null;

  /**
   * Set by the host. Read on EVERY request rather than captured, so a token
   * refresh or an organisation switch on the host takes effect on the next
   * call without the element being touched.
   *
   * The next CALL — not what is already on screen. After an organisation
   * switch the old thread, agent list and armed agent are still showing, so
   * a host that switches through `organisationProvider` also calls
   * `resetScope()`.
   */
  credentialProvider: CredentialProvider | null = null;
  organisationProvider: OrganisationProvider | null = null;
  /**
   * Called when agent-service answers 401, or when `credentialProvider`
   * returned null, so the host can get a new credential: resolve with it, or
   * with null if there is none. The refused request is then retried once,
   * reading `credentialProvider` again — so the new credential must be what
   * `credentialProvider` returns from then on. bolt-v2 wires its
   * `tokenRefresh.forceRefresh()` here.
   *
   * Read at call time like the two above. Left null, a 401 is final and goes
   * to `onUnauthorized`.
   */
  refreshCredential: CredentialRefresher | null = null;
  /**
   * A 401 that `refreshCredential` did not recover, or no credential at all.
   * Never a 403: that is a missing permission, and the widget says so itself.
   */
  onUnauthorized: (() => void) | null = null;

  /**
   * Called when someone opens a drafted form in the host's own form builder.
   *
   * A property rather than a `CustomEvent`, matching the three above: it is a
   * callback, it is typed, and the host that cares about it is the same host
   * already assigning `credentialProvider` on the same node.
   *
   * Left `null` — the default — the draft card renders without its button.
   * That is the correct state for every host that has no form builder to open,
   * which is all of them but bolt-v2.
   *
   * An ACCESSOR, unlike the three above, and for the reason `baseUrl` is one:
   * whether this is set changes what renders, not just what a closure returns
   * when called. A host assigns it after inserting the element — Angular
   * cannot reach a `@ViewChild` any earlier — so a plain field would be
   * written after the first render had already decided there was no button.
   */
  get onFormDraft(): ((draft: FormDraftHandoff) => void) | null {
    return this.onFormDraftValue;
  }

  set onFormDraft(value: ((draft: FormDraftHandoff) => void) | null) {
    const had = this.onFormDraftValue !== null;
    this.onFormDraftValue = value;
    // Only when presence flips. The host nulls this on teardown and re-assigns
    // it on every wiring pass, and re-rendering the whole widget for a swapped
    // function identity would remount the thread mid-run.
    if (had !== (value !== null)) this.render();
  }

  private onFormDraftValue: ((draft: FormDraftHandoff) => void) | null = null;

  /**
   * Dynamic Dashboards (element 1.2.0). All four follow `onFormDraft`'s rule
   * exactly — an accessor, `null` means the feature is off and the key is
   * left out of `AskConfig`, and only a change of PRESENCE re-renders:
   *
   * - `onDashboardDraft` — "Open in builder" on a drafted View.
   * - `onWidgetDraft` — inserts a drafted widget into the builder's unsaved
   *   canvas: automatically, once per draft, on the live stream; from an
   *   "Add to view" click for a reopened thread.
   * - `onEditWidget` — "Edit Widget" on an acknowledged widget.
   * - `hostContextProvider` — sent as `host_context` with every run, and the
   *   source of the composer's selected-widget chip.
   */
  get onDashboardDraft(): DashboardDraftHandler | null {
    return this.onDashboardDraftValue;
  }

  set onDashboardDraft(value: DashboardDraftHandler | null) {
    const had = this.onDashboardDraftValue !== null;
    this.onDashboardDraftValue = value;
    if (had !== (value !== null)) this.render();
  }

  private onDashboardDraftValue: DashboardDraftHandler | null = null;

  get onWidgetDraft(): WidgetDraftHandler | null {
    return this.onWidgetDraftValue;
  }

  set onWidgetDraft(value: WidgetDraftHandler | null) {
    const had = this.onWidgetDraftValue !== null;
    this.onWidgetDraftValue = value;
    if (had !== (value !== null)) this.render();
  }

  private onWidgetDraftValue: WidgetDraftHandler | null = null;

  get onEditWidget(): EditWidgetHandler | null {
    return this.onEditWidgetValue;
  }

  set onEditWidget(value: EditWidgetHandler | null) {
    const had = this.onEditWidgetValue !== null;
    this.onEditWidgetValue = value;
    if (had !== (value !== null)) this.render();
  }

  private onEditWidgetValue: EditWidgetHandler | null = null;

  get hostContextProvider(): HostContextProvider | null {
    return this.hostContextProviderValue;
  }

  set hostContextProvider(value: HostContextProvider | null) {
    const had = this.hostContextProviderValue !== null;
    this.hostContextProviderValue = value;
    if (had !== (value !== null)) this.render();
  }

  private hostContextProviderValue: HostContextProvider | null = null;

  /**
   * One per element, for the element's life — it outlives re-renders and a
   * disconnect/reconnect, so a request made before the widget mounted is
   * still waiting when it does.
   */
  private readonly agentSelection = new AgentSelectionChannel();

  /**
   * Arms the agent whose `slash_command` is `slashCommand` (with or without
   * the leading `/`), exactly as picking it from the composer's `/` menu does.
   *
   * Returns `false` when the agent list has loaded and no active agent has
   * that command. Callable before the widget is mounted or configured, and
   * before its agent list has loaded: the request is then remembered and
   * applied the moment the list arrives, and this returns `true` — meaning
   * "accepted". If the tenant turns out to have no such agent, the remembered
   * request is dropped with a console warning. Only the latest request is
   * remembered. See `chat/agentSelection.ts`.
   */
  selectAgent(slashCommand: string): boolean {
    return this.agentSelection.request(slashCommand);
  }

  /**
   * Starts a fresh conversation: clears the thread and disarms any armed
   * agent — exactly the header's "New conversation" button. Nothing is
   * deleted; the old conversation stays in History.
   *
   * Callable before the widget has mounted, where it cancels a
   * `conversation-id` still waiting to open.
   */
  newConversation(): void {
    this.openRequest = null;
    this.chat?.newConversation();
  }

  /**
   * Disarms the agent a slash command or `selectAgent()` armed, so the next
   * question routes itself again. The thread is kept. Also forgets a
   * `selectAgent()` still waiting on the agent list, so it cannot re-arm one
   * a moment later.
   */
  clearAgent(): void {
    this.agentSelection.cancel();
    this.chat?.clearAgent();
  }

  /**
   * Throws away everything the widget holds for the current organisation —
   * the thread, the armed agent, the agent list, the tenant's settings — and
   * starts again as if newly mounted. For a host that switches organisation
   * without reloading the page: the credential and organisation providers are
   * read per request, so the NEXT request already goes out as the new
   * organisation, but what was fetched and said before the switch stays on
   * screen until this is called.
   *
   * Changing the `organisation-id` attribute does this by itself. A host that
   * uses `organisationProvider` instead has to call it, because a function's
   * answer changing is not something the element can see.
   *
   * A `conversation-id` set before the reset belonged to the old scope and is
   * not reopened; set it after, if the new scope should open one.
   */
  resetScope(): void {
    this.scope += 1;
    this.openRequest = null;
    this.chat = null;
    this.setConversation(null);
    this.render();
  }

  /** Remounts the React tree when bumped — see `resetScope`. */
  private scope = 0;
  /** A conversation to open once the tree is up to take it. */
  private openRequest: OpenRequest | null = null;
  private chat: ChatHandle | null = null;
  /** The conversation on screen, as last announced by `conversationchange`. */
  private conversationIdValue: number | null = null;

  private readonly connectChat = (handle: ChatHandle): (() => void) => {
    this.chat = handle;
    return () => {
      if (this.chat === handle) this.chat = null;
    };
  };

  private readonly reportConversation = (conversationId: number | null): void => {
    this.setConversation(conversationId);
  };

  private readonly takeOpenRequest = (): void => {
    this.openRequest = null;
  };

  private readonly openFailed = (conversationId: number): void => {
    console.warn(`<bolt-ai-ask> couldn't open conversation ${conversationId}; starting empty instead.`);
    // Announced even if nothing was open before: the host asked for this id,
    // most likely from its own storage, and should stop asking for it.
    this.setConversation(null, true);
  };

  /**
   * Fires `conversationchange` — `detail: { conversationId: number | null }`
   * — when the conversation on screen changes: one opened from History or
   * `conversation-id`, a fresh thread's first answer naming its new id, a
   * new conversation (null), a reset (null), or a `conversation-id` that
   * could not be opened (null). Composed and bubbling, so a host can listen
   * on the element or above it. What a host stores to restore the panel
   * after a reload, by setting `conversation-id` back.
   */
  private setConversation(conversationId: number | null, force = false): void {
    if (!force && conversationId === this.conversationIdValue) return;
    this.conversationIdValue = conversationId;
    this.dispatchEvent(
      new CustomEvent("conversationchange", {
        detail: { conversationId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  get onClose(): (() => void) | null {
    return this.onCloseValue;
  }

  set onClose(value: (() => void) | null) {
    const had = this.onCloseValue !== null;
    this.onCloseValue = value;
    if (had !== (value !== null)) this.render();
  }

  private onCloseValue: (() => void) | null = null;

  /**
   * Property forms of `base-url` / `setup-agents-href`, for a host that would
   * rather assign than `setAttribute`. Either works; the property wins.
   *
   * ACCESSORS, not plain fields, because a host almost always assigns them
   * AFTER inserting the element — Angular can only reach a `@ViewChild` once
   * the view has rendered, and React/Vue set properties on a node they have
   * already mounted. A plain field would be written after
   * `connectedCallback` had already tried to render, so the element has to
   * re-render when it learns where its backend is.
   */
  get baseUrl(): string | null {
    return this.baseUrlValue;
  }

  set baseUrl(value: string | null) {
    this.baseUrlValue = value;
    this.render();
  }

  get setupAgentsHref(): string | null {
    return this.setupAgentsHrefValue;
  }

  set setupAgentsHref(value: string | null) {
    this.setupAgentsHrefValue = value;
    this.render();
  }

  private baseUrlValue: string | null = null;
  private setupAgentsHrefValue: string | null = null;

  /**
   * Stops a key typed into one of the widget's own fields at the shadow root.
   *
   * Shadow DOM retargets a key event to the `<bolt-ai-ask>` host on its way
   * out, so to the page every key typed in the composer looks like a key
   * pressed on the element — and bolt-v2's dashboard builder answered
   * Ctrl+Z / Ctrl+Y typed in the composer by undoing the canvas, and its
   * scheduler moved on arrow keys. Stopping propagation here keeps typing
   * where it happened. React still sees it: its listener sits on the mount
   * point, below this one.
   *
   * Never `preventDefault` — the field must still receive the key — and never
   * Escape, which a host legitimately uses to close the panel. Keys pressed
   * anywhere else in the widget (a button, the thread) still reach the host.
   */
  private readonly containTyping = (event: Event): void => {
    if ((event as KeyboardEvent).key === "Escape") return;
    if (isEditable(event.composedPath()[0])) event.stopPropagation();
  };

  connectedCallback(): void {
    if (this.root !== null) return;

    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    for (const type of CONTAINED_KEY_EVENTS) shadow.addEventListener(type, this.containTyping);

    // `adoptedStyleSheets` where available: one parsed sheet shared by every
    // instance of the tag, rather than a fresh `<style>` parsed per element.
    // The `<style>` fallback is for older Safari, and produces the same
    // result more slowly.
    if ("adoptedStyleSheets" in Document.prototype && typeof CSSStyleSheet !== "undefined") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(SHADOW_STYLES);
      shadow.adoptedStyleSheets = [sheet];
    } else {
      const style = document.createElement("style");
      style.textContent = SHADOW_STYLES;
      shadow.appendChild(style);
    }

    this.mountPoint = document.createElement("div");
    // The element is a block that fills whatever the host gives it. Ask's own
    // layout is a column with a scrolling middle, so it needs a definite
    // height from somewhere — the host sizes the tag, the tag sizes this.
    this.mountPoint.style.height = "100%";
    shadow.appendChild(this.mountPoint);

    this.root = createRoot(this.mountPoint);
    // A reconnect (the host moving this node) is a fresh React tree, so the
    // conversation that was on screen would otherwise be lost. Reopen it.
    if (this.conversationIdValue !== null) {
      this.openRequest = { conversationId: this.conversationIdValue };
    }
    this.render();
    this.warnIfUnconfigured();
  }

  disconnectedCallback(): void {
    // Unmount on a microtask, not synchronously: React warns loudly about
    // unmounting during an existing render pass, and a host framework
    // removing this node mid-render (Angular does, on route change) is
    // exactly that case.
    const root = this.root;
    const mountPoint = this.mountPoint;
    this.root = null;
    this.mountPoint = null;
    if (root !== null) {
      queueMicrotask(() => {
        root.unmount();
        // The shadow root is reused on reconnect, and `connectedCallback`
        // appends a fresh mount point. Left behind, the old one — empty but
        // still `height: 100%` — pushed the new tree below the element's
        // visible area, now that a reconnect is expected to bring the
        // conversation back.
        mountPoint?.remove();
      });
    }
    // The shadow root outlives a disconnect (a reconnect reuses it), so the
    // listeners are removed here and added again in `connectedCallback`.
    for (const type of CONTAINED_KEY_EVENTS) {
      this.shadowRoot?.removeEventListener(type, this.containTyping);
    }
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === "conversation-id") {
      // Only ever OPENS. Removing the attribute, or a host echoing back the
      // id it was just told about, changes nothing on screen; starting fresh
      // is `newConversation()`.
      const conversationId = parseConversationId(newValue);
      if (conversationId !== null) this.openRequest = { conversationId };
    }
    // A different organisation is a different tenant's agents, settings and
    // threads. Before, the switch reached the next request but left the old
    // thread, list and armed agent on screen.
    if (name === "organisation-id" && this.root !== null) {
      this.resetScope();
      return;
    }
    if (this.root !== null) this.render();
  }

  private config(): AskConfig | null {
    const baseUrl = this.baseUrlValue ?? this.getAttribute("base-url");
    if (baseUrl === null || baseUrl === "") {
      // `null`, not a throw. It used to throw — and that was wrong in the one
      // case that matters: a host inserts the element first and assigns
      // `baseUrl` a tick later (Angular's `@ViewChild` is not available any
      // earlier), so `connectedCallback` reached this before the host could
      // possibly have configured anything. The throw escaped as an uncaught
      // error and left a blank panel.
      //
      // An embeddable widget must still not GUESS its backend, so the
      // diagnostic moved to `warnIfUnconfigured` — which fires only after the
      // host has genuinely had its chance.
      return null;
    }

    const setupAgentsHref = this.setupAgentsHrefValue ?? this.getAttribute("setup-agents-href");
    const clientType = this.getAttribute("client-type") ?? undefined;
    const staticOrganisationId = this.getAttribute("organisation-id");
    const copy = {
      emptyTitle: this.getAttribute("empty-title") ?? undefined,
      emptyBody: this.getAttribute("empty-body") ?? undefined,
      placeholder: this.getAttribute("placeholder") ?? undefined,
    };

    return {
      baseUrl,
      clientType,
      copy,
      ...(setupAgentsHref === null ? {} : { setupAgentsHref }),
      // Read at call time like the auth providers below, so a host that
      // assigns it after append is honoured. Left out entirely when the host
      // has set nothing: `AskConfig.onFormDraft` being undefined is what the
      // card checks to decide whether to offer its button at all, and a
      // wrapper that always exists would make it always offer one.
      ...(this.onFormDraftValue === null
        ? {}
        : { onFormDraft: (draft: FormDraftHandoff) => this.onFormDraftValue?.(draft) }),
      ...(this.onCloseValue === null ? {} : { onClose: () => this.onCloseValue?.() }),
      // Same rule as `onFormDraft` above: left out when unset, so the cards
      // can tell "no host builder" from "a builder that does nothing".
      ...(this.onDashboardDraftValue === null
        ? {}
        : { onDashboardDraft: (draft: AskDashboardDraft) => this.onDashboardDraftValue?.(draft) }),
      ...(this.onWidgetDraftValue === null
        ? {}
        : {
            onWidgetDraft: (draft: AskWidgetDraft): Promise<WidgetDraftAck> =>
              // Cleared between the render and the call (a host tearing
              // down): the card records that as a rejection, not a hang.
              this.onWidgetDraftValue?.(draft) ??
              Promise.resolve({ status: "rejected", reason: "not_in_builder" }),
          }),
      ...(this.onEditWidgetValue === null
        ? {}
        : { onEditWidget: (widgetId: string) => this.onEditWidgetValue?.(widgetId) }),
      ...(this.hostContextProviderValue === null
        ? {}
        : { hostContextProvider: () => this.hostContextProviderValue?.() ?? null }),
      agentSelection: this.agentSelection,
      auth: {
        // Reads the property at call time, so a host that assigns it after
        // append — or replaces it later — is honoured without a re-render.
        getCredential: () => this.credentialProvider?.() ?? null,
        // The provider wins over the attribute: a host with a live store
        // should not have to keep an attribute in sync with it. The
        // attribute is for a plain-HTML host that has one fixed
        // organisation.
        getOrganisationId: () => this.organisationProvider?.() ?? staticOrganisationId,
        // Always present, answering null when the host set nothing — which
        // Ask reads exactly as "no refresh", so the host can assign this at
        // any time without a re-render.
        refreshCredential: () => this.refreshCredential?.() ?? Promise.resolve(null),
        onUnauthorized: () => this.onUnauthorized?.(),
      },
    };
  }

  private render(): void {
    if (this.root === null) return;
    const config = this.config();
    // Nothing to render until the host says where the backend is. Every
    // property setter and `attributeChangedCallback` calls back in here, so
    // the first configuration is what actually mounts Ask.
    if (config === null) return;
    // A fresh config object per render is fine and intended: it is how a
    // changed attribute reaches the components that read it. It does not
    // reach the HTTP client — `AskProvider` rebuilds that only when
    // `base-url` or `client-type` changes, so a copy attribute swapped by the
    // host's routing never refetches the agent list.
    // `<Ask>`'s own tree, spelled out so `ElementBridge` can sit inside the
    // `ChatProvider` beside the screen. Keyed on the scope, so `resetScope()`
    // remounts all of it: a new client, a new agent list, an empty thread.
    this.root.render(
      <AskProvider key={this.scope} config={config}>
        <ChatProvider>
          <ElementBridge
            connect={this.connectChat}
            onConversationChange={this.reportConversation}
            open={this.openRequest}
            onOpenTaken={this.takeOpenRequest}
            onOpenFailed={this.openFailed}
          />
          <AskScreen />
        </ChatProvider>
      </AskProvider>,
    );
  }

  /**
   * Says so, once, if the host never configured this element.
   *
   * The eager throw this replaces was load-bearing for a real mistake —
   * forgetting `base-url` leaves a silent blank panel — so the check stays;
   * it just waits until after the host's own mount has had a turn. A
   * macrotask is long enough for every framework's "set properties on the
   * node I just created" step, and short enough that a developer sees it
   * immediately.
   */
  private warnIfUnconfigured(): void {
    setTimeout(() => {
      if (this.root === null) return;
      if (this.config() !== null) return;
      console.error(
        "<bolt-ai-ask> was never configured: set a base-url attribute or a " +
          ".baseUrl property pointing at agent-service.",
      );
    }, 0);
  }
}

/**
 * Registers the tag. Idempotent, because a host that loads this bundle twice
 * (two lazy Angular routes, a hot reload) would otherwise throw
 * `NotSupportedError` and take the page down with it.
 */
export function defineBoltAiAsk(tagName = "bolt-ai-ask"): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tagName) !== undefined) return;
  customElements.define(tagName, BoltAiAskElement);
}

// Self-registering: the bundle is delivered as a `<script>` tag or a side-
// effect import, and a host that has to remember to call a function after
// loading it has one more way to get a blank element and no error.
defineBoltAiAsk();
