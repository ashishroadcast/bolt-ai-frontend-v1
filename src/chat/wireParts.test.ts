import { describe, expect, it } from "vitest";
import { toUIPart } from "./wireParts.ts";

/** The exact wire shape a real run produced (captured 2026-08-28): a
 * Decimal column arrives as a *string*, because `intents._json_safe`
 * stringifies Decimal on purpose to avoid rounding money through float. */
const CAPTURED_TABLE = {
  columns: ["store_id", "store_name", "net_sales_sum"],
  rows: [
    [280, "The Bombay Canteen", "29082789.84"],
    [281, "O Pedro", "18492463.05"],
  ],
  row_count: 2,
  truncated: false,
};

function tableProps(data: Record<string, unknown>) {
  return toUIPart("data-table", data).data as {
    columns: { key: string; header: string; type?: string }[];
    rows: Record<string, string | number>[];
    subLabel: string;
  };
}

describe("toUIPart / data-table", () => {
  it("types a string-encoded Decimal column as numeric, which is what right-aligns it", () => {
    const props = tableProps(CAPTURED_TABLE);
    const byKey = Object.fromEntries(props.columns.map((column) => [column.key, column.type]));

    expect(byKey.net_sales_sum).toBe("number");
    expect(byKey.store_id).toBe("number");
    expect(byKey.store_name).toBeUndefined();
  });

  it("groups a decimal measure but leaves an integer id exactly as it arrived", () => {
    const props = tableProps({
      columns: ["store_id", "net_sales_sum"],
      rows: [[12345, "29082789.84"]],
      row_count: 1,
    });

    // 12,345 would state something false about an identifier.
    expect(props.rows[0]!.store_id).toBe(12345);
    expect(props.rows[0]!.net_sales_sum).toBe("2,90,82,789.84");
  });

  it("rounds a plain measure to two decimals rather than showing float noise", () => {
    // `distance_from_median` arrived as 44.71000000007916 — sixteen digits
    // of false precision on a figure meaning "about forty-five rupees".
    // Money is unaffected: a currency column takes the exact-2dp path in
    // formatByKind, so nothing that has to reconcile is rounded here.
    const props = tableProps({
      columns: ["distance_from_median"],
      rows: [["44.71000000007916"]],
      row_count: 1,
    });

    expect(props.rows[0]!.distance_from_median).toBe("44.71");
  });

  it("leaves a bare integer exactly as it arrived", () => {
    // These are overwhelmingly identifiers, and grouping an id into
    // "12,345" states something false about it.
    const props = tableProps({ columns: ["store_id"], rows: [["12345"]], row_count: 1 });

    expect(props.rows[0]!.store_id).toBe("12345");
  });

  it("writes a column name the way a person would", () => {
    const props = tableProps({
      columns: ["total_net_sales", "store_id", "mom_growth_pct"],
      rows: [["1", "2", "3"]],
      row_count: 1,
    });

    expect(props.columns.map((c) => c.header)).toEqual([
      "Total net sales",
      "Store ID",
      "Month-on-month growth %",
    ]);
  });

  it("leaves a mixed column alone: one label is enough to make it not a number", () => {
    const props = tableProps({
      columns: ["value"],
      rows: [["10.5"], ["n/a"]],
      row_count: 2,
    });

    expect(props.columns[0]!.type).toBeUndefined();
    expect(props.rows[1]!.value).toBe("n/a");
  });

  it("does not call an all-blank column numeric on a vacuous truth", () => {
    const props = tableProps({ columns: ["note"], rows: [[null], [""]], row_count: 2 });
    expect(props.columns[0]!.type).toBeUndefined();
  });

  it("says how many rows there are, and when the result was cut short", () => {
    expect(tableProps(CAPTURED_TABLE).subLabel).toBe("2 rows");
    expect(tableProps({ columns: ["n"], rows: [[1]], row_count: 340, truncated: true }).subLabel).toBe(
      "340 rows · truncated",
    );
  });
});

