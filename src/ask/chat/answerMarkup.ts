/**
 * An agent's answer text, as the blocks a renderer can lay out.
 *
 * The agent is prompted to write plain English "laid out so it can be
 * skimmed" (`agent-service/scripts/seed_agent_prompts.py`): one short lead
 * sentence, then — when there are three or more things to list — each on
 * its own line behind a leading `- `, then one closing sentence. That text
 * was reaching the page through a single `white-space: pre-wrap`
 * paragraph, so every bullet arrived as a literal hyphen in a run-on block
 * and the layout the prompt asks for never actually happened on screen.
 *
 * **Deliberately not a markdown engine.** A real one renders far more than
 * this agent can emit, and the thing it renders that matters most here is
 * raw HTML — which is precisely what model output must never be able to
 * put on this page. Nothing in this module can produce markup: every value
 * it returns is a plain string that the renderer places in a text node, so
 * `<img onerror=…>` in an answer is text about an image tag and nothing
 * more.
 *
 * What it does read is the markdown models write whether or not they are
 * asked to — tables, fenced code, `inline code`, *emphasis*, quotes — because
 * each of those rendered as raw punctuation otherwise, and the worst of them
 * rendered as something else entirely: `# comment` inside a code fence came
 * out as a bold heading, and `a**2 + b**2` bolded "2 + b".
 */

/** A run of answer text, and how the agent marked it. */
export interface InlineSpan {
  text: string;
  bold: boolean;
  /** `*x*` or `_x_`. Present only when set, so a plain span stays
   * `{text, bold}` and reads the same as it always has. */
  italic?: true;
  /** `` `x` `` — shown exactly as written, never parsed any further. */
  code?: true;
  /** Set only for a `[label](https://…)` link, and only ever to an http(s)
   * URL: anything else (`javascript:`, `data:`) stays literal text. */
  href?: string;
}

/** One entry of a list: its own text, and whatever is indented under it. */
export interface ListItem {
  /** A run per source line — the same "keep every line break" rule as a
   * paragraph's `lines`. */
  lines: InlineSpan[][];
  /** Blocks indented under this item: a nested list, a code sample, a
   * second paragraph. Drawn after the item's own lines, in source order. */
  children: AnswerBlock[];
}

export interface ListBlock {
  kind: "list";
  ordered: boolean;
  /**
   * The number the source list opened on. A list is numbered from here
   * rather than from 1, so a ranking the agent continued after a paragraph
   * ("3. BKC") still reads 3 — it used to restart at 1 and claim a third
   * first place.
   */
  start: number;
  items: ListItem[];
}

export type CellAlign = "left" | "center" | "right" | null;

export interface TableBlock {
  kind: "table";
  /** From the `|:---|---:|` row; `null` leaves the column to the renderer. */
  align: CellAlign[];
  header: InlineSpan[][];
  /** Always exactly `header.length` cells a row: a short row is padded and
   * a long one cut, so every row lines up under the header it belongs to. */
  rows: InlineSpan[][][];
}

export interface CodeBlock {
  kind: "code";
  /** The fence's info string (` ```sql `), or "" when it named none. */
  lang: string;
  /** Verbatim, indentation included — the one block nothing is trimmed from. */
  text: string;
}

export interface QuoteBlock {
  kind: "quote";
  blocks: AnswerBlock[];
}

/**
 * `lines` rather than one string: a source line break inside a paragraph
 * is *kept* as a line break. Markdown would join those lines into one
 * flowing paragraph, and joining is the one transform that can silently
 * destroy a separation the writer intended — an agent that puts two
 * findings on two lines means two lines. Nothing is ever merged here;
 * blocks only ever split.
 *
 * `heading` marks a `## Heading` line. It is still a paragraph — set bold,
 * not as a heading element, because the answer sits inside a chat bubble
 * whose own title is the only heading it should have — but a renderer has
 * to be able to tell it apart: a heading is never the answer's finding.
 */
export type AnswerBlock =
  | { kind: "paragraph"; lines: InlineSpan[][]; heading?: true }
  | ListBlock
  | TableBlock
  | CodeBlock
  | QuoteBlock;

