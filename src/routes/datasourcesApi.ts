import { gatewayClient } from "../api/client.ts";

/**
 * Wire types for `GET/POST /agent/datasources`, `POST .../test`,
 * `DELETE /agent/datasources/{id}` (`agent-service/app/api/datasources.py`).
 * Field names match the FastAPI response verbatim (snake_case), the same
 * convention `../chat/types.ts`/`../chat/protocol.ts` already use for the
 * `/agent/run` wire shape — this is the JSON the server actually sends,
 * not a client-side reshaping of it.
 *
 * `DataSourceOut` never carries `connection_config_encrypted` (see that
 * module's own docstring, "never echo the credential back") — there is no
 * `dsn` field here at all, on purpose: a value this type doesn't have is a
 * value this screen cannot accidentally render.
 */
export type DataSourceType = "postgres" | "mysql" | "knowledge" | "redis";
export type IsolationMode = "column" | "connection";
export type SchemaMode = "prompt" | "index" | "unscanned";
export type DataSourceStatus = "created" | "indexing" | "ready" | "error";

export interface DataSource {
  id: number;
  name: string;
  type: DataSourceType;
  database_name: string;
  isolation_mode: IsolationMode;
  tenant_column: string | null;
  // Glob key patterns (e.g. "session:*") — only ever populated for a
  // `redis` datasource, null for every other type (app.datasource.models.
  // DataSource.key_patterns's own "populated only for its own type"
  // convention, same as tenant_column above).
  key_patterns: string[] | null;
  // Glob table patterns (e.g. "trip_*") narrowing what a scan indexes — SQL
  // types only. Null means every table the connection can see.
  table_patterns: string[] | null;
  // True for a redis-cluster datasource (redis.asyncio.cluster.RedisCluster)
  // rather than a standalone one. Meaningless (and always false) for every
  // other type.
  redis_cluster: boolean;
  // {"internal_host:port": "local_host:port"} — only populated when
  // redis_cluster is true and the cluster is reached through a tunnel whose
  // forwarded ports differ from what CLUSTER SLOTS advertises internally.
  redis_address_map: Record<string, string> | null;
  // An explicit allow-list of ids substituted into every configured
  // key_patterns entry in place of its "*" — see app.datasource.models.
  // DataSource.allowed_key_ids's own docstring for why this exists (some
  // Redis keyspaces carry no tenant boundary of their own). Null means no
  // allowlist; every pattern's own glob scans normally.
  allowed_key_ids: string[] | null;
  sample_values_enabled: boolean;
  schema_mode: SchemaMode;
  status: DataSourceStatus;
  total_tables: number;
  total_columns: number;
  is_active: boolean;
  // Only ever non-null while status is "error" — the reason a background
  // scan (POST .../scan) failed, so the row says why instead of just that.
  last_scan_error: string | null;
}

/**
 * `dsn` is only ever read from a form field, put straight into this object,
 * handed to `createDatasource`, and discarded — no caller of this module
 * stores one past that call. See DatabasesRoute.tsx for where the form
 * state itself is cleared the same instant the request resolves.
 */
export interface DataSourceCreatePayload {
  name: string;
  type: DataSourceType;
  database_name: string;
  dsn?: string;
  isolation_mode: IsolationMode;
  tenant_column?: string;
  // Required (non-empty) for type: "redis", forbidden for every other type
  // (app.api.datasources.create_datasource's own required/forbidden
  // validation — see DatabasesRoute.tsx's own key-patterns field).
  key_patterns?: string[];
  // Forbidden for every type except "redis" (create_datasource's own
  // required/forbidden validation, mirroring key_patterns above).
  redis_cluster?: boolean;
  redis_address_map?: Record<string, string>;
  allowed_key_ids?: string[];
  sample_values_enabled?: boolean;
}

export interface TestConnectionResult {
  success: boolean;
  reason?: string | null;
}

