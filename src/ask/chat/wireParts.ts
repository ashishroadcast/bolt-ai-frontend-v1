import type { UIPart } from "../parts/catalog.tsx";

/**
 * The one place a wire `data-<name>` part (either live off `useChat.ts`'s
 * stream, or hydrated from `messages.meta.ui_parts` by
 * `conversation.hydrateMessages`) becomes the exact props shape
 * `../components/catalog.tsx`'s `renderUIPart` hands its component. Both
 * call sites converge on this module so the adaptation only exists once —
 * a live table and a reopened one must render identically, and a second,
 * drifted copy of this logic is exactly how that would stop being true.
 *
 * **Why this exists at all, and why it isn't "a second mapping."** The task
 * brief says "render persisted parts through `renderUIPart` — do not add a
 * second mapping," which is about intent name -> component, and that stays
 * entirely inside `catalog.tsx`. This module solves a different problem:
 * `agent-service/app/stream/intents.py`'s `table_intent`/`chart_intent`
 * were written against `app.sql.execute.QueryResult`'s own shape, not
 * against `DataTableProps`/`DataChartProps` — nobody has ever had both
 * files open at once before this task. `table_intent`'s wire shape
 * (`{columns: string[], rows: unknown[][], row_count, truncated}`, parallel
 * arrays, no title) is real and production-wired today (`app.api.run`'s
 * `table_sink_scope`) but is not the catalog's `{title, columns:
 * {key,header}[], rows: Record<string,value>[]}` shape — `DataTable`'s own
 * test (`catalog.test.tsx`) exercises the *target* shape, and until this
 * module existed nothing ever converted a real wire table into it, so a
 * live `data-table` part rendered an empty `<table>` (caught by this
 * task's own `Thread.test.tsx`, not assumed).
 */

function toCellValue(value: unknown): string | number {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  // A real run_sql row can carry a Decimal/datetime/UUID that agent-
  // service's own JSON encoder already stringified (protocol.py's `_json`:
  // "default=str") — anything left non-primitive here (a nested object,
  // a boolean) gets the same treatment rather than rendering "[object
  // Object]" or crashing DataTable's formatter.
  return String(value);
}

/**
 * Whether a cell holds a number, whatever its JavaScript type.
 *
 * This matters because of a shape the wire really has: `intents._json_safe`
 * converts a `Decimal` to a **string**, deliberately, so money and growth
 * percentages don't get silently rounded through float. A live table
 * therefore arrives with `"29082789.84"` in a net-sales column — a string
 * — and every column in it was previously typed `"text"`, so the console
 * rendered a money column left-aligned in the body font. That is the whole
 * reason a real table looked worse here than in the product it was
 * compared against.
 */
function isNumericCell(value: string | number): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return Number.isFinite(Number(trimmed));
}

/**
 * A column is numeric when it has at least one value and every non-blank
 * one reads as a number. "At least one" is load-bearing: an all-empty
 * column would otherwise pass vacuously and get right-aligned for no
 * reason.
 */
function isNumericColumn(rows: readonly (string | number)[][], index: number): boolean {
  let seen = false;
  for (const row of rows) {
    const value = row[index];
    if (value === undefined || value === "") continue;
    if (!isNumericCell(value)) return false;
    seen = true;
  }
  return seen;
}

/**
 * A money or rate cell, at a fixed two decimals.
 *
 * Two decimals for both, because that is what a rupee figure and a
 * percentage are read at — a percent column arrived on screen as
 * `2,119.9706005879884000`, which is the whole reason the server now says
 * what a column *is*. Currency deliberately does NOT use
 * `Intl.NumberFormat`'s own `style: "currency"`: that renders "₹12,34,567"
 * with `maximumFractionDigits: 0`, dropping the paise, and a total that
 * has lost its paise no longer reconciles against the source.
 */
function formatByKind(value: string | number, kind: string): string | number {
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) return value;
  const fixed = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
  if (kind === "currency") return `\u20B9${fixed}`;
  return `${fixed}%`;
}

/**
 * A warehouse column name, as a person would write it.
 *
 * `TOTAL_NET_SALES` and `DISTANCE_FROM_MEDIAN` are how the database spells
 * things, not how the operator reading the table does. A few names are
 * spelled out rather than merely de-underscored, because the short form is
 * warehouse shorthand that means nothing at a glance.
 */
