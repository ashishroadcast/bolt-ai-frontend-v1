import { FileText, Folder, Lock, Tag } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { PageHeader } from "../agents/PageHeader.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { Sheet } from "../ask/parts/Sheet.tsx";
import { ChunksPanel } from "./ChunksPanel.tsx";
import { ClassifyDialog } from "./ClassifyDialog.tsx";
import { createDatasource, listDatasources, type DataSource } from "./datasourcesApi.ts";
import {
  ACCEPTED_EXTENSIONS,
  UNTAGGED_GROUP,
  childTags,
  classifyUpload,
  deleteDocument,
  groupDocuments,
  ingestPhase,
  isReingestable,
  listDocumentTags,
  listDocuments,
  reingestDocument,
  tagLabel,
  tagSegments,
  uploadDocument,
  type DocumentRecord,
  type TagTree,
} from "./documentsApi.ts";
import styles from "./DocumentsRoute.module.css";

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
  pillClass: string;
  detail: string | null;
  detailClass: string;
}

function statusView(row: DocumentRecord): StatusView {
  const phase = ingestPhase(row.status);
  if (phase === "ready") {
    return {
      label: "Ready",
      pillClass: `${styles.pill} ${styles.good}`,
      detail: row.chunk_count !== null ? `${row.chunk_count} chunks` : null,
      detailClass: styles.statusDetail,
    };
  }
  if (phase === "failed") {
    return {
      label: "Failed",
      pillClass: `${styles.pill} ${styles.critical}`,
      detail: row.error,
      detailClass: `${styles.statusDetail} ${styles.critical}`,
    };
  }
  return {
    label: "Processing",
    pillClass: `${styles.pill} ${styles.amber}`,
    detail: `· ${row.status}`,
    detailClass: styles.statusDetail,
  };
}

interface RowState {
  busy: boolean;
  error: string | null;
}

