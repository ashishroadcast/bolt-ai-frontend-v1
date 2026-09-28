import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataChart, axisTickLabel, hasIsolatedPoint } from "./DataChart.tsx";
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
    // "2,90,82,789" is wider than the gutter and overlapped the plot.
    // Crore and lakh, not compact "M"/"B": en-IN's own compact notation
    // abbreviates thousand as "T", which reads as trillion to half this
    // console's audience.
    expect(axisTickLabel(29_082_789)).toBe("2.9Cr");
    expect(axisTickLabel(745_895)).toBe("7.5L");
    expect(axisTickLabel(12_400)).toBe("12.4k");
  });

  it("spells small numbers out in full, where there is room for them", () => {
    expect(axisTickLabel(840)).toBe("840");
    expect(axisTickLabel(0)).toBe("0");
  });

  it("never leaves a trailing .0 — '3Cr' reads better than '3.0Cr'", () => {
    expect(axisTickLabel(30_000_000)).toBe("3Cr");
  });

  it("keeps the unit on a negative figure, and its sign", () => {
    expect(axisTickLabel(-745_895)).toBe("-7.5L");
  });
});

// --- what has to survive a colour-blind reader and a printed page ---------

describe("reading the chart without colour", () => {
  it("labels every series in the legend by text", () => {
    render(<DataChart title="Where orders came from" kind="line" series={series} data={data} />);

    for (const s of series) {
      expect(screen.getByText(s.label)).toBeInTheDocument();
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
