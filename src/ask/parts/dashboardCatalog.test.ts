import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  METRICS,
  VISUALIZATION_LABELS,
  WIDGET_SIZES,
  metricTitle,
  sizeLabel,
  timeRangeLabel,
  widgetGridSize,
  widgetTitle,
} from "./dashboardCatalog.ts";

describe("dashboardCatalog", () => {
  it("falls back from the widget's own title to the metric's, then to the key", () => {
    expect(widgetTitle({ metricKey: "eta.trips_completed", visualization: "kpi", title: "Trips" })).toBe(
      "Trips",
    );
    expect(widgetTitle({ metricKey: "eta.trips_completed", visualization: "kpi" })).toBe(
      "Trips Completed",
    );
    expect(widgetTitle({ metricKey: "eta.trips_completed", visualization: "kpi", title: "  " })).toBe(
      "Trips Completed",
    );
    // A metric this bundle predates still reads as something.
    expect(metricTitle("fleet.vehicle_inspections")).toBe("Vehicle inspections");
  });

  it("sizes a widget from its hint, else from the metric's default", () => {
    expect(widgetGridSize({ metricKey: "eta.trips_completed", visualization: "kpi", size: "wide" })).toEqual(
      { w: 8, h: 4 },
    );
    expect(widgetGridSize({ metricKey: "eta.trips_completed_daily", visualization: "line" })).toEqual({
      w: 8,
      h: 4,
    });
    expect(widgetGridSize({ metricKey: "unknown.metric", visualization: "kpi" })).toEqual({ w: 3, h: 2 });
    expect(sizeLabel({ metricKey: "x", visualization: "kpi" })).toBe("Default size");
    expect(sizeLabel({ metricKey: "x", visualization: "kpi", size: "full" })).toBe("Full width");
  });

  it("reads a time range as a phrase, and an absent one as the metric's default", () => {
    expect(
      timeRangeLabel({
        metricKey: "eta.trips_completed",
        visualization: "kpi",
        params: { timeRange: { preset: "last_30d" } },
      }),
    ).toBe("Last 30 days");
    expect(
      timeRangeLabel({
        metricKey: "eta.trips_completed",
        visualization: "kpi",
        params: { timeRange: { preset: "custom", from: "2026-09-01", to: "2026-09-15" } },
      }),
    ).toBe("2026-09-01 – 2026-09-15");
    expect(timeRangeLabel({ metricKey: "report.alerts_by_type", visualization: "table" })).toBe("Today");
    // A live breakdown has no time range at all, and says nothing about one.
    expect(timeRangeLabel({ metricKey: "fleet.device_status_breakdown", visualization: "donut" })).toBeNull();
  });
});

/**
 * The hand-copied table against the contract it was copied from — whenever
 * that file is checked out beside this repo (it is, in the bolt-ai workspace;
 * a CI checkout of this repo alone skips it).
 */
const CONTRACT = resolve(process.cwd(), "../dashboards-contract/catalog.v1.json");

describe.skipIf(!existsSync(CONTRACT))("dashboardCatalog vs catalog.v1.json", () => {
  interface ContractMetric {
    key: string;
    title: string;
    defaultSize: { w: number; h: number };
    params: Record<string, { kind: string; default?: unknown }>;
  }
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8")) as {
    sizes: Record<string, { w: number; h: number }>;
    visualizations: string[];
    metrics: ContractMetric[];
  };

  it("has the same sizes", () => {
    expect(WIDGET_SIZES).toEqual(contract.sizes);
  });

  it("names every visualization", () => {
    expect(Object.keys(VISUALIZATION_LABELS).sort()).toEqual([...contract.visualizations].sort());
  });

  it("has every metric, with the same title, default size and default time range", () => {
    expect(Object.keys(METRICS).sort()).toEqual(contract.metrics.map((metric) => metric.key).sort());
    for (const metric of contract.metrics) {
      const ours = METRICS[metric.key]!;
      expect(ours.title).toBe(metric.title);
      expect(ours.defaultSize).toEqual(metric.defaultSize);
      expect(ours.defaultTimeRange).toBe(metric.params.timeRange?.default);
    }
  });
});
