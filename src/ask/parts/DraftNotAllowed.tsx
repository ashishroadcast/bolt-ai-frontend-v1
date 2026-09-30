import { Info, Lock, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import type { AskDraftAccess } from "../config.tsx";
import { Sheet } from "./Sheet.tsx";
import styles from "./UnknownIntent.module.css";

export type DraftKind = "dashboard" | "form";

const NOUN: Record<DraftKind, { plural: string; title: string }> = {
  dashboard: { plural: "dashboards", title: "You can't create dashboards" },
  form: { plural: "forms", title: "You can't create forms" },
};

/** The permission sentence, for a reader whose role can't create this kind. */
export function draftNotAllowedText(kind: DraftKind): string {
  const { plural } = NOUN[kind];
  return `Your role doesn't include permission to create ${plural}. Ask an admin to grant it.`;
}

/**
 * Why this reader can't have one kind of draft here, resolved from
 * `AskConfig.draftAccess` — so the draft card's notice, the refused slash
 * command and the quick action all say the same thing.
 */
export interface DraftBlock {
  title: string;
  message: string;
  /** The composer's line for a refused slash command. */
  hint: string;
  icon: LucideIcon;
  /**
   * Leave the quick action out, rather than showing it disabled with `title`.
   * True for a missing permission, which a card has nothing useful to say
   * about; false for a host that can't offer the feature, where a disabled
   * card tells the reader where it went.
   */
  hideQuickAction: boolean;
}

/** The block for `kind`, or `null` when the reader may create it. */
export function draftBlock(kind: DraftKind, access: AskDraftAccess | undefined): DraftBlock | null {
  const value = access?.[kind];
  if (value === false) {
    const message = draftNotAllowedText(kind);
    return { title: NOUN[kind].title, message, hint: message, icon: Lock, hideQuickAction: true };
  }
  if (typeof value === "object" && value !== null) {
    return {
      title: value.title,
      message: value.message,
      hint: `${value.title}. ${value.message}`,
      icon: Info,
      hideQuickAction: false,
    };
  }
  return null;
}

/**
 * Shown in place of a dashboard or form draft the reader can't have here: no
 * permission (bolt-v2's RBAC), or a host with nowhere to open it (mobile).
 *
 * In place of, not beside: a draft card with no way to open it looks finished
 * and leads nowhere, and the answer under it still said to "open it in the
 * builder".
 */
export function DraftNotAllowed({ block }: { block: DraftBlock }): ReactElement {
  return (
    <Sheet title={block.title} icon={block.icon}>
      <p className={styles.message}>{block.message}</p>
    </Sheet>
  );
}
