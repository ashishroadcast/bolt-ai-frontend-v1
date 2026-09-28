import { GatewayError, UnauthorizedError } from "../ask/http/errors.ts";
import { GATEWAY_URL } from "../api/config.ts";
import { gatewayClient } from "../api/client.ts";
import { AgentApiError, stringDetailMessage } from "../ask/http/gatewayClient.ts";
import { getFreshCredential, onCredentialRefused } from "../auth/credential.ts";

/**
 * Wire types for `GET/POST /agent/documents`, `POST .../reingest`,
 * `DELETE /agent/documents/{id}` (`agent-service/app/api/documents.py`).
 * Field names match `DocumentOut` verbatim — see datasourcesApi.ts's own
 * docstring for why.
 */
export type DocumentStatus =
  | "pending"
  | "parsing"
  | "describing"
  | "chunking"
  | "indexing"
  | "ready"
  | "failed";

export interface DocumentRecord {
  id: number;
  datasource_id: number;
  source_url: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: DocumentStatus;
  page_count: number | null;
  figure_count: number | null;
  chunk_count: number | null;
  vision_cost_usd: number;
  error: string | null;
  created_at: string;
  /** Hierarchical classification paths, e.g. `ops/closing/cash-handling`.
   * Always present; `[]` is "unclassified", a state this screen renders. */
  tags: string[];
  /** The permission code a reader must hold to see this document at all,
   * or `null` for "anyone who can read documents". */
  required_permission: string | null;
}

export type KnowledgeSourceStatus = "pending" | "syncing" | "ready" | "failed";

export interface KnowledgeSourceRecord {
  id: number;
  datasource_id: number;
  name: string;
  url: string;
  status: KnowledgeSourceStatus;
  page_count: number;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function listKnowledgeSources(datasourceId: number): Promise<KnowledgeSourceRecord[]> {
  const query = new URLSearchParams({ datasource_id: String(datasourceId) });
  return gatewayClient.agentFetch<KnowledgeSourceRecord[]>(`/agent/knowledge-sources?${query.toString()}`);
}

export function addKnowledgeSource(datasourceId: number, url: string): Promise<KnowledgeSourceRecord> {
  return gatewayClient.agentFetch<KnowledgeSourceRecord>("/agent/knowledge-sources", {
    method: "POST",
    body: JSON.stringify({ datasource_id: datasourceId, url }),
  });
}

export function syncKnowledgeSource(id: number): Promise<KnowledgeSourceRecord> {
  return gatewayClient.agentFetch<KnowledgeSourceRecord>(`/agent/knowledge-sources/${id}/sync`, {
    method: "POST",
  });
}

/**
 * Wire types for `GET /agent/documents/tags`
 * (`agent-service/app/api/documents.py`'s `TagNodeOut`/`TagTreeOut`).
 *
 * Fetched separately from the document list, and deliberately: the tree
 * has to stay whole while the list is narrowed to one branch, or every
 * branch the operator is not currently standing in would vanish from the
 * navigation the moment they used it. `document_count` is rolled up, so a
 * parent reports everything at or below it.
 */
export interface TagNode {
  path: string;
  depth: number;
  document_count: number;
}

export interface TagTree {
  nodes: TagNode[];
  untagged_count: number;
  /** Every document this reader can see. Not the sum of the root counts
   * plus `untagged_count` — a document filed under two roots is counted
   * once here and twice by that sum, which is exactly why the server
   * returns it rather than leaving it to be re-derived. */
  total_count: number;
}

export const TAG_SEPARATOR = "/";

/** The key `groupDocuments` uses for documents nothing has filed yet. Not
 * a legal tag path (a path segment cannot contain `_`), so it can never
 * collide with a real one. */
export const UNTAGGED_GROUP = "__untagged__";

export function tagSegments(path: string): string[] {
  return path.split(TAG_SEPARATOR);
}

export function parentTag(path: string): string | null {
  const segments = tagSegments(path);
  return segments.length <= 1 ? null : segments.slice(0, -1).join(TAG_SEPARATOR);
}

/**
 * The last segment of a path, as a human would write it: `cash-handling`
 * -> `Cash handling`. Only the deepest segment, because the tree already
 * shows the ancestors — repeating them on every node turns a tree into a
 * column of near-identical strings.
 */
export function tagLabel(path: string): string {
  const leaf = tagSegments(path).at(-1) ?? path;
  const spaced = leaf.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The direct children of `parent` (or the roots, for `null`) — how the
 * rail renders one level at a time from a flat node list. */
export function childTags(nodes: TagNode[], parent: string | null): TagNode[] {
  return nodes.filter((node) => parentTag(node.path) === parent);
}

export interface DocumentGroup {
  /** Stable React key; a tag path, or `UNTAGGED_GROUP`. */
  key: string;
  label: string;
  /** The tag path this group represents, or `null` for the unfiled group. */
  path: string | null;
  documents: DocumentRecord[];
}

/**
 * The documents on screen, grouped one level below wherever the operator
 * is standing: at the root they group by top-level classification, and
 * inside `ops` they group by `closing`, `opening`, and whatever sits
 * directly in `ops` itself.
 *
 * A document filed under two branches appears under both. That is
 * deliberate and matches how the server rolls counts up — a closing-cash
 * SOP filed under `ops/closing` and `finance/cash` genuinely belongs in
 * both places, and showing it in one arbitrarily-chosen group would make
 * the other group look wrong.
 */
export function groupDocuments(documents: DocumentRecord[], selected: string | null): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>();

  const push = (key: string, label: string, path: string | null, row: DocumentRecord) => {
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, label, path, documents: [row] });
    } else if (!existing.documents.includes(row)) {
      existing.documents.push(row);
    }
  };

  for (const row of documents) {
    const relevant =
      selected === null
        ? row.tags
        : row.tags.filter((tag) => tag === selected || tag.startsWith(`${selected}${TAG_SEPARATOR}`));

    if (relevant.length === 0) {
      push(UNTAGGED_GROUP, selected === null ? "Unclassified" : `Directly in ${tagLabel(selected)}`, null, row);
      continue;
    }

    for (const tag of relevant) {
      if (tag === selected) {
        // Filed at this exact level, not in any of its sub-branches. Keyed
        // by the path itself, which no child group can collide with (a
        // child is always `selected/something`).
        push(tag, `Directly in ${tagLabel(tag)}`, tag, row);
        continue;
      }
      const depth = selected === null ? 1 : tagSegments(selected).length + 1;
      const path = tagSegments(tag).slice(0, depth).join(TAG_SEPARATOR);
      push(path, tagLabel(path), path, row);
    }
  }

  // Unfiled last: it is the residue, not a peer of the named branches.
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNTAGGED_GROUP) return 1;
    if (b.key === UNTAGGED_GROUP) return -1;
    return a.label.localeCompare(b.label);
  });
}

