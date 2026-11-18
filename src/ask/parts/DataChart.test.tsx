import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DataChart,
  MAX_SLICES,
  ScatterTip,
  axisTickLabel,
  foldSlices,
  formatAxisTick,
  formatValue,
  formatterFor,
  hasIsolatedPoint,
  hbarHeight,
  shareFormatterFor,
  sharedFormat,
  withDistinctColors,
} from "./DataChart.tsx";
import type { DataChartPoint, DataChartSeries } from "./DataChart.tsx";

// The recharts ResponsiveContainer sizing mock lives in src/test/setup.ts —
// jsdom measures everything as 0x0, so without it every assertion below
// would pass against an empty chart.


const series: DataChartSeries[] = [
  { key: "swiggy", label: "Swiggy", color: "var(--swiggy)" },
  { key: "zomato", label: "Zomato", color: "var(--zomato)" },
  { key: "dinein", label: "Dine-in", color: "var(--series-1)" },
];

const data: DataChartPoint[] = [
  { label: "Mon", values: { swiggy: 34, zomato: 18, dinein: 15 } },
  { label: "Tue", values: { swiggy: 29, zomato: 17, dinein: 13 } },
];

const lines = (root: HTMLElement) => root.querySelectorAll(".recharts-line-curve");
const bars = (root: HTMLElement) => [...root.querySelectorAll(".recharts-rectangle")];
const xsAt = (root: HTMLElement) => bars(root).map((bar) => bar.getAttribute("x"));

// --- the choice of chart, which is the whole point of `kind` --------------
//
// Everything was a stacked bar. That is right for parts of a whole and
// wrong for the commonest chart this console draws: six stores' weekly
// sales came back as six bands piled on one another, which claims their
// combined total means something and hides which store is ahead, because
// only the bottom band starts from a common baseline.

describe("choosing how to draw the numbers", () => {
  it("compares entities as lines, never as bars", () => {
    const { container } = render(
      <DataChart title="Weekly net sales" kind="line" series={series} data={data} />,
    );

    expect(lines(container)).toHaveLength(3);
    expect(bars(container)).toHaveLength(0);
  });

  it("stacks parts of a whole on a shared baseline", () => {
    const { container } = render(
      <DataChart title="Channel mix" kind="stack" series={series} data={data} />,
    );

    // Same x at a point is what "stacked" means in the output: the bands
    // sit on top of each other rather than beside each other.
    const xs = xsAt(container);
    expect(new Set(xs).size).toBe(data.length);
    expect(lines(container)).toHaveLength(0);
  });

  it("puts unrelated measures side by side instead of stacking them", () => {
    const { container } = render(
      <DataChart title="Orders and covers" kind="bar" series={series} data={data} />,
    );

    // One x per series per point — adding these bars up would mean nothing,
    // so they must not appear added up.
    const xs = xsAt(container);
    expect(new Set(xs).size).toBe(series.length * data.length);
  });

  it("stacks when a caller predates the field, so nothing silently reshapes", () => {
    const { container } = render(<DataChart title="Legacy" series={series} data={data} />);

    expect(new Set(xsAt(container)).size).toBe(data.length);
  });
});

// --- the axis, which is this component's own work -------------------------

describe("the money axis", () => {
  it("keeps an eight-digit figure short enough to read, in Indian units", () => {
    // "29,082,789" is wider than the gutter and overlapped the plot.
    // Crore and lakh, not compact "M"/"B": en-IN's own compact notation
    // abbreviates thousand as "T", which reads as trillion to half this
    // console's audience.
    expect(axisTickLabel(29_082_789)).toBe("29.1M");
    expect(axisTickLabel(745_895)).toBe("745.9k");
    expect(axisTickLabel(12_400)).toBe("12.4k");
  });

  it("spells small numbers out in full, where there is room for them", () => {
    expect(axisTickLabel(840)).toBe("840");
    expect(axisTickLabel(0)).toBe("0");
  });

  it("never leaves a trailing .0 — '30M' reads better than '30.0M'", () => {
    expect(axisTickLabel(30_000_000)).toBe("30M");
  });

  it("keeps the unit on a negative figure, and its sign", () => {
    expect(axisTickLabel(-745_895)).toBe("-745.9k");
  });
});

// --- what has to survive a colour-blind reader and a printed page ---------

