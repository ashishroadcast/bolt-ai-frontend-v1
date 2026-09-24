import type { AskDashboardDraftWidget, AskDashboardWidgetSize } from "../config.tsx";
import type { GridSize } from "./packLayout.ts";

/**
 * The few facts the draft cards need from the dashboards widget catalog
 * (`dashboards-contract/catalog.v1.json`), copied by hand rather than
 * imported.
 *
 * Copied because the whole JSON is ~13 KB of i18n keys, permission names and
 * param specs that a card never reads, and the widget is already a heavy
 * bundle. What a card does need — what a metric is called when the AI gave no
 * title, how big it is by default, what its time range defaults to — fits in
 * this table. `dashboardCatalog.test.ts` compares it against the contract's
 * JSON whenever that file is checked out beside this repo, so a metric added
 * or renamed there fails a test here instead of drifting silently.
 *
 * The live catalog stays the host's business: bolt-v2 re-validates every draft
 * against it before anything reaches a canvas. A metric this table predates
 * still renders, under a name derived from its key.
 */

/** `catalog.sizes` — the AI's size vocabulary, in grid cells. */
export const WIDGET_SIZES: Record<AskDashboardWidgetSize, GridSize> = {
  small: { w: 3, h: 2 },
  medium: { w: 4, h: 4 },
  large: { w: 6, h: 5 },
  wide: { w: 8, h: 4 },
  full: { w: 12, h: 5 },
};

interface MetricFacts {
  title: string;
  defaultSize: GridSize;
  /** The `timeRange` param's default preset, for metrics that have one. */
  defaultTimeRange?: string;
}

export const METRICS: Record<string, MetricFacts> = {
  "fleet.active_device_groups": {
    title: "Active Device Groups",
    defaultSize: { w: 3, h: 2 },
    defaultTimeRange: "last_7d",
  },
  "fleet.device_status_breakdown": { title: "Device Group Status", defaultSize: { w: 4, h: 4 } },
  "eta.trips_completed": {
    title: "Trips Completed",
    defaultSize: { w: 3, h: 2 },
    defaultTimeRange: "last_7d",
  },
  "eta.trips_completed_daily": {
    title: "Trip Trend",
    defaultSize: { w: 8, h: 4 },
    defaultTimeRange: "last_30d",
  },
  "eta.trip_status_breakdown": {
    title: "Trips by Status",
    defaultSize: { w: 4, h: 4 },
    defaultTimeRange: "last_7d",
  },
  "eta.top_routes_distance": {
    title: "Top Routes",
    defaultSize: { w: 6, h: 5 },
    defaultTimeRange: "last_7d",
  },
  "report.total_distance": {
    title: "Total Distance",
    defaultSize: { w: 3, h: 2 },
    defaultTimeRange: "last_7d",
  },
  "report.total_distance_daily": {
    title: "Distance Trend",
    defaultSize: { w: 8, h: 4 },
    defaultTimeRange: "last_30d",
  },
  "report.fleet_utilisation": {
    title: "Fleet Utilisation",
    defaultSize: { w: 3, h: 2 },
    defaultTimeRange: "last_7d",
  },
  "report.fleet_utilisation_daily": {
    title: "Utilisation Trend",
    defaultSize: { w: 8, h: 4 },
    defaultTimeRange: "last_30d",
  },
  "report.alerts_by_type": {
    title: "Alerts / Exceptions",
    defaultSize: { w: 6, h: 5 },
    defaultTimeRange: "today",
  },
  "report.alert_type_breakdown": {
    title: "Alerts by Type",
    defaultSize: { w: 4, h: 4 },
    defaultTimeRange: "today",
  },
};

/** The builder's own words for each graph style (F10, F3's type lines). */
export const VISUALIZATION_LABELS: Record<string, string> = {
  kpi: "KPI",
  gauge: "Gauge",
  line: "Line chart",
  area: "Area chart",
  bar: "Bar chart",
  hbar: "Horizontal bar chart",
  pie: "Pie chart",
  donut: "Doughnut chart",
  table: "Data table",
};

const SIZE_LABELS: Record<AskDashboardWidgetSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  wide: "Wide",
  full: "Full width",
};

const PRESET_LABELS: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7d: "Last 7 days",
  last_30d: "Last 30 days",
  this_week: "This week",
  this_month: "This month",
  last_month: "Last month",
};

function humanise(word: string): string {
  const spaced = word.replace(/[_.]+/g, " ").trim();
  return spaced === "" ? word : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** What a metric is called, for a widget the AI gave no title. */
export function metricTitle(metricKey: string): string {
  const known = METRICS[metricKey];
  if (known !== undefined) return known.title;
  // A metric this bundle predates: its key still says what it is.
  const tail = metricKey.split(".").pop() ?? metricKey;
  return humanise(tail);
}

export function widgetTitle(widget: AskDashboardDraftWidget): string {
  const own = widget.title?.trim();
  return own !== undefined && own !== "" ? own : metricTitle(widget.metricKey);
}

export function visualizationLabel(visualization: string): string {
  return VISUALIZATION_LABELS[visualization] ?? humanise(visualization);
}

function isSizeName(size: unknown): size is AskDashboardWidgetSize {
  return typeof size === "string" && Object.hasOwn(WIDGET_SIZES, size);
}

/** The cells a widget will take: its size hint, else the metric's default. */
export function widgetGridSize(widget: AskDashboardDraftWidget): GridSize {
  if (isSizeName(widget.size)) return WIDGET_SIZES[widget.size];
  return METRICS[widget.metricKey]?.defaultSize ?? WIDGET_SIZES.small;
}

export function sizeLabel(widget: AskDashboardDraftWidget): string {
  if (isSizeName(widget.size)) return SIZE_LABELS[widget.size];
  return "Default size";
}

/**
 * The widget's time range, as a phrase — or null for a metric that has none
 * (a live status breakdown).
 *
 * Absent from the draft means the metric's default (CONTRACT §1), so that is
 * what is shown: the reader is checking what the widget will measure, and
 * "no range" would be wrong about it.
 */
export function timeRangeLabel(widget: AskDashboardDraftWidget): string | null {
  const range = widget.params?.timeRange;
  if (range !== null && typeof range === "object") {
    const { preset, from, to } = range as { preset?: unknown; from?: unknown; to?: unknown };
    if (preset === "custom" && typeof from === "string" && typeof to === "string") {
      return `${from} – ${to}`;
    }
    if (typeof preset === "string") return PRESET_LABELS[preset] ?? humanise(preset);
  }
  const fallback = METRICS[widget.metricKey]?.defaultTimeRange;
  return fallback === undefined ? null : (PRESET_LABELS[fallback] ?? humanise(fallback));
}
