import { History, MessageSquareText, SquarePen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AgentPicker } from "../chat/AgentPicker.tsx";
import { useChatContext } from "../chat/ChatContext.tsx";
import { HistoryPanel } from "../chat/HistoryPanel.tsx";
import { Thread } from "../chat/Thread.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Composer } from "../shell/Composer.tsx";
import styles from "./AskRoute.module.css";

/*
 * The only screen that owns AgentPicker and Composer now (redesign brief:
 * the composer "belongs on the Ask screen only", and a run needs a
 * visible, choosable agent — see AgentPicker.tsx's own docstring for why
 * that's not just a convenience). Empty only while there is truly nothing
 * to show: no history and no run currently in flight — the moment either
 * exists, Thread takes over and the empty state never renders again for
 * this conversation.
 *
 * **History is a drawer, not a column.** It used to sit as a third card
 * between the nav rail and the thread (Saurabh: "chat history is akwardly
 * placed"), which left one column of conversation framed by three columns
 * of chrome. Reopening a past conversation is navigation used a few times
 * a session; it now costs a button until it is wanted, and the middle of
 * this screen is the conversation and nothing else. Everything the panel
 * could do — search, share, delete — it still does, inside the drawer.
 *
 * **`?conversation=<id>` is what makes History's Share button a real
 * link, not a decorative one** (task brief: "if you conclude a link is
 * meaningless without a backend ... leave it out rather than faking it").
 * There is no sharing backend in this system, so this is deliberately
 * *not* that — it's a permalink into a screen this console already knows
 * how to render: opened once, on mount, so navigating elsewhere and back
 * (or a plain reload once signed back in) doesn't keep re-fetching the
 * same conversation on every render.
 */
export function AskRoute() {
  const { messages, activeRun, loadConversation, clearConversation } = useChatContext();
  const [searchParams] = useSearchParams();
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const isEmpty = messages.length === 0 && activeRun === null;
  const openedFromLinkRef = useRef(false);

  useEffect(() => {
    if (openedFromLinkRef.current) return;
    const raw = searchParams.get("conversation");
    if (raw === null) return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    openedFromLinkRef.current = true;
    void loadConversation(id);
  }, [searchParams, loadConversation]);

  // Stable so HistoryPanel's own Escape listener isn't torn down and
  // re-added on every render of this screen.
  const closeHistory = useCallback(() => {
    setIsHistoryOpen(false);
    // Focus goes back where it came from — a drawer that dumps focus at
    // the top of the document is worse than one that never opened.
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
          <EmptyState
            icon={MessageSquareText}
            title="Ask about your business, in plain language"
            body={`Top items last week, why discounts spiked at Bandra, whether Swiggy or dine-in carried the weekend. The agent researches, plans and runs the query, then shows its work as it goes.`}
          />
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
              keyboard already has two ways out of the drawer (its own
              Close button, and Escape), so a third tab stop that reads as
              a nameless button would be noise. A <button> rather than a
              <div> only so the click target is a real interactive
              element. */}
          <button type="button" className={styles.scrim} onClick={closeHistory} aria-hidden="true" tabIndex={-1} />
          <HistoryPanel onClose={closeHistory} />
        </>
      )}
    </div>
  );
}
