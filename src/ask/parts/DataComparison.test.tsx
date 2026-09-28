import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataComparison, type DataComparisonRow } from "./DataComparison.tsx";

const rows: DataComparisonRow[] = [
  {
    label: "The Bombay Canteen",
    value: "₹75,69,105.48",
    share: 1,
    percentOfTotal: "48.20%",
    delta: "+₹15,69,105.48",
    deltaPercent: "+26.15%",
    direction: "up",
  },
  {
    label: "O Pedro",
    value: "₹45,49,230.71",
    share: 0.6,
    delta: "-₹4,50,769.29",
    deltaPercent: "-9.02%",
    direction: "down",
  },
  {
    label: "Veronica Lower Parel",
    value: "₹35,75,525.88",
    share: 0.47,
    delta: "₹0.00",
    deltaPercent: "0.00%",
    direction: "flat",
  },
];

const listRows = (root: HTMLElement) => [...root.querySelectorAll("li")];

// --- the figures are the server's, verbatim --------------------------------
//
// The whole reason this component exists: for as long as the model wrote
// figures into prose, the panel and the table beneath it were formatted by
// two different things and drifted apart. Nothing here may re-punctuate a
// number.

describe("what the server sent is what the reader sees", () => {
  it("prints each figure exactly as it arrived", () => {
    render(<DataComparison title="Top stores" rows={rows} />);

    expect(screen.getByText("₹75,69,105.48")).toBeInTheDocument();
    expect(screen.getByText("₹45,49,230.71")).toBeInTheDocument();
    // Indian grouping, not re-grouped into ₹7,569,105.48 by a client-side
    // formatter that thought it was helping.
    expect(screen.queryByText(/7,569,105/)).not.toBeInTheDocument();
  });

  it("prints the movement exactly as it arrived, sign included", () => {
    render(<DataComparison title="Top stores" rows={rows} />);

    expect(screen.getByText("+₹15,69,105.48")).toBeInTheDocument();
    expect(screen.getByText("-₹4,50,769.29")).toBeInTheDocument();
    expect(screen.getByText("+26.15%")).toBeInTheDocument();
  });

  it("keeps the server's order — the ranking is the answer", () => {
    render(<DataComparison title="Top stores" rows={rows} />);

    const labels = listRows(document.body).map(
      (row) => row.textContent?.match(/[A-Z][A-Za-z' ]+/)?.[0]?.trim() ?? "",
    );
    expect(labels[0]).toBe("The Bombay Canteen");
    expect(labels[1]).toBe("O Pedro");
  });
});

// --- direction survives losing the colour ----------------------------------

describe("reading a movement without colour", () => {
  it("marks each row's direction as data, not as a colour alone", () => {
    const { container } = render(<DataComparison title="Top stores" rows={rows} />);

    const directions = [...container.querySelectorAll("[data-direction]")].map((chip) =>
      chip.getAttribute("data-direction"),
    );
    expect(directions).toEqual(["up", "down", "flat"]);
  });

  it("draws an arrow beside the number, so form carries it too", () => {
    const { container } = render(<DataComparison title="Top stores" rows={rows} />);

    for (const chip of container.querySelectorAll("[data-direction]")) {
      expect(chip.querySelector("svg")).not.toBeNull();
    }
  });

  it("says the movement in words for a screen reader", () => {
    render(<DataComparison title="Top stores" rows={rows} />);

    const chip = screen.getByLabelText(/^up \+₹15,69,105\.48, \+26\.15%$/);
    expect(chip).toBeInTheDocument();
  });
});

// --- the bar is a real proportion ------------------------------------------

describe("the proportional bar", () => {
  it("scales each row to its share of the leader", () => {
    const { container } = render(<DataComparison title="Top stores" rows={rows} />);

    const widths = listRows(container).map(
      (row) => (row.firstElementChild as HTMLElement).style.width,
    );
    expect(widths[0]).toBe("100%");
    expect(widths[1]).toBe("60%");
  });

  it("clamps a share outside 0–1 rather than overflowing the sheet", () => {
    const { container } = render(
      <DataComparison
        title="Odd"
        rows={[
          { label: "Over", value: "₹1.00", share: 4 },
          { label: "Under", value: "-₹1.00", share: -2 },
        ]}
      />,
    );

    const widths = listRows(container).map(
      (row) => (row.firstElementChild as HTMLElement).style.width,
    );
    expect(widths).toEqual(["100%", "0%"]);
  });
});

// --- a comparison with no baseline is not a broken one ---------------------

describe("no baseline", () => {
  it("shows the figures alone, with no empty movement chip", () => {
    const { container } = render(
      <DataComparison
        title="Top stores"
        rows={[{ label: "O Pedro", value: "₹45,49,230.71", share: 1 }]}
      />,
    );

    expect(screen.getByText("₹45,49,230.71")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-direction]")).toHaveLength(0);
  });

  it("omits the percentage on its own when the baseline was zero", () => {
    // The absolute movement is real and stays; only the percentage — which
    // would be infinite — is left out.
    const { container } = render(
      <DataComparison
        title="New"
        rows={[
          { label: "Just Opened", value: "₹1,20,000.00", share: 1, delta: "+₹1,20,000.00", direction: "up" },
        ]}
      />,
    );

    const chip = container.querySelector("[data-direction]");
    expect(chip).not.toBeNull();
    expect(within(chip as HTMLElement).getByText("+₹1,20,000.00")).toBeInTheDocument();
    expect(chip?.textContent).not.toMatch(/%/);
  });
});

describe("nothing to compare", () => {
  it("says so rather than rendering an empty list", () => {
    render(<DataComparison title="Top stores" rows={[]} />);

    expect(screen.getByText("Nothing to compare here.")).toBeInTheDocument();
  });
});


// --- the share of the whole ------------------------------------------------
//
// "may be show in pct of total sales as well" — and it is the figure that
// turns a ranking into an answer: sixth place means nothing until you know
// whether it is 11% of the business or 0.4% of it.

describe("share of the total", () => {
  it("shows each row's share beside its figure", () => {
    render(<DataComparison title="Top stores" rows={rows} />);

    expect(screen.getByText("48.20%")).toBeInTheDocument();
  });

  it("leaves the column empty rather than inventing a share", () => {
    // Absent whenever the measure cannot carry one honestly — a negative
    // in the set, or a zero total. The column still holds its width so the
    // chips beyond it stay aligned.
    const { container } = render(
      <DataComparison title="Movement" rows={[{ label: "Down", value: "-₹1.00", share: 0 }]} />,
    );

    expect(container.textContent).not.toMatch(/%/);
  });
});

// --- a name that does not fit --------------------------------------------

describe("a label cut short on a narrow sheet", () => {
  it("still offers the whole name on hover", () => {
    render(<DataComparison title="Top stores" rows={rows} />);

    expect(screen.getByText("Veronica Lower Parel").getAttribute("title")).toBe("Veronica Lower Parel");
  });
});
