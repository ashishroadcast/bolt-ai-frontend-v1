import { History, Link2, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GatewayError } from "../api/errors.ts";
import { answerPreview } from "./answerPreview.ts";
import { CopyButton } from "./CopyButton.tsx";
import { useChatContext } from "./ChatContext.tsx";
import {
  deleteConversation,
  listConversations,
  type ConversationSource,
  type ConversationSummary,
} from "./historyApi.ts";
import styles from "./HistoryPanel.module.css";

// Only applies to a search-driven refetch, not the first load on mount —
// see the ref below. 300ms is enough to swallow ordinary typing speed
// without the list visibly lagging a deliberate pause.
const SEARCH_DEBOUNCE_MS = 300;

// How long "Deleted." stays up before the panel goes quiet again — enough
// to read, short enough not to feel stuck once the row it referred to is
// already gone.
const STATUS_MS = 2500;

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

/**
 * The channel a run arrived over, read from `external_ref`'s prefix
 * (`complaint:<uuid>`, `chatwoot:<account>:<inbox>`), or `null` for a
 * conversation someone typed here.
 *
 * Only the prefix is used. The rest of the ref is an internal id — a
 * complaint UUID means nothing to the person reading this list, and
 * printing it would spend the row's one line of heading on it.
 */
function channelLabel(externalRef: string | null | undefined): string | null {
  if (!externalRef) return null;
  const kind = externalRef.split(":", 1)[0];
  if (kind === "complaint") return "Complaint";
  if (kind === "chatwoot") return "Chat";
  // A channel we do not have a name for yet is still visibly a channel
  // run: better a generic badge than a row that silently reads as someone
  // having typed it.
  return "Channel";
}

/**
 * A working, honest permalink — not a decorative string. `AskRoute.tsx`
 * reads `?conversation=` on mount and calls `loadConversation` with it, so
 * pasting this link (once signed in) actually reopens this conversation
 * rather than landing on the plain Ask screen. There is no sharing
 * backend in this system (task brief) — this is deliberately *not* that:
 * it copies a link to a screen this same console already knows how to
 * open, nothing more.
 */
function shareLink(id: number): string {
  return `${window.location.origin}/ask?conversation=${id}`;
}

interface HistoryItemProps {
  item: ConversationSummary;
  onOpen: () => void;
  onDeleted: (id: number) => void;
  disabled: boolean;
}

/**
 * One row: open on the left, Share/Delete on the right. Delete needs a
 * second, explicit click before anything happens — "confirm first; it is
 * not recoverable" (task brief) — kept local to the row (not a
 * `window.confirm`) so it reads the same as everything else in this
 * console and stays reachable by keyboard/screen reader the same way.
 */
