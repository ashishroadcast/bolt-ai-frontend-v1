import { Fragment, useEffect, useState, type FormEvent } from "react";
import { GatewayError } from "../ask/http/errors.ts";
import { PageHeader } from "../agents/PageHeader.tsx";
import { Sheet } from "../ask/parts/Sheet.tsx";
import {
  createDatasource,
  deleteDatasource,
  getDatasourceCatalog,
  listDatasources,
  listDatasourceTables,
  scanDatasource,
  testDatasourceConnection,
  testUnsavedDatasourceConnection,
  updateDatasourceTables,
  type DatasourceCatalog,
  type DataSource,
  type DataSourceType,
  type IsolationMode,
  type SchemaTableInfo,
  type TestConnectionResult,
} from "./datasourcesApi.ts";
import { Database } from "lucide-react";
import styles from "./DatabasesRoute.module.css";

// While at least one row is mid-scan, poll the list so its status/table
// counts pick up the background scan finishing without a manual reload —
// POST .../scan itself only ever returns the "indexing" snapshot, never the
// finished one.
const SCAN_POLL_INTERVAL_MS = 3000;

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the gateway. Check your connection and try again.";
}

const DATASOURCE_TYPE_LABEL: Record<DataSourceType, string> = {
  postgres: "Postgres",
  mysql: "MySQL",
  knowledge: "Knowledge",
  redis: "Redis",
};

const ISOLATION_LABEL: Record<IsolationMode, string> = {
  connection: "Per connection",
  column: "Per column",
};

function statusPillClass(status: DataSource["status"]): string {
  switch (status) {
    case "ready":
      return `${styles.pill} ${styles.good}`;
    case "error":
      return `${styles.pill} ${styles.critical}`;
    case "indexing":
      return `${styles.pill} ${styles.amber}`;
    default:
      return `${styles.pill} ${styles.neutral}`;
  }
}

interface CreateFormState {
  name: string;
  type: DataSourceType;
  databaseName: string;
  dsn: string;
  isolationMode: IsolationMode;
  tenantColumn: string;
  // Raw textarea text, one glob key pattern per line (e.g. "session:*") —
  // only meaningful when type === "redis"; parsed into DataSourceCreate
  // Payload.key_patterns on submit (see handleSubmit).
  keyPatterns: string;
  // Only meaningful when type === "redis".
  redisCluster: boolean;
  // Raw textarea text, one "old_host:port=new_host:port" pair per line —
  // only meaningful when redisCluster is true; parsed into
  // DataSourceCreatePayload.redis_address_map on submit.
  redisAddressMap: string;
  // Raw textarea text, one id per line — substituted for every configured
  // key_patterns entry's "*" (see DataSource.allowed_key_ids's own
  // docstring). Optional even for redis; only meaningful when type ===
  // "redis".
  allowedKeyIds: string;
  sampleValuesEnabled: boolean;
}

const BLANK_FORM: CreateFormState = {
  name: "",
  type: "postgres",
  databaseName: "",
  dsn: "",
  isolationMode: "connection",
  tenantColumn: "",
  keyPatterns: "",
  redisCluster: false,
  redisAddressMap: "",
  allowedKeyIds: "",
  sampleValuesEnabled: true,
};

/** Splits the "Key patterns"/"Allowed IDs" textarea into a clean list —
 * mirrors the dedupe/strip app.api.datasources.create_datasource itself
 * does server-side for key_patterns, so the operator sees the same list
 * they're about to submit rather than a silently different one. */
function parseLines(raw: string): string[] {
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

/** Parses "old_host:port=new_host:port" lines into the plain
 * {"old_host:port": "new_host:port"} shape app.redis.clients.
 * address_remap_from_map expects — one malformed line (no "=", or an
 * empty side) is dropped rather than failing the whole parse, since a
 * still-being-typed line is the common transient state while editing. */
function parseAddressMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) continue;
    const source = trimmed.slice(0, eq).trim();
    const target = trimmed.slice(eq + 1).trim();
    if (source !== "" && target !== "") map[source] = target;
  }
  return map;
}

interface RowState {
  testing: boolean;
  testResult: TestConnectionResult | null;
  testError: string | null;
  removing: boolean;
  removeError: string | null;
  scanning: boolean;
  scanError: string | null;
}

const BLANK_ROW_STATE: RowState = {
  testing: false,
  testResult: null,
  testError: null,
  removing: false,
  removeError: null,
  scanning: false,
  scanError: null,
};

const TABLE_KIND_LABEL: Record<SchemaTableInfo["table_kind"], string> = {
  dim: "dim",
  fact: "fact",
  rpt: "rpt",
  other: "table",
};

