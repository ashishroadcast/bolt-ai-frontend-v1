import { ArrowLeft, Link2, MessageCircle, MessageSquarePlus, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GatewayError } from "../http/errors.ts";
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
import { useAskClient } from "../config.tsx";

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

/** A short time-of-day stamp for a row's own card — Figma shows "10:42 AM"
 * beside today's entries and a bare date ("Sep 4") beside older ones,
 * which the date-group heading above the row already disambiguates. */
function formatStamp(iso: string, bucket: string): string {
  const date = new Date(iso);
  if (bucket === "Today" || bucket === "Yesterday") {
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("en-IN", { month: "short", day: "numeric" }).format(date);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Which date group a row falls into, read straight off `created_at` — the
 * same four buckets Figma's own "AI assistant chat history" frame groups
 * by (Today / Yesterday / Last week / Earlier). */
function dateBucket(iso: string): string {
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "Last week";
  return "Earlier";
}

const BUCKET_ORDER = ["Today", "Yesterday", "Last week", "Earlier"];

/** Buckets `items` by `dateBucket`, preserving the server's own ordering
 * within each bucket (most-recent-first, same as every other list this
 * console reads from `/agent/conversations`) rather than re-sorting. */
function groupByDate(items: ConversationSummary[]): Array<[string, ConversationSummary[]]> {
  const map = new Map<string, ConversationSummary[]>();
  for (const item of items) {
    const bucket = dateBucket(item.created_at);
    const list = map.get(bucket);
    if (list) list.push(item);
    else map.set(bucket, [item]);
  }
  return BUCKET_ORDER.filter((bucket) => map.has(bucket)).map((bucket) => [bucket, map.get(bucket)!]);
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
  bucket: string;
  onOpen: () => void;
  onDeleted: (id: number) => void;
  disabled: boolean;
}

/**
 * One row: an icon tile, title + stamp, preview, open on click — Figma's
 * "Chat entry" card. Share/Delete live in their own strip under the card
 * rather than in the mockup (which shows neither), because both are real,
 * load-bearing actions this console already has and Figma's static frame
 * simply didn't need to depict.
 */
function HistoryItem({ item, bucket, onOpen, onDeleted, disabled }: HistoryItemProps) {
  const client = useAskClient();
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
      await deleteConversation(client, item.id);
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
        <span className={styles.itemIcon} aria-hidden="true">
          <MessageCircle size={16} strokeWidth={2} />
        </span>
        <span className={styles.itemBody}>
          <span className={styles.itemTitleRow}>
            <span className={styles.itemHeading}>{heading}</span>
            <span className={styles.itemStamp}>{formatStamp(item.created_at, bucket)}</span>
          </span>
          {preview !== null && <span className={styles.itemSnippet}>{preview}</span>}
          <span className={styles.itemCount}>
            {item.message_count} message{item.message_count === 1 ? "" : "s"}
          </span>
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
 * Past conversations, grouped by when they happened: a searchable list,
 * each row showing its own heading, a readable one-line preview of the
 * answer and how many messages it holds; clicking one reopens it via
 * `ChatContext.loadConversation` and dismisses the panel.
 *
 * **A full-panel view, not a drawer.** It used to be a `position: fixed`
 * overlay anchored to the viewport — right for the console, where it
 * slides over the nav rail, but wrong for a narrow embedded widget: fixed
 * positioning inside a 400px panel covers the HOST PAGE, not just the
 * widget. `Ask.tsx` now swaps the whole screen's content for this one
 * (own header, own footer) instead, matching Figma's own "AI assistant
 * chat history" frame — a screen of the same panel, not a layer above it.
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
 */
export interface HistoryPanelProps {
  /** Returns to the conversation screen. Called on Escape, on the back
   * arrow, and once a conversation has actually opened. */
  onClose: () => void;
}

export function HistoryPanel({ onClose }: HistoryPanelProps) {
  const client = useAskClient();
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
      listConversations(client, searchInput, source)
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

  function handleStartNew() {
    clearConversation();
    onClose();
  }

  const groups = items !== null ? groupByDate(items) : [];

  return (
    <div className={styles.panel} role="region" aria-label="Conversation history">
      <div className={styles.head}>
        <button type="button" className={styles.back} onClick={onClose} aria-label="Back to conversation">
          <ArrowLeft size={20} strokeWidth={2} aria-hidden="true" />
        </button>
        <div className={styles.headingCopy}>
          <span className={styles.heading}>Chat history</span>
          <span className={styles.subheading}>Pick up where you left off</span>
        </div>
      </div>

      <div className={styles.controls}>
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
      </div>

      <div className={styles.body}>
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
        {error === null &&
          groups.map(([bucket, bucketItems]) => (
            <div key={bucket} className={styles.dateGroup}>
              <p className={styles.dateLabel}>{bucket}</p>
              <ul className={styles.list}>
                {bucketItems.map((item) => (
                  <HistoryItem
                    key={item.id}
                    item={item}
                    bucket={bucket}
                    onOpen={() => void handleOpen(item.id)}
                    onDeleted={handleDeleted}
                    disabled={openingId !== null}
                  />
                ))}
              </ul>
            </div>
          ))}
      </div>

      <div className={styles.footer}>
        <button type="button" className={styles.newConversation} onClick={handleStartNew}>
          <MessageSquarePlus size={16} strokeWidth={2} aria-hidden="true" />
          <span>Start a new conversation</span>
        </button>
      </div>
    </div>
  );
}