/** "Everyone" versus the code a reader has to hold — the one string this
 * screen shows for `required_permission`, so the two call sites (row badge
 * and edit form) can never word it differently. */
export function accessLabel(requiredPermission: string | null): string {
  return requiredPermission === null ? "Everyone" : requiredPermission;
}

/**
 * Three states the console distinguishes (task brief: "still-working /
 * finished / failed"), collapsing `DocumentStatus`'s five in-flight values
 * (`pending`/`parsing`/`describing`/`chunking`/`indexing`) into one
 * "working" bucket — the operator cares whether it's done, not which
 * pipeline stage it's in, but the stage is still shown alongside the
 * bucket (DocumentsRoute.tsx) so "working" never reads as a stall.
 */
export type IngestPhase = "working" | "ready" | "failed";

export function ingestPhase(status: DocumentStatus): IngestPhase {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "working";
}

// A document may be reingested from either terminal state — mirrors
// `documents.py`'s own `_REINGESTABLE_STATUSES` exactly, so the button's
// enabled/disabled state never drifts from the 409 the server would
// otherwise return for the same attempt.
export function isReingestable(status: DocumentStatus): boolean {
  return status === "ready" || status === "failed";
}

// Hard caps enforced server-side (`documents.py`: `_MAX_UPLOAD_BYTES`,
// `_EXTENSION_CONTENT_TYPES`) — duplicated here only as a *client-side*
// pre-check so an oversized or wrong-type file is refused before a byte
// leaves the browser, with the same numbers the server would enforce
// anyway. The server remains the actual authority: classifyUpload rejects
// nothing the server would accept, and a file that slips past it (a caller
// bypassing this check entirely) still gets refused server-side.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".md", ".markdown"];

export type UploadValidation = { ok: true } | { ok: false; message: string };

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Refuses ordinarily — naming the actual limit or the actual accepted
 * types in the message (task brief: "Name the limit or the accepted types
 * in the message"), never a bare "upload failed".
 */
export function classifyUpload(file: File): UploadValidation {
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `"${file.name}" is ${formatMiB(file.size)} — the upload limit is 50 MiB.`,
    };
  }
  const extension = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      message: `"${file.name}" isn't a type the agent can read. Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}.`,
    };
  }
  return { ok: true };
}

export interface DocumentFilter {
  /** A classification path. The server matches this level and everything
   * below it, so `ops` also returns `ops/closing/cash-handling` — the
   * filtering is done there, not here, so the console and the agent can
   * never disagree about what a branch contains. */
  tag?: string;
  untagged?: boolean;
}

export function listDocuments(
  datasourceId: number,
  filter: DocumentFilter = {},
): Promise<DocumentRecord[]> {
  const query = new URLSearchParams({ datasource_id: String(datasourceId) });
  if (filter.tag !== undefined) query.set("tag", filter.tag);
  if (filter.untagged === true) query.set("untagged", "true");
  return gatewayClient.agentFetch<DocumentRecord[]>(`/agent/documents?${query.toString()}`);
}

export function listDocumentTags(datasourceId: number): Promise<TagTree> {
  const query = new URLSearchParams({ datasource_id: String(datasourceId) });
  return gatewayClient.agentFetch<TagTree>(`/agent/documents/tags?${query.toString()}`);
}

export interface Classification {
  tags: string[];
  required_permission: string | null;
}

