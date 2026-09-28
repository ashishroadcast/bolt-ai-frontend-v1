import { History, MessageSquarePlus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AgentIcon } from "./AgentIcon.tsx";
import styles from "./Ask.module.css";
import screenStyles from "./AskScreen.module.css";
import { AgentPicker } from "./chat/AgentPicker.tsx";
import { AgentSelectionBridge } from "./chat/agentSelection.ts";
import { AskAgentsProvider } from "./chat/useAskAgents.ts";
import { ChatProvider, useChatContext } from "./chat/ChatContext.tsx";
import { Composer } from "./chat/Composer.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { HistoryPanel } from "./chat/HistoryPanel.tsx";
import { Thread } from "./chat/Thread.tsx";
import { SCROLL_REGION_ATTR } from "./chat/useStickToBottom.ts";
import type { ChatMessage } from "./chat/types.ts";
import { AskProvider, useAskConfig, type AskConfig } from "./config.tsx";
import { GatewayError } from "./http/errors.ts";

/**
 * Ask, whole: agent picker, thread, composer, history drawer.
 *
 * **This is the embeddable unit.** It renders inside the admin console, and
 * it renders inside anything else that can mount React — `bolt-v2-web`
 * directly, and the Angular app through the custom element in
 * `element.tsx`. Nothing in `src/ask/` imports from outside `src/ask/`,
 * which is the property that makes that true and the one to check before
 * adding an import here.
 *
 * What it deliberately does NOT do, all of which the console used to supply
 * and no other host can be assumed to have:
 *
 * * **No router.** It was a react-router route reading `?conversation=<id>`
 *   from `useSearchParams` and rendering a `<Link>` in its empty state.
 *   Opening a specific conversation is now `initialConversationId`, and the
 *   "no agents yet" link is `setupAgentsHref` — both plain values a host in
 *   any framework can supply.
 * * **No session store.** The credential arrives per request through
 *   `config.auth`.
 * * **No inspector.** Clicking a phase reaches whatever
 *   `AskInspectorProvider` the host wrapped this in, and does nothing
 *   visible if there is none.
 *
 * The console keeps the surrounding chrome — nav rail, top bar, inspector
 * panel — because that is what a console is. Ask is the middle.
 */
export interface AskProps {
  config: AskConfig;
  /**
   * Open this conversation. The console passes the `?conversation=` query
   * parameter it used to read itself; a host with no such concept passes
   * nothing and Ask starts empty.
   *
   * Opened once per value: a host that keeps passing the same id while
   * someone asks follow-ups, or starts a new conversation, is not reopening
   * it. A different id is a new request and is opened; so is the same id
   * again after the prop was cleared in between, which is how the console
   * hands one over (see `AskRoute.tsx`).
   */
  initialConversationId?: number;
  /**
   * Replaces the empty-state copy. The default speaks about business
   * questions in general; a host embedding Ask beside its own fleet screens
   * may want to say something narrower.
   */
  emptyState?: { title: string; body: string };
}

const DEFAULT_EMPTY = {
  title: "Hi! Welcome to AI Assistant",
  body: "Your intelligent companion for reports & analytics",
};

/**
 * Where opening `initialConversationId` has got to. `null` once it has
 * opened, or when nothing was asked for.
 *
 * A failure remembers the thread it failed over (`shownOver`), and the
 * notice stays only while that is still the thread on screen: once the
 * person asks something, opens another conversation or starts a new one,
 * the notice is about something they have already moved past.
 */
type LinkOpen =
  | { id: number; state: "loading" }
  | { id: number; state: "failed"; canRetry: boolean; shownOver: ChatMessage[] };

/**
 * Worth a "Try again" — a dropped connection or a server error. Not a 404,
 * which is a deleted conversation or someone else's (the server answers
 * both identically, on purpose), nor a refused credential: asking again
 * gets the same answer.
 */
function canRetry(err: unknown): boolean {
  const status = err instanceof GatewayError ? err.status : undefined;
  return status === undefined || ![401, 403, 404].includes(status);
}

