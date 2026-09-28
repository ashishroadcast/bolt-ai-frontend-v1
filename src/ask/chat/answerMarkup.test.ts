import { describe, expect, it } from "vitest";
import {
  countChars,
  parseAnswer,
  takeChars,
  type AnswerBlock,
  type InlineSpan,
  type ListBlock,
} from "./answerMarkup.ts";

const join = (spans: InlineSpan[]) => spans.map((span) => span.text).join("");

/** The flat text of a block, for assertions that are about structure: a
 * paragraph's lines, or a list's items (an item's own lines joined). */
function textOf(block: AnswerBlock): string[] {
  switch (block.kind) {
    case "paragraph":
      return block.lines.map(join);
    case "list":
      return block.items.map((item) => item.lines.map(join).join("\n"));
    case "code":
      return [block.text];
    case "table":
      return [block.header.map(join).join(" | "), ...block.rows.map((row) => row.map(join).join(" | "))];
    case "quote":
      return block.blocks.flatMap(textOf);
  }
}

/** The spans of a one-paragraph answer's first line. */
function spansOf(raw: string): InlineSpan[] {
  const [block] = parseAnswer(raw);
  if (block?.kind !== "paragraph") throw new Error(`expected a paragraph, got ${block?.kind}`);
  return block.lines[0]!;
}