describe("reading the chart without colour", () => {
  it("labels every series in the legend by text", () => {
    const { container } = render(
      <DataChart title="Where orders came from" kind="line" series={series} data={data} />,
    );

    const legend = container.querySelector("ul")!;
    for (const s of series) {
      expect(within(legend).getByText(s.label)).toBeInTheDocument();
    }
  });

  it("describes the whole chart for a screen reader, series included", () => {
    render(
      <DataChart title="Where orders came from" subLabel="last 7 days" series={series} data={data} />,
    );

    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toContain("Where orders came from");
    expect(label).toContain("last 7 days");
    expect(label).toContain("Swiggy");
  });
});

// --- degenerate input ------------------------------------------------------

describe("nothing to draw", () => {
  it("says so, rather than rendering empty axes", () => {
    render(<DataChart title="Net sales" series={series} data={[]} />);

    expect(screen.getByText("No data for this window.")).toBeInTheDocument();
  });

  it("says so when there are points but no series", () => {
    render(<DataChart title="Net sales" series={[]} data={data} />);

    expect(screen.getByText("No data for this window.")).toBeInTheDocument();
  });

  it("reads a series missing from a point as zero rather than crashing", () => {
    const gappy: DataChartPoint[] = [
      { label: "Mon", values: { swiggy: 34 } },
      { label: "Tue", values: { swiggy: 29, zomato: 17, dinein: 13 } },
    ];

    const { container } = render(
      <DataChart title="Gappy" kind="stack" series={series} data={gappy} />,
    );

    expect(bars(container).length).toBeGreaterThan(0);
  });
});

// --- negatives -------------------------------------------------------------
//
// Growth charts are the reason: "store revenue growth vs top-item growth"
// for five stores came back -7.8, -4.4, +1.8, -12.1, -20.9, and an axis
// anchored at zero drew exactly one bar — reading as "four stores were
// flat" rather than "four stores fell".

describe("negative values", () => {
  const swings: DataChartPoint[] = [
    { label: "Mon", values: { swiggy: 12, zomato: -8, dinein: 4 } },
    { label: "Tue", values: { swiggy: -3, zomato: -11, dinein: 6 } },
  ];

  it("draws a zero line when values straddle zero", () => {
    const { container } = render(
      <DataChart title="Growth" kind="bar" series={series} data={swings} />,
    );

    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(1);
  });

  it("draws no zero line when every value is positive — it would be the floor", () => {
    const { container } = render(
      <DataChart title="Growth" kind="bar" series={series} data={data} />,
    );

    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(0);
  });

  it("gives every value a shape of its own, declines included", () => {
    // The original bug was a decline vanishing: the hand-rolled SVG passed
    // a negative `height` to a <rect>, which draws nothing at all — no
    // error, just a missing bar. Recharts draws a path instead and carries
    // the sign on the attribute, so the property to pin is that every
    // value produces a shape with real extent, not that the number is
    // positive.
    const { container } = render(
      <DataChart title="Growth" kind="bar" series={series} data={swings} />,
    );

    expect(bars(container)).toHaveLength(series.length * swings.length);
    for (const bar of bars(container)) {
      expect(Math.abs(Number(bar.getAttribute("height")))).toBeGreaterThan(0);
    }
  });
});

// --- a point with no line to sit on, and a gap that is a gap ---------------
//
// Lines are drawn without dots, and a line needs two points: a one-week
// chart drew an empty plot. And a value the server left out was plotted as
// zero — a dive to the floor and back for a week that simply had no reading.

