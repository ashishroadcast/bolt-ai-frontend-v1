import { ArrowRight, Paperclip } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useAskConfig } from "../config.tsx";
import { useChatContext } from "./ChatContext.tsx";
import { useOnlineStatus } from "./useOnlineStatus.ts";
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
const DEFAULT_PLACEHOLDER = "How can I help you?";

export function Composer() {
  const [value, setValue] = useState("");
  const { status, sendMessage, selectedAgent } = useChatContext();
  const { copy } = useAskConfig();
  const isOnline = useOnlineStatus();
  const isStreaming = status === "streaming";
  const canSend = selectedAgent !== null && !isStreaming && isOnline;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === "" || !canSend) return;
    sendMessage(trimmed, { agent: selectedAgent ?? undefined });
    setValue("");
  }

  return (
    <form className={styles.composer} onSubmit={handleSubmit} data-offline={!isOnline || undefined}>
      <div className={styles.leftBox}>
        {/* Visible per the design, but there is nowhere for an attachment
            to go yet — no upload endpoint exists in agent-service's wire
            protocol. Disabled rather than wired to nothing, which would be
            a click that silently does nothing at all. */}
        <button
          type="button"
          className={styles.paperclipBtn}
          disabled
          aria-label="Attachments aren't supported yet"
          title="Attachments aren't supported yet"
        >
          <Paperclip size={18} strokeWidth={2} aria-hidden="true" />
        </button>
        <input
          type="text"
          className={styles.field}
          placeholder={!isOnline ? "Waiting for connection…" : (copy?.placeholder ?? DEFAULT_PLACEHOLDER)}
          aria-label="Ask a question"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={!canSend}
        />
      </div>
      <button type="submit" className={styles.send} disabled={!canSend} aria-label={isStreaming ? "Asking" : "Ask"}>
        <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
      </button>
    </form>
  );
}
