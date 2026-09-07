import type { LucideIcon } from "lucide-react";
import styles from "./EmptyState.module.css";

interface EmptyStateProps {
  /** A lucide icon component, not a unicode glyph — the glyphs this
   * console shipped with (▸ ▤ ◇ ◈ ⚑) read as broken placeholder characters
   * rather than icons (redesign brief). Rendered in a tinted tile
   * (--signal-soft behind a --signal icon) so an empty screen still carries
   * the accent instead of reading as bare grey. */
  icon: LucideIcon;
  title: string;
  /** One line, maybe two — an empty screen is an invitation to act, not a
   * paragraph to read (redesign brief: "tighten to a line or two"). */
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, title, body, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <span className={styles.iconTile} aria-hidden="true">
        <Icon size={20} strokeWidth={2} />
      </span>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {actionLabel !== undefined && (
        <button type="button" className={styles.action} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
