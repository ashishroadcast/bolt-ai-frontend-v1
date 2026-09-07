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
export type DataSourceType = "postgres" | "mysql" | "knowledge";
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

export function deleteDatasource(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/datasources/${id}`, { method: "DELETE" });
}
