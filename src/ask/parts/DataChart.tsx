import { BarChart3 } from "lucide-react";
import type { ReactElement } from "react";
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
  Legend,
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
}

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
  if (abs >= 1e7) return `${trimZero(value / 1e7)}Cr`;
  if (abs >= 1e5) return `${trimZero(value / 1e5)}L`;
  if (abs >= 1e3) return `${trimZero(value / 1e3)}k`;
  return new Intl.NumberFormat("en-IN").format(value);
}

/** One decimal, but never a trailing ".0" — "3Cr" reads better than
 * "3.0Cr" and the axis has no room to spare. */
function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** The tooltip shows one exact figure, so it gets the full grouping the
 * axis cannot afford — this is where a reader goes for the real number. */
function tooltipValue(value: number): string {
  return `₹${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`;
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
 * whose total is zero is left alone rather than dividing by it.
 */
function toPercentRows(rows: ChartRow[], series: DataChartSeries[]): ChartRow[] {
  return rows.map((row) => {
    const total = series.reduce((sum, s) => sum + Math.abs(Number(row[`v:${s.key}`] ?? 0)), 0);
    if (total === 0) return row;
    const scaled: ChartRow = { label: row.label! };
    for (const s of series) scaled[`v:${s.key}`] = Number(row[`v:${s.key}`] ?? 0) / total;
    return scaled;
  });
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

  const describedBy =
    ariaLabel ??
    `${title}${subLabel ? `, ${subLabel}` : ""}. Series: ${series.map((s) => s.label).join(", ")}.`;

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
        tickFormatter={axisTickLabel}
        tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
        tickLine={false}
        axisLine={false}
        width={46}
      />
      <Tooltip
        formatter={(value, name) => [tooltipValue(Number(value)), String(name)]}
        contentStyle={{
          background: "var(--surface)",
          border: "1px solid var(--rule)",
          borderRadius: "var(--radius-control)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          boxShadow: "var(--lift-float)",
        }}
        labelStyle={{ color: "var(--fg)", fontWeight: 600, marginBottom: 4 }}
        cursor={{ fill: "var(--ground-lift)", stroke: "var(--rule)" }}
      />
      <Legend
        verticalAlign="bottom"
        height={28}
        iconType="plainline"
        wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}
      />
      {/* Zero has to read as zero when values sit on both sides of it,
          otherwise a small rise and a small fall look alike. */}
      {hasNegative && <ReferenceLine y={0} stroke="var(--fg-faint)" />}
    </>
  );

  return (
    <Sheet title={title} subLabel={subLabel} icon={BarChart3}>
      <div className={styles.body} role="img" aria-label={describedBy}>
        <ResponsiveContainer width="100%" height={CHART_H}>
          {renderChart(kind, rows, series, axis)}
        </ResponsiveContainer>
      </div>
    </Sheet>
  );
}

/**
 * One chart, by kind. A switch rather than nested ternaries: six shapes do
 * not read as an expression, and each branch here is a different argument
 * about the data rather than a different style of the same one.
 */
