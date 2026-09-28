import type { UIPart } from "../parts/catalog.tsx";

/**
 * Which of an answer's parts lead, and which one is the evidence behind
 * them.
 *
 * The problem this solves, in the reader's words: "formatting is pure,
 * doesn't look generative UI". A question whose answer was a median and an
 * interquartile range rendered as a paragraph followed by a 265-row table
 * of every store — the table being the only structured thing a run could
 * ever produce. Once the agent can compose a real answer (a stat row, a
 * chart), that automatic table stops being the answer and becomes the
 * working behind it.
 *
 * **Collapsed, never dropped.** The table is what the figures are checked
 * against, and an answer nobody can verify is its own complaint. So it
 * stays on the page, one click away, labelled with its own row count.
 *
 * **Conditional on a composed part actually being present.** A plain
 * ranking question — "top ten stores last week" — has no composed part,
 * and its table *is* the answer; hiding that behind a disclosure would be
 * strictly worse than what it replaced. That is the single most important
 * property here, and the one a careless "just collapse tables" change
 * would break.
 *
 * **And conditional on the table being big enough to drown anything.** A
 * real run of the median question produced two tables: the 146-row
 * per-store scan the figures were computed from, and a 3-row "closest to
 * the median" lookup. Folding both away hid three store names that were
 * part of the answer, behind a label that claimed only "2 tables". A short
 * table costs less height than the stat row above it and has nothing to
 * drown, so it stays where it was.
 */

/**
 * Parts that constitute an answer rather than evidence for one. All three
 * are produced only when the model explicitly chose to compose one
 * (`show_stats`/`show_chart`/`show_comparison`), never automatically —
 * which is exactly why their presence is a safe signal that the table is
 * no longer the answer.
 *
 * `data-comparison` is the strongest such signal of the three: it IS the
 * ranking, laid out and formatted, so the raw table under it is working
 * rather than answer.
 */
const COMPOSED_INTENTS = new Set([
  "data-stats",
  "data-chart",
  "data-comparison",
  "data-summary",
  // A drafted form is the answer in the strongest sense here: it is the
  // thing the reader acts on, and the only part on the card that carries a
  // control. Anything a run retrieved on the way to writing it is working.
  "data-form-draft",
  // Drafted dashboards and widgets, for the same reason: each is the thing
  // the reader acts on, and carries the turn's controls.
  "data-dashboard-draft",
  "data-widget-draft",
]);

/**
 * Above this many rows a table stops being a supporting detail and starts
 * being the page. Twelve because a top-ten ranking — the longest table
 * that is routinely read in full — must stay inline, and because at this
 * console's row height that is already about the height of a stat row and
 * its paragraph together.
 */
const COLLAPSE_ABOVE_ROWS = 12;

/**
 * Whether any part composes the answer, so that a table beside it is the
 * working rather than the answer. Exported because `Thread.tsx` makes the
 * same call when the tenant hides query results, and a second copy of this
 * set is how the two would come to disagree about what the answer is.
 */
export function hasComposedAnswer(parts: readonly UIPart[]): boolean {
  return parts.some((part) => COMPOSED_INTENTS.has(part.intent));
}

function rowsShown(part: UIPart): number {
  const { rows } = part.data as { rows?: unknown };
  return Array.isArray(rows) ? rows.length : 0;
}

export interface PartLayout {
  /**
   * What renders in full, in the order it should read: composed answers
   * first, then everything else. The order is decided here rather than by
   * whoever renders it, because it is the whole point of this module — the
   * wire order is table-then-stats (run_sql fires before show_stats) and
   * the answer still has to come first on screen.
   */
  shown: UIPart[];
  /** Tables to put behind a disclosure. Empty when nothing should collapse. */
  evidence: UIPart[];
  /** The disclosure's own label — the row count it is hiding. */
  evidenceLabel: string;
}

/**
 * A table part's own row count, as the disclosure should name it.
 *
 * `subLabel` is what `wireParts.adaptTable` already computed from the
 * server's `row_count` ("265 rows", or "265 rows · truncated"), which is
 * the honest figure: `rows.length` is only what fitted on the wire. The
 * length is the fallback for a part that predates that field.
 */
function rowLabel(part: UIPart): string {
  const data = part.data as { subLabel?: unknown; rows?: unknown };
  if (typeof data.subLabel === "string" && data.subLabel !== "") return data.subLabel;
  const count = Array.isArray(data.rows) ? data.rows.length : 0;
  return `${count} row${count === 1 ? "" : "s"}`;
}

export function arrangeParts(parts: UIPart[]): PartLayout {
  // Questions come before everything, including the composed answer. While
  // a run is live the question is the only thing on screen anyone can act
  // on — it is what the run is blocked on — and it was landing UNDER the
  // finished summary, so it read as a leftover rather than a request. Read
  // back later the same order is the true one: it was asked before the
  // answer existed.
  const questions = parts.filter((part) => part.intent === "data-question");
  const answerable = parts.filter((part) => part.intent !== "data-question");

  const lead = answerable.filter((part) => COMPOSED_INTENTS.has(part.intent));
  if (lead.length === 0) {
    return { shown: [...questions, ...answerable], evidence: [], evidenceLabel: "" };
  }

  const collapses = (part: UIPart): boolean =>
    part.intent === "data-table" && rowsShown(part) > COLLAPSE_ABOVE_ROWS;
  const evidence = answerable.filter(collapses);
  const rest = answerable.filter(
    (part) => !COMPOSED_INTENTS.has(part.intent) && !collapses(part),
  );
  const evidenceLabel =
    evidence.length === 1 ? rowLabel(evidence[0]!) : `${evidence.length} tables`;

  return { shown: [...questions, ...lead, ...rest], evidence, evidenceLabel };
}
