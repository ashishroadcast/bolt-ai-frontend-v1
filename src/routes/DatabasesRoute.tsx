import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Database,
  ListChecks,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { GatewayError } from "../ask/http/errors.ts";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill, type StatusPillTone } from "../agents/StatusPill.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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

function statusTone(status: DataSource["status"]): StatusPillTone {
  switch (status) {
    case "ready":
      return "good";
    case "error":
      return "critical";
    case "indexing":
      return "amber";
    default:
      return "neutral";
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

/** A one-line outcome under a row's actions (or the form's) — the icon
 * carries success/failure as well as the colour does. */
function Note({ tone, children, className }: { tone: "good" | "critical"; children: ReactNode; className?: string }) {
  const Icon = tone === "good" ? CircleCheck : CircleX;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-sm leading-snug",
        tone === "good" ? "text-success" : "text-destructive",
        className,
      )}
    >
      <Icon className="mt-px size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}

/** A quiet in-panel status line ("Loading tables…"). */
function PanelNote({ children, critical = false, busy = false }: { children: ReactNode; critical?: boolean; busy?: boolean }) {
  return (
    <p className={cn("flex items-center gap-2 text-sm", critical ? "text-destructive" : "text-muted-foreground")}>
      {busy && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />}
      {children}
    </p>
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
 * The empty state is the shared `EmptyState` with its action wired to this
 * route's own `openForm` — the same control PageHeader draws, shown only
 * once the list has loaded empty.
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

  const isRedisForm = form.type === "redis";

  return (
    // Tooltips here label the icon-only Remove control; a provider of this
    // screen's own keeps them working outside the shell (tests render the
    // route on its own).
    <TooltipProvider>
      <div className="min-w-0 space-y-6">
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

        {loadError !== null && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {formOpen && (
          <Card>
            {/* autoComplete="off" at both the form and field level: a lone
                type="password" field (the DSN below) is enough for some
                browsers to read this whole form as a login and offer a saved
                email into "Database name" — see this component's own
                docstring. */}
            <form className="flex flex-col gap-6" onSubmit={handleSubmit} autoComplete="off">
              <CardHeader>
                <h3 data-slot="card-title" className="leading-none font-semibold">
                  Connect a database
                </h3>
                <CardDescription>
                  Check it with Test connection first. The connection string stays masked and is never
                  shown again after you connect.
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-5">
                <FieldGroup className="grid gap-5 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="datasource-name">Name</FieldLabel>
                    <Input
                      id="datasource-name"
                      type="text"
                      autoComplete="off"
                      value={form.name}
                      disabled={submitting}
                      onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="datasource-type">Type</FieldLabel>
                    <NativeSelect
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
                          // handleSubmit) — reset away from a stale "Per
                          // column" selection left over from a different type
                          // rather than silently overriding it at submit with
                          // no visible change.
                          isolationMode: nextType === "redis" ? "connection" : prev.isolationMode,
                        }));
                      }}
                    >
                      <NativeSelectOption value="postgres">Postgres</NativeSelectOption>
                      <NativeSelectOption value="mysql">MySQL</NativeSelectOption>
                      <NativeSelectOption value="redis">Redis</NativeSelectOption>
                    </NativeSelect>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="datasource-database-name">Database name</FieldLabel>
                    <Input
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
                  </Field>

                  {!isRedisForm && (
                    <Field>
                      <FieldLabel htmlFor="datasource-isolation-mode">Tenant scoping</FieldLabel>
                      <NativeSelect
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
                        <NativeSelectOption value="connection">Per connection</NativeSelectOption>
                        <NativeSelectOption value="column">Per column</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                  )}

                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="datasource-dsn">Connection string (DSN)</FieldLabel>
                    <Input
                      id="datasource-dsn"
                      type="password"
                      className="font-mono"
                      // "off", never "new-password": the latter is the token
                      // signup/change-password forms use specifically to
                      // invite the browser's "save this password?" prompt on
                      // submit — the opposite of what a live production
                      // credential needs. "off" is the spec's own "do not
                      // offer to remember this value" signal.
                      autoComplete="off"
                      placeholder={isRedisForm ? "redis://[:password@]host:port[/db]" : undefined}
                      value={form.dsn}
                      disabled={submitting}
                      onChange={(event) => {
                        resetConnectionTest();
                        setForm((prev) => ({ ...prev, dsn: event.target.value }));
                      }}
                    />
                  </Field>

                  {isRedisForm && (
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor="datasource-key-patterns">Key patterns</FieldLabel>
                      <Textarea
                        id="datasource-key-patterns"
                        className="font-mono"
                        autoComplete="off"
                        rows={3}
                        placeholder={"session:*\norder:*:items"}
                        value={form.keyPatterns}
                        disabled={submitting}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, keyPatterns: event.target.value }))
                        }
                      />
                      <FieldDescription>
                        One glob pattern per line — only keys matching one of these are ever readable.
                      </FieldDescription>
                    </Field>
                  )}

                  {isRedisForm && (
                    <Field orientation="horizontal" className="sm:col-span-2">
                      <Checkbox
                        id="datasource-redis-cluster"
                        checked={form.redisCluster}
                        disabled={submitting}
                        onCheckedChange={(checked) =>
                          setForm((prev) => ({ ...prev, redisCluster: checked === true }))
                        }
                      />
                      <FieldContent>
                        <FieldLabel htmlFor="datasource-redis-cluster">Cluster mode</FieldLabel>
                        <FieldDescription>
                          On for a multi-node Redis cluster (redis.asyncio.cluster.RedisCluster) — off
                          for a single standalone instance.
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  )}

                  {isRedisForm && form.redisCluster && (
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor="datasource-redis-address-map">Address remap (optional)</FieldLabel>
                      <Textarea
                        id="datasource-redis-address-map"
                        className="font-mono"
                        autoComplete="off"
                        rows={2}
                        placeholder={"10.139.148.254:7000=127.0.0.1:7000"}
                        value={form.redisAddressMap}
                        disabled={submitting}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, redisAddressMap: event.target.value }))
                        }
                      />
                      <FieldDescription>
                        One "internal_host:port=local_host:port" pair per line — only needed when the
                        cluster is reached through a tunnel whose forwarded ports differ from what the
                        cluster itself advertises.
                      </FieldDescription>
                    </Field>
                  )}

                  {isRedisForm && (
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor="datasource-allowed-key-ids">Allowed IDs (optional)</FieldLabel>
                      <Textarea
                        id="datasource-allowed-key-ids"
                        className="font-mono"
                        autoComplete="off"
                        rows={3}
                        placeholder={"11111111-0000-4000-8000-000000000101"}
                        value={form.allowedKeyIds}
                        disabled={submitting}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, allowedKeyIds: event.target.value }))
                        }
                      />
                      <FieldDescription>
                        One id per line, substituted for every key pattern's own "*" — when set, only
                        these exact keys are ever scanned or read, and no broader scan of the pattern
                        ever runs. Leave blank to let each pattern's own glob match normally.
                      </FieldDescription>
                    </Field>
                  )}

                  {!isRedisForm && form.isolationMode === "column" && (
                    <Field>
                      <FieldLabel htmlFor="datasource-tenant-column">Tenant column</FieldLabel>
                      <Input
                        id="datasource-tenant-column"
                        type="text"
                        className="font-mono"
                        autoComplete="off"
                        value={form.tenantColumn}
                        disabled={submitting}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, tenantColumn: event.target.value }))
                        }
                      />
                    </Field>
                  )}

                  <Field orientation="horizontal" className="sm:col-span-2">
                    <Checkbox
                      id="datasource-sample-values"
                      checked={form.sampleValuesEnabled}
                      disabled={submitting}
                      onCheckedChange={(checked) =>
                        setForm((prev) => ({ ...prev, sampleValuesEnabled: checked === true }))
                      }
                    />
                    <FieldLabel htmlFor="datasource-sample-values" className="font-normal">
                      Allow sample values in prompts
                    </FieldLabel>
                  </Field>
                </FieldGroup>

                {submitError !== null && (
                  <Alert variant="destructive">
                    <CircleAlert aria-hidden="true" />
                    <AlertDescription>{submitError}</AlertDescription>
                  </Alert>
                )}
              </CardContent>

              <CardFooter className="flex-col items-stretch gap-3 border-t">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Test connection reads as the "check first" step on the
                      leading edge, not competing with Connect's emphasis. */}
                  <Button
                    type="button"
                    variant="outline"
                    className="mr-auto"
                    disabled={submitting || testingConnection}
                    onClick={handleTestConnection}
                  >
                    {testingConnection ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <PlugZap aria-hidden="true" />
                    )}
                    {testingConnection ? "Testing…" : "Test connection"}
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {submitting ? "Connecting…" : "Connect"}
                  </Button>
                  <Button type="button" variant="ghost" disabled={submitting} onClick={closeForm}>
                    Cancel
                  </Button>
                </div>

                {connectionTestResult !== null && (
                  <Note tone={connectionTestResult.success ? "good" : "critical"}>
                    {connectionTestResult.success ? "Connected." : connectionTestResult.reason}
                  </Note>
                )}
                {connectionTestError !== null && <Note tone="critical">{connectionTestError}</Note>}
              </CardFooter>
            </form>
          </Card>
        )}

        {datasources === null && loadError === null && (
          <Card className="gap-3 py-4" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4 px-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="ml-auto h-8 w-48" />
              </div>
            ))}
          </Card>
        )}

        {datasources !== null && databases.length === 0 && !formOpen && (
          <EmptyState
            icon={Database}
            title="Connect a database"
            body="Point the agent at a database and it can answer directly from your data — sales, items, discounts, taxes — with the query and its plan gate open for you to check in the inspector."
            actionLabel="Connect a database"
            onAction={openForm}
          />
        )}

        {databases.length > 0 && (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="py-4">
              <h3 data-slot="card-title" className="leading-none font-semibold">
                Connected databases
              </h3>
              <CardDescription>
                {databases.length} {databases.length === 1 ? "database" : "databases"}
              </CardDescription>
            </CardHeader>
            <CardContent className="border-t p-0">
              <Table className="[&_tr>*:first-child]:pl-6 [&_tr>*:last-child]:pr-6">
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Name</TableHead>
                    <TableHead className="text-muted-foreground">Type</TableHead>
                    <TableHead className="text-muted-foreground">Isolation</TableHead>
                    <TableHead className="text-muted-foreground">Status</TableHead>
                    <TableHead className="text-right text-muted-foreground">Tables</TableHead>
                    <TableHead className="text-right text-muted-foreground">Columns</TableHead>
                    <TableHead className="text-muted-foreground">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {databases.map((row) => {
                    const state = rowState(row.id);
                    const scanning = state.scanning || row.status === "indexing";
                    const detail = tableDetail(row.id);
                    const pick = picker(row.id);
                    const overBounds =
                      row.status === "error" && (row.last_scan_error ?? "").includes("scan limit");
                    return (
                      <Fragment key={row.id}>
                        <TableRow className="[&>td]:py-3 [&>td]:align-top">
                          <TableCell className="min-w-32 whitespace-normal">
                            <span className="font-medium">{row.name}</span>
                            {scansTables(row) && (
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {row.table_patterns === null
                                  ? "Scans every table"
                                  : `Scans ${row.table_patterns.length} chosen ${
                                      row.table_patterns.length === 1 ? "table" : "tables"
                                    }`}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {DATASOURCE_TYPE_LABEL[row.type]}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {ISOLATION_LABEL[row.isolation_mode]}
                          </TableCell>
                          <TableCell>
                            {/* The raw status word, capitalised by CSS only —
                                it is the server's own vocabulary. */}
                            <span className="capitalize">
                              <StatusPill tone={statusTone(row.status)} label={row.status} />
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              {row.total_tables > 0 && (
                                <Button
                                  type="button"
                                  variant="link"
                                  size="xs"
                                  className="h-auto px-0"
                                  aria-expanded={detail.open}
                                  onClick={() => handleToggleTables(row.id)}
                                >
                                  {detail.open ? "Hide" : "Tables"}
                                </Button>
                              )}
                              <span className="font-mono tabular-nums">{row.total_tables}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {row.total_columns}
                          </TableCell>
                          <TableCell className="min-w-72 whitespace-normal">
                            {/* Two groups, so a narrow table wraps the row's
                                actions between them rather than orphaning
                                Remove on a line of its own. */}
                            <div className="flex flex-wrap items-center gap-1.5">
                              <div className="flex items-center gap-1.5">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={state.testing}
                                  onClick={() => handleTest(row.id)}
                                >
                                  {state.testing ? (
                                    <Loader2 className="animate-spin" aria-hidden="true" />
                                  ) : (
                                    <PlugZap aria-hidden="true" />
                                  )}
                                  {state.testing ? "Testing…" : "Test connection"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={scanning}
                                  onClick={() => handleScan(row.id)}
                                >
                                  <RefreshCw className={cn(scanning && "animate-spin")} aria-hidden="true" />
                                  {scanning ? "Scanning…" : "Scan"}
                                </Button>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {scansTables(row) && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    aria-expanded={pick.open}
                                    onClick={() => handleTogglePicker(row)}
                                  >
                                    <ListChecks aria-hidden="true" />
                                    {pick.open ? "Close tables" : "Choose tables"}
                                  </Button>
                                )}
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                      aria-label={state.removing ? "Removing…" : "Remove"}
                                      disabled={state.removing}
                                      onClick={() => handleRemove(row.id)}
                                    >
                                      {state.removing ? (
                                        <Loader2 className="animate-spin" aria-hidden="true" />
                                      ) : (
                                        <Trash2 aria-hidden="true" />
                                      )}
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Remove</TooltipContent>
                                </Tooltip>
                              </div>
                            </div>
                            <div className="mt-2 max-w-md space-y-1 empty:hidden">
                              {state.testResult !== null && (
                                <Note tone={state.testResult.success ? "good" : "critical"}>
                                  {state.testResult.success ? "Connected." : state.testResult.reason}
                                </Note>
                              )}
                              {state.testError !== null && <Note tone="critical">{state.testError}</Note>}
                              {state.scanError !== null && <Note tone="critical">{state.scanError}</Note>}
                              {state.scanError === null &&
                                row.status === "error" &&
                                row.last_scan_error !== null && (
                                  <Note tone="critical">
                                    Scan failed — {row.last_scan_error}
                                    {overBounds && !pick.open && (
                                      <>
                                        {" "}
                                        <Button
                                          type="button"
                                          variant="link"
                                          className="h-auto p-0 align-baseline whitespace-normal text-destructive underline"
                                          onClick={() => handleTogglePicker(row)}
                                        >
                                          Choose which tables to scan
                                        </Button>
                                      </>
                                    )}
                                  </Note>
                                )}
                              {state.removeError !== null && (
                                <Note tone="critical">Can't remove — {state.removeError}</Note>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {detail.open && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={7} className="p-4 whitespace-normal">
                              {detail.loading && <PanelNote busy>Loading tables…</PanelNote>}
                              {detail.error !== null && <PanelNote critical>{detail.error}</PanelNote>}
                              {detail.tables !== null && !detail.loading && (
                                detail.tables.length === 0 ? (
                                  <PanelNote>Not scanned yet — run Scan to see its tables.</PanelNote>
                                ) : (
                                  <div className="space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                      <span className="font-mono text-xs text-muted-foreground">
                                        {summarizeTables(detail.tables)}
                                      </span>
                                      <InputGroup className="w-full bg-background sm:w-64">
                                        <InputGroupAddon>
                                          <Search aria-hidden="true" />
                                        </InputGroupAddon>
                                        <InputGroupInput
                                          type="search"
                                          placeholder="Search tables and columns…"
                                          aria-label="Search tables and columns"
                                          value={detail.search}
                                          onChange={(event) =>
                                            patchTableDetail(row.id, { search: event.target.value })
                                          }
                                        />
                                      </InputGroup>
                                    </div>
                                    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                                      {detail.tables
                                        .filter((table) => matchesSearch(table, detail.search))
                                        .map((table) => (
                                          <div
                                            key={table.id}
                                            className="min-w-0 rounded-lg border bg-card p-3 shadow-xs"
                                          >
                                            <div className="mb-2 flex items-start justify-between gap-2">
                                              <span className="min-w-0 font-mono text-sm font-medium break-all">
                                                {table.schema_name}.{table.table_name}
                                              </span>
                                              <Badge
                                                variant="secondary"
                                                className="font-mono text-[10px] tracking-wide uppercase"
                                              >
                                                {TABLE_KIND_LABEL[table.table_kind]}
                                              </Badge>
                                            </div>
                                            <ul className="space-y-1">
                                              {table.columns.map((column) => (
                                                <li
                                                  key={column.name}
                                                  className="flex min-w-0 items-baseline gap-2 text-sm"
                                                >
                                                  <span className="shrink-0">{column.name}</span>
                                                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                                    {column.data_type}
                                                  </span>
                                                  {column.has_samples && (
                                                    <span className="min-w-0 truncate text-xs text-muted-foreground">
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
                                  </div>
                                )
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                        {pick.open && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={7} className="p-4 whitespace-normal">
                              <TablePicker
                                row={row}
                                pick={pick}
                                onSearch={(search) => patchPicker(row.id, { search })}
                                onTick={(tables, ticked) => setTicked(row.id, tables, ticked)}
                                onSave={(patterns) => handleSaveTables(row.id, patterns)}
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </TooltipProvider>
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
    return <PanelNote busy>Reading tables from the database…</PanelNote>;
  }
  if (pick.error !== null) {
    return <PanelNote critical>{pick.error}</PanelNote>;
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
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span
          className={cn(
            "font-mono text-sm tabular-nums",
            over ? "font-medium text-destructive" : "text-muted-foreground",
          )}
          role="status"
        >
          {ticked.length} of {catalog.max_tables} tables · {tickedColumns} of{" "}
          {catalog.max_columns} columns
          {over ? " — over the scan limit" : ""}
        </span>
        <InputGroup className="w-full bg-background sm:w-64">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder={`Filter ${catalog.tables.length} tables…`}
            aria-label="Filter tables"
            value={pick.search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </InputGroup>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Tick the tables agents should be able to query. A scan reads their structure and sample
        values, so leave out tables holding credentials or personal data.
        {globs.length > 0 && ` Saving replaces the patterns ${globs.join(", ")} with the tables ticked.`}
      </p>
      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={() => onTick(shown.map((t) => t.table), true)}>
          Tick {needle === "" ? "all" : "shown"}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => onTick(shown.map((t) => t.table), false)}>
          Untick {needle === "" ? "all" : "shown"}
        </Button>
      </div>
      <div className="grid max-h-90 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-4 overflow-y-auto rounded-lg border bg-card p-2">
        {shown.map((t) => (
          <label
            key={t.table}
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
          >
            <Checkbox
              checked={pick.selected.has(t.table)}
              onCheckedChange={(checked) => onTick([t.table], checked === true)}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{t.table}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{t.columns}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pick.saving || ticked.length === 0 || over}
          onClick={() => onSave(ticked.map((t) => t.table))}
        >
          {pick.saving && <Loader2 className="animate-spin" aria-hidden="true" />}
          {pick.saving ? "Saving…" : `Save ${ticked.length} ${ticked.length === 1 ? "table" : "tables"}`}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pick.saving || !allFit || row.table_patterns === null}
          title={allFit ? undefined : "The whole database is over the scan limit"}
          onClick={() => onSave(null)}
        >
          Scan every table
        </Button>
      </div>
      {pick.saveError !== null && <Note tone="critical">{pick.saveError}</Note>}
      {pick.saved && <Note tone="good">Saved. Run Scan to index these tables.</Note>}
    </div>
  );
}
