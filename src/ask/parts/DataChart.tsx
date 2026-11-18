import { numberFormat } from "../locale.ts";
import { BarChart3 } from "lucide-react";
import type { CSSProperties, ReactElement } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Sheet } from "./Sheet.tsx";
import styles from "./DataChart.module.css";

export interface DataChartSeries {
  /** Matches a key in each point's `values`. */
  key: string;
  /** Legend text. Required, not optional — a colour-blind reader or a
      printed sheet must still be able to tell the series apart. */
  label: string;
  /**
   * A CSS colour value. Swiggy and Zomato series must use var(--swiggy) /
   * var(--zomato); no other series may. This component only renders what
   * it's given — the reservation is enforced by whoever builds the props,
   * same as every other colour rule in this catalog.
   */
  color: string;
  /**
   * What this series' numbers ARE, so they can be written the way a reader
   * expects. Optional: a part from before the field existed has none, and
   * reads as a plain grouped number — never as money it may not be.
   *
   * - `currency` rupees, Indian grouping, two decimals ("₹12,34,567.00")
   * - `percent`  already a percentage ("12.5" → "12.5%")
   * - `share`    a 0–1 fraction, shown as a percentage ("0.35" → "35%")
   * - `number`   a grouped plain number, up to two decimals
   * - `integer`  a grouped whole count ("1,204")
   */
  format?: SeriesFormat;
}

export type SeriesFormat = "currency" | "percent" | "share" | "number" | "integer";

export interface DataChartPoint {
  /** X-axis tick label — a day, a date, whatever the time axis is. */
  label: string;
  /**
   * seriesKey -> value at this point. A missing key is a GAP, not a zero:
   * the server leaves a value out on purpose when there was no reading
   * (a store closed that week, a sensor offline), and a line drawn down to
   * zero and back claims a collapse that never happened. Only a stack —
   * where every band sits on the ones below it — reads a gap as 0.
   */
  values: Record<string, number>;
}

/**
 * How the numbers should be drawn — chosen by whoever built the props,
 * because only they know what the series MEAN.
 *
 * This used to have no value at all: everything was a stacked bar. That is
 * right for parts of a whole and wrong for everything else, and the
 * commonest chart this console draws is the case it is most wrong for. Six
 * stores' weekly sales came back as six colours stacked on top of one
 * another, which claims the six add up to something a reader cares about
 * (they do not — no one asks for the combined sales of an arbitrary top
 * six) and makes the one question actually being asked — which store is
 * ahead, and is it pulling away? — impossible to answer, because only the
 * bottom band starts at a common baseline. Every band above it is offset
 * by whatever the bands below it happened to do.
 *
 * - `line`     one entity per series, compared over time. The default for
 *              a pivot, and the fix for the case above.
 * - `bar`      one measure over a time or category axis.
 * - `stack`    parts that genuinely sum to a meaningful total — channel
 *              mix, payment split, a tax breakdown.
 * - `area`     a total over time whose SIZE is the point; stacks when
 *              given several series, which is the composition-over-time
 *              reading a stacked bar makes harder to follow.
 * - `pie`      one measure split into shares of a whole, at one moment.
 * - `scatter`  the relationship between two measures — the first series
 *              is the x axis, the second the y, one point per label.
 */
export type DataChartKind =
  | "line"
  | "step"
  | "bar"
  | "hbar"
  | "stack"
  | "share"
  | "combo"
  | "area"
  | "pie"
  | "donut"
  | "radial"
  | "treemap"
  | "funnel"
  | "radar"
  | "scatter"
  | "bubble";

export interface DataChartProps {
  title: string;
  subLabel?: string;
  /** Draw order. For `stack`, the first series sits at the baseline. */
  series: DataChartSeries[];
  data: DataChartPoint[];
  /** Defaults to `stack` only when a caller predates the field. */
  kind?: DataChartKind;
  /** Falls back to a description built from title/subLabel/series when omitted. */
  ariaLabel?: string;
}

const CHART_H = 240;

/**
 * How tall an hbar chart has to be for its bars to stay bars: a fixed
 * 240px shared out across forty categories left each a hairline with a
 * label it could not hold. A row per category, and a little more per extra
 * series grouped inside it; never shorter than every other chart.
 */
export function hbarHeight(categories: number, seriesCount: number): number {
  return Math.max(CHART_H, categories * (20 + 8 * Math.max(1, seriesCount)));
}

