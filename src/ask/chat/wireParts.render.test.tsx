import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUIPart } from "../parts/catalog.tsx";
import { toUIPart } from "./wireParts.ts";

/**
 * A wire table all the way to the cell a reader sees.
 *
 * The adapter's own tests (`wireParts.test.ts`) pin the props it hands
 * over, and that was not enough: an id the adapter left "exactly as it
 * arrived" was a JS number, and DataTable's formatter groups every number
 * it is handed, so the screen said "12,345" while the adapter's test said
 * 12345. These render the real component and read the text.
 */
function renderWireTable(data: Record<string, unknown>) {
  const part = toUIPart("data-table", data);
  if (part === null) throw new Error("a table part is never dropped");
  return render(renderUIPart(part));
}

function cellTexts(): string[] {
  return screen.getAllByRole("cell").map((cell) => cell.textContent ?? "");
}

describe("a wire table, rendered", () => {
  it("writes ids, years and phone numbers without digit grouping", () => {
    renderWireTable({
      columns: ["store_id", "year", "phone"],
      column_kinds: ["text", "number", "number"],
      rows: [[12345, 2026, 9876543210]],
      row_count: 1,
    });

    expect(cellTexts()).toEqual(["12345", "2026", "9876543210"]);
  });

  it("groups a count, a measure and money", () => {
    renderWireTable({
      columns: ["order_count", "distance_km", "net_sales"],
      column_kinds: ["integer", "number", "currency"],
      rows: [[12345, "12345.25", "1234567.5"]],
      row_count: 1,
    });

    expect(cellTexts()).toEqual(["12,345", "12,345.25", "₹12,34,567.50"]);
  });

  it("leaves an integer column from an older part, which sent no kinds, ungrouped", () => {
    renderWireTable({ columns: ["store_id"], rows: [[280], [12345]], row_count: 2 });

    expect(cellTexts()).toEqual(["280", "12345"]);
  });

  it("shows each of two same-named columns' own values, under headers that differ", () => {
    renderWireTable({
      columns: ["name", "name"],
      rows: [["Bandra", "Asha"], ["Powai", "Ravi"]],
      row_count: 2,
    });

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Name (2)",
    ]);
    expect(cellTexts()).toEqual(["Bandra", "Asha", "Powai", "Ravi"]);
  });

  it("writes zoned and unzoned timestamps in one shape", () => {
    renderWireTable({
      columns: ["last_ping", "scheduled_at"],
      rows: [["2026-01-09T04:30:00Z", "2026-01-09T10:00:00"]],
      row_count: 1,
    });

    expect(cellTexts()).toEqual(["2026-01-09 10:00 IST", "2026-01-09 10:00"]);
  });

  it("counts the rows in its header the way its pager does", () => {
    renderWireTable({
      columns: ["store_name"],
      rows: Array.from({ length: 11 }, (_, index) => [`Store ${index}`]),
      row_count: 12345,
    });

    expect(screen.getByText("12,345 rows")).toBeInTheDocument();
  });
});
