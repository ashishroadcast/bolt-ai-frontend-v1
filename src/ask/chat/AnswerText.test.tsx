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

// --- numbered lists ----------------------------------------------------------

describe("numbering a list the way the agent numbered it", () => {
  const markers = (root: HTMLElement) =>
    [...root.querySelectorAll("ol > li")].map((item) => item.getAttribute("data-marker"));

  it("numbers a loose list 1, 2, 3 rather than 1, 1, 1", () => {
    const { container } = render(<AnswerText text={"1. Bandra\n\n2. Lower Parel\n\n3. BKC"} />);

    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(markers(container)).toEqual(["1.", "2.", "3."]);
  });

  it("starts a list at the number it was written with", () => {
    const { container } = render(<AnswerText text={"3. BKC\n4. Andheri"} />);

    expect(container.querySelector("ol")!.getAttribute("start")).toBe("3");
    expect(markers(container)).toEqual(["3.", "4."]);
  });

  it("draws sub-bullets inside the numbered item they belong to", () => {
    const { container } = render(
      <AnswerText text={"1. Bandra\n   - up 12%\n   - best day Saturday\n2. BKC"} />,
    );

    const outer = container.querySelectorAll("ol > li");
    expect(outer).toHaveLength(2);
    expect(outer[0]!.querySelectorAll("ul > li")).toHaveLength(2);
    expect(markers(container)).toEqual(["1.", "2."]);
  });
});

// --- the markdown models write anyway ---------------------------------------

describe("rendering tables, code and quotes", () => {
  it("renders a pipe table as a real table with column headers", () => {
    render(<AnswerText text={"| Store | Net sales |\n|---|---:|\n| Bandra | ₹10,08,942.35 |"} />);

    const table = screen.getByRole("table");
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Store",
      "Net sales",
    ]);
    expect(screen.getByRole("cell", { name: "₹10,08,942.35" }).getAttribute("data-align")).toBe(
      "right",
    );
    expect(table.textContent).not.toContain("|");
  });

  it("renders fenced code verbatim, with no fence and no heading made of a comment", () => {
    const { container } = render(<AnswerText text={"```bash\n# count\n  wc -l a.csv\n```"} />);

    const code = container.querySelector("pre > code")!;
    expect(code.textContent).toBe("# count\n  wc -l a.csv");
    expect(container.textContent).not.toContain("```");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("renders `code`, *italic* and > quotes as their own elements", () => {
    const { container } = render(<AnswerText text={"Run `SUM` on *net*.\n\n> Excludes refunds."} />);

    expect(container.querySelector("p code")!.textContent).toBe("SUM");
    expect(container.querySelector("em")!.textContent).toBe("net");
    expect(container.querySelector("blockquote")!.textContent).toBe("Excludes refunds.");
  });

  it("lets each paragraph and list item find its own direction, for RTL answers", () => {
    const { container } = render(<AnswerText text={"بندرا في المقدمة\n\n- باندرا\n- BKC"} />);

    expect(container.querySelector("p")!.getAttribute("dir")).toBe("auto");
    for (const item of container.querySelectorAll("li")) {
      expect(item.getAttribute("dir")).toBe("auto");
    }
  });

  it("never shows half an emoji while revealing", () => {
    const { container } = render(<AnswerText text={"Top 👍🏽 pick"} visibleChars={"Top ".length + 2} />);

    expect(container.textContent).toBe("Top ");
  });

  it("keeps a single caret while a table is still arriving", () => {
    const text = "| Store | Sales |\n|---|---|\n| Bandra | 10 |";
    const { container } = render(<AnswerText text={text} visibleChars={"StoreSales".length + 3} />);

    expect(container.querySelectorAll("span[aria-hidden='true']")).toHaveLength(1);
    expect(container.querySelector("td")!.textContent).toBe("Ban");
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