/**
 * The series ramp, extended past the six tokens the server assigns from.
 *
 * `intents.py` hands out `--series-1`…`--series-6` in order and gives
 * every series after the sixth the LAST one again, so the seventh slice of
 * a pie onward were all the same slate — a tail of slices a reader could
 * not tell apart. Two more are added here (a light orchid and a dark umber,
 * continuing the ramp's dark/light alternation and staying off the orange
 * and red reserved for Swiggy and Zomato); `var()` fallbacks, so a host
 * without the tokens still gets the colour.
 */
const PALETTE = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7, #c27bb0)",
  "var(--series-8, #6b4a33)",
];

/** "The rest" — a neutral, so it never reads as one more named category. */
const OTHER_COLOR = "var(--series-other, #b3bab6)";

/**
 * Series with every colour distinct, as far as the palette reaches.
 *
 * Only a REPEATED colour is replaced — the first series to hold a colour
 * keeps it, so the server's own choices (and the partner reservation, which
 * is never repeated) stand. A repeat takes the first palette colour no
 * series is using yet.
 */
export function withDistinctColors<T extends DataChartSeries>(series: readonly T[]): T[] {
  const taken = new Set<string>();
  const spare = PALETTE.filter((color) => !series.some((s) => s.color === color));
  return series.map((s) => {
    if (!taken.has(s.color)) {
      taken.add(s.color);
      return s;
    }
    const next = spare.shift();
    if (next === undefined) return s;
    taken.add(next);
    return { ...s, color: next };
  });
}

/** A slice of a pie, treemap, funnel or radial: one series at one value. */
export interface Slice extends DataChartSeries {
  value: number;
}

/**
 * The most slices a part-of-a-whole chart draws. Past this a pie is a
 * ring of slivers, and even an extended palette runs out of colours a
 * reader can tell apart.
 */
export const MAX_SLICES = 8;

/**
 * Slices, with everything past the largest seven folded into one "Other".
 *
 * The seven kept stay in the server's order (usually already ranked); the
 * fold only decides which make the cut. "Other" takes the format its
 * members share, so its tooltip still reads in their unit. The accessible
 * table beside the chart lists every slice, folded or not.
 */
export function foldSlices(slices: readonly Slice[], max: number = MAX_SLICES): Slice[] {
  if (slices.length <= max) return [...slices];
  const keep = new Set(
    [...slices]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, max - 1)
      .map((slice) => slice.key),
  );
  const rest = slices.filter((slice) => !keep.has(slice.key));
  return [
    ...slices.filter((slice) => keep.has(slice.key)),
    {
      key: "__other__",
      label: "Other",
      color: OTHER_COLOR,
      format: sharedFormat(rest),
      value: rest.reduce((sum, slice) => sum + slice.value, 0),
    },
  ];
}

/** Kinds whose shapes are slices of one moment rather than a series over points. */
const SLICE_KINDS: ReadonlySet<DataChartKind> = new Set(["pie", "donut", "treemap", "funnel", "radial"]);

interface LegendEntry {
  key: string;
  label: string;
  color: string;
}

/**
 * The legend, as HTML beneath the plot rather than inside it.
 *
 * Recharts' own legend sits in a wrapper of a fixed height (28px here), so
 * a legend that wrapped to a second line — five long store names in a
 * 420px panel — was cut off by the sheet's `overflow: hidden`, and the
 * series it named became colours nobody could decode. A plain list wraps
 * as far as it needs to and the plot keeps its full height above it.
 */
