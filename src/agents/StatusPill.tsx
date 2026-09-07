import styles from "./StatusPill.module.css";

export type StatusPillTone = "good" | "amber" | "critical" | "neutral";

interface StatusPillProps {
  tone: StatusPillTone;
  label: string;
}

/** A dot plus a word — never colour alone (task brief: "semantic state
 * carries form as well as colour"). Reused everywhere this console shows
 * an active/inactive, pass/fail or held state. */
export function StatusPill({ tone, label }: StatusPillProps) {
  return <span className={`${styles.pill} ${styles[tone]}`}>{label}</span>;
}