/**
 * "What did the scan find" — opened by the row's own "Tables" action,
 * fetched on demand rather than eagerly for every row (a real warehouse can
 * have dozens of tables' worth of columns, not worth loading before anyone
 * asks). Never holds a search match across rows — each row's `search` is
 * local to its own open panel.
 */
interface TableDetailState {
  open: boolean;
  loading: boolean;
  error: string | null;
  tables: SchemaTableInfo[] | null;
  search: string;
}

const BLANK_TABLE_DETAIL: TableDetailState = {
  open: false,
  loading: false,
  error: null,
  tables: null,
  search: "",
};

function matchesSearch(table: SchemaTableInfo, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  if (table.table_name.toLowerCase().includes(needle)) return true;
  return table.columns.some((column) => column.name.toLowerCase().includes(needle));
}

// "8 tables · 43 cols · 6 value cols" — value cols counts has_samples, not
// whether this viewer can actually see the values (sample_values_enabled
// may hide them) — it's still true that the scan found something worth
// looking at in that column.
function summarizeTables(tables: SchemaTableInfo[]): string {
  const tableCount = tables.length;
  const colCount = tables.reduce((sum, table) => sum + table.columns.length, 0);
  const valueColCount = tables.reduce(
    (sum, table) => sum + table.columns.filter((column) => column.has_samples).length,
    0,
  );
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(tableCount, "table")} · ${plural(colCount, "col")} · ${plural(valueColCount, "value col")}`;
}

/** Only the SQL types scan tables, so only they have tables to choose. */
function scansTables(row: DataSource): boolean {
  return row.type === "postgres" || row.type === "mysql";
}

/**
 * Python's `fnmatchcase`, which is what the server's scan matches
 * `table_patterns` with: `*`, `?`, `[...]` and `[!...]`, case-sensitive.
 */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) source += "\\[";
      else {
        const body = glob.slice(i + 1, end);
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else source += ch.replace(/[.+^${}()|\\/\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function isGlob(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/**
 * "Choose tables" — opened from a SQL row. Reads the live catalog, because a
 * datasource over the scan bounds can never be scanned to find out what it
 * holds, and writes the ticked tables as `table_patterns`.
 */
interface PickerState {
  open: boolean;
  loading: boolean;
  error: string | null;
  catalog: DatasourceCatalog | null;
  selected: Set<string>;
  search: string;
  saving: boolean;
  saveError: string | null;
  saved: boolean;
}

const BLANK_PICKER: PickerState = {
  open: false,
  loading: false,
  error: null,
  catalog: null,
  selected: new Set(),
  search: "",
  saving: false,
  saveError: null,
  saved: false,
};

/** What the row currently scans, pre-ticked. `null` patterns mean every
 * table, which is only ticked when it would actually fit the bounds. */
function initialSelection(catalog: DatasourceCatalog, patterns: string[] | null): Set<string> {
  if (patterns === null) {
    const columns = catalog.tables.reduce((sum, t) => sum + t.columns, 0);
    const fits = catalog.tables.length <= catalog.max_tables && columns <= catalog.max_columns;
    return new Set(fits ? catalog.tables.map((t) => t.table) : []);
  }
  const regexps = patterns.map(globToRegExp);
  return new Set(
    catalog.tables.filter((t) => regexps.some((re) => re.test(t.table))).map((t) => t.table),
  );
}

/*
 * Connecting a database is the highest-consequence action in this console
 * (task brief) — the DSN is a live credential, so the form's own state
 * (`CreateFormState`, including `dsn`) is discarded the instant the create
 * call resolves (`resetForm` + closing the form, DatabasesRoute.test.tsx's
 * "leaves the DSN with no trace") rather than merely cleared and left
 * mounted. `DataSourceOut` (datasourcesApi.ts) never carries the
 * credential back either, so there is no code path in this component that
 * ever holds a DSN past that one submit — including the form's own "Test
 * connection" (`handleTestConnection`), which reads `form.dsn` once to
 * build a request body and never stores it anywhere else, matching
 * `POST /agent/datasources/test`'s own "never persisted" contract on the
 * server side.
 *
 * A saved row's "Scan" (`handleScan`) is a second, unrelated background
 * action — `POST /agent/datasources/{id}/scan` only ever returns the
 * "indexing" snapshot immediately, so this component polls the list while
 * any row is indexing (see SCAN_POLL_INTERVAL_MS) to pick up the finished
 * table/column counts or `last_scan_error` without a manual reload.
 *
 * Replaces the inert shared `EmptyState` (src/components/, out of this
 * task's file list — its action button has no handler yet) with this
 * route's own real, wired invite — EmptyState.tsx's own docstring already
 * names this file as where that happens.
 */
export function DatabasesRoute() {
  const [datasources, setDatasources] = useState<DataSource[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CreateFormState>(BLANK_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  // The form's own "Test connection" — separate from a saved row's
  // per-id test above (testDatasourceConnection/handleTest): nothing here
  // ever saves a row, so it has no rowStates entry of its own.
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<TestConnectionResult | null>(
    null,
  );
  const [connectionTestError, setConnectionTestError] = useState<string | null>(null);
  const [tableDetails, setTableDetails] = useState<Record<number, TableDetailState>>({});
  const [pickers, setPickers] = useState<Record<number, PickerState>>({});

  useEffect(() => {
    let cancelled = false;
    listDatasources()
      .then((rows) => {
        if (!cancelled) setDatasources(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const databases = (datasources ?? []).filter((row) => row.type !== "knowledge");

  // Polls while a scan is in flight so a finished (or failed) background
  // scan's status/table counts show up without the operator reloading —
  // see this module's own SCAN_POLL_INTERVAL_MS comment. Reads `datasources`
  // directly rather than the derived `databases` filter above: `databases`
  // is a fresh array every render, so depending on it would tear the
  // interval down and rebuild it on every unrelated re-render (a keystroke
  // in the form, a row's test result landing) instead of only when the
  // fetched list itself actually changes.
  useEffect(() => {
    const rows = datasources ?? [];
    if (!rows.some((row) => row.status === "indexing")) return;
    const interval = window.setInterval(() => {
      listDatasources()
        .then((fetched) => setDatasources(fetched))
        .catch(() => {
          // A transient failure here just means the next tick retries —
          // there is no user-facing action to surface it against.
        });
    }, SCAN_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [datasources]);

  function rowState(id: number): RowState {
    return rowStates[id] ?? BLANK_ROW_STATE;
  }

  function patchRow(id: number, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW_STATE), ...patch } }));
  }

  function resetConnectionTest() {
    setTestingConnection(false);
    setConnectionTestResult(null);
    setConnectionTestError(null);
  }

  function openForm() {
    setSubmitError(null);
    resetConnectionTest();
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setForm(BLANK_FORM);
    setSubmitError(null);
    resetConnectionTest();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);

    const name = form.name.trim();
    const databaseName = form.databaseName.trim();
    const dsn = form.dsn.trim();
    const tenantColumn = form.tenantColumn.trim();
    const isRedis = form.type === "redis";
    const keyPatterns = parseLines(form.keyPatterns);
    const addressMap = parseAddressMap(form.redisAddressMap);
    const allowedKeyIds = parseLines(form.allowedKeyIds);

    if (name === "") {
      setSubmitError("Name is required.");
      return;
    }
    if (databaseName === "") {
      setSubmitError("Database name is required.");
      return;
    }
    if (dsn === "") {
      setSubmitError("A connection string is required to connect a database.");
      return;
    }
    if (isRedis) {
      if (keyPatterns.length === 0) {
        setSubmitError("At least one key pattern is required for a Redis datasource.");
        return;
      }
    } else if (form.isolationMode === "column" && tenantColumn === "") {
      setSubmitError("A tenant column is required when scoping per column.");
      return;
    }

    setSubmitting(true);
    try {
      const created = await createDatasource({
        name,
        type: form.type,
        database_name: databaseName,
        dsn,
        // Redis only supports per-connection tenant scoping (app.api.
        // datasources.create_datasource rejects isolation_mode=column for
        // it) — forced here rather than trusting whatever the selector last
        // held from a previous type.
        isolation_mode: isRedis ? "connection" : form.isolationMode,
        tenant_column: !isRedis && form.isolationMode === "column" ? tenantColumn : undefined,
        key_patterns: isRedis ? keyPatterns : undefined,
        redis_cluster: isRedis ? form.redisCluster : undefined,
        // Forbidden server-side unless redis_cluster is also true (create_
        // datasource) — only sent at all when both this agent's own
        // redisCluster checkbox is on AND the operator actually typed a
        // mapping, so an empty textarea never trips that validation.
        redis_address_map:
          isRedis && form.redisCluster && Object.keys(addressMap).length > 0
            ? addressMap
            : undefined,
        allowed_key_ids: isRedis && allowedKeyIds.length > 0 ? allowedKeyIds : undefined,
        sample_values_enabled: form.sampleValuesEnabled,
      });
      setDatasources((prev) => [...(prev ?? []), created]);
      // Closes the form and drops every field, `dsn` included, in the same
      // state update the success is handled in — see this component's own
      // docstring.
      closeForm();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  /*
   * Tests the fields currently in the form, before a datasource row exists
   * — never calls createDatasource, and reports the server's own classified
   * reason rather than a generic failure (this route's task brief, same
   * wording as _classify_connection_error's own docstring). Nothing here
   * writes `form.dsn` anywhere but the request body sent to `POST /agent/
   * datasources/test`, which never persists it either (that handler's own
   * docstring) — the field it came from is left exactly as it was so
   * Connect still works afterward either way.
   */
  async function handleTestConnection() {
    const databaseName = form.databaseName.trim();
    const dsn = form.dsn.trim();

    if (dsn === "") {
      setConnectionTestResult(null);
      setConnectionTestError("A connection string is required to test the connection.");
      return;
    }

    setTestingConnection(true);
    setConnectionTestResult(null);
    setConnectionTestError(null);
    try {
      const result = await testUnsavedDatasourceConnection({
        type: form.type,
        database_name: databaseName,
        dsn,
      });
      setConnectionTestResult(result);
    } catch (err) {
      setConnectionTestError(errorMessage(err));
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleTest(id: number) {
    patchRow(id, { testing: true, testResult: null, testError: null });
    try {
      const result = await testDatasourceConnection(id);
      patchRow(id, { testing: false, testResult: result });
    } catch (err) {
      patchRow(id, { testing: false, testError: errorMessage(err) });
    }
  }

  async function handleScan(id: number) {
    patchRow(id, { scanning: true, scanError: null });
    try {
      const updated = await scanDatasource(id);
      setDatasources((prev) => (prev ?? []).map((row) => (row.id === id ? updated : row)));
      patchRow(id, { scanning: false });
    } catch (err) {
      patchRow(id, { scanning: false, scanError: errorMessage(err) });
    }
  }

  function tableDetail(id: number): TableDetailState {
    return tableDetails[id] ?? BLANK_TABLE_DETAIL;
  }

  function patchTableDetail(id: number, patch: Partial<TableDetailState>) {
    setTableDetails((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? BLANK_TABLE_DETAIL), ...patch },
    }));
  }

  /*
   * Opens (or closes) a row's "what did the scan find" panel — fetched
   * fresh on every open rather than cached indefinitely, so re-opening
   * after a Scan shows what the latest run actually wrote.
   */
  async function handleToggleTables(id: number) {
    if (tableDetail(id).open) {
      patchTableDetail(id, { open: false });
      return;
    }
    patchTableDetail(id, { open: true, loading: true, error: null });
    try {
      const tables = await listDatasourceTables(id);
      patchTableDetail(id, { loading: false, tables });
    } catch (err) {
      patchTableDetail(id, { loading: false, error: errorMessage(err) });
    }
  }

  function picker(id: number): PickerState {
    return pickers[id] ?? BLANK_PICKER;
  }

  function patchPicker(id: number, patch: Partial<PickerState>) {
    setPickers((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_PICKER), ...patch } }));
  }

  /* Fetched fresh on every open: tables come and go, and a stale list would
     let someone tick a table that no longer exists. */
  async function handleTogglePicker(row: DataSource) {
    if (picker(row.id).open) {
      patchPicker(row.id, { open: false });
      return;
    }
    patchPicker(row.id, { ...BLANK_PICKER, open: true, loading: true });
    try {
      const catalog = await getDatasourceCatalog(row.id);
      patchPicker(row.id, {
        loading: false,
        catalog,
        selected: initialSelection(catalog, row.table_patterns),
      });
    } catch (err) {
      patchPicker(row.id, { loading: false, error: errorMessage(err) });
    }
  }

  function setTicked(id: number, tables: string[], ticked: boolean) {
    const next = new Set(picker(id).selected);
    for (const table of tables) {
      if (ticked) next.add(table);
      else next.delete(table);
    }
    patchPicker(id, { selected: next, saved: false });
  }

  async function handleSaveTables(id: number, tablePatterns: string[] | null) {
    patchPicker(id, { saving: true, saveError: null, saved: false });
    try {
      const updated = await updateDatasourceTables(id, tablePatterns);
      setDatasources((prev) => (prev ?? []).map((row) => (row.id === id ? updated : row)));
      patchPicker(id, { saving: false, saved: true });
    } catch (err) {
      patchPicker(id, { saving: false, saveError: errorMessage(err) });
    }
  }

  async function handleRemove(id: number) {
    patchRow(id, { removing: true, removeError: null });
    try {
      await deleteDatasource(id);
      setDatasources((prev) => (prev ?? []).filter((row) => row.id !== id));
      setRowStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      patchRow(id, { removing: false, removeError: errorMessage(err) });
    }
  }

  return (
    <div>
      {/* The shared header, not a local copy of one: this screen used to
          stack its own eyebrow, a 22px title and a paragraph, which put
          its title on a different line and at a different size from the
          eleven screens either side of it in the rail. */}
      <PageHeader
        kicker="Connections"
        title="Databases"
        description="Point the agent at a database and it can answer directly from your data, with the query and its plan gate open for you to check in the inspector."
        actionLabel={formOpen ? undefined : "Connect a database"}
        onAction={openForm}
      />

      {loadError !== null && <p className={styles.loadError}>{loadError}</p>}

      {formOpen && (
        // autoComplete="off" at both the form and field level: a lone
        // type="password" field (the DSN below) is enough for some browsers
        // to read this whole form as a login and offer a saved email into
        // "Database name" — see this component's own docstring.
        <form className={styles.form} onSubmit={handleSubmit} autoComplete="off">
          <h3 className={styles.formTitle}>Connect a database</h3>

          <div className={styles.field}>
            <label htmlFor="datasource-name">Name</label>
            <input
              id="datasource-name"
              type="text"
              autoComplete="off"
              value={form.name}
              disabled={submitting}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="datasource-type">Type</label>
            <select
              id="datasource-type"
              value={form.type}
              disabled={submitting}
              onChange={(event) => {
                resetConnectionTest();
                const nextType = event.target.value as DataSourceType;
                setForm((prev) => ({
                  ...prev,
                  type: nextType,
                  // Redis only supports per-connection scoping (see
                  // handleSubmit) — reset away from a stale "Per column"
                  // selection left over from a different type rather than
                  // silently overriding it at submit with no visible change.
                  isolationMode: nextType === "redis" ? "connection" : prev.isolationMode,
                }));
              }}
            >
              <option value="postgres">Postgres</option>
              <option value="mysql">MySQL</option>
              <option value="redis">Redis</option>
            </select>
          </div>

          <div className={styles.field}>
            <label htmlFor="datasource-database-name">Database name</label>
            <input
              id="datasource-database-name"
              type="text"
              autoComplete="off"
              value={form.databaseName}
              disabled={submitting}
              onChange={(event) => {
                resetConnectionTest();
                setForm((prev) => ({ ...prev, databaseName: event.target.value }));
              }}
            />
          </div>

          {form.type !== "redis" && (
            <div className={styles.field}>
              <label htmlFor="datasource-isolation-mode">Tenant scoping</label>
              <select
                id="datasource-isolation-mode"
                value={form.isolationMode}
                disabled={submitting}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    isolationMode: event.target.value as IsolationMode,
                  }))
                }
              >
                <option value="connection">Per connection</option>
                <option value="column">Per column</option>
              </select>
            </div>
          )}

          <div className={`${styles.field} ${styles.wide}`}>
            <label htmlFor="datasource-dsn">Connection string (DSN)</label>
            <input
              id="datasource-dsn"
              type="password"
              // "off", never "new-password": the latter is the token
              // signup/change-password forms use specifically to invite the
              // browser's "save this password?" prompt on submit — the
              // opposite of what a live production credential needs. "off"
              // is the spec's own "do not offer to remember this value"
              // signal.
              autoComplete="off"
              placeholder={form.type === "redis" ? "redis://[:password@]host:port[/db]" : undefined}
              value={form.dsn}
              disabled={submitting}
              onChange={(event) => {
                resetConnectionTest();
                setForm((prev) => ({ ...prev, dsn: event.target.value }));
              }}
            />
          </div>

          {form.type === "redis" ? (
            <div className={`${styles.field} ${styles.wide}`}>
              <label htmlFor="datasource-key-patterns">Key patterns</label>
              <textarea
                id="datasource-key-patterns"
                autoComplete="off"
                rows={3}
                placeholder={"session:*\norder:*:items"}
                value={form.keyPatterns}
                disabled={submitting}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, keyPatterns: event.target.value }))
                }
              />
              <p className={styles.fieldHint}>
                One glob pattern per line — only keys matching one of these are ever readable.
              </p>
            </div>
          ) : null}

          {form.type === "redis" && (
            <div className={`${styles.field} ${styles.wide}`}>
              <label className={styles.checkboxField} htmlFor="datasource-redis-cluster">
                <input
                  id="datasource-redis-cluster"
                  type="checkbox"
                  checked={form.redisCluster}
                  disabled={submitting}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, redisCluster: event.target.checked }))
                  }
                />
                Cluster mode
              </label>
              <p className={styles.fieldHint}>
                On for a multi-node Redis cluster (redis.asyncio.cluster.RedisCluster) — off for a
                single standalone instance.
              </p>
            </div>
          )}

          {form.type === "redis" && form.redisCluster && (
            <div className={`${styles.field} ${styles.wide}`}>
              <label htmlFor="datasource-redis-address-map">Address remap (optional)</label>
              <textarea
                id="datasource-redis-address-map"
                autoComplete="off"
                rows={2}
                placeholder={"10.139.148.254:7000=127.0.0.1:7000"}
                value={form.redisAddressMap}
                disabled={submitting}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, redisAddressMap: event.target.value }))
                }
              />
              <p className={styles.fieldHint}>
                One "internal_host:port=local_host:port" pair per line — only needed when the
                cluster is reached through a tunnel whose forwarded ports differ from what the
                cluster itself advertises.
              </p>
            </div>
          )}

          {form.type === "redis" && (
            <div className={`${styles.field} ${styles.wide}`}>
              <label htmlFor="datasource-allowed-key-ids">Allowed IDs (optional)</label>
              <textarea
                id="datasource-allowed-key-ids"
                autoComplete="off"
                rows={3}
                placeholder={"11111111-0000-4000-8000-000000000101"}
                value={form.allowedKeyIds}
                disabled={submitting}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, allowedKeyIds: event.target.value }))
                }
              />
              <p className={styles.fieldHint}>
                One id per line, substituted for every key pattern's own "*" — when set, only
                these exact keys are ever scanned or read, and no broader scan of the pattern ever
                runs. Leave blank to let each pattern's own glob match normally.
              </p>
            </div>
          )}

          {form.type !== "redis" && (
            form.isolationMode === "column" && (
              <div className={styles.field}>
                <label htmlFor="datasource-tenant-column">Tenant column</label>
                <input
                  id="datasource-tenant-column"
                  type="text"
                  autoComplete="off"
                  value={form.tenantColumn}
                  disabled={submitting}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, tenantColumn: event.target.value }))
                  }
                />
              </div>
            )
          )}

          <div className={`${styles.field} ${styles.wide}`}>
            <label className={styles.checkboxField} htmlFor="datasource-sample-values">
              <input
                id="datasource-sample-values"
                type="checkbox"
                checked={form.sampleValuesEnabled}
                disabled={submitting}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, sampleValuesEnabled: event.target.checked }))
                }
              />
              Allow sample values in prompts
            </label>
          </div>

          {submitError !== null && (
            <p role="alert" className={styles.formError}>
              {submitError}
            </p>
          )}

          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.testConnection}
              disabled={submitting || testingConnection}
              onClick={handleTestConnection}
            >
              {testingConnection ? "Testing…" : "Test connection"}
            </button>
            <button type="submit" className={styles.submit} disabled={submitting}>
              {submitting ? "Connecting…" : "Connect"}
            </button>
            <button type="button" className={styles.cancel} disabled={submitting} onClick={closeForm}>
              Cancel
            </button>
          </div>

          {connectionTestResult !== null && (
            <p
              className={`${styles.formTestNote} ${connectionTestResult.success ? styles.good : styles.critical}`}
            >
              {connectionTestResult.success ? "Connected." : connectionTestResult.reason}
            </p>
          )}
          {connectionTestError !== null && (
            <p className={`${styles.formTestNote} ${styles.critical}`}>{connectionTestError}</p>
          )}
        </form>
      )}

      {datasources !== null && databases.length === 0 && !formOpen && (
        <div className={styles.empty}>
          <Database className={styles.emptyGlyph} size={22} aria-hidden="true" />
          <h3 className={styles.emptyTitle}>Connect a database</h3>
          <p className={styles.emptyBody}>
            Point the agent at a database and it can answer directly from your data — sales, items,
            discounts, taxes — with the query and its plan gate open for you to check in the
            inspector.
          </p>
          <button type="button" className={styles.primaryAction} onClick={openForm}>
            Connect a database
          </button>
        </div>
      )}

      {databases.length > 0 && (
        <Sheet title="Connected databases" subLabel={`${databases.length} of ${databases.length}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Isolation</th>
                <th>Status</th>
                <th className={styles.num}>Tables</th>
                <th className={styles.num}>Columns</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {databases.map((row) => {
                const state = rowState(row.id);
                const scanDisabled = state.scanning || row.status === "indexing";
                const detail = tableDetail(row.id);
                const pick = picker(row.id);
                const overBounds =
                  row.status === "error" && (row.last_scan_error ?? "").includes("scan limit");
                return (
                  <Fragment key={row.id}>
                  <tr>
                    <td>
                      <span>{row.name}</span>
                      {scansTables(row) && (
                        <span className={styles.scopeNote}>
                          {row.table_patterns === null
                            ? "Scans every table"
                            : `Scans ${row.table_patterns.length} chosen ${
                                row.table_patterns.length === 1 ? "table" : "tables"
                              }`}
                        </span>
                      )}
                    </td>
                    <td>{DATASOURCE_TYPE_LABEL[row.type]}</td>
                    <td>{ISOLATION_LABEL[row.isolation_mode]}</td>
                    <td>
                      <span className={statusPillClass(row.status)}>{row.status}</span>
                    </td>
                    <td className={styles.num}>
                      {row.total_tables}
                      {row.total_tables > 0 && (
                        <button
                          type="button"
                          className={styles.tablesLink}
                          onClick={() => handleToggleTables(row.id)}
                        >
                          {detail.open ? "Hide" : "Tables"}
                        </button>
                      )}
                    </td>
                    <td className={styles.num}>{row.total_columns}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          disabled={state.testing}
                          onClick={() => handleTest(row.id)}
                        >
                          {state.testing ? "Testing…" : "Test connection"}
                        </button>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          disabled={scanDisabled}
                          onClick={() => handleScan(row.id)}
                        >
                          {state.scanning || row.status === "indexing" ? "Scanning…" : "Scan"}
                        </button>
                        {scansTables(row) && (
                          <button
                            type="button"
                            className={styles.actionBtn}
                            aria-expanded={pick.open}
                            onClick={() => handleTogglePicker(row)}
                          >
                            {pick.open ? "Close tables" : "Choose tables"}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${styles.danger}`}
                          disabled={state.removing}
                          onClick={() => handleRemove(row.id)}
                        >
                          {state.removing ? "Removing…" : "Remove"}
                        </button>
                      </div>
                      {state.testResult !== null && (
                        <p
                          className={`${styles.rowNote} ${state.testResult.success ? styles.good : styles.critical}`}
                        >
                          {state.testResult.success ? "Connected." : state.testResult.reason}
                        </p>
                      )}
                      {state.testError !== null && (
                        <p className={`${styles.rowNote} ${styles.critical}`}>{state.testError}</p>
                      )}
                      {state.scanError !== null && (
                        <p className={`${styles.rowNote} ${styles.critical}`}>{state.scanError}</p>
                      )}
                      {state.scanError === null && row.status === "error" && row.last_scan_error !== null && (
                        <p className={`${styles.rowNote} ${styles.critical}`}>
                          Scan failed — {row.last_scan_error}
                          {overBounds && !pick.open && (
                            <>
                              {" "}
                              <button
                                type="button"
                                className={styles.tablesLink}
                                onClick={() => handleTogglePicker(row)}
                              >
                                Choose which tables to scan
                              </button>
                            </>
                          )}
                        </p>
                      )}
                      {state.removeError !== null && (
                        <p className={`${styles.rowNote} ${styles.critical}`}>
                          Can't remove — {state.removeError}
                        </p>
                      )}
                    </td>
                  </tr>
                  {detail.open && (
                    <tr>
                      <td colSpan={7} className={styles.tablesDetail}>
                        {detail.loading && (
                          <p className={styles.tablesDetailNote}>Loading tables…</p>
                        )}
                        {detail.error !== null && (
                          <p className={`${styles.tablesDetailNote} ${styles.critical}`}>
                            {detail.error}
                          </p>
                        )}
                        {detail.tables !== null && !detail.loading && (
                          detail.tables.length === 0 ? (
                            <p className={styles.tablesDetailNote}>
                              Not scanned yet — run Scan to see its tables.
                            </p>
                          ) : (
                            <>
                              <div className={styles.tablesSummaryRow}>
                                <span className={styles.tablesSummary}>
                                  {summarizeTables(detail.tables)}
                                </span>
                                <input
                                  type="search"
                                  className={styles.tablesSearch}
                                  placeholder="Search tables and columns…"
                                  value={detail.search}
                                  onChange={(event) =>
                                    patchTableDetail(row.id, { search: event.target.value })
                                  }
                                />
                              </div>
                              <div className={styles.tablesList}>
                                {detail.tables
                                  .filter((table) => matchesSearch(table, detail.search))
                                  .map((table) => (
                                    <div key={table.id} className={styles.tableCard}>
                                      <div className={styles.tableCardHead}>
                                        <span className={styles.tableCardName}>
                                          {table.schema_name}.{table.table_name}
                                        </span>
                                        <span className={styles.tableKindTag}>
                                          {TABLE_KIND_LABEL[table.table_kind]}
                                        </span>
                                      </div>
                                      <ul className={styles.columnList}>
                                        {table.columns.map((column) => (
                                          <li key={column.name} className={styles.columnRow}>
                                            <span className={styles.columnName}>{column.name}</span>
                                            <span className={styles.columnType}>{column.data_type}</span>
                                            {column.has_samples && (
                                              <span className={styles.columnSamples}>
                                                {column.samples !== null
                                                  ? column.samples.map(String).join(", ")
                                                  : "sampled"}
                                              </span>
                                            )}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ))}
                              </div>
                            </>
                          )
                        )}
                      </td>
                    </tr>
                  )}
                  {pick.open && (
                    <tr>
                      <td colSpan={7} className={styles.tablesDetail}>
                        <TablePicker
                          row={row}
                          pick={pick}
                          onSearch={(search) => patchPicker(row.id, { search })}
                          onTick={(tables, ticked) => setTicked(row.id, tables, ticked)}
                          onSave={(patterns) => handleSaveTables(row.id, patterns)}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Sheet>
      )}
    </div>
  );
}

interface TablePickerProps {
  row: DataSource;
  pick: PickerState;
  onSearch: (search: string) => void;
  onTick: (tables: string[], ticked: boolean) => void;
  onSave: (tablePatterns: string[] | null) => void;
}

/**
 * The live table list with a running total against the scan bounds. Saving
 * writes the ticked names as `table_patterns`; it never scans by itself.
 * Saving is refused while the ticked set is over the bounds — the scan
 * would only refuse it again, after the operator had walked away.
 */
function TablePicker({ row, pick, onSearch, onTick, onSave }: TablePickerProps) {
  if (pick.loading) {
    return <p className={styles.tablesDetailNote}>Reading tables from the database…</p>;
  }
  if (pick.error !== null) {
    return <p className={`${styles.tablesDetailNote} ${styles.critical}`}>{pick.error}</p>;
  }
  const catalog = pick.catalog;
  if (catalog === null) return null;

  const ticked = catalog.tables.filter((t) => pick.selected.has(t.table));
  const tickedColumns = ticked.reduce((sum, t) => sum + t.columns, 0);
  const over = ticked.length > catalog.max_tables || tickedColumns > catalog.max_columns;
  const allColumns = catalog.tables.reduce((sum, t) => sum + t.columns, 0);
  const allFit = catalog.tables.length <= catalog.max_tables && allColumns <= catalog.max_columns;
  const needle = pick.search.trim().toLowerCase();
  const shown = catalog.tables.filter((t) => needle === "" || t.table.toLowerCase().includes(needle));
  const globs = (row.table_patterns ?? []).filter(isGlob);

  return (
    <div className={styles.picker}>
      <div className={styles.tablesSummaryRow}>
        <span className={`${styles.pickerMeter} ${over ? styles.critical : ""}`} role="status">
          {ticked.length} of {catalog.max_tables} tables · {tickedColumns} of{" "}
          {catalog.max_columns} columns
          {over ? " — over the scan limit" : ""}
        </span>
        <input
          type="search"
          className={styles.tablesSearch}
          placeholder={`Filter ${catalog.tables.length} tables…`}
          aria-label="Filter tables"
          value={pick.search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      <p className={styles.tablesDetailNote}>
        Tick the tables agents should be able to query. A scan reads their structure and sample
        values, so leave out tables holding credentials or personal data.
        {globs.length > 0 && ` Saving replaces the patterns ${globs.join(", ")} with the tables ticked.`}
      </p>
      <div className={styles.pickerTools}>
        <button type="button" className={styles.tablesLink} onClick={() => onTick(shown.map((t) => t.table), true)}>
          Tick {needle === "" ? "all" : "shown"}
        </button>
        <button type="button" className={styles.tablesLink} onClick={() => onTick(shown.map((t) => t.table), false)}>
          Untick {needle === "" ? "all" : "shown"}
        </button>
      </div>
      <div className={styles.pickerList}>
        {shown.map((t) => (
          <label key={t.table} className={styles.pickerItem}>
            <input
              type="checkbox"
              checked={pick.selected.has(t.table)}
              onChange={(event) => onTick([t.table], event.target.checked)}
            />
            <span className={styles.pickerName}>{t.table}</span>
            <span className={styles.pickerCols}>{t.columns}</span>
          </label>
        ))}
      </div>
      <div className={styles.rowActions}>
        <button
          type="button"
          className={styles.actionBtn}
          disabled={pick.saving || ticked.length === 0 || over}
          onClick={() => onSave(ticked.map((t) => t.table))}
        >
          {pick.saving ? "Saving…" : `Save ${ticked.length} ${ticked.length === 1 ? "table" : "tables"}`}
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          disabled={pick.saving || !allFit || row.table_patterns === null}
          title={allFit ? undefined : "The whole database is over the scan limit"}
          onClick={() => onSave(null)}
        >
          Scan every table
        </button>
      </div>
      {pick.saveError !== null && (
        <p className={`${styles.rowNote} ${styles.critical}`}>{pick.saveError}</p>
      )}
      {pick.saved && (
        <p className={`${styles.rowNote} ${styles.good}`}>Saved. Run Scan to index these tables.</p>
      )}
    </div>
  );
}