function ChartLegend({ entries, line }: { entries: readonly LegendEntry[]; line: boolean }): ReactElement {
  return (
    <ul className={styles.legend} data-swatch={line ? "line" : "block"}>
      {entries.map((entry) => (
        <li
          key={entry.key}
          className={styles.legendItem}
          style={{ "--swatch": entry.color } as CSSProperties}
        >
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * An axis tick, short enough not to crowd the plot.
 *
 * Net sales for a month of a real store runs to eight digits, and
 * `Intl.NumberFormat("en-IN")` renders that as `2,90,82,789` — wider than
 * the whole gutter, so the ticks overlapped the bars and each other.
 * Indian units (crore, lakh) rather than compact-notation "M"/"B": this
 * console reads rupee figures for Indian restaurants throughout, and
 * `en-IN`'s own compact notation abbreviates thousand as "T", which reads
 * as trillion to half its audience.
 */
export function axisTickLabel(value: number): string {
  const abs = Math.abs(value);
  // WFM: thousands, millions, billions (upstream used lakh and crore).
  if (abs >= 1e9) return `${trimZero(value / 1e9)}B`;
  if (abs >= 1e6) return `${trimZero(value / 1e6)}M`;
  if (abs >= 1e3) return `${trimZero(value / 1e3)}k`;
  return numberFormat().format(value);
}

/** One decimal, but never a trailing ".0" — "3Cr" reads better than
 * "3.0Cr" and the axis has no room to spare. */
function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

const MONEY = numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PLAIN = numberFormat({ maximumFractionDigits: 2 });
const WHOLE = numberFormat({ maximumFractionDigits: 0 });
const PERCENT = numberFormat({ maximumFractionDigits: 1 });

/**
 * One exact figure, written the way its series says it should be — the
 * tooltip and the data table are where a reader goes for the real number,
 * so they get the full grouping the axis cannot afford.
 *
 * Every tooltip used to put a rupee sign in front of every value, so a
 * trip count read "₹42.00" and a share of 0.35 read "₹0.35". Without a
 * `format` this now falls back to a plain grouped number: a figure with no
 * unit is less wrong than a figure with the wrong one.
 */
export function formatValue(value: number, format?: SeriesFormat): string {
  if (!Number.isFinite(value)) return "—";
  // `-0` would otherwise print as "-0%".
  const v = value === 0 ? 0 : value;
  switch (format) {
    case "currency":
      // WFM: no currency symbol (see `../locale`).
      return `${v < 0 ? "-" : ""}${MONEY.format(Math.abs(v))}`;
    case "percent":
      return `${PERCENT.format(v)}%`;
    case "share":
      return `${PERCENT.format(v * 100)}%`;
    case "integer":
      return WHOLE.format(v);
    default:
      return PLAIN.format(v);
  }
}

/** An axis tick in the same unit, kept short: percentages as percentages
 * (a share axis read 0–1), everything else in Indian units. */
export function formatAxisTick(value: number, format?: SeriesFormat): string {
  const v = value === 0 ? 0 : value;
  if (format === "percent") return `${PERCENT.format(v)}%`;
  if (format === "share") return `${PERCENT.format(v * 100)}%`;
  return axisTickLabel(v);
}

/** The format every one of these series shares, or none: one axis can only
 * carry one unit, and a mixed axis is better plain than mislabelled. */
export function sharedFormat(series: readonly DataChartSeries[]): SeriesFormat | undefined {
  const first = series[0]?.format;
  return series.every((s) => s.format === first) ? first : undefined;
}

/** The shared look of every hover read-out on these sheets. */
const TOOLTIP_STYLE = {
  contentStyle: {
    background: "var(--surface)",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius-control)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    boxShadow: "var(--lift-float)",
  },
  labelStyle: { color: "var(--fg)", fontWeight: 600, marginBottom: 4 },
} as const;

/**
 * A tooltip formatter that writes each entry in its OWN series' format.
 * Found by data key first (`v:<key>`), then by name — a slice chart's
 * entries are named for their series and carry no key of ours.
 */
export function formatterFor(series: readonly DataChartSeries[]) {
  const byKey = new Map(series.map((s) => [`v:${s.key}`, s]));
  const byLabel = new Map(series.map((s) => [s.label, s]));
  return (value: unknown, name: unknown, item: { dataKey?: unknown } | undefined): [string, string] => {
    const owner = byKey.get(String(item?.dataKey)) ?? byLabel.get(String(name));
    return [formatValue(Number(value), owner?.format), String(name)];
  };
}

/**
 * For the share chart, whose drawn values are fractions of each column:
 * the share first, then the figure it is a share of, in its own format.
 */
export function shareFormatterFor(series: readonly DataChartSeries[]) {
  const byKey = new Map(series.map((s) => [`v:${s.key}`, s]));
  return (
    value: unknown,
    name: unknown,
    item: { dataKey?: unknown; payload?: Record<string, unknown> } | undefined,
  ): [string, string] => {
    const owner = byKey.get(String(item?.dataKey));
    const raw = owner === undefined ? undefined : item?.payload?.[`r:${owner.key}`];
    const share = formatValue(Number(value), "share");
    return [typeof raw === "number" ? `${share} · ${formatValue(raw, owner?.format)}` : share, String(name)];
  };
}

/**
 * A scatter's hover read-out: WHICH point this is as the title, then each
 * measure in its own format — and nothing that is not a number.
 */
export function ScatterTip({
  active,
  row,
  measures,
}: {
  active: boolean;
  row: ChartRow | undefined;
  measures: readonly DataChartSeries[];
}): ReactElement | null {
  if (!active || row === undefined) return null;
  return (
    <div className={styles.tip} style={TOOLTIP_STYLE.contentStyle}>
      <p className={styles.tipTitle}>{String(row.label ?? "")}</p>
      {measures.map((s) => {
        const value = row[`v:${s.key}`];
        return typeof value === "number" ? (
          <p key={s.key} className={styles.tipRow}>
            <span>{s.label}</span>
            <span className={styles.tipValue}>{formatValue(value, s.format)}</span>
          </p>
        ) : null;
      })}
    </div>
  );
}

type ChartRow = Record<string, string | number | null>;

/**
 * Recharts wants a flat row per point; this component's props keep the
 * values nested so a series key can be anything. `label` is reserved as
 * the x key, so a series whose key is literally "label" would collide —
 * it is prefixed rather than trusted.
 *
 * `missing` is what an absent value becomes: `null` — a gap Recharts
 * leaves undrawn — everywhere except where the shape needs a number to
 * stand on (a stack's bands, a radar's polygon, a slice).
 */
function toRows(data: DataChartPoint[], series: DataChartSeries[], missing: 0 | null): ChartRow[] {
  return data.map((point) => {
    const row: ChartRow = { label: point.label };
    for (const s of series) {
      const value = point.values[s.key];
      row[`v:${s.key}`] = typeof value === "number" && Number.isFinite(value) ? value : missing;
    }
    return row;
  });
}

/** Kinds whose shape needs every value to be a number. */
const ZERO_FILLED: ReadonlySet<DataChartKind> = new Set(["stack", "share", "radar"]);

/**
 * Whether a series has a point that no line reaches — the only point on
 * the chart, or one with a gap on both sides of it.
 *
 * Lines and areas are drawn without dots (see `line` below), and a line
 * needs two points to exist. So a one-week chart, or a store with a single
 * reading between two gaps, drew an empty plot: the value was there, the
 * mark for it was not. Such a series gets its dots back.
 */
export function hasIsolatedPoint(rows: ChartRow[], dataKey: string): boolean {
  const present = (row: ChartRow | undefined) => typeof row?.[dataKey] === "number";
  return rows.some((row, index) => present(row) && !present(rows[index - 1]) && !present(rows[index + 1]));
}

/**
 * Rows rescaled so each column sums to 1. `stackOffset="expand"` does the
 * drawing, but the TOOLTIP would still read raw values against a
 * percentage axis — so the numbers themselves are converted, and a column
 * whose total is zero is left alone rather than dividing by it. The raw
 * figure rides along under `r:<key>` for the tooltip to show beside it.
 */
function toPercentRows(rows: ChartRow[], series: DataChartSeries[]): ChartRow[] {
  return rows.map((row) => {
    const total = series.reduce((sum, s) => sum + Math.abs(Number(row[`v:${s.key}`] ?? 0)), 0);
    if (total === 0) return row;
    const scaled: ChartRow = { label: row.label! };
    for (const s of series) {
      scaled[`v:${s.key}`] = Number(row[`v:${s.key}`] ?? 0) / total;
      scaled[`r:${s.key}`] = row[`v:${s.key}`] ?? 0;
    }
    return scaled;
  });
}

interface ChartTableModel {
  columns: { key: string; label: string }[];
  rows: { label: string; cells: string[] }[];
}

/** What a reader hears for a value the server left out. */
const NO_VALUE = "No data";

function cellText(value: number | undefined, format?: SeriesFormat): string {
  return typeof value === "number" && Number.isFinite(value) ? formatValue(value, format) : NO_VALUE;
}

/**
 * The chart's numbers as rows and columns, from the props rather than from
 * what was drawn: every slice (a folded "Other" is a drawing decision, not
 * data), every point, and a gap said as a gap rather than as the zero a
 * stack had to draw it at.
 *
 * - slices  one row per series, one column for the moment they describe
 * - scatter one row per point, one column per measure
 * - the rest one row per point on the x axis, one column per series
 */
function chartTable(kind: DataChartKind, series: readonly DataChartSeries[], data: readonly DataChartPoint[]): ChartTableModel {
  if (SLICE_KINDS.has(kind)) {
    const point = data[0];
    return {
      columns: [{ key: "value", label: point?.label ?? "Value" }],
      rows: series.map((s) => ({ label: s.label, cells: [cellText(point?.values[s.key], s.format)] })),
    };
  }
  const measures = kind === "scatter" ? series.slice(0, 2) : kind === "bubble" ? series.slice(0, 3) : series;
  return {
    columns: measures.map((s) => ({ key: s.key, label: s.label })),
    rows: data.map((point) => {
      // The share chart draws each value as its part of the column, so the
      // table says both: the figure, and the share it was drawn as.
      const total =
        kind === "share" ? measures.reduce((sum, s) => sum + Math.abs(point.values[s.key] ?? 0), 0) : 0;
      return {
        label: point.label,
        cells: measures.map((s) => {
          const value = point.values[s.key];
          const text = cellText(value, s.format);
          return total > 0 && typeof value === "number" ? `${text} (${formatValue(value / total, "share")})` : text;
        }),
      };
    }),
  };
}

/**
 * The chart, for a screen reader: the same numbers as a table, visually
 * hidden.
 *
 * All a screen reader used to get was the image's label — "Weekly net
 * sales. Series: Bandra, BKC." — and not one value. The plot itself is
 * `aria-hidden` beside this, so nothing is read twice. Values go through
 * the same `formatValue` the tooltip uses, so the table and the hover
 * read-out can never disagree about a figure.
 */
function ChartTable({ caption, model }: { caption: string; model: ChartTableModel }): ReactElement {
  return (
    <table className={styles.visuallyHidden}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {/* The corner names nothing: the rows are named by their own
              first cell. */}
          <td />
          {model.columns.map((column) => (
            <th key={column.key} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {model.rows.map((row, rowIndex) => (
          // Points can share a label (two "Mon"s across a fortnight); the
          // table is one render's snapshot, never reordered.
          // eslint-disable-next-line react/no-array-index-key
          <tr key={rowIndex}>
            <th scope="row">{row.label}</th>
            {row.cells.map((text, cellIndex) => (
              // eslint-disable-next-line react/no-array-index-key
              <td key={cellIndex}>{text}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A chart sheet: faint horizontal grid, an axis in Indian units, a
 * hover read-out, and a legend in the console's own voice rather than
 * Recharts' default.
 *
 * **On the library.** The previous version was hand-authored SVG with the
 * plot box hard-coded (`VIEW_W`/`PLOT_LEFT`/`TICK_LABEL_Y`, ported 1:1
 * from a mockup) and every x tick drawn, centred, unconditionally. With
 * fourteen weekly points that is fourteen ten-character dates competing
 * for 598px, and they rendered as one unbroken smear —
 * `2026-08-2026-08-2926-08-10…`. Thinning ticks, measuring text, placing a
 * tooltip and reflowing to the container are all work a chart library has
 * already done; none of it was the point of this file.
 */
export function DataChart({
  title,
  subLabel,
  series,
  data,
  kind = "stack",
  ariaLabel,
}: DataChartProps): ReactElement {
  if (series.length === 0 || data.length === 0) {
    return (
      <Sheet title={title} subLabel={subLabel} icon={BarChart3}>
        <p className={styles.empty}>No data for this window.</p>
      </Sheet>
    );
  }

  const rows = toRows(data, series, ZERO_FILLED.has(kind) ? 0 : null);
  const hasNegative = data.some((point) =>
    series.some((s) => (point.values[s.key] ?? 0) < 0),
  );
  const drawn = withDistinctColors(series);
  // A slice chart's slices are its series at the first point. A funnel's
  // stages are an ordered sequence, so they are never folded: an "Other"
  // stage would be a step nobody took.
  const sliceValues: Slice[] = drawn.map((s) => ({ ...s, value: Number(rows[0]?.[`v:${s.key}`] ?? 0) }));
  const slices = SLICE_KINDS.has(kind) ? (kind === "funnel" ? sliceValues : foldSlices(sliceValues)) : [];
  const legend: LegendEntry[] =
    kind === "treemap" || kind === "funnel" || kind === "scatter" || kind === "bubble"
      ? []
      : SLICE_KINDS.has(kind)
        ? slices
        : drawn;
  const height = kind === "hbar" ? hbarHeight(rows.length, drawn.length) : CHART_H;

  const describedBy =
    ariaLabel ??
    `${title}${subLabel ? `, ${subLabel}` : ""}. Series: ${series.map((s) => s.label).join(", ")}.`;

  // One unit per axis. A share chart's axis is a fraction of each column,
  // whatever its series measure; a combo's left axis is its first series.
  const leftFormat =
    kind === "share" ? "share" : kind === "combo" ? series[0]!.format : sharedFormat(series);

  const axis = (
    <>
      <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" vertical={false} />
      <XAxis
        dataKey="label"
        tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
        tickLine={false}
        axisLine={{ stroke: "var(--rule)" }}
        // Recharts drops whichever labels will not fit rather than drawing
        // them on top of each other, which is the whole reason the old
        // hand-rolled axis was unreadable. The gap is generous because
        // these are ISO dates, the widest tick this console draws.
        minTickGap={28}
        interval="preserveStartEnd"
      />
      <YAxis
        tickFormatter={(value: number) => formatAxisTick(value, leftFormat)}
        // A count axis of 0, 0.5, 1, 1.5 trips claims half-trips exist.
        allowDecimals={leftFormat !== "integer"}
        tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
        tickLine={false}
        axisLine={false}
        width={46}
      />
      <Tooltip
        formatter={kind === "share" ? shareFormatterFor(series) : formatterFor(series)}
        {...TOOLTIP_STYLE}
        cursor={{ fill: "var(--ground-lift)", stroke: "var(--rule)" }}
      />
      {/* Zero has to read as zero when values sit on both sides of it,
          otherwise a small rise and a small fall look alike. */}
      {hasNegative && <ReferenceLine y={0} stroke="var(--fg-faint)" />}
    </>
  );

  return (
    <Sheet title={title} subLabel={subLabel} icon={BarChart3}>
      <div className={styles.body}>
        {/* The picture, named as one image; everything inside it hidden
            from assistive tech, because the table below carries the same
            numbers in a form that can actually be read. */}
        <div role="img" aria-label={describedBy}>
          <div aria-hidden="true">
            <ResponsiveContainer width="100%" height={height}>
              {renderChart(kind, rows, drawn, axis, slices)}
            </ResponsiveContainer>
            {legend.length > 0 && (
              <ChartLegend entries={legend} line={kind === "line" || kind === "step"} />
            )}
          </div>
        </div>
        <ChartTable
          caption={`${title}${subLabel ? `, ${subLabel}` : ""}`}
          model={chartTable(kind, drawn, data)}
        />
      </div>
    </Sheet>
  );
}

/**
 * One chart, by kind. A switch rather than nested ternaries: six shapes do
 * not read as an expression, and each branch here is a different argument
 * about the data rather than a different style of the same one.
 */
// `accessibilityLayer={false}` on every chart below: Recharts' own layer
// makes the SVG a focusable `role="application"`, and a focusable element
// inside the `aria-hidden` plot is a keyboard stop that announces nothing.
// The hidden table is what a screen reader reads instead.
function renderChart(
  kind: DataChartKind,
  rows: ChartRow[],
  series: DataChartSeries[],
  axis: ReactElement,
  slices: Slice[],
): ReactElement {
  const margin = { top: 8, right: 12, bottom: 0, left: 0 };
  // A dot only where a line cannot be drawn — see `hasIsolatedPoint`.
  const dotFor = (s: DataChartSeries) => (hasIsolatedPoint(rows, `v:${s.key}`) ? { r: 3 } : false);

  switch (kind) {
    case "line":
      return (
        <LineChart data={rows} margin={margin} accessibilityLayer={false}>
          {axis}
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={`v:${s.key}`}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              // A dot per point would be 84 dots on a six-store fourteen-
              // week chart. The hover read-out is where a reader goes for
              // a single value — unless a point has no line to sit on.
              dot={dotFor(s)}
              activeDot={{ r: 3.5 }}
              // A missing week is a break in the line, not a bridge over it.
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      );

    case "area":
      return (
        <AreaChart data={rows} margin={margin} accessibilityLayer={false}>
          {axis}
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={`v:${s.key}`}
              name={s.label}
              stroke={s.color}
              // Translucent so an overlapping series stays readable
              // underneath; a solid fill turns two areas into one shape.
              fill={s.color}
              fillOpacity={0.22}
              strokeWidth={2}
              // Several areas stack: the composition-over-time reading is
              // the only one an area chart of multiple series supports.
              stackId={series.length > 1 ? "total" : undefined}
              dot={dotFor(s)}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      );

    case "pie":
    case "donut":
      // Slices come from the SERIES, not the points: the server turns each
      // label into a series for a pie precisely so its own palette — and
      // the Swiggy/Zomato reservation inside it — applies per slice.
      return (
        <PieChart margin={margin} accessibilityLayer={false}>
          <Tooltip formatter={formatterFor(slices)} {...TOOLTIP_STYLE} />
          <Pie
            data={slices.map((slice) => ({ name: slice.label, value: slice.value }))}
            dataKey="value"
            nameKey="name"
            // A donut, not a full pie: the hole gives the labels somewhere
            // to breathe and stops the eye comparing centre angles, which
            // people read badly.
            innerRadius="45%"
            outerRadius="78%"
            paddingAngle={1}
            isAnimationActive={false}
          >
            {slices.map((slice) => (
              <Cell key={slice.key} fill={slice.color} />
            ))}
          </Pie>
        </PieChart>
      );

    case "scatter":
    case "bubble": {
      // A bubble's third measure sizes the dot, so one chart carries three
      // dimensions; a plain scatter has none and every dot is equal.
      const sizeBy = kind === "bubble" ? series[2] : undefined;
      // Two measures, one point per label: the first series is x, the
      // second y. The tool refuses anything else, so both exist here.
      return (
        <ScatterChart margin={{ ...margin, bottom: 8 }} accessibilityLayer={false}>
          <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey={`v:${series[0]!.key}`}
            name={series[0]!.label}
            tickFormatter={(value: number) => formatAxisTick(value, series[0]!.format)}
            tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--rule)" }}
          />
          <YAxis
            type="number"
            dataKey={`v:${series[1]!.key}`}
            name={series[1]!.label}
            tickFormatter={(value: number) => formatAxisTick(value, series[1]!.format)}
            tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={false}
            width={46}
          />
          {/* For a bubble the third measure sizes the dot, so one chart
              carries three dimensions; for a plain scatter every dot is
              the same size. It used to be keyed on `label` to name the
              point, which put the label into the tooltip as a value —
              "label: ₹NaN". The point's name is the tooltip's title now. */}
          {sizeBy === undefined ? (
            <ZAxis range={[60, 60]} />
          ) : (
            <ZAxis
              // Recharts narrows dataKey from the row type it inferred, which
              // cannot know about the `v:` prefix these rows carry.
              dataKey={`v:${sizeBy.key}` as string}
              name={sizeBy.label}
              range={[40, 420]}
            />
          )}
          <Tooltip
            cursor={{ stroke: "var(--rule)" }}
            content={({ active, payload }) => (
              <ScatterTip
                active={active === true}
                row={payload?.[0]?.payload as ChartRow | undefined}
                measures={sizeBy === undefined ? [series[0]!, series[1]!] : [series[0]!, series[1]!, sizeBy]}
              />
            )}
          />
          {/* A point missing either coordinate has nowhere to be drawn;
              it used to be drawn at zero, which put it on an axis it never
              reached. */}
          <Scatter
            data={rows.filter(
              (row) => typeof row[`v:${series[0]!.key}`] === "number" && typeof row[`v:${series[1]!.key}`] === "number",
            )}
            fill={series[0]!.color}
            isAnimationActive={false}
          />
        </ScatterChart>
      );
    }

    case "step":
      // Holds its value between points instead of sloping between them.
      // A price, a headcount or a tax rate did not drift from one reading
      // to the next — it stayed, then changed — and a sloped line asserts
      // a journey the data never took.
      return (
        <LineChart data={rows} margin={margin} accessibilityLayer={false}>
          {axis}
          {series.map((s) => (
            <Line
              key={s.key}
              type="stepAfter"
              dataKey={`v:${s.key}`}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={dotFor(s)}
              activeDot={{ r: 3.5 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      );

    case "hbar":
      // Categories on the vertical axis, so a long name — "No Added Sugar
      // Mango Ice Cream (Medium Fat)" is a real one — gets a full line to
      // itself instead of being rotated 45° or truncated to nothing.
      return (
        <BarChart data={rows} layout="vertical" margin={{ ...margin, left: 8 }} accessibilityLayer={false}>
          <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(value: number) => formatAxisTick(value, sharedFormat(series))}
            allowDecimals={sharedFormat(series) !== "integer"}
            tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--rule)" }}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={140}
            tick={{ fill: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--font-body)" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip formatter={formatterFor(series)} {...TOOLTIP_STYLE} cursor={{ fill: "var(--ground-lift)" }} />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={`v:${s.key}`}
              name={s.label}
              fill={s.color}
              radius={[0, 2, 2, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      );

    case "share":
      // Every column the same height, so what changes is COMPOSITION and
      // nothing else. A stacked bar answers "how big" and "what mix" at
      // once and does neither cleanly; this answers only the second, which
      // is what "share over time" actually asks.
      return (
        <BarChart data={toPercentRows(rows, series)} margin={margin} stackOffset="expand" accessibilityLayer={false}>
          {axis}
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={`v:${s.key}`}
              name={s.label}
              fill={s.color}
              stackId="total"
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      );

    case "combo":
      // Two measures on different scales — orders in thousands beside a
      // rate in single digits — where one is the volume and the other the
      // thing you read against it. Both on one axis would flatten the
      // smaller to a straight line at zero.
      return (
        <ComposedChart data={rows} margin={margin} accessibilityLayer={false}>
          {axis}
          <YAxis
            yAxisId="right"
            orientation="right"
            tickFormatter={(value: number) => formatAxisTick(value, sharedFormat(series.slice(1)))}
            allowDecimals={sharedFormat(series.slice(1)) !== "integer"}
            tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={false}
            width={46}
          />
          {series.map((s, i) =>
            i === 0 ? (
              <Bar key={s.key} dataKey={`v:${s.key}`} name={s.label} fill={s.color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            ) : (
              <Line
                key={s.key}
                yAxisId="right"
                type="monotone"
                dataKey={`v:${s.key}`}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={dotFor(s)}
                connectNulls={false}
                isAnimationActive={false}
              />
            ),
          )}
        </ComposedChart>
      );

    case "radar":
      // One shape per entity across several measures at once. Useful for
      // "how do these stores differ in character" — the shape is the
      // comparison, and an outlier reads as a dent rather than as a row
      // you have to find.
      return (
        <RadarChart data={rows} margin={margin} accessibilityLayer={false}>
          <PolarGrid stroke="var(--rule)" />
          <PolarAngleAxis dataKey="label" tick={{ fill: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--font-body)" }} />
          <PolarRadiusAxis
            tick={{ fill: "var(--fg-faint)", fontSize: 10 }}
            tickFormatter={(value: number) => formatAxisTick(value, sharedFormat(series))}
          />
          <Tooltip formatter={formatterFor(series)} {...TOOLTIP_STYLE} />
          {series.map((s) => (
            <Radar key={s.key} dataKey={`v:${s.key}`} name={s.label} stroke={s.color} fill={s.color} fillOpacity={0.18} isAnimationActive={false} />
          ))}
        </RadarChart>
      );

    case "treemap":
      // Share by area rather than by angle. Past about six slices a pie
      // stops being readable and this does not — a long tail of small
      // items still reads as a long tail.
      return (
        <Treemap
          data={slices.map((slice) => ({ name: slice.label, size: Math.abs(slice.value), fill: slice.color }))}
          dataKey="size"
          isAnimationActive={false}
          stroke="var(--surface)"
        >
          <Tooltip formatter={formatterFor(slices)} {...TOOLTIP_STYLE} />
        </Treemap>
      );

    case "funnel":
      // Steps that necessarily shrink — sessions, carts, orders paid. The
      // narrowing IS the finding, and the gap between two stages is what a
      // reader is looking for.
      return (
        <FunnelChart margin={margin} accessibilityLayer={false}>
          <Tooltip formatter={formatterFor(slices)} {...TOOLTIP_STYLE} />
          <Funnel
            dataKey="size"
            data={slices.map((slice) => ({ name: slice.label, size: slice.value, fill: slice.color }))}
            isAnimationActive={false}
          >
            <LabelList position="right" dataKey="name" fill="var(--fg-dim)" stroke="none" fontSize={11} />
          </Funnel>
        </FunnelChart>
      );

    case "radial":
      // A handful of parts of a whole drawn as arcs. Reads as progress
      // against a total, which is the register a target or a share of
      // capacity wants — not the register a pie wants.
      return (
        <RadialBarChart
          data={slices.map((slice) => ({ name: slice.label, value: slice.value, fill: slice.color }))}
          innerRadius="28%"
          outerRadius="95%"
          startAngle={90}
          endAngle={-270}
          margin={margin}
          accessibilityLayer={false}
        >
          <RadialBar dataKey="value" background={{ fill: "var(--surface-sunk)" }} isAnimationActive={false} />
          <Tooltip formatter={formatterFor(slices)} {...TOOLTIP_STYLE} />
        </RadialBarChart>
      );

    default:
      return (
        <BarChart data={rows} margin={margin} accessibilityLayer={false}>
          {axis}
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={`v:${s.key}`}
              name={s.label}
              fill={s.color}
              // One stack id makes them a stack; none makes Recharts group
              // them side by side, which is what a comparison of unrelated
              // measures wants.
              stackId={kind === "stack" ? "total" : undefined}
              radius={kind === "stack" ? 0 : [2, 2, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      );
  }
}