export function Ask({ config, initialConversationId, emptyState }: AskProps) {
  return (
    <AskProvider config={config}>
      <ChatProvider>
        <AskScreen initialConversationId={initialConversationId} emptyState={emptyState} />
      </ChatProvider>
    </AskProvider>
  );
}

/**
 * Ask's screen, for a host that provides `AskProvider` and `ChatProvider`
 * itself.
 *
 * The console has to: `ChatProvider` sits above its router so a run
 * survives navigating away from Ask, and `AskProvider` has to be above
 * that. `<Ask>` above is the same screen with both providers included, for
 * a host that just wants to drop it in.
 */
export function AskScreen({
  initialConversationId,
  emptyState,
}: Omit<AskProps, "config">) {
  const { messages, activeRun, loadConversation, clearConversation } = useChatContext();
  const { copy, onClose } = useAskConfig();
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const isEmpty = messages.length === 0 && activeRun === null;

  // Three sources, most specific first: the `emptyState` prop (a React host
  // rendering one screen), `config.copy` (a host configuring the whole
  // widget, including through the custom element's attributes), then the
  // console's own default.
  const title = emptyState?.title ?? copy?.emptyTitle ?? DEFAULT_EMPTY.title;
  const body = emptyState?.body ?? copy?.emptyBody ?? DEFAULT_EMPTY.body;

  // Loading from the first render, not from the effect's first run: an
  // effect runs after paint, and for that one frame the empty state and
  // its quick actions would be on screen and clickable.
  const [linkOpen, setLinkOpen] = useState<LinkOpen | null>(() =>
    initialConversationId === undefined ? null : { id: initialConversationId, state: "loading" },
  );
  // The id last opened from the prop, so a host re-rendering with the same
  // one — or StrictMode running this effect twice — does not re-fetch it
  // over whatever the person has done since. Cleared with the prop, so the
  // same id handed over again later is a new request.
  const openedIdRef = useRef<number | undefined>(undefined);
  // Only the latest request may settle the state; an earlier one landing
  // late must not overwrite it.
  const linkRequestRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const openLinked = useCallback(
    (id: number) => {
      const request = ++linkRequestRef.current;
      setLinkOpen({ id, state: "loading" });
      loadConversation(id).then(
        () => {
          if (linkRequestRef.current === request) setLinkOpen(null);
        },
        (err: unknown) => {
          // It used to be `void loadConversation(...)` with no catch: a
          // deleted conversation, a colleague's link (conversations are per
          // user) or a dropped request all left the ordinary empty state
          // and no word about what had happened to the link.
          if (linkRequestRef.current !== request) return;
          setLinkOpen({ id, state: "failed", canRetry: canRetry(err), shownOver: messagesRef.current });
        },
      );
    },
    [loadConversation],
  );

  useEffect(() => {
    if (initialConversationId === undefined) {
      openedIdRef.current = undefined;
      return;
    }
    if (openedIdRef.current === initialConversationId) return;
    openedIdRef.current = initialConversationId;
    openLinked(initialConversationId);
  }, [initialConversationId, openLinked]);

  const linkLoading = linkOpen?.state === "loading";
  const linkFailed = linkOpen?.state === "failed" && linkOpen.shownOver === messages ? linkOpen : null;

  function startOverFromLink() {
    setLinkOpen(null);
    clearConversation();
  }

  let linkNotice: ReactNode = null;
  if (linkLoading) {
    linkNotice = (
      <p role="status" className={screenStyles.opening}>
        Opening conversation…
      </p>
    );
  } else if (linkFailed !== null) {
    linkNotice = (
      <div className={isEmpty ? `${screenStyles.notice} ${screenStyles.noticeAlone}` : screenStyles.notice}>
        <p role="alert" className={screenStyles.noticeText}>
          That conversation couldn't be opened. It may have been deleted, or it belongs to someone else.
        </p>
        <div className={screenStyles.noticeActions}>
          <button type="button" className={screenStyles.primaryBtn} onClick={startOverFromLink}>
            <MessageSquarePlus size={15} strokeWidth={2} aria-hidden="true" />
            <span>Start a new conversation</span>
          </button>
          {linkFailed.canRetry && (
            <button type="button" className={screenStyles.secondaryBtn} onClick={() => openLinked(linkFailed.id)}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  // Stable so HistoryPanel's own Escape listener isn't torn down and
  // re-added on every render.
  const closeHistory = useCallback(() => {
    setIsHistoryOpen(false);
    // Focus goes back where it came from — a drawer that dumps focus at the
    // top of the document is worse than one that never opened.
    historyButtonRef.current?.focus();
  }, []);

  if (isHistoryOpen) {
    // A view-swap, not an overlay drawer: HistoryPanel now fills the whole
    // panel (its own back-arrow header, grouped list, and "start a new
    // conversation" footer) rather than sliding in over a scrim. The old
    // fixed-position drawer was anchored to the viewport, which is right
    // for the console (it slides over the nav rail) but breaks a narrow
    // embedded panel — a `position: fixed` drawer inside a 400px widget
    // covers the HOST PAGE, not just the widget. Swapping the panel's own
    // content sidesteps that regardless of where Ask is mounted.
    return (
      <div className={styles.screen}>
        <div className={styles.accentLine} />
        <HistoryPanel onClose={closeHistory} onMinimize={onClose} />
      </div>
    );
  }

  return (
    // One agent fetch for the screen. Both the picker and the composer's `/`
    // menu read the same list, and each used to fetch its own copy.
    <AskAgentsProvider>
    <div className={styles.screen}>
      <div className={styles.accentLine} />
      <div className={styles.panelHeader}>
        <div className={styles.agentProfile}>
          <span className={styles.avatarShield} aria-hidden="true">
            <AgentIcon size={18} />
          </span>
          <span className={styles.headerTitle}>AI Agent Assistant</span>
        </div>
        <div className={styles.headerActions}>
          <button
            ref={historyButtonRef}
            type="button"
            className={styles.iconAction}
            onClick={() => setIsHistoryOpen(true)}
            aria-expanded={isHistoryOpen}
            aria-label="Conversation history"
            title="History"
          >
            <History size={18} strokeWidth={2} aria-hidden="true" />
          </button>
          {!isEmpty && (
            <button
              type="button"
              className={styles.iconAction}
              onClick={clearConversation}
              aria-label="Start a new conversation"
              title="New conversation"
            >
              <MessageSquarePlus size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          {onClose !== undefined && (
            <button
              type="button"
              className={styles.iconAction}
              onClick={onClose}
              aria-label="Minimize assistant"
              title="Minimize"
            >
              <X size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className={styles.pickerRow}>
        <AgentPicker />
        {/* After the picker, on purpose — see AgentSelectionBridge. */}
        <AgentSelectionBridge />
      </div>

      <div className={styles.scroll} {...{ [SCROLL_REGION_ATTR]: "" }}>
        {linkNotice}
        {isEmpty ? (
          // Not while a linked conversation is loading or has failed: a
          // quick action clicked then started a run that the conversation
          // arriving a moment later wiped off the screen.
          linkNotice === null && (
            <div className={styles.empty}>
              <EmptyState title={title} body={body} />
            </div>
          )
        ) : (
          <Thread />
        )}
      </div>

      <div className={styles.composerBar}>
        <div className={styles.composerInner}>
          {/* Disabled while a linked conversation loads, for the reason the
              empty state is hidden then: a question sent in that gap is
              overwritten when the conversation arrives. Always rendered,
              so toggling it never remounts the composer and its draft. */}
          <fieldset role="presentation" className={screenStyles.composerGate} disabled={linkLoading}>
            <Composer />
          </fieldset>
        </div>
      </div>
    </div>
    </AskAgentsProvider>
  );
}
