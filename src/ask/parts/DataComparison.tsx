import { ArrowDownRight, ArrowRight, ArrowUpRight, ListOrdered } from "lucide-react";
import type { ReactElement } from "react";
import { Sheet } from "./Sheet.tsx";
import styles from "./DataComparison.module.css";

export interface DataComparisonRow {
  /** The thing being compared, by its name — never an id. */
  label: string;
  /** The figure, already formatted server-side (₹, Indian grouping, 2dp). */
  value: string;
  /** 0–1 of the largest value in the set. Drives the bar behind the row. */
  share: number;
  /**
   * This row's share of the total across every row the query returned,
   * already rendered ("12.40%"). It is what turns a ranking into an
   * answer — sixth place means nothing until you know whether it is 11%
   * of the business or 0.4% of it. Absent when the measure cannot carry
   * one honestly (any negative value in the set, or a zero total).
   */
  percentOfTotal?: string;
  /** Absolute movement against the baseline, signed. Absent when the
      query returned no baseline column. */
  delta?: string;
  /** Percentage movement, signed. Absent when the baseline was zero — see
      the note on `direction` below. */
  deltaPercent?: string;
  /** Direction only. NOT a judgement: whether up is good belongs to the
      metric, not to the arithmetic. */
  direction?: "up" | "down" | "flat";
}

export interface DataComparisonProps {
  title: string;
  subLabel?: string;
  rows: DataComparisonRow[];
}

const ARROW = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;

/**
 * A ranked comparison — the shape most answers this console gives actually
 * have, and the one it had no component for.
 *
 * **Why this exists.** "Which stores did best, and how did they move?" was
 * answered as a paragraph with the numbers written into the sentences by
 * the model. Three things go wrong with that, and all three were observed:
 * the figures drift from the table below them because two different things
 * formatted them; a percentage the model computed in its head is presented
 * with the same confidence as one that was measured; and a reader who
 * wants the third-placed store has to read the whole paragraph to find it.
 * Here the model chooses which columns are being compared and writes
 * nothing — every string on screen was rendered by `app.stream.columns`,
 * the same formatter the table uses, from rows a query returned.
 *
 * **The bar is the comparison; the number is the detail.** Ranked order
 * plus a proportional bar answers "who leads and by how much" before the
 * eye reaches a single digit, which is the question being asked. The
 * figures are set in mono and right-aligned so the digits line up as a
 * column to scan down.
 *
 * **Direction is form as well as colour.** An arrow, a sign on the number,
 * and only then a colour — so the reading survives greyscale, a projector,
 * and a colour-blind reader. Green and red here are `--good`/`--critical`,
 * which is what those tokens are for: this is a state chip, not a plot
 * area, and the palette rule that keeps them out of charts does not apply.
 */
export function DataComparison({ title, subLabel, rows }: DataComparisonProps): ReactElement {
  if (rows.length === 0) {
    return (
      <Sheet title={title} subLabel={subLabel} icon={ListOrdered}>
        <p className={styles.empty}>Nothing to compare here.</p>
      </Sheet>
    );
  }

  return (
    <Sheet title={title} subLabel={subLabel} icon={ListOrdered}>
      <ol className={styles.list}>
        {rows.map((row, index) => {
          const Arrow = row.direction ? ARROW[row.direction] : null;
          return (
            <li key={`${row.label}-${index}`} className={styles.row}>
              {/* Painted behind the content rather than as a sibling
                  column, so a long store name never squeezes the bar into
                  nothing on a narrow sheet. */}
              <span
                className={styles.bar}
                style={{ width: `${Math.max(0, Math.min(1, row.share)) * 100}%` }}
                aria-hidden="true"
              />
              <span className={styles.rank} aria-hidden="true">
                {index + 1}
              </span>
              {/* The full name on hover: a long store name ellipsizes on a
                  narrow sheet, and a ranking whose names cannot be read is
                  a ranking of nothing. */}
              <span className={styles.label} title={row.label}>
                {row.label}
              </span>
              <span className={styles.value}>{row.value}</span>
              {/* Quieter than the figure it qualifies: the amount is the
                  fact, its share is the scale of it. */}
              <span className={styles.ofTotal}>{row.percentOfTotal ?? ""}</span>
              {row.delta !== undefined && (
                <span
                  className={styles.delta}
                  data-direction={row.direction ?? "flat"}
                  // The arrow is decorative once the sign is on the number,
                  // but a screen reader still needs the movement said out
                  // loud in words rather than as "+" and "%".
                  aria-label={`${row.direction ?? "unchanged"} ${row.delta}${
                    row.deltaPercent ? `, ${row.deltaPercent}` : ""
                  }`}
                >
                  {Arrow && <Arrow size={12} aria-hidden="true" />}
                  <span className={styles.deltaValue}>{row.delta}</span>
                  {/* Absent when the baseline was zero. "Up 400% from a
                      base of ₹12" is noise dressed as a finding, so the
                      server sends no percentage at all rather than one
                      that has to be explained away. */}
                  {row.deltaPercent !== undefined && (
                    <span className={styles.deltaPercent}>{row.deltaPercent}</span>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </Sheet>
  );
}
