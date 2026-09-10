import { BookMarked } from "lucide-react";
import type { ReactElement } from "react";
import { Sheet } from "./Sheet.tsx";
import styles from "./Citations.module.css";

export interface Citation {
  id: string;
  /** What the source is — a document name, a partner agreement, a menu policy. */
  title: string;
  /** Where within the source: "p. 4", "§2.1", "chunk 12/54". */
  locator?: string;
  /** A short excerpt or paraphrase that grounds the answer in this source. */
  snippet?: string;
  /** Opens the source directly, when the console has somewhere to send the reader. */
  href?: string;
}

export interface CitationsProps {
  title: string;
  subLabel?: string;
  citations: Citation[];
  emptyMessage?: string;
}

/**
 * Cited sources for a knowledge answer. Not in the mockup — designed in
 * the same paper-sheet language as DataTable and DataChart: the Sheet
 * header, hairline rules between rows, mono for the locator, display type
 * for the source title.
 */
export function Citations({
  title,
  subLabel,
  citations,
  emptyMessage = "No sources cited for this answer.",
}: CitationsProps): ReactElement {
  if (citations.length === 0) {
    return (
      <Sheet title={title} subLabel={subLabel} icon={BookMarked}>
        <p className={styles.empty}>{emptyMessage}</p>
      </Sheet>
    );
  }

  return (
    <Sheet title={title} subLabel={subLabel}>
      <ol className={styles.list}>
        {citations.map((citation, index) => (
          <li key={citation.id} className={styles.item}>
            <span className={styles.index}>{index + 1}</span>
            <div className={styles.body}>
              <div className={styles.titleRow}>
                {citation.href !== undefined ? (
                  <a
                    className={`${styles.title} ${styles.link}`}
                    href={citation.href}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {citation.title}
                  </a>
                ) : (
                  <span className={styles.title}>{citation.title}</span>
                )}
                {citation.locator !== undefined && (
                  <span className={styles.locator}>{citation.locator}</span>
                )}
              </div>
              {citation.snippet !== undefined && <p className={styles.snippet}>{citation.snippet}</p>}
            </div>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}
