import { useEffect, useState } from "react";
import { Loader2, Search, TriangleAlert, X } from "lucide-react";
import { GatewayError } from "../ask/http/errors.ts";
import {
  chunkKindLabel,
  ingestPhase,
  listDocumentChunks,
  type DocumentChunk,
  type DocumentRecord,
} from "./documentsApi.ts";
import styles from "./ChunksPanel.module.css";

// Generous enough that a modest PDF (the ~300-400 page corpus documents.py's
// own docstring sizes this service for) shows in one page, small enough
// that a genuinely huge document never dumps its whole chunk table in one
// response — matches the server's own _DEFAULT_CHUNK_LIMIT so the common
// case needs no second page at all.
const PAGE_SIZE = 50;

function errorMessage(err: unknown): string {
  return err instanceof GatewayError
    ? err.message
    : "Couldn't reach the gateway. Check your connection and try again.";
}

interface LoadState {
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  chunks: DocumentChunk[];
  nextCursor: number | null;
  hasMore: boolean;
}

const INITIAL_STATE: LoadState = {
  loading: true,
  loadingMore: false,
  error: null,
  chunks: [],
  nextCursor: null,
  hasMore: false,
};

function matchesSearch(chunk: DocumentChunk, query: string): boolean {
  const haystack = [
    chunk.text,
    ...(chunk.headings ?? []),
    chunkKindLabel(chunk.kind),
    chunk.page_no !== null ? `page ${chunk.page_no}` : "",
  ]
    .join(" \n ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

interface ChunksPanelProps {
  document: DocumentRecord;
  onClose: () => void;
}

/*
 * A read-only view of what `app.knowledge.ingest`/`app.knowledge.chunk`
 * actually indexed for one document — "chunks of knowledge — so user can
 * validate" (Saurabh, via the console). No editing, no re-chunking here;
 * `POST /agent/documents/{id}/reingest` already covers that and belongs to
 * the row this panel opens from, not to this view (task brief).
 *
 * Always fetches on mount regardless of the document's own status, rather
 * than special-casing "skip the request while working/failed": `app.api.
 * documents.list_document_chunks`'s own docstring establishes that an
 * `indexing` document may already have a genuinely partial set of chunks
 * committed (its per-chunk write loop commits before the terminal status
 * flips), so skipping the fetch would hide real, already-indexed progress.
 * The banner above the list — not the fetch itself — is what makes a
 * still-working or failed document read differently from a document that
 * is simply, legitimately empty.
 */
export function ChunksPanel({ document, onClose }: ChunksPanelProps) {
  const [state, setState] = useState<LoadState>(INITIAL_STATE);
  const [search, setSearch] = useState("");

  async function load(cursor: number | undefined, mode: "first" | "more") {
    setState((prev) => ({
      ...prev,
      loading: mode === "first",
      loadingMore: mode === "more",
      error: null,
    }));
    try {
      const result = await listDocumentChunks(document.id, { cursor, limit: PAGE_SIZE });
      setState((prev) => ({
        loading: false,
        loadingMore: false,
        error: null,
        chunks: mode === "first" ? result.items : [...prev.chunks, ...result.items],
        nextCursor: result.next_cursor,
        hasMore: result.has_more,
      }));
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, loadingMore: false, error: errorMessage(err) }));
    }
  }

  useEffect(() => {
    void load(undefined, "first");
    // document.id alone: this panel is remounted (a fresh key) whenever the
    // operator opens a different row, so there is no in-place "switch
    // documents" transition to react to here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const phase = ingestPhase(document.status);
  const visible = search.trim() === "" ? state.chunks : state.chunks.filter((c) => matchesSearch(c, search));

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chunks-panel-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <p className={styles.kicker}>Chunks</p>
            <h3 id="chunks-panel-title" className={styles.title}>
              {document.filename}
            </h3>
          </div>
          <button type="button" className={styles.closeBtn} aria-label="Close" onClick={onClose}>
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        {phase === "working" && (
          <div className={`${styles.banner} ${styles.amber}`}>
            <Loader2 size={16} strokeWidth={2} className={styles.spin} />
            <span>
              Still processing — status: <strong>{document.status}</strong>. Chunks already indexed
              appear below; more will land as the pipeline continues.
            </span>
          </div>
        )}
        {phase === "failed" && (
          <div className={`${styles.banner} ${styles.critical}`}>
            <TriangleAlert size={16} strokeWidth={2} />
            <span>
              Ingestion failed: {document.error ?? "no reason was recorded."}
            </span>
          </div>
        )}

        <div className={styles.searchRow}>
          <Search size={14} strokeWidth={2} className={styles.searchIcon} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search chunk text or headings…"
            aria-label="Search chunks"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className={styles.body}>
          {state.loading && <p className={styles.status}>Loading chunks…</p>}

          {!state.loading && state.error !== null && (
            <div className={styles.errorBox}>
              <p>{state.error}</p>
              <button type="button" className={styles.retryBtn} onClick={() => void load(undefined, "first")}>
                Retry
              </button>
            </div>
          )}

          {/* Only for "ready": a working/failed document with zero chunks
              is already explained by the banner above, and repeating a
              generic "no chunks" line underneath it would read as a
              contradiction ("still processing" next to "there is
              nothing") rather than the honest, distinct states the task
              brief asks for. */}
          {!state.loading && state.error === null && state.chunks.length === 0 && phase === "ready" && (
            <p className={styles.status}>No chunks were recorded for this document.</p>
          )}

          {!state.loading && state.error === null && state.chunks.length > 0 && visible.length === 0 && (
            <p className={styles.status}>No loaded chunks match “{search}”.</p>
          )}

          {!state.loading && state.error === null && visible.length > 0 && (
            <ul className={styles.list}>
              {visible.map((chunk) => (
                <li key={chunk.id} className={styles.card} data-testid="chunk-card">
                  <div className={styles.cardMeta}>
                    <span className={styles.ordinal}>#{chunk.ordinal}</span>
                    <span className={styles.pill}>{chunkKindLabel(chunk.kind)}</span>
                    {chunk.page_no !== null && <span className={styles.metaBit}>Page {chunk.page_no}</span>}
                    {chunk.headings !== null && chunk.headings.length > 0 && (
                      <span className={styles.headings}>{chunk.headings.join(" › ")}</span>
                    )}
                  </div>
                  <pre className={styles.text}>{chunk.text}</pre>
                </li>
              ))}
            </ul>
          )}

          {!state.loading && state.hasMore && (
            <button
              type="button"
              className={styles.loadMoreBtn}
              disabled={state.loadingMore}
              onClick={() => void load(state.nextCursor ?? undefined, "more")}
            >
              {state.loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