function asList(block: AnswerBlock | undefined): ListBlock {
  if (block?.kind !== "list") throw new Error(`expected a list, got ${block?.kind}`);
  return block;
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

  it("turns a cited page into a link, and only for http(s) targets", () => {
    const [block] = parseAnswer(
      "See [Geofence List](https://roadcast.gitbook.io/boltv2/geofence-list) and [x](javascript:alert(1)).",
    );

    const spans = block!.kind === "paragraph" ? block!.lines[0]! : [];
    const link = spans.find((span) => span.href !== undefined);
    expect(link).toEqual({
      text: "Geofence List",
      bold: false,
      href: "https://roadcast.gitbook.io/boltv2/geofence-list",
    });
    // Never a link, and never lost: it stays exactly as written.
    expect(spans.filter((span) => span.href !== undefined)).toHaveLength(1);
    expect(spans.map((span) => span.text).join("")).toContain("[x](javascript:alert(1))");
  });

  it("keeps a link a link while the answer is still being revealed", () => {
    const blocks = parseAnswer("[Geofence List](https://example.com/g)");

    const [partial] = takeChars(blocks, 5);

    expect(partial!.kind === "paragraph" && partial!.lines[0]![0]).toEqual({
      text: "Geofe",
      bold: false,
      href: "https://example.com/g",
    });
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

// --- numbered lists that keep their numbers --------------------------------
//
// A loose list ("1. A", blank, "2. B", blank, "3. C") rendered as "1. A /
// 1. B / 1. C": every blank line ended the list, every new list restarted
// its CSS counter, and the number the agent wrote was thrown away.

describe("numbered lists", () => {
  it("keeps a loose list — items a blank line apart — as one list", () => {
    const blocks = parseAnswer("1. Bandra\n\n2. Lower Parel\n\n3. BKC");

    expect(blocks).toHaveLength(1);
    const list = asList(blocks[0]);
    expect(list).toMatchObject({ ordered: true, start: 1 });
    expect(textOf(list)).toEqual(["Bandra", "Lower Parel", "BKC"]);
  });

  it("keeps the number a list opened on, so a list that starts at 3 reads 3", () => {
    const list = asList(parseAnswer("3. BKC\n4. Andheri")[0]);

    expect(list.start).toBe(3);
  });

  it("carries on counting after prose interrupts a ranking", () => {
    const blocks = parseAnswer("1. Bandra\n2. Lower Parel\nThe rest trail well behind.\n3. BKC");

    expect(blocks.map((block) => block.kind)).toEqual(["list", "paragraph", "list"]);
    expect(asList(blocks[2]).start).toBe(3);
  });

  it("nests indented bullets under the numbered item above them", () => {
    const blocks = parseAnswer(
      [
        "1. **Bandra** — ₹10,08,942.35",
        "   - Up 12% on last week",
        "   - Best day: Saturday",
        "2. **BKC** — ₹8,44,110.20",
        "   - Flat",
        "3. Lower Parel",
      ].join("\n"),
    );

    // One list of three, not five lists that each restart at 1.
    expect(blocks).toHaveLength(1);
    const list = asList(blocks[0]);
    expect(textOf(list)).toEqual(["Bandra — ₹10,08,942.35", "BKC — ₹8,44,110.20", "Lower Parel"]);
    const firstChildren = list.items[0]!.children;
    expect(firstChildren).toHaveLength(1);
    expect(asList(firstChildren[0])).toMatchObject({ ordered: false });
    expect(textOf(firstChildren[0]!)).toEqual(["Up 12% on last week", "Best day: Saturday"]);
    expect(textOf(list.items[1]!.children[0]!)).toEqual(["Flat"]);
    expect(list.items[2]!.children).toEqual([]);
  });

  it("nests sub-bullets across the blank lines of a loose list", () => {
    const blocks = parseAnswer("1. Bandra\n\n   - up 12%\n\n2. BKC");

    expect(blocks).toHaveLength(1);
    const list = asList(blocks[0]);
    expect(textOf(list)).toEqual(["Bandra", "BKC"]);
    expect(textOf(list.items[0]!.children[0]!)).toEqual(["up 12%"]);
  });

  it("returns to the outer list after a nested one", () => {
    const list = asList(parseAnswer("- Stores\n  - Bandra\n  - BKC\n- Channels")[0]);

    expect(textOf(list)).toEqual(["Stores", "Channels"]);
    expect(textOf(list.items[0]!.children[0]!)).toEqual(["Bandra", "BKC"]);
  });

  it("keeps an indented line under an item as part of that item", () => {
    const list = asList(parseAnswer("1. Bandra led\n   by a wide margin\n2. BKC")[0]);

    expect(list.items[0]!.lines.map(join)).toEqual(["Bandra led", "by a wide margin"]);
  });

  it("still ends a list at an unindented line after a blank one", () => {
    const blocks = parseAnswer("- Bandra\n- BKC\n\nTogether they carry a third.");

    expect(blocks.map((block) => block.kind)).toEqual(["list", "paragraph"]);
  });
});

// --- the markdown models write anyway ---------------------------------------

describe("tables", () => {
  const TABLE = [
    "Top stores:",
    "| Store | Net sales | Orders |",
    "|:---|---:|:---:|",
    "| Bandra | ₹10,08,942.35 | 1,204 |",
    "| **BKC** | ₹8,44,110.20 |",
  ].join("\n");

  it("reads a pipe table as a table, not as lines of pipes", () => {
    const blocks = parseAnswer(TABLE);

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table"]);
    const table = blocks[1]!;
    if (table.kind !== "table") throw new Error("expected a table");
    expect(table.header.map(join)).toEqual(["Store", "Net sales", "Orders"]);
    expect(table.align).toEqual(["left", "right", "center"]);
    // The delimiter row is structure: it never reaches the page as dashes.
    expect(textOf(table).join("\n")).not.toContain("---");
    // A short row is padded to the header's width, and a cell's own
    // markdown is still read.
    expect(table.rows[1]!.map(join)).toEqual(["BKC", "₹8,44,110.20", ""]);
    expect(table.rows[1]![0]![0]!.bold).toBe(true);
  });

  it("leaves a lone line with pipes in it as text until a delimiter row follows", () => {
    const blocks = parseAnswer("Swiggy | Zomato split was even.");

    expect(blocks[0]!.kind).toBe("paragraph");
  });

  it("keeps an escaped pipe inside its cell", () => {
    const [table] = parseAnswer("| a | b |\n|---|---|\n| x \\| y | z |");

    expect(table!.kind === "table" && table!.rows[0]!.map(join)).toEqual(["x | y", "z"]);
  });
});

describe("fenced code", () => {
  const FENCED = [
    "Run this:",
    "```bash",
    "# count the rows",
    "for f in *.csv; do",
    '  wc -l "$f"',
    "done",
    "```",
    "Then compare.",
  ].join("\n");

  it("takes a fence verbatim — no heading, no lost indentation, no visible fence", () => {
    const blocks = parseAnswer(FENCED);

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1]).toEqual({
      kind: "code",
      lang: "bash",
      text: '# count the rows\nfor f in *.csv; do\n  wc -l "$f"\ndone',
    });
  });

  it("does not read emphasis or links inside code", () => {
    const [code] = parseAnswer("```\na**2 + b**2 [x](https://example.com)\n```");

    expect(code).toMatchObject({ kind: "code", text: "a**2 + b**2 [x](https://example.com)" });
  });

  it("treats an unclosed fence as code to the end, since the rest is still arriving", () => {
    const blocks = parseAnswer("```sql\nSELECT 1\n## not a heading");

    expect(blocks).toEqual([{ kind: "code", lang: "sql", text: "SELECT 1\n## not a heading" }]);
  });

  it("keeps a fence indented under a list item inside that item", () => {
    const list = asList(parseAnswer("1. Install:\n   ```\n   npm i\n   ```\n2. Run it")[0]);

    expect(textOf(list)).toEqual(["Install:", "Run it"]);
    expect(list.items[0]!.children).toEqual([{ kind: "code", lang: "", text: "npm i" }]);
  });
});

describe("quotes", () => {
  it("reads > lines as a quote, parsed like any other answer", () => {
    const blocks = parseAnswer(
      "Per the policy:\n> Refunds within **7 days**.\n> - receipts required\nThat is all.",
    );

    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "quote", "paragraph"]);
    const quote = blocks[1]!;
    if (quote.kind !== "quote") throw new Error("expected a quote");
    expect(quote.blocks.map((block) => block.kind)).toEqual(["paragraph", "list"]);
    expect(textOf(quote)).toEqual(["Refunds within 7 days.", "receipts required"]);
  });
});

