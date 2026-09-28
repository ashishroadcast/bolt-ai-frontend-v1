import { CircleHelp } from "lucide-react";
import type { ReactElement } from "react";
import { Sheet } from "./Sheet.tsx";
import styles from "./UnknownIntent.module.css";

interface UnknownIntentProps {
  /** The intent name the agent sent that this bundle has no component for. */
  intent: string;
}

/**
 * The required fallback for an intent this bundle predates (task brief,
 * §10.1: the agent will one day emit an intent the console doesn't know
 * yet). Renders as an honest, still-on-paper sheet instead of crashing the
 * thread or silently dropping the answer — only this one attachment
 * couldn't be shown; the answer's own text still rendered.
 *
 * Worded for wherever Ask is mounted. It said "This console doesn't yet
 * render…", which inside bolt-v2's panel names a console the reader has
 * never seen. The intent name stays in the sub-label, for whoever has to
 * work out which build is behind.
 */
export function UnknownIntent({ intent }: UnknownIntentProps): ReactElement {
  return (
    <Sheet title="Unsupported response" subLabel={intent} icon={CircleHelp}>
      <p className={styles.message}>
        This part of the answer can&rsquo;t be shown here yet. The rest of the answer is unaffected.
      </p>
    </Sheet>
  );
}