describe("single points and gaps", () => {
  const one: DataChartPoint[] = [{ label: "W1", values: { swiggy: 34, zomato: 18, dinein: 15 } }];
  const gappy: DataChartPoint[] = [
    { label: "W1", values: { swiggy: 30 } },
    { label: "W2", values: { swiggy: 32 } },
    { label: "W3", values: {} },
    { label: "W4", values: { swiggy: 35 } },
    { label: "W5", values: { swiggy: 31 } },
  ];
  const oneSeries = series.slice(0, 1);
  const moves = (d: string | null) => (d ?? "").match(/M/g)?.length ?? 0;

  for (const kind of ["line", "step", "area"] as const) {
    it(`draws a dot for a ${kind} chart with only one point`, () => {
      const { container } = render(<DataChart title="One week" kind={kind} series={series} data={one} />);

      expect(container.querySelectorAll(".recharts-dot").length).toBeGreaterThanOrEqual(series.length);
    });
  }

  it("keeps dots off a line that has neighbours to join", () => {
    const { container } = render(<DataChart title="Weekly" kind="line" series={series} data={data} />);

    expect(container.querySelectorAll(".recharts-line-dots .recharts-dot")).toHaveLength(0);
  });

  it("breaks a line at a missing value rather than diving to zero", () => {
    const { container } = render(<DataChart title="Gappy" kind="line" series={oneSeries} data={gappy} />);

    // Two separate runs of line — W1–W2 and W4–W5 — not one through zero.
    expect(moves(container.querySelector(".recharts-line-curve")!.getAttribute("d"))).toBe(2);
  });

  it("breaks an area at a missing value too", () => {
    const { container } = render(<DataChart title="Gappy" kind="area" series={oneSeries} data={gappy} />);

    expect(moves(container.querySelector(".recharts-area-curve")!.getAttribute("d"))).toBe(2);
  });

  it("leaves a point missing a coordinate off a scatter instead of pinning it to zero", () => {
    const { container } = render(
      <DataChart
        title="Orders against sales"
        kind="scatter"
        series={series.slice(0, 2)}
        data={[
          { label: "Bandra", values: { swiggy: 34, zomato: 18 } },
          { label: "BKC", values: { swiggy: 29 } },
        ]}
      />,
    );

    expect(container.querySelectorAll(".recharts-scatter-symbol")).toHaveLength(1);
  });
});

describe("hasIsolatedPoint", () => {
  it("finds a value with no neighbour on either side", () => {
    expect(hasIsolatedPoint([{ label: "a", "v:x": 1 }], "v:x")).toBe(true);
    expect(hasIsolatedPoint([{ "v:x": 1 }, { "v:x": null }, { "v:x": 2 }], "v:x")).toBe(true);
    expect(hasIsolatedPoint([{ "v:x": 1 }, { "v:x": 2 }, { "v:x": null }], "v:x")).toBe(false);
  });
});

// --- writing each number in its own unit ------------------------------------
//
// Every tooltip put a rupee sign on every value: trip counts read "42.00",
// a 0–1 share read "0.35" on an axis from 0 to 1, and a scatter tooltip
// read "label: NaN" because the point's name had been fed in as a value.

describe("formatValue", () => {
  it("writes money in rupees with Indian grouping", () => {
    expect(formatValue(1234567, "currency")).toBe("1,234,567.00");
    expect(formatValue(-1234.5, "currency")).toBe("-1,234.50");
  });

  it("writes a percentage as a percentage, and a 0–1 share as one too", () => {
    expect(formatValue(12.5, "percent")).toBe("12.5%");
    expect(formatValue(0.35, "share")).toBe("35%");
    expect(formatValue(0.1234, "share")).toBe("12.3%");
  });

  it("writes counts and plain numbers without a rupee sign", () => {
    expect(formatValue(1204, "integer")).toBe("1,204");
    expect(formatValue(1234567.891, "number")).toBe("1,234,567.89");
  });

  it("falls back to a plain grouped number when a series names no format", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(42)).not.toContain("₹");
  });

  it("never prints a negative zero", () => {
    expect(formatValue(-0, "percent")).toBe("0%");
  });
});

describe("formatAxisTick", () => {
  it("labels a share axis in percent rather than 0–1", () => {
    expect(formatAxisTick(0.25, "share")).toBe("25%");
    expect(formatAxisTick(1, "share")).toBe("100%");
  });

  it("keeps money and counts in short Indian units", () => {
    expect(formatAxisTick(29_082_789, "currency")).toBe("29.1M");
    expect(formatAxisTick(12_400, "integer")).toBe("12.4k");
    expect(formatAxisTick(50, "percent")).toBe("50%");
  });
});

describe("sharedFormat", () => {
  it("gives an axis a unit only when every series on it agrees", () => {
    expect(sharedFormat([{ ...series[0]!, format: "integer" }, { ...series[1]!, format: "integer" }])).toBe(
      "integer",
    );
    expect(sharedFormat([{ ...series[0]!, format: "integer" }, { ...series[1]!, format: "currency" }])).toBe(
      undefined,
    );
  });
});