const HEADER_WORDS: Record<string, string> = {
  id: "ID",
  pct: "%",
  qty: "quantity",
  mom: "month-on-month",
  wow: "week-on-week",
  avg: "average",
  iqr: "spread",
  txn: "transactions",
};

function headerLabel(column: string): string {
  const words = column
    .trim()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => HEADER_WORDS[word.toLowerCase()] ?? word.toLowerCase());
  if (words.length === 0) return column;
  const [first, ...rest] = words;
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(" ");
}

/**
 * A plain number, at no more than two decimals.
 *
 * A computed column arrives from Postgres as the float it really is:
 * `distance_from_median` reached the screen as `44.71000000007916`, which
 * reads as false precision on a figure that means "about forty-five
 * rupees". Currency and percent already had this; every other numeric
 * column did not.
 */
function formatPlainNumber(value: string | number): string | number {
  const text = String(value).trim();
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return value;
  // A bare integer is returned exactly as it arrived. The integers in
  // these tables are overwhelmingly identifiers, and grouping an id into
  // "12,345" states something false about it.
  if (Number.isInteger(parsed)) return value;
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(parsed);
}

/**
 * A warehouse-write bookkeeping column, never the operator's own concern.
 *
 * `updated_at`/`created_at` are ETL/row-management timestamps — when a
 * sync job last touched the row, not when the thing it describes actually
 * happened. Live against real fleet data they were the same 09-Jan sync
 * run for every device, wildly unlike the true telematics activity
 * (`last_ping`, `lastUpdate`) sitting right next to them in the same
 * table — an operator reading them alongside real activity columns has no
 * way to tell which is which. Exact name match only, case-insensitive:
 * this hides the two specific columns named, never a real activity column
 * this codebase has not been told is noise (`last_ping`, `modified_on`,
 * `lastUpdate` all stay).
 */
const HIDDEN_TABLE_COLUMNS = new Set(["updated_at", "created_at"]);

function isHiddenColumn(name: string): boolean {
  return HIDDEN_TABLE_COLUMNS.has(name.trim().toLowerCase());
}

/**
 * The one timestamp shape this codebase actually produces once a `Date`/
 * `datetime` has been JSON-stringified: `app.stream.intents._json_safe`
 * (a real SQL column) and a Redis hash field read undecoded (`app.
 * datasource.redis_query`) both end up here — `YYYY-MM-DDTHH:MM:SS`, an
 * optional fractional second, then either `Z` or an explicit `±HH:MM`
 * offset. The offset is REQUIRED by this pattern on purpose: a value with
 * no offset at all is not safe to reinterpret as UTC (mirrors `app.
 * stream.columns._as_ist_aware_timestamp`'s identical rule on the Python
 * side of this same wire), and anchoring on `^...$` is what keeps a UUID
 * or a device name from ever matching — neither is date-shaped at all.
 */
const ISO_TIMESTAMP_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIstTimestampCell(value: string | number): value is string {
  return typeof value === "string" && ISO_TIMESTAMP_WITH_TZ.test(value.trim());
}

/**
 * A column is a timestamp column when it has at least one value and every
 * non-blank one matches — the same "seen at least one, and none of them
 * disagree" rule `isNumericColumn` already uses, so one blank cell can't
 * knock a real timestamp column back to plain text and one stray label
 * can't force-format an unrelated column as a date.
 */
function isTimestampColumn(rows: readonly (string | number)[][], index: number): boolean {
  let seen = false;
  for (const row of rows) {
    const value = row[index];
    if (value === undefined || value === "") continue;
    if (!isIstTimestampCell(value)) return false;
    seen = true;
  }
  return seen;
}

const IST_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * A UTC-or-explicitly-offset timestamp string, shown the way every other
 * figure in this table already is: India-first, and labelled so nobody
 * reads a converted value as still being UTC. `"%Y-%m-%d %H:%M IST"` —
 * the identical shape `app.stream.columns.render` produces for the same
 * value on the model's own side of this wire, so the sentence and the
 * table agree, not just the currency and percent columns that already had
 * this property.
 */
