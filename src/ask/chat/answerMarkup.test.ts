import { describe, expect, it } from "vitest";
import { countChars, parseAnswer, takeChars, type AnswerBlock } from "./answerMarkup.ts";

/** The flat text of a block, for assertions that are about structure. */
function textOf(block: AnswerBlock): string[] {
  const runs = block.kind === "paragraph" ? block.lines : block.items;
  return runs.map((spans) => spans.map((span) => span.text).join(""));
}

describe("parseAnswer", () => {
  it("turns the agent's '- ' lines into a list rather than literal hyphens", () => {
    const blocks = parseAnswer(
      "Bandra led the month.\n- Bandra — ₹10,08,942.35\n- Lower Parel — ₹9,12,004.00\n- BKC — ₹8,44,110.20",
    );

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(textOf(blocks[1]!)).toEqual([
      "Bandra — ₹10,08,942.35",
      "Lower Parel — ₹9,12,004.00",
      "BKC — ₹8,44,110.20",
    ]);
    // The marker is structure now, not content — a hyphen left in the text
    // is the exact bug this replaces.
    expect(textOf(blocks[1]!).join(" ")).not.toContain("- ");
  });

  it("renders a markdown heading as its own bold line, without the # marks", () => {
    const blocks = parseAnswer("## What is a Geofence?\nA geofence is a virtual boundary.");

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "paragraph"]);
    expect(textOf(blocks[0]!)).toEqual(["What is a Geofence?"]);
    expect(blocks[0]!.kind === "paragraph" && blocks[0]!.lines[0]!.every((s) => s.bold)).toBe(true);
    expect(textOf(blocks[1]!)).toEqual(["A geofence is a virtual boundary."]);
  });

  it("treats a --- rule as a separator, never as text or a bullet", () => {
    const blocks = parseAnswer("First part.\n---\n* * *\nSecond part.");

    expect(blocks.map(textOf)).toEqual([["First part."], ["Second part."]]);
  });

  it("splits on a blank line into separate paragraphs", () => {
    const blocks = parseAnswer("Bandra led the month.\n\nThat is a third of the total.");

    expect(blocks).toHaveLength(2);
    expect(textOf(blocks[0]!)).toEqual(["Bandra led the month."]);
    expect(textOf(blocks[1]!)).toEqual(["That is a third of the total."]);
  });

  it("keeps a line break inside a paragraph instead of flowing the lines together", () => {
    // Markdown would join these into one paragraph. An agent that put two
    // findings on two lines meant two lines, and merging them is the one
    // transform here that could destroy something it cannot get back.
    const blocks = parseAnswer("Bandra led.\nLower Parel was second.");

    expect(blocks).toHaveLength(1);
    expect(textOf(blocks[0]!)).toEqual(["Bandra led.", "Lower Parel was second."]);
  });

  it("reads **bold** as emphasis and leaves the text around it plain", () => {
    const blocks = parseAnswer("Bandra led at **₹10,08,942.35** last month.");

    const spans = (blocks[0] as { lines: { text: string; bold: boolean }[][] }).lines[0]!;
    expect(spans).toEqual([
      { text: "Bandra led at ", bold: false },
      { text: "₹10,08,942.35", bold: true },
      { text: " last month.", bold: false },
    ]);
  });

  it("leaves an unclosed ** exactly as it arrived, because mid-stream it is not emphasis yet", () => {
    const blocks = parseAnswer("Bandra led at **₹10,08");

    expect(textOf(blocks[0]!)).toEqual(["Bandra led at **₹10,08"]);
    const spans = (blocks[0] as { lines: { bold: boolean }[][] }).lines[0]!;
    expect(spans.every((span) => !span.bold)).toBe(true);
  });

  it("does not mistake a line opening with **bold** for a bullet", () => {
    // A bullet marker must be followed by whitespace; `**Bandra**` is not.
    const blocks = parseAnswer("**Bandra** led the month.");

    expect(blocks[0]!.kind).toBe("paragraph");
  });

  it("reads a numbered ranking as an ordered list, so the numbers are not printed twice", () => {
    const blocks = parseAnswer("1. Bandra\n2. Lower Parel\n3. BKC");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!).toMatchObject({ kind: "list", ordered: true });
    expect(textOf(blocks[0]!)).toEqual(["Bandra", "Lower Parel", "BKC"]);
  });

  it("starts a new list when the marker changes, rather than mixing markers in one", () => {
    const blocks = parseAnswer("- Bandra\n1. Lower Parel");

    expect(blocks.map((block) => (block as { ordered: boolean }).ordered)).toEqual([false, true]);
  });

  it("closes the list when prose resumes, keeping the agent's own order", () => {
    const blocks = parseAnswer("Top three:\n- Bandra\n- BKC\nTogether they carry a third.");

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "list", "paragraph"]);
    expect(textOf(blocks[2]!)).toEqual(["Together they carry a third."]);
  });

  it("leaves no dangling whitespace from a markdown hard break", () => {
    // The agent emits trailing double-spaces as line breaks; every line
    // break is already kept, so those spaces would only ever render as a
    // gap hanging off the end of a line.
    const blocks = parseAnswer("Bandra led.  \nLower Parel was second.");

    expect(textOf(blocks[0]!)).toEqual(["Bandra led.", "Lower Parel was second."]);
  });

  it("returns nothing for an answer with nothing in it", () => {
    expect(parseAnswer("")).toEqual([]);
    expect(parseAnswer("\n\n   \n")).toEqual([]);
  });
});

describe("countChars / takeChars", () => {
  const LIST = parseAnswer("Top three:\n- Bandra\n- Lower Parel\n- BKC");

  it("counts the text a reader sees, not the markers that arrange it", () => {
    // "Top three:" + the three names. The hyphens and newlines are
    // structure now and never reach the page as characters.
    expect(countChars(LIST)).toBe("Top three:".length + "BandraLower ParelBKC".length);
  });

  it("keeps a half-revealed list a list, rather than rebuilding it as prose", () => {
    // The whole reason the reveal cuts an existing parse instead of
    // re-parsing a prefix: `"- Band"` parsed on its own is a list, but
    // `"Top three:\n- Band"` mid-word is not obviously anything, and a
    // block tree rebuilt every frame flickers.
    const partial = takeChars(LIST, "Top three:".length + 4);

    expect(partial.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(textOf(partial[1]!)).toEqual(["Band"]);
  });

  it("drops whole blocks that the reveal has not reached", () => {
    const partial = takeChars(LIST, 3);

    expect(partial).toHaveLength(1);
    expect(textOf(partial[0]!)).toEqual(["Top"]);
  });

  it("keeps emphasis on the part of a bold run that has arrived", () => {
    const blocks = parseAnswer("Bandra led at **₹10,08,942.35** last month.");
    const partial = takeChars(blocks, "Bandra led at ".length + 3);

    const spans = (partial[0] as { lines: { text: string; bold: boolean }[][] }).lines[0]!;
    expect(spans[1]).toEqual({ text: "₹10", bold: true });
  });

  it("returns the whole answer once the budget covers it", () => {
    expect(takeChars(LIST, countChars(LIST))).toEqual(LIST);
  });
});