describe("currency and percent columns", () => {
  // The server now says what a column holds (app.stream.columns), because a
  // prompt could not: one run wrote "₹944,220.66" and the next
  // "Rs 1,012,406.24", and a growth column reached the screen as
  // 2,119.9706005879884000.
  function table(kinds: string[], rows: unknown[][]) {
    return toUIPart("data-table", {
      columns: ["store_name", "total_net_sales", "mom_growth_pct"],
      column_kinds: kinds,
      rows,
      row_count: rows.length,
      truncated: false,
    }).data as { rows: Record<string, unknown>[]; columns: { type?: string }[] };
  }

  it("puts a rupee sign and exactly two decimals on a currency column", () => {
    const out = table(
      ["text", "currency", "percent"],
      [["Bombay Canteen", "12443248.6", "12.3456"]],
    );

    expect(out.rows[0].total_net_sales).toBe("₹1,24,43,248.60");
  });

  it("caps a percentage at two decimals rather than sixteen", () => {
    const out = table(
      ["text", "currency", "percent"],
      [["Panvel", "142.86", "2119.9706005879884"]],
    );

    expect(out.rows[0].mom_growth_pct).toBe("2,119.97%");
  });

  it("keeps paise — a currency total that loses them stops reconciling", () => {
    // Intl's own style:"currency" defaults to maximumFractionDigits 0 here,
    // which would render this as ₹9,44,221.
    const out = table(["text", "currency", "percent"], [["Sinhgad", "944220.66", "0"]]);

    expect(out.rows[0].total_net_sales).toBe("₹9,44,220.66");
  });

  it("right-aligns a money column even when its values arrive as strings", () => {
    const out = table(["text", "currency", "percent"], [["Sinhgad", "944220.66", "0"]]);

    expect(out.columns[1].type).toBe("number");
  });

  it("adds no symbol at all when the server sent no kinds", () => {
    // An older part, or one from a path that does not classify: a wrong
    // symbol is worse than none.
    const out = toUIPart("data-table", {
      columns: ["total_net_sales"],
      rows: [["944220.66"]],
      row_count: 1,
      truncated: false,
    }).data as { rows: Record<string, unknown>[] };

    expect(out.rows[0].total_net_sales).toBe("9,44,220.66");
  });

  it("leaves an id column alone", () => {
    const out = toUIPart("data-table", {
      columns: ["store_id"],
      column_kinds: ["text"],
      rows: [["280"]],
      row_count: 1,
      truncated: false,
    }).data as { rows: Record<string, unknown>[] };

    // Never "₹280", never "2,80".
    expect(out.rows[0].store_id).toBe("280");
  });
});

describe("toUIPart / data-stats", () => {
  it("carries the server's already-rendered figures through untouched", () => {
    const part = toUIPart("data-stats", {
      title: "Net sales per store",
      subLabel: "last 14 days · over 265 values",
      figures: [
        { label: "Median net sales", value: "₹9,44,220.66" },
        { label: "IQR net sales", value: "₹9,62,279.45" },
      ],
    });

    expect(part.intent).toBe("data-stats");
    expect(part.data).toEqual({
      title: "Net sales per store",
      subLabel: "last 14 days · over 265 values",
      figures: [
        { label: "Median net sales", value: "₹9,44,220.66" },
        { label: "IQR net sales", value: "₹9,62,279.45" },
      ],
    });
  });

  it("drops a figure missing either half rather than rendering a blank tile", () => {
    const data = toUIPart("data-stats", {
      title: "x",
      figures: [{ label: "Median" }, { value: "12" }, null, { label: "Q1", value: "₹5.00" }],
    }).data as { figures: unknown[] };

    expect(data.figures).toEqual([{ label: "Q1", value: "₹5.00" }]);
  });

  it("names the part honestly when the server sent no title", () => {
    const data = toUIPart("data-stats", { figures: [] }).data as { title: string };

    expect(data.title).toBe("Summary");
  });
});
