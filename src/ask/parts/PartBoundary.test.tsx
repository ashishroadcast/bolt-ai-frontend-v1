import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIPart } from "./catalog.tsx";
import { PartBoundary } from "./PartBoundary.tsx";

function Explodes(): never {
  throw new Error("series[1] is undefined");
}

describe("PartBoundary", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React reports a caught render error through console.error as well.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("renders a small sheet in place of a part that throws, and logs why", () => {
    const part: UIPart = { intent: "data-chart", data: {} };
    render(
      <>
        <PartBoundary part={part}>
          <Explodes />
        </PartBoundary>
        <p>The rest of the answer.</p>
      </>,
    );

    expect(screen.getByText(/Couldn.t display this part of the answer\./)).toBeInTheDocument();
    expect(screen.getByText("data-chart")).toBeInTheDocument();
    expect(screen.getByText("The rest of the answer.")).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'Ask could not render a "data-chart" part.',
      expect.any(Error),
      expect.any(String),
    );
  });

  it("tries again when handed a different part", () => {
    // A live run re-arranges its parts as they arrive, so the boundary at
    // one position can come to hold a part that renders fine.
    const broken: UIPart = { intent: "data-chart", data: {} };
    const { rerender } = render(
      <PartBoundary part={broken}>
        <Explodes />
      </PartBoundary>,
    );
    expect(screen.getByText(/Couldn.t display/)).toBeInTheDocument();

    rerender(
      <PartBoundary part={{ intent: "data-table", data: {} }}>
        <p>A table</p>
      </PartBoundary>,
    );

    expect(screen.getByText("A table")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t display/)).not.toBeInTheDocument();
  });
});
