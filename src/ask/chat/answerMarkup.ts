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
 */

/** A run of answer text, and whether the agent emphasised it. */
export interface InlineSpan {
  text: string;
  bold: boolean;
  /** Set only for a `[label](https://…)` link, and only ever to an http(s)
   * URL: anything else (`javascript:`, `data:`) stays literal text. */
  href?: string;
}

/**
 * `lines` rather than one string: a source line break inside a paragraph
 * is *kept* as a line break. Markdown would join those lines into one
 * flowing paragraph, and joining is the one transform that can silently
 * destroy a separation the writer intended — an agent that puts two
 * findings on two lines means two lines. Nothing is ever merged here;
 * blocks only ever split.
 */
export type AnswerBlock =
  | { kind: "paragraph"; lines: InlineSpan[][] }
  | { kind: "list"; ordered: boolean; items: InlineSpan[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
// `## Heading` and `---` are the two markdown habits models keep even when
// asked for plain text. Both used to render literally: a heading as
// "## What is a Geofence?", a rule as a line of hyphens.
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ORDERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const BLANK = /^\s*$/;
const BOLD = /\*\*(.+?)\*\*/g;

/**
 * `**bold**` and `[label](https://…)` links, and nothing else.
 *
 * An unmatched `**` is left exactly as it arrived rather than swallowed:
 * mid-stream the closing pair simply has not been typed yet, and text that
 * flickers between "literal asterisks" and "gone entirely" reads as a
 * rendering bug. Empty spans are dropped so `**a****b**` cannot emit a
 * zero-length node between the two.
 */
function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let cursor = 0;
  LINK.lastIndex = 0;
  let match = LINK.exec(text);
  while (match !== null) {
    if (match.index > cursor) spans.push(...parseBold(text.slice(cursor, match.index)));
    // The label is shown as plain text: emphasis marks inside it are dropped
    // rather than nested, since a link already stands out.
    spans.push({ text: match[1]!.replace(/\*\*/g, ""), bold: false, href: match[2]! });
    cursor = match.index + match[0].length;
    match = LINK.exec(text);
  }
  if (cursor < text.length) spans.push(...parseBold(text.slice(cursor)));
  return spans.filter((span) => span.text !== "");
}

// Documentation answers cite their pages as `[Page](https://…)`, which
// rendered as raw brackets and a wrapped URL. Only http(s) targets become
// links; a `javascript:` or `data:` target never matches and stays text.
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

function parseBold(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let cursor = 0;
  BOLD.lastIndex = 0;
  let match = BOLD.exec(text);
  while (match !== null) {
    if (match.index > cursor) {
      spans.push({ text: text.slice(cursor, match.index), bold: false });
    }
    spans.push({ text: match[1]!, bold: true });
    cursor = match.index + match[0].length;
    match = BOLD.exec(text);
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), bold: false });
  return spans.filter((span) => span.text !== "");
}

/**
 * Blocks, in the order the agent wrote them.
 *
 * A blank line ends whatever block is open. A `- ` / `* ` / `• ` line is a
 * bullet, a `1. ` / `1) ` line is a numbered one, and switching between the
 * two mid-run starts a new list rather than mixing markers inside one.
 * Everything else is a paragraph line.
 *
 * A bullet marker must be followed by whitespace, which is what keeps
 * `**Bandra** led the week` from being read as a bullet.
 */
export function parseAnswer(raw: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: InlineSpan[][] | null = null;
  let list: { ordered: boolean; items: InlineSpan[][] } | null = null;

  function flush() {
    if (paragraph !== null) blocks.push({ kind: "paragraph", lines: paragraph });
    if (list !== null) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    paragraph = null;
    list = null;
  }

  function pushItem(ordered: boolean, text: string) {
    if (list === null || list.ordered !== ordered) {
      flush();
      list = { ordered, items: [] };
    }
    list.items.push(parseInline(text));
  }

  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (BLANK.test(line)) {
      flush();
      continue;
    }

    // Before the bullet test: `* * *` is a rule, not a bullet reading "* *".
    // A rule only separates, so it closes the open block and draws nothing.
    if (RULE.test(line)) {
      flush();
      continue;
    }

    // A heading is its own one-line block in bold, without its `#` marks:
    // no heading element, because the answer sits inside a chat bubble whose
    // own title is the only heading it should have.
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const spans = parseInline(heading[1]!).map((span) => ({ ...span, bold: true }));
      blocks.push({ kind: "paragraph", lines: [spans] });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      pushItem(false, bullet[1]!.trim());
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered !== null) {
      pushItem(true, ordered[1]!.trim());
      continue;
    }

    // A plain line after a list closes it — the closing sentence the
    // prompt asks for is prose, not a fourth bullet.
    if (list !== null) flush();
    // Trailing whitespace is markdown's own hard-break marker and this
    // renderer already keeps every line break, so it would only ever
    // render as a dangling space at the end of a line.
    (paragraph ??= []).push(parseInline(line.trim()));
  }

  flush();
  // A line of pure emphasis marks (`**`, or a bare `-`) parses to nothing
  // at all; an empty block would render as a stray gap.
  return blocks.filter((block) =>
    block.kind === "paragraph"
      ? block.lines.some((spans) => spans.length > 0)
      : block.items.some((spans) => spans.length > 0),
  );
}

/** Total characters of visible text across every block — what a reveal
 * counts up to, and what tells a renderer whether it is showing all of it. */
export function countChars(blocks: AnswerBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    for (const run of block.kind === "paragraph" ? block.lines : block.items) {
      for (const span of run) total += span.text.length;
    }
  }
  return total;
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
  let budget = count;
  const taken: AnswerBlock[] = [];

  for (const block of blocks) {
    if (budget <= 0) break;
    const runs: InlineSpan[][] = [];
    for (const run of block.kind === "paragraph" ? block.lines : block.items) {
      if (budget <= 0) break;
      const spans: InlineSpan[] = [];
      for (const span of run) {
        if (budget <= 0) break;
        const text = span.text.slice(0, budget);
        budget -= text.length;
        spans.push({ ...span, text });
      }
      // An empty run only ever appears when the budget ran out exactly at a
      // boundary; rendering it would add a blank line or a bare marker
      // ahead of the text it belongs to.
      if (spans.length > 0) runs.push(spans);
    }
    if (runs.length === 0) break;
    taken.push(
      block.kind === "paragraph"
        ? { kind: "paragraph", lines: runs }
        : { kind: "list", ordered: block.ordered, items: runs },
    );
  }

  return taken;
}
