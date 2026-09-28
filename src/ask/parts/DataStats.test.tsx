import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataStats } from "./DataStats.tsx";

const figures = [
  { label: "Median net sales", value: "₹9,44,220.66" },
  { label: "IQR net sales", value: "₹9,62,279.45" },
];

describe("DataStats", () => {
  it("shows every figure as a label/value pair, in order", () => {
    render(
      <DataStats title="Net sales per store" subLabel="last 14 days" figures={figures} />,
    );

    // Read as pairs, not as four unrelated fragments — the reason this is
    // a <dl> rather than a grid of divs.
    const terms = screen.getAllByRole("term").map((node) => node.textContent);
    const definitions = screen.getAllByRole("definition").map((node) => node.textContent);
    expect(terms).toEqual(["Median net sales", "IQR net sales"]);
    expect(definitions).toEqual(["₹9,44,220.66", "₹9,62,279.45"]);
  });

  it("renders the value exactly as given, never reformatting it", () => {
    // agent-service/app/stream/columns.py is the only formatter in this
    // system, and the model's own prose is rendered through it. A second
    // pass here is how a tile and the sentence above it start disagreeing.
    render(<DataStats title="x" figures={[{ label: "Total", value: "₹1,01,240.62" }]} />);

    expect(screen.getByRole("definition")).toHaveTextContent("₹1,01,240.62");
  });

  it("names the window in the sheet header rather than in a figure", () => {
    render(<DataStats title="Net sales per store" subLabel="last 14 days" figures={figures} />);

    expect(screen.getByText("last 14 days")).toBeInTheDocument();
    expect(screen.getByText("Net sales per store")).toBeInTheDocument();
  });

  it("says so plainly when there is nothing to show", () => {
    render(<DataStats title="Net sales per store" figures={[]} />);

    expect(screen.getByText("No figures for this window.")).toBeInTheDocument();
    expect(screen.queryAllByRole("definition")).toHaveLength(0);
  });

  it("keeps a label or figure cut short on a narrow tile readable in full on hover", () => {
    render(
      <DataStats
        title="Net sales per store"
        figures={[{ label: "Median net sales per store per month", value: "₹9,44,220.66" }]}
      />,
    );

    expect(screen.getByRole("term").getAttribute("title")).toBe("Median net sales per store per month");
    expect(screen.getByRole("definition").getAttribute("title")).toBe("₹9,44,220.66");
  });
});
