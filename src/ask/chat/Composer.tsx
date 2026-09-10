import { useState, type FormEvent } from "react";
import { useAskConfig } from "../config.tsx";
import { useChatContext } from "./ChatContext.tsx";
import styles from "./Composer.module.css";

/*
 * Owned by AskRoute now, not global shell chrome — Saurabh: pinning this
 * to the bottom of every screen "implies you can type a question into a
 * database list." Composer.tsx stays a standalone component (Shell.tsx no
 * longer imports it) purely so AskRoute.tsx doesn't carry its markup
 * inline, not because anything else renders it.
 *
 * Sends to `selectedAgent` from `ChatContext` (`AgentPicker.tsx` sets it)
 * — disabled while that's `null`, i.e. before the picker has resolved a
 * default or when the tenant has no agent at all, so this can never fire
 * a run with no agent named on the wire.
 *
 * Copy rule (task brief): an action keeps its name through the flow —
 * "Ask" becomes "Asking" while a run is in flight, never a spinner with no
 * label of its own.
 */
/** The console's own wording. A host in another domain overrides it —
 * `AskConfig.copy` — because "sales, items, discounts" is nonsense on a
 * screen full of vehicles. */
const DEFAULT_PLACEHOLDER = "Ask about sales, items, discounts, taxes or partners…";

export function Composer() {
  const [value, setValue] = useState("");
  const { status, sendMessage, selectedAgent } = useChatContext();
  const { copy } = useAskConfig();
  const isStreaming = status === "streaming";
  const canSend = selectedAgent !== null && !isStreaming;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === "" || !canSend) return;
    sendMessage(trimmed, { agent: selectedAgent ?? undefined });
    setValue("");
  }

  return (
    <form className={styles.composer} onSubmit={handleSubmit}>
      <input
        type="text"
        className={styles.field}
        placeholder={copy?.placeholder ?? DEFAULT_PLACEHOLDER}
        aria-label="Ask a question"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={!canSend}
      />
      <button type="submit" className={styles.btn} disabled={!canSend}>
        {isStreaming ? "Asking" : "Ask"}
      </button>
      <span className={styles.hint}>Enter to send</span>
    </form>
  );
}
