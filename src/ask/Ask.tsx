import { History, MessageSquarePlus, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon.tsx";
import styles from "./Ask.module.css";
import { AgentPicker } from "./chat/AgentPicker.tsx";
import { AgentSelectionBridge } from "./chat/agentSelection.ts";
import { AskAgentsProvider } from "./chat/useAskAgents.ts";
import { ChatProvider, useChatContext } from "./chat/ChatContext.tsx";
import { Composer } from "./chat/Composer.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { HistoryPanel } from "./chat/HistoryPanel.tsx";
import { Thread } from "./chat/Thread.tsx";
import { SCROLL_REGION_ATTR } from "./chat/useStickToBottom.ts";
import { AskProvider, useAskConfig, type AskConfig } from "./config.tsx";

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
   * Open this conversation on mount. The console passes the `?conversation=`
   * query parameter it used to read itself; a host with no such concept
   * passes nothing and Ask starts empty.
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

  // Once, on mount, for the id the host opened us with. A ref rather than a
  // dependency list because re-running it would re-fetch the same
  // conversation every time the host re-renders — and would fight the user
  // if they had since started a new one.
  const openedRef = useRef(false);
  if (!openedRef.current && initialConversationId !== undefined) {
    openedRef.current = true;
    void loadConversation(initialConversationId);
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
        {isEmpty ? (
          <div className={styles.empty}>
            <EmptyState title={title} body={body} />
          </div>
        ) : (
          <Thread />
        )}
      </div>

      <div className={styles.composerBar}>
        <div className={styles.composerInner}>
          <Composer />
        </div>
      </div>
    </div>
    </AskAgentsProvider>
  );
}
