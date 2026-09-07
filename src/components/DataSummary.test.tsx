import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataSummary } from "./DataSummary.tsx";

// The summary was the last piece of an answer the model typed itself, and
// it failed in every way typing fails. Two from one screenshot: a nine-line
// paragraph where the prompt asks for a line and three bullets, and
// ₹198,466,502.74 in the prose directly above a table reading
// ₹19,84,66,502.74 — the same number, retyped into Western grouping.

describe("the reading, as parts", () => {
  it("shows the server's figure exactly as it arrived", () => {
    render(
      <DataSummary
        headline="POS is far the biggest channel"
        headlineValue="₹19,84,66,502.74"
        points={["Zomato and Swiggy together are still well behind."]}
      />,
    );

    expect(screen.getByText("₹19,84,66,502.74")).toBeInTheDocument();
    // Never re-grouped by a client that thought it was helping.
    expect(screen.queryByText(/198,466,502/)).not.toBeInTheDocument();
  });

  it("reads without a figure, which is a legitimate opening", () => {
    const { container } = render(
      <DataSummary headline="Nothing moved much this week" points={["All five stores within 3%."]} />,
    );

    expect(screen.getByText(/Nothing moved much/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/₹/);
  });

  it("shows each observation as its own item", () => {
    render(
      <DataSummary
        headline="POS leads"
        points={["First observation.", "Second observation.", "Third observation."]}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("marks the recommendation as one rather than letting it trail off", () => {
    render(<DataSummary headline="POS leads" points={["A point."]} nextStep="Check store mix." />);

    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText("Check store mix.")).toBeInTheDocument();
  });

  it("leaves the recommendation out entirely when there isn't one", () => {
    // The prompt says to omit it rather than invent a next step, so an
    // empty string must not render a bare label.
    render(<DataSummary headline="POS leads" points={["A point."]} nextStep="" />);

    expect(screen.queryByText("Next")).not.toBeInTheDocument();
  });

  it("survives a malformed part rather than taking the answer down", () => {
    const { container } = render(<DataSummary headline="" points={[]} />);

    expect(container.querySelector("section")).not.toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

// --- what the reading was drawn from ---------------------------------------
//
// A headline that makes a claim is unreadable without it. Shipped: "Brand 3
// outlet sales and top products do not move in lockstep", alone, over an
// unnamed set of outlets and an unnamed period. The reader cannot tell
// whether it covers 12 rows or 12,000, check it, or act on it.

describe("the basis of a reading", () => {
  it("shows what the finding covers", () => {
    render(
      <DataSummary
        headline="Outlet sales and top products do not move in lockstep"
        points={["Sales run ₹47.6L to ₹67.5L — a 42% spread."]}
        basis="20 Brand 3 outlets, 16-29 Aug, net sales against each outlet's biggest product."
      />,
    );

    expect(screen.getByText(/20 Brand 3 outlets, 16-29 Aug/)).toBeInTheDocument();
  });

  it("renders nothing when there is no basis to give", () => {
    const { container } = render(<DataSummary headline="Sitaphal leads" points={[]} />);

    expect(container.querySelector("[class*='basis']")).toBeNull();
  });
});
