import { describe, expect, it } from "vitest";
import { arrangeParts } from "./partLayout.ts";
import type { UIPart } from "../parts/catalog.tsx";

function tableOf(rowCount: number, subLabel?: string): UIPart {
  return {
    intent: "data-table",
    data: {
      ...(subLabel === undefined ? {} : { subLabel }),
      rows: Array.from({ length: rowCount }, (_, index) => [index]),
    },
  };
}

/** Big enough to drown an answer — the 265-row scan from the real run. */
const table: UIPart = tableOf(265, "265 rows");
const stats: UIPart = { intent: "data-stats", data: { figures: [{ label: "Median", value: "1" }] } };
const chart: UIPart = { intent: "data-chart", data: { series: [], data: [] } };
const citations: UIPart = { intent: "citations", data: { citations: [] } };

describe("arrangeParts", () => {
  it("leaves a table inline when nothing composed an answer from it", () => {
    // A ranking question's table IS the answer. Collapsing it would be
    // strictly worse than the layout this replaced.
    const layout = arrangeParts([table]);

    expect(layout.shown).toEqual([table]);
    expect(layout.evidence).toEqual([]);
  });

  it("puts a stat row first and the table it was computed from behind a disclosure", () => {
    // Wire order is table-then-stats, because run_sql fires before
    // show_stats. The answer still has to come first on screen.
    const layout = arrangeParts([table, stats]);

    expect(layout.shown).toEqual([stats]);
    expect(layout.evidence).toEqual([table]);
    expect(layout.evidenceLabel).toBe("265 rows");
  });

  it("treats a chart as a composed answer too", () => {
    const layout = arrangeParts([table, chart]);

    expect(layout.shown).toEqual([chart]);
    expect(layout.evidence).toEqual([table]);
  });

  it("keeps a part that is neither composed nor a table on the page, after the answer", () => {
    // Order, not just membership: the wire order is citations-then-stats
    // here, and the composed answer still has to read first.
    const layout = arrangeParts([citations, stats]);

    expect(layout.shown).toEqual([stats, citations]);
    expect(layout.evidence).toEqual([]);
  });

  it("names the disclosure from the server's row count, not the rows that fitted", () => {
    // `subLabel` carries `row_count`; `rows.length` is only what the wire
    // carried, so labelling from it would understate a truncated result.
    const truncated = tableOf(1000, "1000 rows · truncated");

    expect(arrangeParts([truncated, stats]).evidenceLabel).toBe("1000 rows · truncated");
  });

  it("falls back to counting rows when a part carries no sub-label", () => {
    expect(arrangeParts([tableOf(40), stats]).evidenceLabel).toBe("40 rows");
  });

  it("names how many tables there are when more than one would collapse", () => {
    expect(arrangeParts([table, table, stats]).evidenceLabel).toBe("2 tables");
  });

  it("leaves a short supporting table inline even beside a stat row", () => {
    // A real run of the median question returned two tables: the 146-row
    // scan the figures came from, and a 3-row "closest to the median"
    // lookup naming the stores the question asked for. Folding both away
    // hid half the answer behind a label reading "2 tables".
    const nearest = tableOf(3);

    const layout = arrangeParts([table, nearest, stats]);

    expect(layout.shown).toEqual([stats, nearest]);
    expect(layout.evidence).toEqual([table]);
    expect(layout.evidenceLabel).toBe("265 rows");
  });

  it("keeps a top-ten ranking inline, and collapses the scan a size above it", () => {
    // The boundary itself, both sides of it — a threshold nothing pins
    // down is a threshold that drifts.
    expect(arrangeParts([tableOf(12), stats]).evidence).toEqual([]);
    expect(arrangeParts([tableOf(13), stats]).evidence).toEqual([tableOf(13)]);
  });
});

describe("arrangeParts — drafted dashboards and widgets", () => {
  const dashboardDraft: UIPart = { intent: "data-dashboard-draft", data: { name: "V", widgets: [] } };
  const widgetDraft: UIPart = { intent: "data-widget-draft", data: { draftId: "d" } };

  it("leads with a drafted View or widget and folds the scan behind it", () => {
    for (const draft of [dashboardDraft, widgetDraft]) {
      const layout = arrangeParts([table, draft]);
      expect(layout.shown[0]).toEqual(draft);
      expect(layout.evidence).toEqual([table]);
    }
  });
});