/**
 * The subset of `DataSourceCreatePayload` that actually affects whether a
 * connection opens — matches `app.api.datasources.DataSourceTestConnection
 * Payload` exactly. `dsn` is only ever read from the form field, put
 * straight into this object, handed to `testUnsavedDatasourceConnection`,
 * and discarded — same discipline `DataSourceCreatePayload`'s own docstring
 * describes for `createDatasource`.
 */
export interface DataSourceTestConnectionPayload {
  type: DataSourceType;
  database_name: string;
  dsn?: string;
}

export function listDatasources(): Promise<DataSource[]> {
  return gatewayClient.agentFetch<DataSource[]>("/agent/datasources");
}

export function createDatasource(payload: DataSourceCreatePayload): Promise<DataSource> {
  return gatewayClient.agentFetch<DataSource>("/agent/datasources", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Tests connection fields before a datasource row exists — the "Test
 * connection" button in the Connect-a-database form, distinct from
 * `testDatasourceConnection` below which only ever tests an already-saved
 * row. Never saves anything: `POST /agent/datasources/test` takes no
 * session/persistence path at all on the server (see that handler's own
 * docstring).
 */
export function testUnsavedDatasourceConnection(
  payload: DataSourceTestConnectionPayload,
): Promise<TestConnectionResult> {
  return gatewayClient.agentFetch<TestConnectionResult>("/agent/datasources/test", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function testDatasourceConnection(id: number): Promise<TestConnectionResult> {
  return gatewayClient.agentFetch<TestConnectionResult>(`/agent/datasources/${id}/test`, {
    method: "POST",
  });
}

export function scanDatasource(id: number): Promise<DataSource> {
  return gatewayClient.agentFetch<DataSource>(`/agent/datasources/${id}/scan`, {
    method: "POST",
  });
}

export type TableKind = "dim" | "fact" | "rpt" | "other";

/**
 * A column as a scan actually found it (`app.api.datasources.
 * SchemaColumnOut`). `has_samples` is always present — whether this column
 * had row-level values worth looking at — but `samples` (the values
 * themselves) is only ever populated by the server when the owning
 * datasource's `sample_values_enabled` is true; this client renders
 * whatever it's given and never fabricates a value for a column the server
 * left blank.
 */
export interface SchemaColumn {
  name: string;
  data_type: string;
  has_samples: boolean;
  samples: unknown[] | null;
}

export interface SchemaTableInfo {
  id: number;
  schema_name: string;
  table_name: string;
  table_kind: TableKind;
  partition_key: string | null;
  description: string | null;
  keywords: string[] | null;
  columns: SchemaColumn[];
  scanned_at: string | null;
}

/** What a scan actually wrote for this datasource — `[]` for one never
 * scanned, not an error (matches `GET .../tables`'s own contract). */
export function listDatasourceTables(id: number): Promise<SchemaTableInfo[]> {
  return gatewayClient.agentFetch<SchemaTableInfo[]>(`/agent/datasources/${id}/tables`);
}

/**
 * Which tables a scan indexes — `PATCH /agent/datasources/{id}`. `null`
 * goes back to every table. Takes effect on the next Scan, never by itself.
 */
export function updateDatasourceTables(
  id: number,
  tablePatterns: string[] | null,
): Promise<DataSource> {
  return gatewayClient.agentFetch<DataSource>(`/agent/datasources/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ table_patterns: tablePatterns }),
  });
}

export interface CatalogTable {
  table: string;
  columns: number;
}

/** Every table the connection can see, live — unlike `listDatasourceTables`,
 * which lists what a scan stored — plus the scan bounds a selection must fit. */
export interface DatasourceCatalog {
  tables: CatalogTable[];
  max_tables: number;
  max_columns: number;
}

export function getDatasourceCatalog(id: number): Promise<DatasourceCatalog> {
  return gatewayClient.agentFetch<DatasourceCatalog>(`/agent/datasources/${id}/catalog`);
}

export function deleteDatasource(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/datasources/${id}`, { method: "DELETE" });
}
