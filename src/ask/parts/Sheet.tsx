import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./Sheet.module.css";

interface SheetProps {
  /** What the data is — an operator-recognisable name, not a component label. */
  title: string;
  /** The qualifier that changes reading of the numbers: window, scope, "net of discounts". */
  subLabel?: string;
  /** What kind of artifact this is (a table, a chart, a citation list) —
   * optional so a caller with nothing fitting can still render a plain
   * header, but every consumer in this codebase passes one (redesign
   * brief: "icons... on card headers"). */
  icon?: LucideIcon;
  children: ReactNode;
}

/*
 * Shared by every persisted artifact — table, chart, citations — the third
 * consumer being the point at which this stopped being copy-paste (house
 * rule: extract at the third occurrence). Keeping the sheet chrome in one
 * component is what keeps a table and a chart reading as the same kind of
 * object laid on the same workbench.
 */
export function Sheet({ title, subLabel, icon: Icon, children }: SheetProps) {
  return (
    <section className={styles.sheet}>
      <header className={styles.head}>
        {Icon !== undefined && (
          <span className={styles.icon} aria-hidden="true">
            <Icon size={13} strokeWidth={2.25} />
          </span>
        )}
        <h3 className={styles.title}>{title}</h3>
        {subLabel !== undefined && <span className={styles.sub}>{subLabel}</span>}
      </header>
      {children}
    </section>
  );
}