/**
 * Replaces a document's whole classification — `tags` is the complete set
 * now, not an addition, and `required_permission: null` genuinely lifts a
 * restriction rather than leaving it alone. Both mirror the server's own
 * `ClassificationIn`, whose docstring explains why a partial patch would
 * be ambiguous in exactly the permissive direction.
 */
export function setDocumentClassification(
  id: number,
  classification: Classification,
): Promise<DocumentRecord> {
  return gatewayClient.agentFetch<DocumentRecord>(`/agent/documents/${id}/classification`, {
    method: "PATCH",
    body: JSON.stringify(classification),
  });
}

export function reingestDocument(id: number): Promise<DocumentRecord> {
  return gatewayClient.agentFetch<DocumentRecord>(`/agent/documents/${id}/reingest`, { method: "POST" });
}

export function deleteDocument(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/documents/${id}`, { method: "DELETE" });
}

/**
 * Wire types for `GET /agent/documents/{id}/chunks`
 * (`agent-service/app/api/documents.py`'s `DocumentChunkOut`/
 * `DocumentChunkListOut`) — field names match verbatim, same rule as
 * `DocumentRecord` above. `bbox` is left untyped beyond `Record<string,
 * unknown>`: the console never draws it, only displays it as-is (an
 * operator checking provenance wants to see the numbers, not have this
 * module assert a shape docling's own `BoundingBox.model_dump` happens to
 * produce today).
 */
export type ChunkKind = "text" | "table" | "figure" | "page_image";

export interface DocumentChunk {
  id: number;
  ordinal: number;
  text: string;
  headings: string[] | null;
  page_no: number | null;
  bbox: Record<string, unknown> | null;
  kind: ChunkKind;
}

export interface DocumentChunkPage {
  items: DocumentChunk[];
  next_cursor: number | null;
  has_more: boolean;
}

// A short, human label per ChunkKind — "page_image" reads as a raw enum
// value otherwise, and an operator scanning the list should see why a
// chunk exists (a transcribed page, not the document's own text layer)
// without knowing the wire vocabulary.
const CHUNK_KIND_LABELS: Record<ChunkKind, string> = {
  text: "Text",
  table: "Table",
  figure: "Figure",
  page_image: "Page scan",
};

export function chunkKindLabel(kind: ChunkKind): string {
  return CHUNK_KIND_LABELS[kind];
}

export function listDocumentChunks(
  documentId: number,
  options: { cursor?: number; limit?: number } = {},
): Promise<DocumentChunkPage> {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set("cursor", String(options.cursor));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const qs = query.toString();
  return gatewayClient.agentFetch<DocumentChunkPage>(
    `/agent/documents/${documentId}/chunks${qs ? `?${qs}` : ""}`,
  );
}

/**
 * The one deliberate exception to "route every /agent/* call through
 * GatewayClient" in this task, for exactly the same reason
 * `../chat/runStream.ts` already carries one (see that module's own
 * docstring): `GatewayClient.agentFetch` unconditionally sets
 * `Content-Type: application/json` whenever a body is present and no
 * header was already supplied, which is correct for every other call this
 * module makes but wrong here — `POST /agent/documents` is
 * `multipart/form-data` (`documents.py`'s `File`/`Form` params), and the
 * only way a `FormData` body gets a *correct* `Content-Type` (with the
 * boundary the server's multipart parser needs) is for no `Content-Type`
 * header to be present at all when the request is built, so the fetch
 * implementation fills one in itself. `agentFetch` cannot do that — it
 * cannot tell "no header was set" from "the body doesn't need one" — and
 * this task's concurrency boundary forbids editing gatewayClient.ts to
 * teach it that distinction. This function reproduces exactly the same
 * auth contract `agentFetch` already enforces (the same `getFreshCredential`/
 * `onCredentialRefused` primitives `../api/client.ts` wires that class to) and
 * reuses `AgentApiError`/`stringDetailMessage` for the error path, rather
 * than a second, independent notion of either. Flagged to Saurabh in this
 * task's report as a gap for whoever next touches gatewayClient.ts: a
 * `GatewayClient.agentUpload`-shaped method (skip the default Content-Type
 * when `init.body instanceof FormData`) would let this collapse back into
 * the shared client.
 */
export async function uploadDocument(datasourceId: number, file: File): Promise<DocumentRecord> {
  const token = await getFreshCredential();
  if (token === null) {
    onCredentialRefused();
    throw new UnauthorizedError(401);
  }

  const formData = new FormData();
  formData.append("datasource_id", String(datasourceId));
  formData.append("file", file);

  const response = await fetch(`${GATEWAY_URL}/agent/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (response.status === 401 || response.status === 403) {
    if (response.status === 401) onCredentialRefused();
    throw new UnauthorizedError(response.status);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new AgentApiError(
      stringDetailMessage(body) ?? `Upload failed (${response.status}).`,
      response.status,
      body,
    );
  }
  if (response.status === 204) {
    throw new GatewayError("Upload succeeded but the server sent no document back.");
  }
  return (await response.json()) as DocumentRecord;
}
