import type { ReactElement } from "react";
import styles from "./DataSummary.module.css";

export interface DataSummaryProps {
  /** One short phrase. Carries no figure — see `headlineValue`. */
  headline: string;
  /**
   * The figure for the headline, already rendered server-side from the row
   * the model named. Absent when the reading opens without a number, which
   * is legitimate.
   */
  headlineValue?: string;
  /** At most three, each one observation. */
  points: string[];
  /**
   * What the reading was drawn from — the population, the window, the
   * measure. A headline that makes a claim is unreadable without it: the
   * reader cannot tell whether it covers 12 rows or 12,000.
   */
  basis?: string;
  /** What to look at next, when the numbers point somewhere. */
  nextStep?: string;
}

/**
 * The reading of what was found — the part a person actually reads.
 *
 * **Why this is a component at all.** It was the last piece of an answer
 * the model typed itself, and it failed in every way typing fails. Two
 * from one screenshot: a nine-line paragraph where the prompt asks for a
 * line and three bullets, and `₹198,466,502.74` in the prose directly
 * above a table reading `₹19,84,66,502.74` — the same number, retyped by
 * hand into Western grouping.
 *
 * Styling free text could not fix either. Setting the first paragraph as a
 * headline made the nine-line version *worse*, because a rule that assumes
 * a shape amplifies the failure when the shape isn't there. So the shape
 * is structural now: the model supplies words, the server supplies
 * figures, and this lays out parts it can rely on existing.
 *
 * The figure is the one thing set in the accent, and it is the only place
 * in an answer where a number is allowed to shout.
 */
export function DataSummary({
  headline,
  headlineValue,
  points,
  basis,
  nextStep,
}: DataSummaryProps): ReactElement {
  return (
    <section className={styles.summary} aria-label="What this shows">
      <p className={styles.headline}>
        {headline}
        {headlineValue !== undefined && (
          <>
            {" "}
            <b className={styles.figure}>{headlineValue}</b>
          </>
        )}
      </p>

      {basis !== undefined && basis !== "" && <p className={styles.basis}>{basis}</p>}

      {points.length > 0 && (
        <ul className={styles.points}>
          {points.map((point) => (
            <li key={point} className={styles.point}>
              {point}
            </li>
          ))}
        </ul>
      )}

      {nextStep !== undefined && nextStep !== "" && (
        <p className={styles.next}>
          <span className={styles.nextLabel}>Next</span>
          {nextStep}
        </p>
      )}
    </section>
  );
}