describe("tooltip formatters", () => {
  const typed: DataChartSeries[] = [
    { key: "trips", label: "Trips", color: "var(--series-1)", format: "integer" },
    { key: "sales", label: "Net sales", color: "var(--series-2)", format: "currency" },
  ];

  it("writes each entry in its own series' format, found by key or by name", () => {
    const format = formatterFor(typed);

    expect(format(42, "Trips", { dataKey: "v:trips" })).toEqual(["42", "Trips"]);
    expect(format(1500, "Net sales", { dataKey: "v:sales" })).toEqual(["1,500.00", "Net sales"]);
    // A slice has no data key of ours, only its series' name.
    expect(format(42, "Trips", undefined)).toEqual(["42", "Trips"]);
  });

  it("shows a share chart's share, then the figure it is a share of", () => {
    const format = shareFormatterFor(typed);

    expect(format(0.35, "Net sales", { dataKey: "v:sales", payload: { "r:sales": 1234 } })).toEqual([
      "35% · 1,234.00",
      "Net sales",
    ]);
  });
});

describe("the share chart's axis", () => {
  it("reads in percent, not as a fraction", () => {
    const { container } = render(<DataChart title="Channel mix" kind="share" series={series} data={data} />);

    const ticks = [...container.querySelectorAll("svg text")].map((tick) => tick.textContent);
    expect(ticks).toContain("100%");
    expect(ticks.some((tick) => tick === "1")).toBe(false);
  });
});

describe("the scatter's hover read-out", () => {
  const measures: DataChartSeries[] = [
    { key: "orders", label: "Orders", color: "var(--series-1)", format: "integer" },
    { key: "sales", label: "Net sales", color: "var(--series-2)", format: "currency" },
  ];

  it("names the point and shows only its measures, each in its own format", () => {
    render(
      <ScatterTip active row={{ label: "Bandra", "v:orders": 1204, "v:sales": 1008942.35 }} measures={measures} />,
    );

    expect(screen.getByText("Bandra")).toBeInTheDocument();
    expect(screen.getByText("1,204")).toBeInTheDocument();
    expect(screen.getByText("1,008,942.35")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^label/i)).not.toBeInTheDocument();
  });

  it("renders nothing when nothing is hovered", () => {
    const { container } = render(<ScatterTip active={false} row={undefined} measures={measures} />);

    expect(container.firstChild).toBeNull();
  });
});

// --- legends that fit, slices that can be told apart -------------------------
//
// Recharts' legend sat in a fixed 28px box, so a legend that wrapped was cut
// off by the sheet. Every slice past the sixth came back the same slate. And
// forty hbar categories shared the same 240px as four.

describe("the legend", () => {
  it("is a wrapping list beneath the plot, naming every series", () => {
    const { container } = render(<DataChart title="Weekly" kind="line" series={series} data={data} />);

    const items = [...container.querySelectorAll("ul > li")].map((item) => item.textContent);
    expect(items).toEqual(series.map((s) => s.label));
    // Outside the SVG, where Recharts' fixed-height wrapper cannot clip it.
    expect(container.querySelector("svg ul")).toBeNull();
    expect(container.querySelector(".recharts-legend-wrapper")).toBeNull();
  });

  it("names each slice of a pie", () => {
    const { container } = render(<DataChart title="Mix" kind="pie" series={series} data={data} />);

    expect([...container.querySelectorAll("ul > li")].map((item) => item.textContent)).toEqual(
      series.map((s) => s.label),
    );
  });
});

