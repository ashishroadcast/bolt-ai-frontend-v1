import { History, SquarePen } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import styles from "./Ask.module.css";
import { AgentPicker } from "./chat/AgentPicker.tsx";
import { ChatProvider, useChatContext } from "./chat/ChatContext.tsx";
import { Composer } from "./chat/Composer.tsx";
import { HistoryPanel } from "./chat/HistoryPanel.tsx";
import { Thread } from "./chat/Thread.tsx";
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
  title: "Ask about your business, in plain language",
  body:
    "Top items last week, why discounts spiked at Bandra, whether Swiggy or dine-in carried the " +
    "weekend. The agent researches, plans and runs the query, then shows its work as it goes.",
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
  const { copy } = useAskConfig();
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

  return (
    <div className={styles.screen}>
      <div className={styles.topBar}>
        <AgentPicker />
        <div className={styles.topActions}>
          {!isEmpty && (
            <button type="button" className={styles.topAction} onClick={clearConversation}>
              <SquarePen size={13} strokeWidth={2} aria-hidden="true" />
              <span>New</span>
            </button>
          )}
          <button
            ref={historyButtonRef}
            type="button"
            className={styles.topAction}
            onClick={() => setIsHistoryOpen(true)}
            aria-expanded={isHistoryOpen}
          >
            <History size={13} strokeWidth={2} aria-hidden="true" />
            <span>History</span>
          </button>
        </div>
      </div>

      <div className={styles.scroll}>
        {isEmpty ? (
          // Ask's own, not the console's `EmptyState`: that one is shared
          // with seven admin routes and stays there. Copying nine lines of
          // markup is the cheaper of the two ways to keep this package from
          // importing the console.
          <div className={styles.empty}>
            <h2 className={styles.emptyTitle}>{title}</h2>
            <p className={styles.emptyBody}>{body}</p>
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

      {isHistoryOpen && (
        <>
          {/* Pointer-only, and hidden from assistive tech on purpose: the
              keyboard already has two ways out of the drawer (its own Close
              button, and Escape), so a third tab stop that reads as a
              nameless button would be noise. A <button> rather than a <div>
              only so the click target is a real interactive element. */}
          <button
            type="button"
            className={styles.scrim}
            onClick={closeHistory}
            aria-hidden="true"
            tabIndex={-1}
          />
          <HistoryPanel onClose={closeHistory} />
        </>
      )}
    </div>
  );
}
