import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Citations, type Citation } from "./Citations.tsx";

const citations: Citation[] = [
  {
    id: "c1",
    title: "Menu policy v3",
    locator: "§2.1",
    snippet: "Combos price at the sum of parts unless flagged otherwise.",
  },
  {
    id: "c2",
    title: "Swiggy partner agreement",
    locator: "chunk 12/54",
    href: "https://example.com/doc",
  },
];

describe("Citations", () => {
  it("renders each source's title, locator and snippet", () => {
    render(<Citations title="Sources" citations={citations} />);

    expect(screen.getByText("Menu policy v3")).toBeInTheDocument();
    expect(screen.getByText("§2.1")).toBeInTheDocument();
    expect(screen.getByText(/Combos price at the sum of parts/)).toBeInTheDocument();
  });

  it("links a citation that carries an href, and doesn't invent one for the rest", () => {
    render(<Citations title="Sources" citations={citations} />);

    const link = screen.getByRole("link", { name: "Swiggy partner agreement" });
    expect(link).toHaveAttribute("href", "https://example.com/doc");
    expect(screen.queryByRole("link", { name: "Menu policy v3" })).toBeNull();
  });

  it("renders an empty state instead of an empty list when nothing was cited", () => {
    render(<Citations title="Sources" citations={[]} />);

    expect(screen.getByText("No sources cited for this answer.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
