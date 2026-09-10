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
 */
export function UnknownIntent({ intent }: UnknownIntentProps): ReactElement {
  return (
    <Sheet title="Unsupported response" subLabel={intent} icon={CircleHelp}>
      <p className={styles.message}>
        This console doesn't yet render a &ldquo;{intent}&rdquo; result. The rest of the answer is
        unaffected.
      </p>
    </Sheet>
  );
}