function formatIstCell(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = IST_FORMATTER.formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} IST`;
}

/**
 * `table_intent`'s wire shape -> `DataTableProps`. No title travels on the
 * wire at all (`table_intent` never sets one) — "Query results" names what
 * the part honestly *is* rather than inventing a specific-sounding label
 * this module has no data to justify.
 */
function adaptTable(data: Record<string, unknown>): Record<string, unknown> {
  const allColumns = Array.isArray(data.columns) ? (data.columns as unknown[]).map(String) : [];
  const rawRows = Array.isArray(data.rows) ? (data.rows as unknown[][]) : [];
  const rowCount = typeof data.row_count === "number" ? data.row_count : rawRows.length;
  const truncated = data.truncated === true;

  // What the server says each column holds (app.stream.columns). Absent on
  // an older part, in which case every column falls back to the value-shape
  // guess below and simply gains no symbol — never a wrong one.
  const allKinds = Array.isArray(data.column_kinds)
    ? (data.column_kinds as unknown[]).map(String)
    : [];

  // Dropped before anything else below ever sees them — a hidden column's
  // values never reach `isNumericColumn`/`isTimestampColumn`, so a stray
  // `updated_at` full of identical sync timestamps can't skew a real
  // column's own type inference by sharing an index with it.
  const visible = allColumns
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => !isHiddenColumn(name));
  const columns = visible.map(({ name }) => name);
  const kinds = visible.map(({ index }) => allKinds[index]);

  const cells = rawRows.map((row) => visible.map(({ index }) => toCellValue(row[index])));
  const timestamp = columns.map((_name, index) => isTimestampColumn(cells, index));
  // Typed once per column, off the whole column's values, not per cell:
  // one blank or one stray label must not knock a money column back to
  // left-aligned halfway down the table.
  const numeric = columns.map(
    (_name, index) =>
      !timestamp[index] &&
      (kinds[index] === "currency" ||
        kinds[index] === "percent" ||
        kinds[index] === "integer" ||
        isNumericColumn(cells, index)),
  );

  return {
    title: "Query results",
    subLabel: `${rowCount} row${rowCount === 1 ? "" : "s"}${truncated ? " · truncated" : ""}`,
    // `"number"` is what puts DataTable's own `.num` rule on the cell —
    // right-aligned, mono, `font-variant-numeric: tabular-nums`. The value
    // stays a string, which DataTable's `formatCell` passes through
    // untouched, so the alignment is gained without handing a Decimal
    // through a float.
    columns: columns.map((name, index) => ({
      key: name,
      header: headerLabel(name),
      ...(numeric[index] === true ? { type: "number" as const } : {}),
    })),
    rows: cells.map((row) =>
      Object.fromEntries(
        columns.map((name, index) => {
          if (timestamp[index]) {
            return [name, formatIstCell(row[index] as string)];
          }
          const kind = kinds[index];
          if (kind === "currency" || kind === "percent") {
            return [name, formatByKind(row[index]!, kind)];
          }
          return [name, numeric[index] === true ? formatPlainNumber(row[index]!) : row[index]!];
        }),
      ),
    ),
  };
}

/**
 * `stats_intent`'s wire shape -> `DataStatsProps`. Almost a pass-through:
 * that builder already emits `title`/`subLabel`/`figures` in the
 * component's own prop names, and each figure's `value` arrives already
 * rendered by `app.stream.columns` (see `DataStatsFigure.value` for why
 * the formatting deliberately happens there and not here).
 *
 * So the only work is refusing a malformed part rather than throwing on
 * it: a figure missing either half is dropped, and an unusable payload
 * renders `DataStats`'s own empty state — the same judgement `adaptChart`
 * below makes, for the same reason. This is the wire boundary; the data is
 * only as trustworthy as whatever produced it.
 */
function adaptStats(data: Record<string, unknown>): Record<string, unknown> {
  const raw = Array.isArray(data.figures) ? data.figures : [];
  const figures = raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const { label, value } = entry as { label?: unknown; value?: unknown };
    if (typeof label !== "string" || label === "") return [];
    if (typeof value !== "string" && typeof value !== "number") return [];
    return [{ label, value: String(value) }];
  });

  return {
    title: typeof data.title === "string" && data.title !== "" ? data.title : "Summary",
    ...(typeof data.subLabel === "string" ? { subLabel: data.subLabel } : {}),
    figures,
  };
}

/**
 * `chart_intent`'s wire shape is `{spec: Mapping, artifact_id: string}` — a
 * declarative spec plus a reference `GET /agent/artifacts/{id}` would have
 * to resolve, not rendered series data. `DataChartProps` needs concrete
 * `series`/`data` arrays.
 *
 * `series_chart_intent` — what the `show_chart` tool emits — already hands
 * over that concrete shape, `kind` included, so it passes straight through
 * (the spread is deliberate: a new field on the wire reaches
 * `DataChartProps` without a change here). `chart_intent`'s spec+artifact
 * shape still has no production caller; anything that is not already
 * concrete renders as `DataChart`'s own safe empty state ("No data for
 * this window.") rather than throwing on a missing array.
 */
function adaptChart(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data.series) && Array.isArray(data.data)) {
    return { title: "Chart", ...data };
  }
  return { title: "Chart", series: [], data: [] };
}

/**
 * No `citations_intent` builder exists in agent-service yet either
 * (`intents.py`'s own docstring), so — same reasoning as `adaptChart` —
 * this only has to not crash on whatever shape eventually arrives.
 */
function adaptCitations(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data.citations)) {
    return { title: "Sources", ...data };
  }
  return { title: "Sources", citations: [] };
}

/**
 * Bridges a wire `data-<name>` type to the catalog's own intent key.
 * Almost always the identity mapping (`"data-table"`/`"data-chart"` match
 * the catalog's keys already) — except citations, where the wire protocol
 * names the part `"data-citations"` (spec §10.1's own part list) while
 * `catalog.tsx`'s `UIPartIntent` uses the bare `"citations"`. That
 * mismatch belongs to whoever owns the catalog (task 2, out of this task's
 * file list) — this function only bridges it so a citations part actually
 * reaches `renderUIPart` instead of silently falling through to
 * `UnknownIntent`.
 */
export function wireTypeToIntent(type: string): string {
  if (type === "data-citations") return "citations";
  return type;
}

/**
 * `comparison_intent` already emits `DataComparisonProps` — title, an
 * optional `subLabel`, and rows whose every string the server rendered.
 * Nothing is reformatted here on purpose: a figure re-punctuated on the
 * client is a figure that can disagree with the one in the table beside
 * it, which is the whole reason formatting moved to Python.
 *
 * The guard is the same shape as the others: a malformed part renders as
 * `DataComparison`'s own empty state rather than throwing and taking the
 * rest of the answer down with it.
 */
function adaptComparison(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data.rows)) {
    return { title: "Comparison", ...data };
  }
  return { title: "Comparison", rows: [] };
}

/**
 * `summary_intent` already emits `DataSummaryProps`. Nothing is reformatted
 * here for the same reason nothing is in `adaptComparison`: the headline's
 * figure was rendered server-side from the row, and a client that
 * re-punctuated it would recreate the exact drift this part exists to
 * prevent.
 */
function adaptSummary(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.headline === "string" && Array.isArray(data.points)) {
    return data;
  }
  return { headline: "", points: [] };
}

/**
 * A question the run is blocked on. `onAnswer` is not on the wire — it is
 * supplied by whatever renders the part, because only the live thread
 * knows how to reach the run. A part re-rendered from history therefore
 * arrives without one, which is exactly right: that run ended long ago.
 */
function adaptQuestion(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.questionId === "string" && typeof data.question === "string") {
    return { options: [], allowMultiple: false, allowOther: true, ...data };
  }
  return { questionId: "", question: "", options: [], allowMultiple: false, allowOther: false };
}

/**
 * A drafted form. `form_draft_intent` already emits `FormDraftProps`, and
 * the fields arrive in the order the server assigned rather than in
 * whatever order a `Record` iterates.
 *
 * Nothing is reshaped here. The one thing this does do is drop malformed
 * field entries rather than the whole draft: a card missing one row is
 * still a form the reader can open and fix, where a thrown adapter would
 * lose the entire proposal and the run that produced it.
 */
function adaptFormDraft(data: Record<string, unknown>): Record<string, unknown> {
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const usable = fields.filter(
    (field): field is Record<string, unknown> =>
      typeof field === "object" &&
      field !== null &&
      typeof (field as Record<string, unknown>).label === "string" &&
      typeof (field as Record<string, unknown>).type === "string",
  );
  if (typeof data.name !== "string" || usable.length === 0) {
    return { name: "", description: "", category: "", formType: "standalone", fields: [] };
  }
  return {
    description: "",
    category: "checklist",
    formType: "standalone",
    ...data,
    fields: usable.map((field, index) => ({
      required: false,
      order: index,
      ...field,
    })),
  };
}

const WIDGET_SIZES = new Set(["small", "medium", "large", "wide", "full"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One drafted widget, reduced to the contract's keys (CONTRACT §5/§6) —
 * or null when it is missing the two it cannot mean anything without.
 *
 * Optional keys are copied only when present and well-typed, and otherwise
 * left OUT rather than set to undefined or null: the host re-validates every
 * draft against its live catalog, and "absent" is what means "use the
 * metric's default" there. An unknown `size` is dropped for the same reason
 * — the default size is a better answer than a size the grid cannot place.
 */
function adaptDraftWidget(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (!nonEmptyString(raw.metricKey) || !nonEmptyString(raw.visualization)) return null;
  return {
    metricKey: raw.metricKey,
    visualization: raw.visualization,
    ...(typeof raw.title === "string" && raw.title !== "" ? { title: raw.title } : {}),
    ...(typeof raw.subtitle === "string" && raw.subtitle !== "" ? { subtitle: raw.subtitle } : {}),
    ...(typeof raw.size === "string" && WIDGET_SIZES.has(raw.size) ? { size: raw.size } : {}),
    ...(isRecord(raw.params) ? { params: raw.params } : {}),
  };
}

/**
 * A drafted dashboard. `dashboard_draft_intent` already emits the contract
 * shape, so this only drops what it cannot use: a malformed widget is left
 * out rather than taking the whole draft with it — same judgement as
 * `adaptFormDraft`, because a View missing one widget is still one the reader
 * can open and finish.
 *
 * A missing/blank `name` gets a placeholder rather than emptying `widgets`
 * too. It used to: any run whose model forgot the view's name (the name and
 * the widgets are independent fields on the wire — nothing stops one arriving
 * without the other) came back with `widgets: []`, which reads as "no
 * widgets the assistant could read" and hides "Open in builder" even though
 * every widget parsed fine. The card can offer a widget list with no name;
 * it cannot offer one with no widgets.
 */
function adaptDashboardDraft(data: Record<string, unknown>): Record<string, unknown> {
  const widgets = (Array.isArray(data.widgets) ? data.widgets : [])
    .map(adaptDraftWidget)
    .filter((widget): widget is Record<string, unknown> => widget !== null);
  return {
    draftId: typeof data.draftId === "string" ? data.draftId : "",
    name: nonEmptyString(data.name) ? data.name : "Untitled view",
    ...(typeof data.description === "string" && data.description !== ""
      ? { description: data.description }
      : {}),
    widgets,
  };
}

/**
 * A drafted widget. `live` is NOT read from the payload: it says where the
 * part came from (the run stream, not history), which only the caller knows —
 * and it decides whether the card may insert itself into the host's canvas
 * without a click, so a persisted part must never be able to claim it.
 *
 * An unusable part comes back with an empty `draftId`, which the card treats
 * as read-only: no insert, no button.
 */
function adaptWidgetDraft(data: Record<string, unknown>, live: boolean): Record<string, unknown> {
  const widget = adaptDraftWidget(data.widget);
  if (widget === null || !nonEmptyString(data.draftId)) {
    return { draftId: "", widget: { metricKey: "", visualization: "" }, live: false };
  }
  return {
    draftId: data.draftId,
    ...(nonEmptyString(data.replaceWidgetId) ? { replaceWidgetId: data.replaceWidgetId } : {}),
    widget,
    live,
  };
}

/**
 * `live` is true only for a part `useChat` is reading off a run this session
 * started. History (`conversation.hydrateMessages`) never passes it. Only
 * `data-widget-draft` reads it today — see `adaptWidgetDraft`.
 */
export function toUIPart(
  type: string,
  data: Record<string, unknown>,
  options: { live?: boolean } = {},
): UIPart {
  const intent = wireTypeToIntent(type);
  if (intent === "data-dashboard-draft") return { intent, data: adaptDashboardDraft(data) };
  if (intent === "data-widget-draft") {
    return { intent, data: adaptWidgetDraft(data, options.live === true) };
  }
  if (intent === "data-table") return { intent, data: adaptTable(data) };
  if (intent === "data-chart") return { intent, data: adaptChart(data) };
  if (intent === "data-stats") return { intent, data: adaptStats(data) };
  if (intent === "data-comparison") return { intent, data: adaptComparison(data) };
  if (intent === "data-summary") return { intent, data: adaptSummary(data) };
  if (intent === "data-question") return { intent, data: adaptQuestion(data) };
  if (intent === "data-form-draft") return { intent, data: adaptFormDraft(data) };
  if (intent === "citations") return { intent, data: adaptCitations(data) };
  // An intent this module doesn't know how to adapt is passed through
  // unchanged — catalog.tsx's own UnknownIntent fallback is what renders
  // it, not a decision this module gets to make.
  return { intent, data };
}