const BLANK_ROW_STATE: RowState = { busy: false, error: null };

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
      <ul className={styles.railList}>
        {nodes.map((node) => {
          const isSelected = node.path === selected;
          const isOpen = openPath.includes(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                className={`${styles.railItem} ${isSelected ? styles.railItemOn : ""}`}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                aria-current={isSelected ? "true" : undefined}
                aria-label={railName(tagLabel(node.path), node.document_count)}
                onClick={() => onSelect(node.path, false)}
              >
                <Folder size={12} strokeWidth={2} aria-hidden="true" />
                <span className={styles.railLabel}>{tagLabel(node.path)}</span>
                <span className={styles.railCount}>{node.document_count}</span>
              </button>
              {isOpen && renderLevel(node.path, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <nav className={styles.rail} aria-label="Classification">
      <p className={styles.railHead}>Filed under</p>
      <ul className={styles.railList}>
        <li>
          <button
            type="button"
            className={`${styles.railItem} ${selected === null ? styles.railItemOn : ""}`}
            aria-current={selected === null ? "true" : undefined}
            aria-label={railName("All documents", totalCount)}
            onClick={() => onSelect(null, false)}
          >
            <Tag size={12} strokeWidth={2} aria-hidden="true" />
            <span className={styles.railLabel}>All documents</span>
            <span className={styles.railCount}>{totalCount}</span>
          </button>
        </li>
      </ul>
      {renderLevel(null, 0)}
      {tree.untagged_count > 0 && (
        <ul className={styles.railList}>
          <li>
            <button
              type="button"
              className={styles.railItem}
              aria-label={railName("Unclassified", tree.untagged_count)}
              onClick={() => onSelect(null, true)}
            >
              <Folder size={12} strokeWidth={2} aria-hidden="true" />
              <span className={`${styles.railLabel} ${styles.railLabelQuiet}`}>Unclassified</span>
              <span className={styles.railCount}>{tree.untagged_count}</span>
            </button>
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
 * The screen is a rail plus grouped sheets rather than one flat table.
 * Classification is a hierarchy the operator can have several levels of,
 * so three more columns bolted onto a table would push the thing they are
 * navigating by into the narrowest part of the widest row. The rail is
 * the hierarchy; a sheet is one branch of it; the table inside a sheet is
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

  async function refreshAll(datasourceId: number) {
    await Promise.all([refreshDocuments(datasourceId), refreshTree(datasourceId)]);
  }

  useEffect(() => {
    if (corpus === null) return;
    void refreshDocuments(corpus.id);
    void refreshTree(corpus.id);
    // corpus.id alone (plus the two refetchers, which are memoised on the
    // filter): a freshly-created corpus is a new object each time, so
    // identity would refetch on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpus?.id, refreshDocuments, refreshTree]);

  // Self-terminating poll: reschedules itself only while something in the
  // list is still mid-pipeline, and stops the moment nothing is (task
  // brief: "a spinner that never resolves is the failure people actually
  // hit").
  useEffect(() => {
    if (corpus === null || documents === null) return;
    const stillWorking = documents.some((row) => ingestPhase(row.status) === "working");
    if (!stillWorking) return;
    const corpusId = corpus.id;
    const timer = setTimeout(() => {
      void refreshDocuments(corpusId);
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [documents, corpus, refreshDocuments]);

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
    <div>
      <PageHeader
        kicker="Connections"
        title="Knowledge"
        description="Connect the menus, SOPs and policy documents you want the agent to cite. File them under a classification, and restrict the sensitive ones — the agent can only quote what the person asking is allowed to read."
        actionLabel={uploading ? "Uploading…" : "Add a document"}
        onAction={openFilePicker}
        actionDisabled={uploading}
      />

      {corpora.length > 1 && (
        <div className={styles.corpusPicker}>
          <label htmlFor="document-corpus">Library</label>
          <select
            id="document-corpus"
            value={corpus?.id ?? ""}
            onChange={(event) => {
              const next = corpora.find((row) => String(row.id) === event.target.value);
              if (next !== undefined) setCorpus(next);
            }}
          >
            {corpora.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <label className={styles.visuallyHidden} htmlFor="document-upload">
        Add a document
      </label>
      <input
        ref={fileInputRef}
        id="document-upload"
        type="file"
        className={styles.visuallyHidden}
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={(event) => void handleFileSelected(event)}
      />

      {uploadError !== null && (
        <p role="alert" className={styles.uploadError}>
          {uploadError}
        </p>
      )}
      {loadError !== null && <p className={styles.loadError}>{loadError}</p>}

      {/* No action button here — PageHeader's own "Add a document" above
          is the one control for this, not a second button with the same
          name (the empty state used to be a dead-end with no action at
          all; now it at least explains what the header's button does). */}
      {corpusLoaded && rows.length === 0 && tree.nodes.length === 0 && (
        <EmptyState
          icon={FileText}
          title="Give the agent something to read"
          body="PDF, DOCX, PPTX, XLSX, HTML or Markdown, up to 50 MiB each — the agent can quote and cite any of it."
        />
      )}

      {(rows.length > 0 || tree.nodes.length > 0) && (
        <div className={styles.layout}>
          <TagRail
            tree={tree}
            selected={untaggedOnly ? null : selectedTag}
            totalCount={tree.total_count}
            onSelect={selectBranch}
          />

          <div className={styles.groups}>
            {groups.length === 0 && (
              <p className={styles.branchEmpty}>Nothing filed under {branchLabel} yet.</p>
            )}
            {groups.map((group) => (
              <Sheet
                key={group.key}
                title={group.label}
                subLabel={`${group.documents.length} document${group.documents.length === 1 ? "" : "s"}`}
                icon={group.key === UNTAGGED_GROUP ? FileText : Folder}
              >
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Status</th>
                        <th className={styles.num}>Size</th>
                        <th>Added</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.documents.map((row) => {
                        const view = statusView(row);
                        const state = rowState(row.id);
                        const reingestable = isReingestable(row.status);
                        return (
                          <tr key={row.id}>
                            <td>
                              <span className={styles.filename}>{row.filename}</span>
                              <span className={styles.rowMeta}>
                                {row.required_permission !== null && (
                                  <span className={`${styles.badge} ${styles.restricted}`}>
                                    <Lock size={10} strokeWidth={2.5} aria-hidden="true" />
                                    {row.required_permission}
                                  </span>
                                )}
                                {row.tags.map((tag) => (
                                  <span key={tag} className={styles.badge}>
                                    {tag}
                                  </span>
                                ))}
                                {row.tags.length === 0 && row.required_permission === null && (
                                  <span className={`${styles.badge} ${styles.quiet}`}>Unclassified</span>
                                )}
                              </span>
                            </td>
                            <td>
                              <span className={view.pillClass}>{view.label}</span>
                              {view.detail !== null && <span className={view.detailClass}>{view.detail}</span>}
                            </td>
                            <td className={styles.num}>{formatBytes(row.size_bytes)}</td>
                            <td>{formatDate(row.created_at)}</td>
                            <td>
                              <div className={styles.rowActions}>
                                <button
                                  type="button"
                                  className={styles.actionBtn}
                                  onClick={() => setClassifyDocumentId(row.id)}
                                >
                                  Classify
                                </button>
                                <button
                                  type="button"
                                  className={styles.actionBtn}
                                  onClick={() => setChunksDocumentId(row.id)}
                                >
                                  Chunks
                                </button>
                                <button
                                  type="button"
                                  className={styles.actionBtn}
                                  disabled={!reingestable || state.busy}
                                  onClick={() => handleReingest(row.id)}
                                >
                                  {state.busy ? "Reingesting…" : "Reingest"}
                                </button>
                                <button
                                  type="button"
                                  className={`${styles.actionBtn} ${styles.danger}`}
                                  disabled={state.busy}
                                  onClick={() => handleRemove(row.id)}
                                >
                                  {state.busy ? "Removing…" : "Remove"}
                                </button>
                              </div>
                              {state.error !== null && <p className={styles.rowNote}>{state.error}</p>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Sheet>
            ))}
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
  );
}
