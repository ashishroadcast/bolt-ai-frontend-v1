import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnswerText } from "./AnswerText.tsx";

describe("AnswerText", () => {
  it("renders the agent's '- ' lines as a real list", () => {
    const { container } = render(
      <AnswerText text={"Top three stores:\n- Bandra\n- Lower Parel\n- BKC"} />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Bandra", "Lower Parel", "BKC"]);
    expect(container.querySelector("ul")).not.toBeNull();
    // A list item that still carries its own marker means the text was
    // printed rather than parsed — the bug this component replaces.
    expect(items[0]!.textContent).not.toContain("-");
  });

  it("renders blank-line-separated prose as separate paragraphs", () => {
    const { container } = render(
      <AnswerText text={"Bandra led the month.\n\nThat is a third of the total."} />,
    );

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.textContent).toBe("Bandra led the month.");
  });

  it("renders **bold** as real emphasis, not as asterisks", () => {
    render(<AnswerText text="Bandra led at **₹10,08,942.35** last month." />);

    const strong = screen.getByText("₹10,08,942.35");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it("never turns model output into markup, however the answer is written", () => {
    // The load-bearing safety property. An answer is untrusted text: it
    // reaches the page through text nodes only, so a tag in it is a tag
    // the reader can see, never one the browser runs.
    const { container } = render(
      <AnswerText text={'Sales rose <img src=x onerror="alert(1)"> and <b>held</b>.'} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain("<b>held</b>");
  });

  it("renders nothing at all for an answer with no text, rather than an empty block", () => {
    const { container } = render(<AnswerText text="" />);

    expect(container.firstChild).toBeNull();
  });

  it("shows only what the reveal has reached, and marks where it is", () => {
    const { container } = render(
      <AnswerText text={"Bandra led the month."} visibleChars={6} />,
    );

    expect(container.textContent).toBe("Bandra");
    // The caret is what makes a half-written answer read as still
    // arriving rather than as a truncated one.
    expect(container.querySelectorAll("span[aria-hidden='true']")).toHaveLength(1);
  });

  it("drops the caret the moment the answer is all there", () => {
    const text = "Bandra led the month.";
    const { container } = render(<AnswerText text={text} visibleChars={text.length} />);

    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll("span[aria-hidden='true']")).toHaveLength(0);
  });

  it("keeps a line break inside a paragraph visible", () => {
    const { container } = render(<AnswerText text={"Bandra led.\nLower Parel was second."} />);

    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });
});

// --- the three voices in an answer ----------------------------------------
//
// The prompt asks for one line carrying the answer, then observations, then
// one line on what to look at next. All three were rendered at the same
// size and weight, so a considered reading arrived as an undesigned block
// of grey — the only thing on the screen that wasn't a designed object.

describe("telling the finding apart from the reading of it", () => {
  const answer = [
    "**POS** led with **₹21,36,43,836.26**",
    "",
    "- In-store ordering dominates the mix.",
    "- Delightservice and ownly are negligible.",
    "",
    "Worth checking whether the share differs by store.",
  ].join("\n");

  it("sets the first line apart as the finding", () => {
    const { container } = render(<AnswerText text={answer} />);

    const paragraphs = [...container.querySelectorAll("p")];
    expect(paragraphs[0]!.className).not.toBe(paragraphs[1]!.className);
  });

  it("sets the closing line apart from the observations", () => {
    const { container } = render(<AnswerText text={answer} />);

    const paragraphs = [...container.querySelectorAll("p")];
    // Lead and closing are the two paragraphs; they must not share a class
    // with each other either — a recommendation is not a finding.
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.className).not.toBe(paragraphs[1]!.className);
  });

  it("does not treat a lone paragraph as a closing line", () => {
    // Mid-stream an answer is one paragraph and nothing else. Styling that
    // as "what to look at next" would flash the finding in the quietest
    // ink on the page before the rest arrives.
    const { container } = render(<AnswerText text="**POS** led." />);

    const paragraphs = [...container.querySelectorAll("p")];
    expect(paragraphs).toHaveLength(1);
    const lead = render(<AnswerText text={answer} />).container.querySelector("p")!;
    expect(paragraphs[0]!.className).toBe(lead.className);
  });

  it("does not promote a trailing paragraph when there were no observations", () => {
    const { container } = render(<AnswerText text={"First line.\n\nSecond line."} />);

    const paragraphs = [...container.querySelectorAll("p")];
    expect(paragraphs).toHaveLength(2);
    // No list between them, so the second is ordinary prose, not a
    // recommendation.
    expect(paragraphs[1]!.className).not.toBe(paragraphs[0]!.className);
  });
});
