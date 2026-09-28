import { Lock } from "lucide-react";
import type { ReactElement } from "react";
import { Sheet } from "./Sheet.tsx";
import styles from "./UnknownIntent.module.css";

export type DraftKind = "dashboard" | "form";

const NOUN: Record<DraftKind, { plural: string; title: string }> = {
  dashboard: { plural: "dashboards", title: "You can't create dashboards" },
  form: { plural: "forms", title: "You can't create forms" },
};

/**
 * The one sentence both the notice and the composer say, so a refused
 * slash command and a refused card read the same.
 */
export function draftNotAllowedText(kind: DraftKind): string {
  const { plural } = NOUN[kind];
  return `Your role doesn't include permission to create ${plural}. Ask an admin to grant it.`;
}

/**
 * Shown in place of a dashboard or form draft when the host says the reader
 * may not create one (`AskConfig.draftAccess`, bolt-v2's RBAC).
 *
 * In place of, not beside: a draft card with no way to open it — which is
 * what a reader without the permission used to get — looks finished and
 * leads nowhere, and the answer under it still said to "open it in the
 * builder".
 */
export function DraftNotAllowed({ kind }: { kind: DraftKind }): ReactElement {
  return (
    <Sheet title={NOUN[kind].title} icon={Lock}>
      <p className={styles.message}>{draftNotAllowedText(kind)}</p>
    </Sheet>
  );
}