const BULLET = /^(\s*)[-*•]\s+(.*)$/;
// `## Heading` and `---` are the two markdown habits models keep even when
// asked for plain text. Both used to render literally: a heading as
// "## What is a Geofence?", a rule as a line of hyphens.
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const BLANK = /^\s*$/;
// Any indentation, not markdown's three spaces: a fence inside a list item
// sits at the item's own indent, and this parser has no four-space
// indented-code rule for the difference to matter to.
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})([^`]*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
// A GFM table's second line: cells of dashes, optionally colon-aligned.
// The pipe is required, so a lone `---` under a line with a `|` in it is
// still a rule rather than a one-column table.
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * How far an item must be indented past its list's own marker to nest
 * under that list's last item. Two columns, not markdown's exact content
 * column: models indent sub-bullets by two, three or four spaces, and all
 * three mean "under the item above".
 */
const NEST = 2;

// Documentation answers cite their pages as `[Page](https://…)`, which
// rendered as raw brackets and a wrapped URL. Only http(s) targets become
// links; a `javascript:` or `data:` target never matches and stays text.
// Sticky: it is tried at one position by the inline scanner, never searched.
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y;

// ---- inline ----------------------------------------------------------------

/** A piece of a line before emphasis is decided: plain text, or a run the
 * emphasis pass must treat as one opaque character. */
type Atom =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const ESCAPABLE = new Set(["*", "_", "`"]);

/**
 * Code spans and links first, because nothing inside either is emphasis:
 * `` `a**2` `` is code, and a URL's underscores are part of the URL.
 *
 * A backtick run with no matching closing run is literal, for the same
 * reason an unmatched `**` is — mid-stream it is not code yet. `\*`, `\_`
 * and `` \` `` are the escapes a writer uses to mean the character itself;
 * they become a one-character code-free text atom the emphasis pass skips.
 */
function atomize(text: string): { atoms: Atom[]; literal: Set<number> } {
  const atoms: Atom[] = [];
  // Indices of text atoms that came from an escape: emphasis never reads
  // a delimiter out of one.
  const literal = new Set<number>();
  let buffer = "";
  const flush = () => {
    if (buffer !== "") atoms.push({ kind: "text", text: buffer });
    buffer = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\" && ESCAPABLE.has(text[i + 1] ?? "")) {
      flush();
      literal.add(atoms.length);
      atoms.push({ kind: "text", text: text[i + 1]! });
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = runLength(text, i, "`");
      const close = findRun(text, i + run, run);
      if (close !== -1) {
        flush();
        atoms.push({ kind: "code", text: trimCode(text.slice(i + run, close)) });
        i = close + run;
        continue;
      }
      buffer += text.slice(i, i + run);
      i += run;
      continue;
    }
    if (ch === "[") {
      LINK.lastIndex = i;
      const link = LINK.exec(text);
      if (link !== null) {
        flush();
        // The label is shown as plain text: emphasis marks inside it are
        // dropped rather than nested, since a link already stands out.
        atoms.push({ kind: "link", text: link[1]!.replace(/\*\*/g, ""), href: link[2]! });
        i += link[0].length;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return { atoms, literal };
}

function runLength(text: string, from: number, ch: string): number {
  let end = from;
  while (text[end] === ch) end += 1;
  return end - from;
}

/** Where the next backtick run of exactly `length` starts, or -1. A longer
 * or shorter run is part of the code, which is how `` `a`b` `` works. */
function findRun(text: string, from: number, length: number): number {
  let i = text.indexOf("`", from);
  while (i !== -1) {
    const run = runLength(text, i, "`");
    if (run === length) return i;
    i = text.indexOf("`", i + run);
  }
  return -1;
}

/** Markdown's own rule: one space either side is padding, so `` ` `x` ` ``
 * can show a backtick; anything else is kept exactly. */
function trimCode(text: string): string {
  return text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== ""
    ? text.slice(1, -1)
    : text;
}

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
/** What a code span or link looks like to its neighbours: something that
 * is neither a space nor part of a word, so `**`x`**` can be bold. */
const OPAQUE = "\u0001";

interface EmphasisNode {
  kind: "text" | "code" | "link" | "delim";
  text: string;
  href?: string;
  /** Delimiters: which character, how many are still unmatched. */
  char?: "*" | "_";
  count?: number;
  canOpen?: boolean;
  canClose?: boolean;
  bold: number;
  italic: number;
}

/**
 * `**bold**`, `*italic*` / `_italic_`, `` `code` `` and `[label](https://…)`
 * links, and nothing else.
 *
 * Emphasis follows markdown's flanking idea, simplified: a delimiter opens
 * only when the next character is not a space and the previous one is not
 * part of a word, and closes only the mirror way round. That one rule is
 * what keeps `a**2 + b**2` from bolding "2 + b" (both runs sit inside a
 * word), `snake_case_name` from italicising "case", and `2 * 3 * 4` from
 * italicising " 3 ". `***x***` is bold and italic at once — it used to be
 * a bold "*x" and a stray asterisk.
 *
 * An unmatched `**` is left exactly as it arrived rather than swallowed:
 * mid-stream the closing pair simply has not been typed yet, and text that
 * flickers between "literal asterisks" and "gone entirely" reads as a
 * rendering bug. Empty spans are dropped so `**a****b**` cannot emit a
 * zero-length node between the two.
 */
function parseInline(text: string): InlineSpan[] {
  const { atoms, literal } = atomize(text);
  const nodes: EmphasisNode[] = [];

  atoms.forEach((atom, index) => {
    if (atom.kind !== "text" || literal.has(index)) {
      nodes.push({ kind: atom.kind, text: atom.text, href: atom.kind === "link" ? atom.href : undefined, bold: 0, italic: 0 });
      return;
    }
    // Split plain text into words and delimiter runs.
    const pattern = /\*+|_+/g;
    let cursor = 0;
    for (let match = pattern.exec(atom.text); match !== null; match = pattern.exec(atom.text)) {
      if (match.index > cursor) nodes.push({ kind: "text", text: atom.text.slice(cursor, match.index), bold: 0, italic: 0 });
      nodes.push({ kind: "delim", text: match[0], char: match[0][0] as "*" | "_", count: match[0].length, bold: 0, italic: 0 });
      cursor = match.index + match[0].length;
    }
    if (cursor < atom.text.length) nodes.push({ kind: "text", text: atom.text.slice(cursor), bold: 0, italic: 0 });
  });

  // Flanking, from the characters either side of each run.
  nodes.forEach((node, index) => {
    if (node.kind !== "delim") return;
    const before = edgeChar(nodes[index - 1], "end");
    const after = edgeChar(nodes[index + 1], "start");
    node.canOpen = after !== "" && !SPACE.test(after) && !WORD.test(before);
    node.canClose = before !== "" && !SPACE.test(before) && !WORD.test(after);
  });

  // Match closers against the nearest opener of the same character, taking
  // two at a time (bold) when both sides have two to give, else one.
  const delims = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.kind === "delim");
  for (let c = 0; c < delims.length; c += 1) {
    const closer = delims[c]!;
    if (closer.node.canClose !== true) continue;
    while (closer.node.count! > 0) {
      let o = c - 1;
      while (
        o >= 0 &&
        !(delims[o]!.node.canOpen === true && delims[o]!.node.char === closer.node.char && delims[o]!.node.count! > 0)
      ) {
        o -= 1;
      }
      if (o < 0) break;
      const opener = delims[o]!;
      const use = opener.node.count! >= 2 && closer.node.count! >= 2 ? 2 : 1;
      for (let n = opener.index + 1; n < closer.index; n += 1) {
        if (use === 2) nodes[n]!.bold += 1;
        else nodes[n]!.italic += 1;
      }
      opener.node.count! -= use;
      closer.node.count! -= use;
      // Anything left open between the pair can no longer close across it.
      for (let k = o + 1; k < c; k += 1) delims[k]!.node.canOpen = false;
    }
  }

  const spans: InlineSpan[] = [];
  for (const node of nodes) {
    const content = node.kind === "delim" ? node.char!.repeat(node.count!) : node.text;
    if (content === "") continue;
    const span: InlineSpan = { text: content, bold: node.bold > 0 };
    if (node.italic > 0) span.italic = true;
    if (node.kind === "code") span.code = true;
    if (node.kind === "link") span.href = node.href;
    const previous = spans[spans.length - 1];
    // Neighbouring plain runs with the same emphasis are one run: the
    // renderer should see "Bandra led at " rather than three fragments of it.
    if (previous !== undefined && sameStyle(previous, span) && previous.code !== true && previous.href === undefined && node.kind !== "code" && node.kind !== "link") {
      previous.text += span.text;
    } else {
      spans.push(span);
    }
  }
  return spans;
}

function edgeChar(node: EmphasisNode | undefined, edge: "start" | "end"): string {
  if (node === undefined) return "";
  if (node.kind === "code" || node.kind === "link") return OPAQUE;
  return edge === "start" ? node.text[0] ?? "" : node.text[node.text.length - 1] ?? "";
}

function sameStyle(a: InlineSpan, b: InlineSpan): boolean {
  return a.bold === b.bold && a.italic === b.italic;
}

// ---- blocks ----------------------------------------------------------------

/** Columns of leading whitespace, a tab counting to the next stop of four. */
function indentOf(line: string): number {
  let column = 0;
  for (const ch of line) {
    if (ch === " ") column += 1;
    else if (ch === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/** Up to `columns` of leading whitespace off a line, and no more. */
function dedent(line: string, columns: number): string {
  let column = 0;
  let i = 0;
  while (i < line.length && column < columns && (line[i] === " " || line[i] === "\t")) {
    column += line[i] === "\t" ? 4 - (column % 4) : 1;
    i += 1;
  }
  return line.slice(i);
}

/** A table row's cells: the outer pipes are optional, `\|` is a pipe. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (body[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += body[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): CellAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function fitRow(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => cells[index] ?? "");
}

interface OpenList {
  block: ListBlock;
  /** The column this list's markers sit at. */
  indent: number;
}

/**
 * Blocks, in the order the agent wrote them.
 *
 * A `- ` / `* ` / `• ` line is a bullet and a `1. ` / `1) ` line a numbered
 * one; an item indented under another nests beneath it, and switching
 * between the two markers at one level starts a new list beside the first
 * rather than mixing markers inside one. A blank line ends a paragraph, but
 * only *pauses* a list: markdown's "loose" list — items a blank line apart —
 * is how models write a ranking with room to breathe, and ending the list
 * at every gap is what printed "1. A / 1. B / 1. C". The list resumes if the
 * next line is another item or is indented under the last one, and ends
 * otherwise. Everything else is a paragraph line.
 *
 * A bullet marker must be followed by whitespace, which is what keeps
 * `**Bandra** led the week` from being read as a bullet.
 */
export function parseAnswer(raw: string): AnswerBlock[] {
  return parseBlocks(raw.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: InlineSpan[][] | null = null;
  const open: OpenList[] = [];
  // A blank line since the last content line. Inside a list it decides
  // whether an indented line continues the item's text or starts a second
  // paragraph under it.
  let gap = false;

  function closeParagraph() {
    if (paragraph !== null) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = null;
  }

  function closeAll() {
    closeParagraph();
    open.length = 0;
  }

  function newList(ordered: boolean, start: number): ListBlock {
    return { kind: "list", ordered, start: ordered ? start : 1, items: [] };
  }

  function newItem(text: string): ListItem {
    return { lines: [parseInline(text)], children: [] };
  }

  function addItem(indent: number, ordered: boolean, start: number, text: string) {
    closeParagraph();
    while (open.length > 0) {
      const top = open[open.length - 1]!;
      const owner = top.block.items[top.block.items.length - 1]!;
      if (indent >= top.indent + NEST) {
        // Indented under the item above: a list of its own inside it. This
        // is what keeps "1. Bandra / - up 12%" one numbered list with a
        // bullet under its first item, instead of three lists that each
        // restart their count.
        const list = newList(ordered, start);
        list.items.push(newItem(text));
        owner.children.push(list);
        open.push({ block: list, indent });
        return;
      }
      if (indent > top.indent - NEST) {
        if (top.block.ordered === ordered) {
          top.block.items.push(newItem(text));
          return;
        }
        // Same level, other marker: a new list beside this one.
        open.pop();
        const list = newList(ordered, start);
        list.items.push(newItem(text));
        const parent = open[open.length - 1];
        if (parent === undefined) blocks.push(list);
        else parent.block.items[parent.block.items.length - 1]!.children.push(list);
        open.push({ block: list, indent });
        return;
      }
      // Shallower than this list: it is finished.
      open.pop();
    }
    const list = newList(ordered, start);
    list.items.push(newItem(text));
    blocks.push(list);
    open.push({ block: list, indent });
  }

  /** The item an indented line belongs to — the deepest open list it sits
   * inside — closing any list nested deeper than the line. */
  function ownerOf(indent: number): ListItem | null {
    while (open.length > 0) {
      const top = open[open.length - 1]!;
      if (indent >= top.indent + NEST) return top.block.items[top.block.items.length - 1]!;
      if (open.length === 1) return top.block.items[top.block.items.length - 1]!;
      open.pop();
    }
    return null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const indent = indentOf(line);

    // Fenced code first, and everything up to its closing fence is taken
    // verbatim — which is the whole point: `# comment` in a shell sample
    // used to become a bold heading, and every line lost its indentation.
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const marker = fence[2]!;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const close = FENCE_CLOSE.exec(lines[j]!);
        if (close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        body.push(dedent(lines[j]!, indent));
      }
      // Unclosed runs to the end of the answer: mid-stream the closing fence
      // has not arrived yet, and the sample is still a sample.
      i = j;
      const code: CodeBlock = { kind: "code", lang: fence[3]!.trim().split(/\s+/)[0] ?? "", text: body.join("\n") };
      const owner = open.length > 0 && indent >= NEST ? ownerOf(indent) : null;
      if (owner !== null) {
        closeParagraph();
        owner.children.push(code);
      } else {
        closeAll();
        blocks.push(code);
      }
      gap = false;
      continue;
    }

    if (BLANK.test(line)) {
      closeParagraph();
      gap = true;
      continue;
    }

    // Before the bullet test: `* * *` is a rule, not a bullet reading "* *".
    // A rule only separates, so it closes the open block and draws nothing.
    if (RULE.test(line)) {
      closeAll();
      gap = false;
      continue;
    }

    // A heading is its own one-line block in bold, without its `#` marks.
    const heading = HEADING.exec(line);
    if (heading !== null) {
      closeAll();
      const spans = parseInline(heading[1]!).map((span) => ({ ...span, bold: true }));
      blocks.push({ kind: "paragraph", lines: [spans], heading: true });
      gap = false;
      continue;
    }

    // A quote is every consecutive `>` line, parsed as an answer of its own.
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      i -= 1;
      closeAll();
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      gap = false;
      continue;
    }

    // A table is a row of pipes followed by a row of dashes with the same
    // number of cells. Until that second row arrives the first is just a
    // line of text, which is also what it was before this existed.
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && next.includes("|") && TABLE_DELIMITER.test(next)) {
      const header = splitRow(line);
      const align = splitRow(next).map(alignOf);
      if (header.length === align.length) {
        closeAll();
        const rows: InlineSpan[][][] = [];
        let j = i + 2;
        for (; j < lines.length && !BLANK.test(lines[j]!) && lines[j]!.includes("|"); j += 1) {
          rows.push(fitRow(splitRow(lines[j]!), header.length).map(parseInline));
        }
        blocks.push({ kind: "table", align, header: header.map(parseInline), rows });
        i = j - 1;
        gap = false;
        continue;
      }
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      addItem(indent, false, 1, bullet[2]!.trim());
      gap = false;
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered !== null) {
      addItem(indent, true, Number(ordered[2]), ordered[3]!.trim());
      gap = false;
      continue;
    }

    // An indented line under an open list belongs to its item: straight
    // after it, a second line of the item's text; after a blank line, a
    // paragraph of its own inside the item.
    if (open.length > 0 && indent >= NEST) {
      const owner = ownerOf(indent)!;
      const spans = parseInline(line.trim());
      const last = owner.children[owner.children.length - 1];
      if (!gap && owner.children.length === 0) owner.lines.push(spans);
      else if (!gap && last?.kind === "paragraph") last.lines.push(spans);
      else owner.children.push({ kind: "paragraph", lines: [spans] });
      gap = false;
      continue;
    }

    // A plain line after a list closes it — the closing sentence the
    // prompt asks for is prose, not a fourth bullet.
    if (open.length > 0) open.length = 0;
    // Trailing whitespace is markdown's own hard-break marker and this
    // renderer already keeps every line break, so it would only ever
    // render as a dangling space at the end of a line.
    (paragraph ??= []).push(parseInline(line.trim()));
    gap = false;
  }

  closeParagraph();
  return prune(blocks);
}

/**
 * A line of pure emphasis marks (`**`, or a bare `-`) parses to nothing at
 * all; an empty block would render as a stray gap, and an empty item as a
 * marker with nothing beside it.
 */
function prune(blocks: AnswerBlock[]): AnswerBlock[] {
  const kept: AnswerBlock[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
        if (block.lines.some((spans) => spans.length > 0)) kept.push(block);
        break;
      case "list": {
        const items = block.items
          .map((item) => ({ lines: item.lines.filter((spans) => spans.length > 0), children: prune(item.children) }))
          .filter((item) => item.lines.length > 0 || item.children.length > 0);
        if (items.length > 0) kept.push({ ...block, items });
        break;
      }
      case "quote": {
        const inner = prune(block.blocks);
        if (inner.length > 0) kept.push({ kind: "quote", blocks: inner });
        break;
      }
      case "code":
        // A fence that opened and closed on nothing is an empty box.
        if (block.text.trim() !== "") kept.push(block);
        break;
      default:
        kept.push(block);
    }
  }
  return kept;
}

// ---- the reveal -------------------------------------------------------------

function spanChars(spans: InlineSpan[]): number {
  return spans.reduce((total, span) => total + span.text.length, 0);
}

/** Total characters of visible text across every block — what a reveal
 * counts up to, and what tells a renderer whether it is showing all of it. */
export function countChars(blocks: AnswerBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
        for (const run of block.lines) total += spanChars(run);
        break;
      case "list":
        for (const item of block.items) {
          for (const run of item.lines) total += spanChars(run);
          total += countChars(item.children);
        }
        break;
      case "table":
        for (const cell of block.header) total += spanChars(cell);
        for (const row of block.rows) for (const cell of row) total += spanChars(cell);
        break;
      case "code":
        total += block.text.length;
        break;
      case "quote":
        total += countChars(block.blocks);
        break;
    }
  }
  return total;
}

/** How much of the reveal is left, shared down the recursion. */
interface Budget {
  left: number;
}

/** The part of `text` the budget reaches. */
function takeText(text: string, budget: Budget): string {
  const taken = text.slice(0, Math.max(0, budget.left));
  // A cut short of the end spends the rest: nothing after a half-shown run
  // may appear before it has finished.
  budget.left = taken.length < text.length ? 0 : budget.left - taken.length;
  return taken;
}

function takeSpans(spans: InlineSpan[], budget: Budget): InlineSpan[] {
  const taken: InlineSpan[] = [];
  for (const span of spans) {
    if (budget.left <= 0) break;
    const text = takeText(span.text, budget);
    if (text !== "") taken.push(text === span.text ? span : { ...span, text });
  }
  return taken;
}

/** Runs the budget reaches. An empty run only ever appears when the budget
 * ran out exactly at a boundary; rendering it would add a blank line or a
 * bare marker ahead of the text it belongs to. */
function takeRuns(runs: InlineSpan[][], budget: Budget): InlineSpan[][] {
  const taken: InlineSpan[][] = [];
  for (const run of runs) {
    if (budget.left <= 0) break;
    const spans = takeSpans(run, budget);
    if (spans.length > 0) taken.push(spans);
  }
  return taken;
}

function takeBlocks(blocks: AnswerBlock[], budget: Budget): AnswerBlock[] {
  const taken: AnswerBlock[] = [];
  for (const block of blocks) {
    if (budget.left <= 0) break;
    const cut = takeBlock(block, budget);
    if (cut === null) break;
    taken.push(cut);
  }
  return taken;
}

function takeBlock(block: AnswerBlock, budget: Budget): AnswerBlock | null {
  switch (block.kind) {
    case "paragraph": {
      const lines = takeRuns(block.lines, budget);
      return lines.length > 0 ? { ...block, lines } : null;
    }
    case "list": {
      const items: ListItem[] = [];
      for (const item of block.items) {
        if (budget.left <= 0) break;
        const lines = takeRuns(item.lines, budget);
        const children = takeBlocks(item.children, budget);
        if (lines.length === 0 && children.length === 0) break;
        items.push({ lines, children });
      }
      return items.length > 0 ? { ...block, items } : null;
    }
    case "table": {
      // Header first, then row by row: a half-arrived table is already a
      // table with its columns in place, filling in downwards.
      const header = block.header.map((cell) => takeSpans(cell, budget));
      if (header.every((cell) => cell.length === 0)) return null;
      const rows: InlineSpan[][][] = [];
      for (const row of block.rows) {
        if (budget.left <= 0) break;
        rows.push(row.map((cell) => takeSpans(cell, budget)));
      }
      return { ...block, header, rows };
    }
    case "code": {
      const text = takeText(block.text, budget);
      return text !== "" ? { ...block, text } : null;
    }
    case "quote": {
      const inner = takeBlocks(block.blocks, budget);
      return inner.length > 0 ? { kind: "quote", blocks: inner } : null;
    }
  }
}

/**
 * The first `count` characters of an already-parsed answer.
 *
 * The structure is decided once, from the whole text, and only then cut
 * down — never re-parsed from a prefix. Parsing `"- Band"` on one tick and
 * `"- Bandra\n- BKC"` on the next would rebuild the block tree under the
 * reader every frame, and a half-written bullet would flicker between a
 * paragraph and a list item. Here a partly-revealed list is already a
 * list; it just has fewer items in it so far.
 */
export function takeChars(blocks: AnswerBlock[], count: number): AnswerBlock[] {
  return takeBlocks(blocks, { left: count });
}
