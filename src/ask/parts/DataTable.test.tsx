import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn, type DataTableRow } from "./DataTable.tsx";
import tableStyles from "./DataTable.module.css";

const columns: DataTableColumn[] = [
  { key: "item", header: "Item" },
  { key: "orders", header: "Orders", type: "number" },
  { key: "netSales", header: "Net sales", type: "currency" },
  { key: "share", header: "Share", type: "share" },
];

const rows: DataTableRow[] = [
  { item: "Chicken Biryani", orders: 486, netSales: 142310, share: 28.4 },
  { item: "Butter Chicken", orders: 301, netSales: 98420, share: 19.6 },
  { item: "Gulab Jamun (2 pc)", orders: 352, netSales: 31680, share: 6.3 },
];

/** A result long enough to page, with a descending share column so the
 * leader is unambiguously on the first page. */
function manyRows(count: number): DataTableRow[] {
  return Array.from({ length: count }, (_, index) => ({
    item: `Store ${index + 1}`,
    orders: count - index,
    netSales: (count - index) * 1000,
    share: (count - index) / count * 100,
  }));
}

describe("DataTable", () => {
  it("renders every column header and row value, formatted by type", () => {
    render(<DataTable title="Top items" columns={columns} rows={rows} />);

    expect(screen.getByRole("columnheader", { name: "Item" })).toBeInTheDocument();
    expect(screen.getByText("Chicken Biryani")).toBeInTheDocument();
    // Indian digit grouping and an INR sign — proves currency formatting ran,
    // not just that the raw number was passed through.
    expect(screen.getByText("₹1,42,310")).toBeInTheDocument();
    expect(screen.getByText("28.4%")).toBeInTheDocument();
  });

  it("sizes the share bar relative to the largest value in its own column", () => {
    render(<DataTable title="Top items" columns={columns} rows={rows} />);

    const bars = document.querySelectorAll(`.${tableStyles.sparkbarFill}`);
    expect(bars).toHaveLength(3);
    // Chicken Biryani (28.4) is the leader in this data: a full-width bar.
    expect((bars[0] as HTMLElement).style.width).toBe("100%");
    // Gulab Jamun (6.3) is the smallest: a visibly short bar, not empty and
    // not full — proves the width is actually relative, not a constant.
    const smallestWidth = Number.parseFloat((bars[2] as HTMLElement).style.width);
    expect(smallestWidth).toBeGreaterThan(0);
    expect(smallestWidth).toBeLessThan(100);
  });

  it("renders a real empty state for a zero-row result, not an empty tbody", () => {
    render(<DataTable title="Top items" columns={columns} rows={[]} emptyMessage="No rows for this window." />);

    expect(screen.getByText("No rows for this window.")).toBeInTheDocument();
    // Exactly one row carries the message — the table isn't just silently
    // missing its data rows.
    expect(screen.getAllByRole("row")).toHaveLength(2); // header row + the empty-state row
  });

  it("keeps the table inside its own horizontally-scrolling container", () => {
    const { container } = render(<DataTable title="Wide" columns={columns} rows={rows} />);

    const wrap = container.querySelector(`.${tableStyles.tableWrap}`);
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector("table")).not.toBeNull();
  });

  it("marks numeric cells with the class the stylesheet gives tabular figures", () => {
    render(<DataTable title="Top items" columns={columns} rows={rows} />);

    const cell = screen.getByText("486");
    expect(cell.className).toContain(tableStyles.num);

    // The class assertion alone can't tell you the rule still exists in the
    // stylesheet — read the actual CSS so this fails if tabular-nums is
    // ever dropped from .num, not just if the class stops being applied.
    const css = readFileSync(join(import.meta.dirname, "DataTable.module.css"), "utf8");
    const numRule = css.slice(css.indexOf(".num {"), css.indexOf(".num {") + 200);
    expect(numRule).toContain("font-variant-numeric: tabular-nums");
  });
  it("renders every row when there are few enough to read straight through", () => {
    render(<DataTable title="Top items" columns={columns} rows={rows} />);

    // Three rows plus a header — and no page controls at all: paging an
    // answer that never needed it is its own kind of noise.
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("shows only ten rows of a long result, and says how much of it that is", () => {
    // Saurabh, on a 267-row answer: "i am doing endless scrolling".
    render(<DataTable title="Stores" columns={columns} rows={manyRows(267)} />);

    expect(screen.getAllByRole("row")).toHaveLength(11); // header + 10
    expect(screen.getByText("Store 1")).toBeInTheDocument();
    expect(screen.queryByText("Store 11")).not.toBeInTheDocument();
    expect(screen.getByText("1–10 of 267")).toBeInTheDocument();
    expect(screen.getByText("1 / 27")).toBeInTheDocument();
  });

  it("moves to the next page of rows when Next is clicked", () => {
    render(<DataTable title="Stores" columns={columns} rows={manyRows(267)} />);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.getByText("Store 11")).toBeInTheDocument();
    expect(screen.queryByText("Store 10")).not.toBeInTheDocument();
    expect(screen.getByText("11–20 of 267")).toBeInTheDocument();
  });

  it("cannot page off either end of the result", () => {
    render(<DataTable title="Stores" columns={columns} rows={manyRows(12)} />);

    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    // 12 rows is two pages: the last one holds the remaining two.
    expect(screen.getByText("11–12 of 12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("scales the share bar against the whole result, not against the page on screen", () => {
    // The leader lives on page one. If the bar rescaled per page, the
    // largest value on page two would draw full-width and claim to be the
    // biggest number in a column it is nowhere near the top of.
    render(<DataTable title="Stores" columns={columns} rows={manyRows(20)} />);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    const bars = document.querySelectorAll(`.${tableStyles.sparkbarFill}`);
    expect(bars).toHaveLength(10);
    const widest = Math.max(...[...bars].map((bar) => Number.parseFloat((bar as HTMLElement).style.width)));
    expect(widest).toBeLessThan(100);
  });
});

