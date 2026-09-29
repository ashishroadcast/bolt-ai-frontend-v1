import {
  BookOpen,
  CircleAlert,
  FileText,
  Folder,
  Layers,
  Loader2,
  Lock,
  RefreshCw,
  RotateCw,
  Tag,
  Tags,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill, type StatusPillTone } from "../agents/StatusPill.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { ChunksPanel } from "./ChunksPanel.tsx";
import { ClassifyDialog } from "./ClassifyDialog.tsx";
import { createDatasource, listDatasources, type DataSource } from "./datasourcesApi.ts";
import {
  ACCEPTED_EXTENSIONS,
  UNTAGGED_GROUP,
  addKnowledgeSource,
  childTags,
  classifyUpload,
  deleteDocument,
  groupDocuments,
  ingestPhase,
  isReingestable,
  listDocumentTags,
  listDocuments,
  listKnowledgeSources,
  reingestDocument,
  syncKnowledgeSource,
  tagLabel,
  tagSegments,
  uploadDocument,
  type DocumentRecord,
  type KnowledgeSourceRecord,
  type TagTree,
} from "./documentsApi.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Refetch cadence while at least one document is mid-pipeline — see this
// component's own docstring for why polling, not a websocket, is what
// keeps the three-state read (working/ready/failed) from ever looking
// like a spinner that never resolves.
const POLL_INTERVAL_MS = 4000;

const EMPTY_TREE: TagTree = { nodes: [], untagged_count: 0, total_count: 0 };

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the gateway. Check your connection and try again.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  return `${(kib / 1024).toFixed((kib / 1024) < 10 ? 1 : 0)} MiB`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

interface StatusView {
  label: string;
  tone: StatusPillTone;
  detail: string | null;
  /** A failure's detail is the reason, in prose; the others are a count or
   * a pipeline stage, in mono. */
  detailIsError: boolean;
}

function statusView(row: DocumentRecord): StatusView {
  const phase = ingestPhase(row.status);
  if (phase === "ready") {
    return {
      label: "Ready",
      tone: "good",
      detail: row.chunk_count !== null ? `${row.chunk_count} chunks` : null,
      detailIsError: false,
    };
  }
  if (phase === "failed") {
    return { label: "Failed", tone: "critical", detail: row.error, detailIsError: true };
  }
  return { label: "Processing", tone: "amber", detail: `· ${row.status}`, detailIsError: false };
}

interface RowState {
  busy: boolean;
  error: string | null;
}

const BLANK_ROW_STATE: RowState = { busy: false, error: null };

/** An icon-only row action: `label` is its accessible name and the tooltip
 * a pointer sees, so the icon never has to be guessed at. */
function IconAction({
  label,
  tooltip,
  destructive = false,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive")}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The classification rail: one branch of the tree per level, expanded
 * along the path to whatever is selected. Rendered from the server's flat
 * node list rather than a nested structure — the server rolls counts up
 * through every ancestor, so each node already knows how many documents
 * sit at or below it, and nesting is `childTags` one level at a time.
 *
 * Only the selected path is expanded. A corpus of a few hundred documents
 * can carry a wide tag tree, and a rail that renders all of it is the
 * "intern level" failure this screen is being pulled out of: navigation
 * you have to read past rather than read.
 */
/** A rail button's accessible name. Spelled out rather than left to the
 * browser's own concatenation of a label span and a count span, which
 * renders as "Ops7" to a screen reader. */
function railName(label: string, count: number): string {
  return `${label}, ${count} document${count === 1 ? "" : "s"}`;
}

/** One rail button. Depth is carried by an inline left inset the caller
 * computes, so an arbitrarily deep tree needs no new rule; the selected
 * branch is carried by fill and weight as well as colour. */
function RailItem({
  icon: Icon,
  label,
  count,
  selected,
  quiet = false,
  depth = 0,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  selected: boolean;
  quiet?: boolean;
  depth?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected && "bg-primary/10 font-medium text-primary hover:bg-primary/10 hover:text-primary",
      )}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      aria-current={selected ? "true" : undefined}
      aria-label={railName(label, count)}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      <span className={cn("min-w-0 flex-1 truncate", quiet && "italic")}>{label}</span>
      <span className="font-mono text-xs tabular-nums opacity-80">{count}</span>
    </button>
  );
}