function HistoryItem({ item, onOpen, onDeleted, disabled }: HistoryItemProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const channel = channelLabel(item.external_ref);
  // A channel run's `title` is null for the same reason every other
  // conversation's is, so it would otherwise fall back to a bare date and
  // a list of them would read as identical rows. Naming the channel is the
  // one thing that distinguishes them from each other at a glance.
  const heading = item.title ?? (channel === null ? formatWhen(item.created_at) : `${channel} · ${formatWhen(item.created_at)}`);
  const preview = answerPreview(item.last_assistant_snippet);

  async function handleConfirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteConversation(item.id);
      onDeleted(item.id);
    } catch {
      // A specific, stable message rather than surfacing the raw server
      // detail here — the action failed, and "try again" is the one thing
      // an operator can actually do about it either way.
      setDeleteError("Couldn't delete — try again.");
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.item}
        onClick={onOpen}
        disabled={disabled}
        aria-label={`Open conversation: ${heading}`}
      >
        <span className={styles.itemHeading} aria-hidden="true">
          {heading}
        </span>
        {preview !== null && (
          <span className={styles.itemSnippet} aria-hidden="true">
            {preview}
          </span>
        )}
        <span className={styles.itemCount} aria-hidden="true">
          {item.message_count} message{item.message_count === 1 ? "" : "s"}
        </span>
      </button>

      <div className={styles.rowActions}>
        <CopyButton text={shareLink(item.id)} icon={Link2} idleLabel="Share" ariaLabel={`Copy link to ${heading}`} />

        {/* No Delete on a channel run. `delete_conversation` keeps the
            strict (tenant, user) scope that reading widens, so this button
            could only ever 404 here — and it is refused on purpose: a
            complaint transcript is what a refund decision rested on, and
            this endpoint takes its code-execution artifacts with it.
            Rendering a control whose only outcome is an error is worse
            than not offering it. */}
        {channel !== null ? null : confirming ? (
          <span className={styles.confirmRow}>
            <span className={styles.confirmText}>Delete this conversation?</span>
            <button
              type="button"
              className={styles.confirmBtn}
              onClick={() => void handleConfirmDelete()}
              disabled={deleting}
              aria-label="Confirm delete"
            >
              {deleting ? "Deleting…" : "Confirm"}
            </button>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => setConfirming(false)}
              disabled={deleting}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={styles.rowAction}
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${heading}`}
          >
            <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
            <span>Delete</span>
          </button>
        )}
      </div>

      {deleteError !== null && (
        <p role="alert" className={styles.rowError}>
          {deleteError}
        </p>
      )}
    </li>
  );
}

/**
 * Past conversations: a searchable list, each row showing its own
 * heading, a readable one-line preview of the answer and how many
 * messages it holds; clicking one reopens it via
 * `ChatContext.loadConversation` and dismisses the panel.
 *
 * **This is navigation, and it is no longer a column.** It used to sit as
 * a third card between the nav rail and the conversation, with its own
 * search field and a pair of buttons on every row — Saurabh: "chat
 * history is akwardly placed". Three columns of chrome around one column
 * of content is what made the thread read as a panel rather than as the
 * screen. It is a drawer now: absent until asked for, over the page rather
 * than beside it, and closing itself the moment it has done its job.
 * `AskRoute` owns whether it is open; this component owns everything
 * inside it.
 *
 * **The preview is cleaned up, not merely truncated** — see
 * `answerPreview.ts`. An analytics answer's own text is routinely a
 * pipe-delimited table, and a row of it read as an unbroken wall of pipes
 * and dashes.
 *
 * **Heading falls back to a formatted date, and this is a real gap.**
 * `ConversationSummary` carries `title` (always `null` — nothing in
 * `agent-service` generates one) and the last *assistant* snippet, but
 * never the question that started the conversation, so the title a reader
 * actually wants is not in this endpoint's response at all. Fetching each
 * conversation's detail to recover it would be one request per visible row
 * on every keystroke of the search box. So this shows when the
 * conversation happened rather than inventing a question from data it does
 * not have — the fix belongs in `ConversationSummaryOut`.
 *
 * **Reopening never resurrects the run rail** — not by anything this
 * component does, but by construction one layer down: `loadConversation`
 * calls `conversation.hydrateMessages`, which never attaches a
 * `runSummary` (a reopened message's transient `data-phase` events never
 * reached `messages.meta.ui_parts` to begin with — `StreamWriter.
 * persisted_parts`'s own guarantee), and `Thread.tsx`'s `PhaseRail` only
 * ever renders from `activeRun`, which `loadConversation` never touches.
 * See `chat/useChat.ts`'s own docstring for the fuller mechanism and
 * `AskRoute.test.tsx` for the click-through proof.
 *
 * **The real "history doesn't open" bug lived in `useChat.ts`, not here**
 * — see that file's own note on `mountedRef`. This component's fetch,
 * render and click wiring were correct the whole time; a StrictMode-only
 * dev bug dropped the `setMessages` call that would have shown what this
 * panel had already loaded successfully.
 */
export interface HistoryPanelProps {
  /** Dismisses the drawer. Called on Escape, on the close button, and
   * once a conversation has actually opened — a list that stays up over
   * the thread it just navigated to is the same "in the way" complaint in
   * a smaller form. */
  onClose: () => void;
}

export function HistoryPanel({ onClose }: HistoryPanelProps) {
  const { loadConversation, activeConversationId, clearConversation } = useChatContext();
  const [searchInput, setSearchInput] = useState("");
  const [source, setSource] = useState<ConversationSource>("mine");
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const isFirstRun = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const delay = isFirstRun.current ? 0 : SEARCH_DEBOUNCE_MS;
    isFirstRun.current = false;

    const timer = setTimeout(() => {
      listConversations(searchInput, source)
        .then((result) => {
          if (cancelled) return;
          setItems(result.items);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `source` refetches on the same path as `search`: switching tabs is a
    // different list, and showing the previous tab's rows under the new
    // tab's label for a frame reads as the filter having done nothing.
  }, [searchInput, source]);

  // Blanks the list while the new tab loads. Without this the old tab's
  // rows stay on screen under the new tab — briefly offering, for example,
  // a Delete button on a row that is about to be replaced by a channel run
  // that has none.
  function handleSourceChange(next: ConversationSource) {
    if (next === source) return;
    setItems(null);
    setSource(next);
  }

  useEffect(() => () => clearTimeout(statusTimer.current), []);

  // The search field, not the panel itself: someone who opened history
  // came to find a conversation, and typing is what they do next.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleOpen(id: number) {
    setOpeningId(id);
    try {
      await loadConversation(id);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOpeningId(null);
    }
  }

  function handleDeleted(id: number) {
    setItems((prev) => (prev ? prev.filter((it) => it.id !== id) : prev));
    // The thread on screen was reading from the conversation that just got
    // deleted — leaving it up would let a stray next message try to
    // continue a conversation that no longer exists server-side.
    if (activeConversationId === id) clearConversation();
    setStatusMessage("Deleted.");
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatusMessage(null), STATUS_MS);
  }

  return (
    <div className={styles.panel} role="dialog" aria-label="Conversation history">
      <div className={styles.head}>
        <span className={styles.iconTile} aria-hidden="true">
          <History size={14} strokeWidth={2} />
        </span>
        <span className={styles.title}>History</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close history">
          <X size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Which conversations to show">
        {(
          [
            ["mine", "Mine"],
            ["channel", "Channels"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={source === value}
            className={source === value ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => handleSourceChange(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={styles.searchField}>
        <Search size={13} strokeWidth={2} className={styles.searchIcon} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          className={styles.searchInput}
          placeholder="Search conversations"
          aria-label="Search past conversations"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </div>

      {statusMessage !== null && (
        <p role="status" className={styles.status}>
          {statusMessage}
        </p>
      )}

      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {error === null && items === null && <p className={styles.loading}>Loading…</p>}
      {error === null && items !== null && items.length === 0 && (
        <p className={styles.empty}>
          {searchInput.trim() !== ""
            ? "Nothing matches that search."
            : source === "channel"
              ? "No channel runs yet. Complaints and chats handled by an agent appear here."
              : "No past conversations yet."}
        </p>
      )}
      {error === null && items !== null && items.length > 0 && (
        <ul className={styles.list}>
          {items.map((item) => (
            <HistoryItem
              key={item.id}
              item={item}
              onOpen={() => void handleOpen(item.id)}
              onDeleted={handleDeleted}
              disabled={openingId !== null}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
