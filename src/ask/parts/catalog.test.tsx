import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUIPart } from "./catalog.tsx";
import type { DataTableProps } from "./DataTable.tsx";
import type { DataChartProps } from "./DataChart.tsx";
import type { CitationsProps } from "./Citations.tsx";

describe("renderUIPart — the intent-to-component catalog", () => {
  it("routes a data-table intent to DataTable", () => {
    const data: DataTableProps = {
      title: "Top items",
      columns: [{ key: "item", header: "Item" }],
      rows: [{ item: "Chicken Biryani" }],
    };

    render(renderUIPart({ intent: "data-table", data }));

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Chicken Biryani")).toBeInTheDocument();
  });

  it("routes a data-chart intent to DataChart", () => {
    const data: DataChartProps = {
      title: "Where orders came from",
      series: [{ key: "swiggy", label: "Swiggy", color: "var(--swiggy)" }],
      data: [{ label: "Mon", values: { swiggy: 10 } }],
    };

    render(renderUIPart({ intent: "data-chart", data }));

    expect(document.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Swiggy")).toBeInTheDocument();
  });

  it("routes a citations intent to Citations", () => {
    const data: CitationsProps = {
      title: "Sources",
      citations: [{ id: "c1", title: "Menu policy v3" }],
    };

    render(renderUIPart({ intent: "citations", data }));

    expect(screen.getByText("Menu policy v3")).toBeInTheDocument();
  });

  it("falls back to something legible for an intent this bundle doesn't know, instead of throwing", () => {
    const unknown = { intent: "a-future-intent-not-yet-built", data: { anything: "goes" } };

    // The failure mode this guards against is exactly this: a future intent
    // reaching the console and taking the whole thread down with it.
    expect(() => render(renderUIPart(unknown))).not.toThrow();

    // Not just "didn't crash" — the fallback names the intent it couldn't
    // render (it shows up twice: the sub-label and the body copy), so the
    // operator sees something honest rather than a blank.
    expect(screen.getByText("Unsupported response")).toBeInTheDocument();
    expect(screen.getAllByText(/a-future-intent-not-yet-built/).length).toBeGreaterThan(0);
  });
});
