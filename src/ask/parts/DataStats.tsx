import { Sigma } from "lucide-react";
import type { ReactElement } from "react";
import { Sheet } from "./Sheet.tsx";
import styles from "./DataStats.module.css";

export interface DataStatsFigure {
  /** What the figure is — "Median net sales", "IQR", "Stores". */
  label: string;
  /**
   * The figure, already formatted for a reader ("₹9,44,220.66").
   *
   * A string, not a number with a type beside it, and that is the whole
   * point rather than a shortcut: `agent-service/app/stream/columns.py` is
   * the one formatter in this system, and the model's own prose is
   * rendered through it too, so a tile and the sentence above it can never
   * disagree about a rupee figure. `DataTable` takes numbers instead
   * because a table column needs its kind for alignment anyway; a single
   * tile has nothing to align against.
   */
  value: string;
}

export interface DataStatsProps {
  title: string;
  /** The qualifier that changes how the figures read: window, basis, scope. */
  subLabel?: string;
  figures: DataStatsFigure[];
}

/**
 * The answer, when the answer is two or three figures.
 *
 * A question like "what is the median store and how wide is the spread?"
 * used to render as a paragraph followed by 265 rows of per-store
 * evidence, with the two figures actually asked for appearing in no
 * component at all. This is the component `--text-stat` was defined for
 * and never built against ("a count is the point of a stat tile and has to
 * land before anything else does", `styles/tokens.css`).
 *
 * Figures are mono and tabular for the same reason every other numeric
 * cell in this console is: this business reads columns of figures, and two
 * tiles side by side should line up on their decimal point.
 *
 * Four figures is the working ceiling, enforced by the `show_stats` tool
 * that produces these: a rupee figure in Indian grouping is twelve
 * monospaced characters, and past four tiles a thread column leaves each
 * one too narrow to set that at a size worth calling a headline.
 */
export function DataStats({ title, subLabel, figures }: DataStatsProps): ReactElement {
  if (figures.length === 0) {
    return (
      <Sheet title={title} subLabel={subLabel} icon={Sigma}>
        <p className={styles.empty}>No figures for this window.</p>
      </Sheet>
    );
  }

  return (
    <Sheet title={title} subLabel={subLabel} icon={Sigma}>
      {/* A description list, not a grid of divs: these are label/value
          pairs, and a screen reader should read them as pairs rather than
          as eight unrelated fragments.

          `data-count` is the one thing the stylesheet cannot work out for
          itself and needs: how big a figure can be set depends on how many
          share the row, and it must be the same for every tile whatever
          line each lands on. See DataStats.module.css. */}
      <dl className={styles.row} data-count={figures.length}>
        {figures.map((figure, index) => (
          // Positional key: two figures over the same column can legitimately
          // share a label, and a snapshot of one render has nothing else
          // unique to key on — the same convention DataTable's rows use.
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className={styles.figure}>
            {/* Titles, so a label clamped to two lines — or a figure that
                had to wrap — can still be read whole on hover. */}
            <dt className={styles.label} title={figure.label}>
              {figure.label}
            </dt>
            <dd className={styles.value} title={figure.value}>
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
