/**
 * One line of an answer, fit to read in a history row.
 *
 * The problem this solves is real and was on screen: `last_assistant_
 * snippet` is the assistant message's own text, and an analytics answer's
 * text is routinely a pipe-delimited table dump —
 *
 *   store_id | store_name | net_sales
 *   ---------|------------|----------
 *   280 | The Bombay Canteen | 29082789.84
 *
 * — which, collapsed into a one-line row, is an unreadable wall of pipes
 * and dashes. This is not "trim to N characters": trimming that string
 * produces the first N characters of the same wall.
 *
 * The rules are all reversible transforms on shape, never on meaning —
 * nothing here summarises, rewrites, or infers anything the answer did
 * not say. A separator row (`|---|---|`) is pure table scaffolding and is
 * dropped; the remaining cell boundaries become a middot, which is what
 * makes "280 · The Bombay Canteen · 29082789.84" legible where the raw
 * form is not; markdown emphasis and heading marks go, because they are
 * formatting for a renderer this row does not have.
 */

const SEPARATOR_ROW = /^[\s|:-]+$/;

/** How much of an answer a history row can show before the CSS ellipsis
 * would take over anyway. Cut here rather than only in CSS so the DOM (and
 * therefore a screen reader, and a test) sees the same short string a
 * sighted reader does. */
const MAX_LENGTH = 140;

function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

function tidyRow(line: string): string {
  // Leading/trailing pipes are a markdown table's own frame, not content:
  // dropping them first stops the join below from opening with a stray
  // separator.
  const cells = line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
  return cells.join(" · ");
}

/**
 * Returns `null` — never an empty string, and never a fabricated stand-in
 * — when the answer has nothing left to show. A caller decides what to
 * render instead; this function does not get to invent a preview.
 */
export function answerPreview(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !SEPARATOR_ROW.test(line));

  const parts: string[] = [];
  for (const line of lines) {
    const tidied = tidyRow(stripMarkdown(line)).trim();
    if (tidied !== "") parts.push(tidied);
    // Two rows is already more than a single row can show; reading the
    // whole of a long answer to build a 140-character preview is wasted
    // work on a list that renders one of these per conversation.
    if (parts.join(" · ").length >= MAX_LENGTH) break;
  }

  const joined = parts.join(" · ").replace(/\s+/g, " ").trim();
  if (joined === "") return null;
  return joined.length <= MAX_LENGTH ? joined : `${joined.slice(0, MAX_LENGTH).trimEnd()}…`;
}
