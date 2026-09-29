import { useEffect, useState } from "react";
import { CircleAlert, Loader2, Search, TriangleAlert } from "lucide-react";
import { GatewayError } from "../ask/http/errors.ts";
import {
  chunkKindLabel,
  ingestPhase,
  listDocumentChunks,
  type DocumentChunk,
  type DocumentRecord,
} from "./documentsApi.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

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
 *
 * A modal over the Documents screen, not a second page: the parent mounts
 * this only while it is open, so the dialog is always `open` and any way
 * Radix closes it — the close button, Escape, a click outside — is
 * `onClose`. Nothing here scrolls the page body: the chunk list is the
 * dialog's own scroll region, and one chunk's body is its own nested one
 * again (see the `<pre>` below).
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

  const phase = ingestPhase(document.status);
  const visible = search.trim() === "" ? state.chunks : state.chunks.filter((c) => matchesSearch(c, search));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 gap-1 border-b px-6 pt-5 pb-4 pr-12 text-left">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Chunks</p>
          <DialogTitle asChild>
            <h3 className="text-base font-semibold wrap-anywhere">{document.filename}</h3>
          </DialogTitle>
        </DialogHeader>

        {phase === "working" && (
          <div className="mx-6 mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm leading-relaxed text-warning">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
            <span>
              Still processing — status: <strong>{document.status}</strong>. Chunks already indexed
              appear below; more will land as the pipeline continues.
            </span>
          </div>
        )}
        {phase === "failed" && (
          <div className="mx-6 mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm leading-relaxed text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="wrap-anywhere">
              Ingestion failed: {document.error ?? "no reason was recorded."}
            </span>
          </div>
        )}

        <div className="mx-6 mt-4 shrink-0">
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              placeholder="Search chunk text or headings…"
              aria-label="Search chunks"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
        </div>

        {/* The dialog's own scroll region — everything below the header,
            banner and search lives here, so a long chunk list scrolls in
            place rather than growing the dialog (and the page) without
            bound. */}
        <div data-slot="chunks-scroll" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pt-4 pb-6">
          {state.loading && (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading chunks…
            </p>
          )}

          {!state.loading && state.error !== null && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription className="gap-2">
                <p>{state.error}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void load(undefined, "first")}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Only for "ready": a working/failed document with zero chunks
              is already explained by the banner above, and repeating a
              generic "no chunks" line underneath it would read as a
              contradiction ("still processing" next to "there is
              nothing") rather than the honest, distinct states the task
              brief asks for. */}
          {!state.loading && state.error === null && state.chunks.length === 0 && phase === "ready" && (
            <p className="py-6 text-center text-sm text-muted-foreground">No chunks were recorded for this document.</p>
          )}

          {!state.loading && state.error === null && state.chunks.length > 0 && visible.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No loaded chunks match “{search}”.</p>
          )}

          {!state.loading && state.error === null && visible.length > 0 && (
            <ul className="flex flex-col gap-3">
              {visible.map((chunk) => (
                // The card itself never scrolls or clips sideways — only
                // the chunk's own text does. A wide heading breadcrumb
                // still just wraps within the card.
                <li key={chunk.id} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3" data-testid="chunk-card">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground tabular-nums">#{chunk.ordinal}</span>
                    <Badge variant="secondary">{chunkKindLabel(chunk.kind)}</Badge>
                    {chunk.page_no !== null && <span className="text-muted-foreground">Page {chunk.page_no}</span>}
                    {chunk.headings !== null && chunk.headings.length > 0 && (
                      <span className="min-w-0 text-muted-foreground">{chunk.headings.join(" › ")}</span>
                    )}
                  </div>
                  {/* One chunk's own text — the load-bearing scroll
                      container. Both axes (not just vertical) because a
                      chunk transcribed from a markdown table
                      (app.knowledge.chunk's TripletTableSerializer output)
                      is unwrapped `pre` rows that can run far wider than
                      the dialog; those scroll horizontally inside this box
                      rather than forcing the page to. `max-h-60` bounds
                      vertical growth the same way for a long paragraph. */}
                  <pre className="m-0 max-h-60 overflow-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre text-foreground">
                    {chunk.text}
                  </pre>
                </li>
              ))}
            </ul>
          )}

          {!state.loading && state.hasMore && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-center"
              disabled={state.loadingMore}
              onClick={() => void load(state.nextCursor ?? undefined, "more")}
            >
              {state.loadingMore && <Loader2 className="animate-spin" aria-hidden="true" />}
              {state.loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