describe("inline marks", () => {
  it("does not bold the middle of an expression like a**2 + b**2", () => {
    const spans = spansOf("The formula is a**2 + b**2 here.");

    expect(spans.every((span) => !span.bold)).toBe(true);
    expect(join(spans)).toBe("The formula is a**2 + b**2 here.");
  });

  it("reads `code` as code, and nothing inside it as emphasis", () => {
    expect(spansOf("Use `a**2 + b**2` or `snake_case`.")).toEqual([
      { text: "Use ", bold: false },
      { text: "a**2 + b**2", bold: false, code: true },
      { text: " or ", bold: false },
      { text: "snake_case", bold: false, code: true },
      { text: ".", bold: false },
    ]);
  });

  it("reads *x* and _x_ as italic", () => {
    expect(spansOf("It was *slightly* up and _mostly_ flat.")).toEqual([
      { text: "It was ", bold: false },
      { text: "slightly", bold: false, italic: true },
      { text: " up and ", bold: false },
      { text: "mostly", bold: false, italic: true },
      { text: " flat.", bold: false },
    ]);
  });

  it("never italicises inside a word — snake_case stays snake_case", () => {
    expect(spansOf("Column net_sales_amount and 2*3*4.")).toEqual([
      { text: "Column net_sales_amount and 2*3*4.", bold: false },
    ]);
  });

  it("does not read a lone asterisk between spaces as emphasis", () => {
    expect(spansOf("5 * 3 * 2 = 30")).toEqual([{ text: "5 * 3 * 2 = 30", bold: false }]);
  });

  it("reads ***x*** as bold and italic, with no stray asterisk", () => {
    expect(spansOf("***Bandra*** led.")).toEqual([
      { text: "Bandra", bold: true, italic: true },
      { text: " led.", bold: false },
    ]);
  });

  it("nests italic inside bold", () => {
    expect(spansOf("**up *12%* on last week**")).toEqual([
      { text: "up ", bold: true },
      { text: "12%", bold: true, italic: true },
      { text: " on last week", bold: true },
    ]);
  });

  it("can bold a link or a code span", () => {
    const spans = spansOf("**[Geofence List](https://example.com/g)** and **`SUM`**");

    expect(spans[0]).toEqual({ text: "Geofence List", bold: true, href: "https://example.com/g" });
    expect(spans[2]).toEqual({ text: "SUM", bold: true, code: true });
  });

  it("leaves an unclosed backtick as a backtick", () => {
    expect(spansOf("Type `SELECT")).toEqual([{ text: "Type `SELECT", bold: false }]);
  });

  it("reads an escaped asterisk as the character itself", () => {
    expect(spansOf("\\*not italic\\*")).toEqual([{ text: "*not italic*", bold: false }]);
  });
});

describe("revealing the new blocks", () => {
  it("counts a table's cells, a code sample's text and a quote's contents", () => {
    const blocks = parseAnswer("| a | bc |\n|---|---|\n| d | e |\n```\nxyz\n```\n> q");

    expect(countChars(blocks)).toBe("abcde".length + "xyz".length + "q".length);
  });

  it("reveals a table header first, then row by row", () => {
    const blocks = parseAnswer("| Store | Sales |\n|---|---|\n| Bandra | 10 |");
    const [partial] = takeChars(blocks, "StoreSales".length + 3);

    expect(partial!.kind === "table" && partial!.rows.map((row) => row.map(join))).toEqual([
      ["Ban", ""],
    ]);
  });

  it("reveals a code sample as code, a character at a time", () => {
    const [partial] = takeChars(parseAnswer("```\nSELECT 1\n```"), 6);

    expect(partial).toEqual({ kind: "code", lang: "", text: "SELECT" });
  });

  it("reveals a nested list inside its item, never ahead of it", () => {
    const blocks = parseAnswer("1. Bandra\n   - up 12%\n2. BKC");

    expect(asList(takeChars(blocks, 4)[0]).items).toEqual([
      { lines: [[{ text: "Band", bold: false }]], children: [] },
    ]);

    const list = asList(takeChars(blocks, "Bandra".length + 2)[0]);
    expect(textOf(list)).toEqual(["Bandra"]);
    expect(textOf(list.items[0]!.children[0]!)).toEqual(["up"]);
  });

  it("gives back the whole of a structured answer once the budget covers it", () => {
    const blocks = parseAnswer(
      "1. a\n   - b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n> quoted\n```\ncode\n```",
    );

    expect(takeChars(blocks, countChars(blocks))).toEqual(blocks);
  });
});