function TagRail({
  tree,
  selected,
  totalCount,
  onSelect,
}: {
  tree: TagTree;
  selected: string | null;
  totalCount: number;
  onSelect: (tag: string | null, untagged: boolean) => void;
}) {
  const openPath = selected === null ? [] : tagSegments(selected).map((_, index, all) => all.slice(0, index + 1).join("/"));

  function renderLevel(parent: string | null, depth: number) {
    const nodes = childTags(tree.nodes, parent);
    if (nodes.length === 0) return null;
    return (
      <ul className="flex flex-col gap-0.5">
        {nodes.map((node) => {
          const isOpen = openPath.includes(node.path);
          return (
            <li key={node.path} className="flex flex-col gap-0.5">
              <RailItem
                icon={Folder}
                label={tagLabel(node.path)}
                count={node.document_count}
                selected={node.path === selected}
                depth={depth}
                onClick={() => onSelect(node.path, false)}
              />
              {isOpen && renderLevel(node.path, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <nav
      className="flex flex-col gap-0.5 rounded-xl border bg-card p-2 text-card-foreground shadow-sm max-2xl:max-h-64 max-2xl:overflow-y-auto 2xl:sticky 2xl:top-0"
      aria-label="Classification"
    >
      <p className="px-2 pt-1 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Filed under</p>
      <ul className="flex flex-col gap-0.5">
        <li>
          <RailItem
            icon={Tag}
            label="All documents"
            count={totalCount}
            selected={selected === null}
            onClick={() => onSelect(null, false)}
          />
        </li>
      </ul>
      {renderLevel(null, 0)}
      {tree.untagged_count > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 border-t pt-1">
          <li>
            <RailItem
              icon={Folder}
              label="Unclassified"
              count={tree.untagged_count}
              selected={false}
              quiet
              onClick={() => onSelect(null, true)}
            />
          </li>
        </ul>
      )}
    </nav>
  );
}

/*
 * There is exactly one document library (a `type=knowledge` datasource,
 * `app.datasource.models.DataSource`'s own docstring: "a document
 * corpus") per tenant in this screen, created invisibly on the first
 * upload rather than exposed as its own object to manage. Nothing in the
 * spec, the mockup, or the backend names a "corpus" as something an
 * operator configures — the copy rule (task brief) is "name things by
 * what the operator controls", and what the operator controls here is
 * documents, not the row `POST /agent/documents` happens to need a
 * `datasource_id` to attach them to. If a tenant already has one or more
 * knowledge datasources (e.g. from a previous session), the first one
 * found is reused rather than creating a second — see the `find` below.
 *
 * Every mutation (upload, reingest, delete, classify) refetches the
 * document list rather than patching state in place: `POST .../reingest`
 * returns a *new* row with a *new* id (documents.py's own docstring — the
 * old row is deleted, not updated), so an id-keyed local patch would
 * silently go stale the moment a reingest actually ran.
 *
 * The screen is a rail plus grouped cards rather than one flat table.
 * Classification is a hierarchy the operator can have several levels of,
 * so three more columns bolted onto a table would push the thing they are
 * navigating by into the narrowest part of the widest row. The rail is
 * the hierarchy; a card is one branch of it; the table inside a card is
 * just the documents. Filtering is done by the *server* (`?tag=`), which
 * matches every level below the selection, so what this screen shows and
 * what the agent may retrieve can never drift apart.
 */
export function DocumentsRoute() {
  const [corpora, setCorpora] = useState<DataSource[]>([]);
  const [corpus, setCorpus] = useState<DataSource | null>(null);
  const [corpusLoaded, setCorpusLoaded] = useState(false);
  const [documents, setDocuments] = useState<DocumentRecord[] | null>(null);
  const [tree, setTree] = useState<TagTree>(EMPTY_TREE);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceRecord[]>([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceBusy, setSourceBusy] = useState<number | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  const [chunksDocumentId, setChunksDocumentId] = useState<number | null>(null);
  const [classifyDocumentId, setClassifyDocumentId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDatasources()
      .then((rows) => {
        if (cancelled) return;
        // Every knowledge datasource, not the first one found. A tenant
        // really does have several — one per agent (a customer-facing
        // menu corpus, an ops handbook, a complaint SOP library) — and
        // taking `find`'s first match showed the Complaint SOP Library's
        // empty state to an operator whose menu document was sitting in
        // the customer corpus, with no control anywhere to switch.
        const knowledge = rows.filter((row) => row.type === "knowledge");
        setCorpora(knowledge);
        setCorpus(knowledge[0] ?? null);
        setCorpusLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
        setCorpusLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDocuments = useCallback(
    async (datasourceId: number) => {
      try {
        const rows = await listDocuments(datasourceId, {
          tag: selectedTag ?? undefined,
          untagged: untaggedOnly,
        });
        setDocuments(rows);
      } catch (err) {
        setLoadError(errorMessage(err));
      }
    },
    [selectedTag, untaggedOnly],
  );

  // The tree is fetched unfiltered and separately from the list, so
  // narrowing to a branch never deletes the other branches from the rail
  // you narrowed with.
  const refreshTree = useCallback(async (datasourceId: number) => {
    try {
      setTree(await listDocumentTags(datasourceId));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  const refreshKnowledgeSources = useCallback(async (datasourceId: number) => {
    try {
      setKnowledgeSources(await listKnowledgeSources(datasourceId));
    } catch (err) {
      setSourceError(errorMessage(err));
    }
  }, []);

  const refreshAll = useCallback(
    async (datasourceId: number) => {
      await Promise.all([
        refreshDocuments(datasourceId),
        refreshTree(datasourceId),
        refreshKnowledgeSources(datasourceId),
      ]);
    },
    [refreshDocuments, refreshTree, refreshKnowledgeSources],
  );

  useEffect(() => {
    if (corpus === null) return;
    void refreshDocuments(corpus.id);
    void refreshTree(corpus.id);
    void refreshKnowledgeSources(corpus.id);
    // corpus.id alone (plus the two refetchers, which are memoised on the
    // filter): a freshly-created corpus is a new object each time, so
    // identity would refetch on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpus?.id, refreshDocuments, refreshTree, refreshKnowledgeSources]);

  // Self-terminating poll: reschedules itself only while something in the
  // list is still mid-pipeline, and stops the moment nothing is (task
  // brief: "a spinner that never resolves is the failure people actually
  // hit").
  useEffect(() => {
    if (corpus === null || documents === null) return;
    const stillWorking =
      documents.some((row) => ingestPhase(row.status) === "working") ||
      knowledgeSources.some((source) => source.status === "pending" || source.status === "syncing");
    if (!stillWorking) return;
    const corpusId = corpus.id;
    const timer = setTimeout(() => {
      void refreshAll(corpusId);
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [documents, knowledgeSources, corpus, refreshAll]);

  function rowState(id: number): RowState {
    return rowStates[id] ?? BLANK_ROW_STATE;
  }

  function patchRow(id: number, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW_STATE), ...patch } }));
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function selectBranch(tag: string | null, untagged: boolean) {
    setSelectedTag(tag);
    setUntaggedOnly(untagged);
  }

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    // Cleared immediately so choosing the same file again still fires
    // change — otherwise a retry after fixing a rejected file would
    // silently do nothing.
    event.target.value = "";
    if (file === null) return;

    setUploadError(null);
    const validation = classifyUpload(file);
    if (!validation.ok) {
      setUploadError(validation.message);
      return;
    }

    setUploading(true);
    try {
      let target = corpus;
      if (target === null) {
        target = await createDatasource({
          name: "Documents",
          type: "knowledge",
          database_name: "Documents",
          isolation_mode: "connection",
        });
        setCorpus(target);
      }
      await uploadDocument(target.id, file);
      // A new upload has no tags yet, so it can only land outside a
      // selected branch — clear the filter rather than refetch a list that
      // provably will not contain it. It arrives visibly "Unclassified",
      // and the rail's own Unclassified branch is the to-do list an
      // operator filing a few hundred PDFs works through, which is why
      // this does not force the classify dialog open one file at a time.
      selectBranch(null, false);
      await refreshAll(target.id);
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleAddKnowledgeSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sourceBusy !== null || !sourceUrl.trim()) return;
    setSourceError(null);
    setSourceBusy(-1);
    try {
      let target = corpus;
      if (target === null) {
        target = await createDatasource({
          name: "Documents",
          type: "knowledge",
          database_name: "Documents",
          isolation_mode: "connection",
        });
        setCorpus(target);
      }
      await addKnowledgeSource(target.id, sourceUrl.trim());
      setSourceUrl("");
      await refreshAll(target.id);
    } catch (err) {
      setSourceError(errorMessage(err));
    } finally {
      setSourceBusy(null);
    }
  }

  async function handleSyncKnowledgeSource(id: number) {
    if (corpus === null) return;
    setSourceError(null);
    setSourceBusy(id);
    try {
      await syncKnowledgeSource(id);
      await refreshAll(corpus.id);
    } catch (err) {
      setSourceError(errorMessage(err));
    } finally {
      setSourceBusy(null);
    }
  }

  async function handleReingest(id: number) {
    if (corpus === null) return;
    patchRow(id, { busy: true, error: null });
    try {
      await reingestDocument(id);
      await refreshAll(corpus.id);
    } catch (err) {
      patchRow(id, { busy: false, error: errorMessage(err) });
    }
  }

  async function handleRemove(id: number) {
    if (corpus === null) return;
    patchRow(id, { busy: true, error: null });
    try {
      await deleteDocument(id);
      await refreshAll(corpus.id);
      setRowStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      patchRow(id, { busy: false, error: errorMessage(err) });
    }
  }

  const rows = documents ?? [];
  const groups = groupDocuments(rows, untaggedOnly ? null : selectedTag);
  const knownPermissions = [...new Set(rows.map((row) => row.required_permission).filter((code): code is string => code !== null))].sort();
  const classifyDocument = rows.find((row) => row.id === classifyDocumentId);
  const branchLabel = untaggedOnly ? "Unclassified" : selectedTag === null ? "All documents" : selectedTag;

  return (
    // Tooltips here label the icon-only row actions; a provider of this
    // screen's own keeps them working outside the shell (tests render the
    // route on its own).
    <TooltipProvider>
      <div className="min-w-0 space-y-6">
        <PageHeader
          kicker="Connections"
          title="Knowledge"
          description="Connect the menus, SOPs and policy documents you want the agent to cite. Upload files or import a public GitBook, then file content under a classification and restrict sensitive documents."
          actionLabel={uploading ? "Uploading…" : "Add a document"}
          onAction={openFilePicker}
          actionDisabled={uploading}
        />

        {/* Only rendered when the tenant has more than one knowledge
            datasource, which is the only case where the operator has a
            choice to make. A single-library tenant still sees no concept
            it does not need. */}
        {corpora.length > 1 && (
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="document-corpus" className="text-muted-foreground">
              Library
            </Label>
            <NativeSelect
              id="document-corpus"
              className="min-w-56"
              value={corpus?.id ?? ""}
              onChange={(event) => {
                const next = corpora.find((row) => String(row.id) === event.target.value);
                if (next !== undefined) setCorpus(next);
              }}
            >
              {corpora.map((row) => (
                <NativeSelectOption key={row.id} value={row.id}>
                  {row.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}

        <section aria-labelledby="gitbook-heading">
          <Card className="gap-5">
            <CardHeader>
              <h2 id="gitbook-heading" data-slot="card-title" className="flex items-center gap-2 leading-none font-semibold">
                <BookOpen className="size-4 text-muted-foreground" aria-hidden="true" />
                GitBook sources
              </h2>
              <CardDescription>
                Import a public GitBook into this library. Sync again to refresh changed pages.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <form className="space-y-2" onSubmit={(event) => void handleAddKnowledgeSource(event)}>
                <Label htmlFor="gitbook-url">Public GitBook URL</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="gitbook-url"
                    type="url"
                    required
                    value={sourceUrl}
                    onChange={(event) => setSourceUrl(event.target.value)}
                    placeholder="https://roadcast.gitbook.io/"
                    disabled={sourceBusy !== null}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    className="sm:w-auto"
                    disabled={sourceBusy !== null || sourceUrl.trim() === ""}
                  >
                    {sourceBusy === -1 && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {sourceBusy === -1 ? "Adding…" : "Add GitBook"}
                  </Button>
                </div>
              </form>
              {sourceError !== null && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertDescription className="wrap-anywhere">{sourceError}</AlertDescription>
                </Alert>
              )}
              {knowledgeSources.length > 0 && (
                <ul className="divide-y rounded-lg border">
                  {knowledgeSources.map((source) => {
                    const working = source.status === "pending" || source.status === "syncing";
                    const label = source.status === "ready" ? "Ready" : source.status === "failed" ? "Failed" : "Syncing";
                    const tone: StatusPillTone =
                      source.status === "ready" ? "good" : source.status === "failed" ? "critical" : "amber";
                    const syncing = sourceBusy === source.id || working;
                    return (
                      <li
                        key={source.id}
                        className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="font-medium wrap-anywhere text-primary underline-offset-4 hover:underline"
                          >
                            {source.name}
                          </a>
                          <StatusPill tone={tone} label={label} />
                          <span className="font-mono text-xs text-muted-foreground">
                            {source.page_count} pages{source.last_synced_at ? ` · Synced ${formatDate(source.last_synced_at)}` : ""}
                          </span>
                          {source.last_error !== null && (
                            <span className="basis-full text-sm wrap-anywhere text-destructive">{source.last_error}</span>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="self-start sm:self-auto"
                          disabled={working || sourceBusy !== null}
                          onClick={() => void handleSyncKnowledgeSource(source.id)}
                        >
                          <RefreshCw className={cn(syncing && "animate-spin")} aria-hidden="true" />
                          {syncing ? "Syncing…" : "Sync"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* The real file input stays in the DOM and keeps an accessible
            name (a `<label>`, read by screen readers and by
            testing-library's getByLabelText) — it is only ever visually
            hidden, never aria-hidden, so the visible control is
            PageHeader's button forwarding its click to this input via a
            ref rather than a second, competing way to choose a file. */}
        <label className="sr-only" htmlFor="document-upload">
          Add a document
        </label>
        <input
          ref={fileInputRef}
          id="document-upload"
          type="file"
          className="sr-only"
          accept={ACCEPTED_EXTENSIONS.join(",")}
          onChange={(event) => void handleFileSelected(event)}
        />

        {uploadError !== null && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{uploadError}</AlertDescription>
          </Alert>
        )}
        {loadError !== null && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {/* No action button here — PageHeader's own "Add a document" above
            is the one control for this, not a second button with the same
            name (the empty state used to be a dead-end with no action at
            all; now it at least explains what the header's button does). */}
        {corpusLoaded && rows.length === 0 && tree.nodes.length === 0 && (
          <EmptyState
            icon={FileText}
            title="Give the agent something to read"
            body="Upload PDF, DOCX, PPTX, XLSX, HTML or Markdown files, or import a public GitBook URL above. The agent can cite each source."
          />
        )}

        {/* Two zones: the rail navigates the hierarchy, the right column
            holds one card per branch below the selection. Below `2xl` (the
            console sidebar takes 16rem of it; at 1280px the tables were
            still cut off) the rail stacks above the cards, height-capped
            and scrolling itself, rather than squeezing them into a column
            too narrow for their tables. */}
        {(rows.length > 0 || tree.nodes.length > 0) && (
          <div className="grid items-start gap-6 2xl:grid-cols-[14rem_minmax(0,1fr)]">
            <TagRail
              tree={tree}
              selected={untaggedOnly ? null : selectedTag}
              totalCount={tree.total_count}
              onSelect={selectBranch}
            />

            <div className="flex min-w-0 flex-col gap-4">
              {groups.length === 0 && (
                <p className="rounded-xl border border-dashed bg-card px-6 py-10 text-center text-sm text-muted-foreground">
                  Nothing filed under {branchLabel} yet.
                </p>
              )}
              {groups.map((group) => {
                const GroupIcon = group.key === UNTAGGED_GROUP ? FileText : Folder;
                const count = group.documents.length;
                return (
                  <Card key={group.key} className="gap-0 overflow-hidden py-0">
                    <CardHeader className="flex items-center gap-2 py-3.5">
                      <GroupIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <h3 data-slot="card-title" className="min-w-0 truncate leading-none font-semibold">
                        {group.label}
                      </h3>
                      <span className="text-sm text-muted-foreground">
                        {count} document{count === 1 ? "" : "s"}
                      </span>
                    </CardHeader>
                    <CardContent className="border-t p-0">
                      <Table className="[&_tr>*:first-child]:pl-6 [&_tr>*:last-child]:pr-6">
                        <TableHeader className="bg-muted/40">
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="text-muted-foreground">File</TableHead>
                            <TableHead className="text-muted-foreground">Status</TableHead>
                            <TableHead className="text-right text-muted-foreground">Size</TableHead>
                            <TableHead className="text-muted-foreground">Added</TableHead>
                            <TableHead className="text-right text-muted-foreground">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.documents.map((row) => {
                            const view = statusView(row);
                            const state = rowState(row.id);
                            const reingestable = isReingestable(row.status);
                            return (
                              <TableRow key={row.id} className="[&>td]:py-3 [&>td]:align-top">
                                <TableCell className="min-w-56 whitespace-normal">
                                  {/* The file cell: its name, then its filing
                                      and its access. A tag reads as a path,
                                      in mono, because that is what it is —
                                      prettifying it here would make the chip
                                      and the thing you type into the
                                      classify dialog two different strings. */}
                                  {row.source_url ? (
                                    <a
                                      className="block font-medium wrap-anywhere underline-offset-4 hover:text-primary hover:underline"
                                      href={row.source_url}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                    >
                                      {row.filename}
                                    </a>
                                  ) : (
                                    <span className="block font-medium wrap-anywhere">{row.filename}</span>
                                  )}
                                  <span className="mt-1.5 flex flex-wrap gap-1">
                                    {/* Restricted carries a lock as well as
                                        the amber fill — colour alone is the
                                        wrong channel for "not everyone may
                                        read this". */}
                                    {row.required_permission !== null && (
                                      <Badge variant="warning" className="font-mono">
                                        <Lock aria-hidden="true" />
                                        {row.required_permission}
                                      </Badge>
                                    )}
                                    {row.tags.map((tag) => (
                                      <Badge key={tag} variant="outline" className="font-mono font-normal text-muted-foreground">
                                        {tag}
                                      </Badge>
                                    ))}
                                    {row.tags.length === 0 && row.required_permission === null && (
                                      <Badge variant="secondary" className="font-normal text-muted-foreground italic">
                                        Unclassified
                                      </Badge>
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell className="whitespace-normal">
                                  <StatusPill tone={view.tone} label={view.label} />
                                  {view.detail !== null && (
                                    <span
                                      className={cn(
                                        "mt-1 block",
                                        view.detailIsError
                                          ? "max-w-64 text-sm wrap-anywhere text-destructive"
                                          : "font-mono text-xs text-muted-foreground",
                                      )}
                                    >
                                      {view.detail}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                                  {formatBytes(row.size_bytes)}
                                </TableCell>
                                <TableCell className="text-muted-foreground">{formatDate(row.created_at)}</TableCell>
                                <TableCell>
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setClassifyDocumentId(row.id)}
                                    >
                                      <Tags aria-hidden="true" />
                                      Classify
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setChunksDocumentId(row.id)}
                                    >
                                      <Layers aria-hidden="true" />
                                      Chunks
                                    </Button>
                                    <IconAction
                                      label={state.busy ? "Reingesting…" : "Reingest"}
                                      tooltip="Reingest"
                                      disabled={!reingestable || state.busy}
                                      onClick={() => handleReingest(row.id)}
                                    >
                                      {state.busy ? (
                                        <Loader2 className="animate-spin" aria-hidden="true" />
                                      ) : (
                                        <RotateCw aria-hidden="true" />
                                      )}
                                    </IconAction>
                                    <IconAction
                                      label={state.busy ? "Removing…" : "Remove"}
                                      tooltip="Remove"
                                      destructive
                                      disabled={state.busy}
                                      onClick={() => handleRemove(row.id)}
                                    >
                                      <Trash2 aria-hidden="true" />
                                    </IconAction>
                                  </div>
                                  {state.error !== null && (
                                    <p className="mt-2 ml-auto max-w-64 text-right text-sm whitespace-normal wrap-anywhere text-destructive">
                                      {state.error}
                                    </p>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {classifyDocument !== undefined && (
          <ClassifyDialog
            document={classifyDocument}
            knownTags={tree.nodes}
            knownPermissions={knownPermissions}
            onClose={() => setClassifyDocumentId(null)}
            onSaved={() => {
              setClassifyDocumentId(null);
              if (corpus !== null) void refreshAll(corpus.id);
            }}
          />
        )}

        {chunksDocumentId !== null &&
          (() => {
            // Re-looked-up from `rows` on every render, never captured once —
            // a poll tick (or a reingest/remove) can replace or drop this
            // exact row while the panel is open, and the panel must track
            // whichever row is now live under this id rather than freeze the
            // stale snapshot from the click that opened it.
            const chunksDocument = rows.find((row) => row.id === chunksDocumentId);
            if (chunksDocument === undefined) return null;
            return <ChunksPanel document={chunksDocument} onClose={() => setChunksDocumentId(null)} />;
          })()}
      </div>
    </TooltipProvider>
  );
}
