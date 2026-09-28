import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveThought } from "./LiveThought.tsx";

describe("reasoning in flight", () => {
  it("shows nothing at all before the first thought arrives", () => {
    // An empty bordered block sitting under the rail for nine seconds is
    // worse than no block: it reads as something that failed to load.
    const { container } = render(<LiveThought text="" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when the stream is only whitespace", () => {
    // Braces, not a quoted attribute: JSX does not process escapes inside
    // a string attribute, so text="\n" would pass a literal backslash.
    const { container } = render(<LiveThought text={"   \n  "} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows a short thought whole, with no elision", () => {
    render(<LiveThought text="Checking which stores traded last week." />);

    expect(screen.getByText(/Checking which stores traded last week\./)).toBeInTheDocument();
    expect(screen.queryByText(/…/)).not.toBeInTheDocument();
  });

  it("keeps only the tail of a long stream, so the page does not grow", () => {
    // A run's full reasoning is thousands of characters and nobody reads
    // it top to bottom; what it is for is evidence of motion. The whole of
    // it is still in the run trace behind the Inspector.
    //
    // The bound is asserted as "does not grow with the input" rather than
    // against a character count, so it keeps meaning what it means when
    // the window is resized — which it has been once already.
    const short = `${"word ".repeat(200)}tail words at the very end`;
    const long = `${"word ".repeat(2000)}tail words at the very end`;

    const shownFor = (text: string) =>
      (render(<LiveThought text={text} />).container.textContent ?? "").length;

    const shortLength = shownFor(short);
    const longLength = shownFor(long);

    expect(longLength).toBe(shortLength);
    expect(longLength).toBeLessThan(long.length / 4);
  });

  it("never begins mid-word", () => {
    // Sliced to a fixed length the tail starts on whatever character
    // landed there, which reads as corruption rather than as a thought
    // still being written.
    const long = `${"filler ".repeat(60)}Bombay Canteen leads on net sales`;

    const { container } = render(<LiveThought text={long} />);

    const shown = (container.textContent ?? "").replace(/^…\s*/, "");
    expect(shown.startsWith("filler")).toBe(true);
  });

  it("carries a cursor, so a reader can see more is coming", () => {
    const { container } = render(<LiveThought text="Working on it" />);

    expect(container.querySelector("span[aria-hidden='true']")).not.toBeNull();
  });

  it("names itself as progress, not as the answer", () => {
    render(<LiveThought text="Working on it" />);

    expect(screen.getByRole("group", { name: "What the agent is working on" })).toBeInTheDocument();
  });

  it("is not read aloud as it streams", () => {
    // As a live region, every streamed chunk of reasoning was announced
    // for the whole run, over whatever else the reader was doing.
    render(<LiveThought text="Working on it" />);

    const group = screen.getByRole("group", { name: "What the agent is working on" });
    expect(group).toHaveAttribute("aria-live", "off");
    expect(screen.getByText(/Working on it/)).not.toHaveAttribute("aria-live");
  });
});
