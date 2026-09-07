import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "./clipboard.ts";
import styles from "./CopyButton.module.css";

type Status = "idle" | "copied" | "failed";

// Long enough to read "Copied" without it feeling stuck, short enough that
// clicking the same button twice in a row still looks live.
const RESET_MS = 2000;

export interface CopyButtonProps {
  /** The exact text a click writes to the clipboard — never re-derived
   * from what's on screen, so what gets pasted is always what this prop
   * says, byte for byte (the task brief's own correctness bar: "assert
   * the text, not that a handler ran"). */
  text: string;
  icon: LucideIcon;
  /** Button label before anything has happened yet — "Copy" for a
   * message's own text, "Share" for the history panel's copy-a-link
   * action. Copy rule (CLAUDE.md): the action keeps its name through the
   * flow, so this becomes "Copied" on success, never a generic spinner. */
  idleLabel: string;
  /** Distinguishes this button from its sibling when more than one
   * "Copy"/"Share" exists on screen at once (a question's and an
   * answer's, or one per history row) — screen-reader users navigating by
   * role="button" would otherwise hit several indistinguishable "Copy"
   * buttons in a row. */
  ariaLabel: string;
}

/**
 * One clipboard button, used for both per-message Copy (Thread.tsx) and
 * the history panel's Share-as-copy-a-link (HistoryPanel.tsx) — see
 * clipboard.ts for why both collapse "denied" and "API absent" to the same
 * outcome. A copy that silently does nothing is worse than no button at
 * all (task brief), so a failure never dead-ends here: it opens a
 * read-only, pre-selected text field carrying the exact same text, so
 * "select and Cmd/Ctrl+C" is the one manual step left rather than the
 * whole workaround.
 */
export function CopyButton({ text, icon: Icon, idleLabel, ariaLabel }: CopyButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function handleClick() {
    const ok = await copyText(text);
    if (ok) {
      setStatus("copied");
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setStatus("idle"), RESET_MS);
    } else {
      // No auto-reset here: the fallback below is the only way left to
      // actually get this text onto the clipboard, so it stays up until
      // the operator has had a chance to use it rather than vanishing on
      // a timer.
      setStatus("failed");
    }
  }

  const label = status === "copied" ? "Copied" : status === "failed" ? "Couldn't copy" : idleLabel;
  const btnClass = [styles.btn, status === "copied" ? styles.copied : "", status === "failed" ? styles.failed : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={styles.wrap} aria-live="polite">
      <button type="button" className={btnClass} onClick={() => void handleClick()} aria-label={ariaLabel}>
        <Icon size={13} strokeWidth={2} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {status === "failed" && (
        <span className={styles.fallback}>
          <label>
            Copy blocked by the browser — select and copy manually:
            <input
              readOnly
              className={styles.fallbackInput}
              value={text}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        </span>
      )}
    </span>
  );
}