function renderChart(
  kind: DataChartKind,
  rows: ChartRow[],
  series: DataChartSeries[],
  axis: ReactElement,
): ReactElement {
  const margin = { top: 8, right: 12, bottom: 0, left: 0 };
  // A dot only where a line cannot be drawn — see `hasIsolatedPoint`.
  const dotFor = (s: DataChartSeries) => (hasIsolatedPoint(rows, `v:${s.key}`) ? { r: 3 } : false);

  switch (kind) {
    case "line":
      return (
        <LineChart data={rows} margin={margin}>
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
        <AreaChart data={rows} margin={margin}>
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
        <PieChart margin={margin}>
          <Tooltip formatter={(value, name) => [tooltipValue(Number(value)), String(name)]} />
          <Legend
            verticalAlign="bottom"
            height={28}
            wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }}
          />
          <Pie
            data={series.map((s) => ({ name: s.label, value: Number(rows[0]?.[`v:${s.key}`] ?? 0) }))}
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
            {series.map((s) => (
              <Cell key={s.key} fill={s.color} />
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
        <ScatterChart margin={{ ...margin, bottom: 8 }}>
          <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey={`v:${series[0]!.key}`}
            name={series[0]!.label}
            tickFormatter={axisTickLabel}
            tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--rule)" }}
          />
          <YAxis
            type="number"
            dataKey={`v:${series[1]!.key}`}
            name={series[1]!.label}
            tickFormatter={axisTickLabel}
            tick={{ fill: "var(--fg-faint)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            tickLine={false}
            axisLine={false}
            width={46}
          />
          {/* Names the point, so hovering says WHICH store this is —
              without it a scatter is a cloud of anonymous dots. */}
          {/* For a bubble the third measure sizes the dot, so one chart
              carries three dimensions; for a plain scatter every dot is
              the same size and the axis only carries the label. */}
          <ZAxis
            // Recharts narrows dataKey from the row type it inferred, which
            // cannot know about the `v:` prefix these rows carry.
            dataKey={(sizeBy === undefined ? "label" : `v:${sizeBy.key}`) as string}
            name={sizeBy?.label ?? ""}
            range={sizeBy === undefined ? [60, 60] : [40, 420]}
          />
          <Tooltip
            cursor={{ stroke: "var(--rule)" }}
            formatter={(value, name) => [tooltipValue(Number(value)), String(name)]}
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
        <LineChart data={rows} margin={margin}>
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
        <BarChart data={rows} layout="vertical" margin={{ ...margin, left: 8 }}>
          <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={axisTickLabel}
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
          <Tooltip
            formatter={(value, name) => [tooltipValue(Number(value)), String(name)]}
            cursor={{ fill: "var(--ground-lift)" }}
          />
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
        <BarChart data={toPercentRows(rows, series)} margin={margin} stackOffset="expand">
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
        <ComposedChart data={rows} margin={margin}>
          {axis}
          <YAxis
            yAxisId="right"
            orientation="right"
            tickFormatter={axisTickLabel}
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
        <RadarChart data={rows} margin={margin}>
          <PolarGrid stroke="var(--rule)" />
          <PolarAngleAxis dataKey="label" tick={{ fill: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--font-body)" }} />
          <PolarRadiusAxis tick={{ fill: "var(--fg-faint)", fontSize: 10 }} tickFormatter={axisTickLabel} />
          <Tooltip formatter={(value, name) => [tooltipValue(Number(value)), String(name)]} />
          <Legend verticalAlign="bottom" height={28} wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }} />
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
          data={series.map((s) => ({ name: s.label, size: Math.abs(Number(rows[0]?.[`v:${s.key}`] ?? 0)), fill: s.color }))}
          dataKey="size"
          isAnimationActive={false}
          stroke="var(--surface)"
        >
          <Tooltip formatter={(value, name) => [tooltipValue(Number(value)), String(name)]} />
        </Treemap>
      );

    case "funnel":
      // Steps that necessarily shrink — sessions, carts, orders paid. The
      // narrowing IS the finding, and the gap between two stages is what a
      // reader is looking for.
      return (
        <FunnelChart margin={margin}>
          <Tooltip formatter={(value, name) => [tooltipValue(Number(value)), String(name)]} />
          <Funnel
            dataKey="size"
            data={series.map((s) => ({ name: s.label, size: Number(rows[0]?.[`v:${s.key}`] ?? 0), fill: s.color }))}
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
          data={series.map((s) => ({ name: s.label, value: Number(rows[0]?.[`v:${s.key}`] ?? 0), fill: s.color }))}
          innerRadius="28%"
          outerRadius="95%"
          startAngle={90}
          endAngle={-270}
          margin={margin}
        >
          <RadialBar dataKey="value" background={{ fill: "var(--surface-sunk)" }} isAnimationActive={false} />
          <Tooltip formatter={(value, name) => [tooltipValue(Number(value)), String(name)]} />
          <Legend verticalAlign="bottom" height={28} wrapperStyle={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-dim)" }} />
        </RadialBarChart>
      );

    default:
      return (
        <BarChart data={rows} margin={margin}>
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