describe("slices past the palette", () => {
  const many: DataChartSeries[] = Array.from({ length: 11 }, (_, index) => ({
    key: `c${index}`,
    label: `Channel ${index + 1}`,
    // What the server sends: six tokens, then the last one repeated.
    color: `var(--series-${Math.min(index + 1, 6)})`,
    format: "currency",
  }));
  const shares: DataChartPoint[] = [
    { label: "This month", values: Object.fromEntries(many.map((s, index) => [s.key, 1000 * (12 - index)])) },
  ];

  it("folds everything past the largest seven into one Other slice", () => {
    const slices = many.map((s) => ({ ...s, value: shares[0]!.values[s.key]! }));
    const folded = foldSlices(slices);

    expect(folded).toHaveLength(MAX_SLICES);
    expect(folded.slice(0, 7).map((slice) => slice.label)).toEqual(many.slice(0, 7).map((s) => s.label));
    expect(folded[7]).toMatchObject({ label: "Other", value: 5000 + 4000 + 3000 + 2000, format: "currency" });
  });

  it("leaves eight or fewer slices alone", () => {
    const eight = many.slice(0, 8).map((s) => ({ ...s, value: 1 }));

    expect(foldSlices(eight)).toEqual(eight);
  });

  it("draws a pie of eleven channels as eight distinctly coloured slices", () => {
    const { container } = render(<DataChart title="Mix" kind="pie" series={many} data={shares} />);

    const fills = [...container.querySelectorAll(".recharts-pie-sector path")].map((path) =>
      path.getAttribute("fill"),
    );
    expect(fills).toHaveLength(MAX_SLICES);
    expect(new Set(fills).size).toBe(MAX_SLICES);
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("never folds a funnel, whose stages are a sequence", () => {
    const { container } = render(<DataChart title="Steps" kind="funnel" series={many} data={shares} />);

    expect(container.querySelectorAll(".recharts-funnel-trapezoid")).toHaveLength(many.length);
  });

  it("recolours only a repeated colour, keeping the server's first choices", () => {
    const coloured = withDistinctColors(many);

    expect(coloured.slice(0, 6).map((s) => s.color)).toEqual(many.slice(0, 6).map((s) => s.color));
    expect(new Set(coloured.slice(0, 8).map((s) => s.color)).size).toBe(8);
    // Partner colours are never repeated, so never replaced.
    const partners = withDistinctColors(series);
    expect(partners.map((s) => s.color)).toEqual(series.map((s) => s.color));
  });
});

describe("hbarHeight", () => {
  it("gives each category room for a bar, never less than the standard height", () => {
    expect(hbarHeight(3, 1)).toBe(240);
    expect(hbarHeight(40, 1)).toBe(40 * 28);
    expect(hbarHeight(20, 2)).toBe(20 * 36);
  });
});

// --- the numbers, for a screen reader ----------------------------------------
//
// A screen reader heard "Weekly net sales. Series: Swiggy, Zomato, Dine-in."
// and not one value.

describe("the chart's accessible table", () => {
  const typed: DataChartSeries[] = [
    { key: "trips", label: "Trips", color: "var(--series-1)", format: "integer" },
    { key: "sales", label: "Net sales", color: "var(--series-2)", format: "currency" },
  ];
  const points: DataChartPoint[] = [
    { label: "Mon", values: { trips: 1204, sales: 1008942.35 } },
    { label: "Tue", values: { trips: 988 } },
  ];

  it("gives every point and series a cell, formatted like the tooltip", () => {
    render(<DataChart title="Weekly" subLabel="last 7 days" kind="line" series={typed} data={points} />);

    const table = screen.getByRole("table", { name: "Weekly, last 7 days" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Trips",
      "Net sales",
    ]);
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Mon", "Tue"]);
    const cells = within(table).getAllByRole("cell").map((cell) => cell.textContent);
    // The corner, then each row's values in order — and a gap said as one.
    expect(cells).toEqual(["", "1,204", "1,008,942.35", "988", "No data"]);
  });

  it("hides the drawing itself, so nothing is read twice", () => {
    const { container } = render(<DataChart title="Weekly" kind="line" series={typed} data={points} />);

    const svg = container.querySelector("svg.recharts-surface")!;
    expect(svg.closest("[aria-hidden='true']")).not.toBeNull();
    // Recharts' own keyboard layer would leave a focus stop inside it.
    expect(svg.getAttribute("tabindex")).toBeNull();
  });

  it("lists every slice of a pie, including the ones folded into Other", () => {
    const many: DataChartSeries[] = Array.from({ length: 10 }, (_, index) => ({
      key: `c${index}`,
      label: `Channel ${index + 1}`,
      color: "var(--series-1)",
      format: "currency",
    }));
    render(
      <DataChart
        title="Mix"
        kind="pie"
        series={many}
        data={[{ label: "This month", values: Object.fromEntries(many.map((s, index) => [s.key, 100 * (index + 1)])) }]}
      />,
    );

    const table = screen.getByRole("table", { name: "Mix" });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(10);
    expect(within(table).getByRole("columnheader").textContent).toBe("This month");
    expect(within(table).getAllByRole("cell").map((cell) => cell.textContent)).toContain("1,000.00");
  });

  it("says both the figure and its share on a share chart", () => {
    render(
      <DataChart
        title="Mix"
        kind="share"
        series={typed}
        data={[{ label: "Mon", values: { trips: 30, sales: 10 } }]}
      />,
    );

    expect(screen.getByRole("cell", { name: "30 (75%)" })).toBeInTheDocument();
  });
});
