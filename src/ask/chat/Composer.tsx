import { ArrowRight, Paperclip, Slash } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useAskConfig } from "../config.tsx";
import { useChatContext } from "./ChatContext.tsx";
import { useAskAgents, type AskAgent } from "./useAskAgents.ts";
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

/**
 * A `/command` and the agent it runs.
 *
 * The menu is built from the agent list this caller already loads, filtered
 * to the ones an operator gave a command. Nothing here is hardcoded: a
 * tenant with no form-drafting agent gets no `/form`, because offering one
 * would send a run to an agent name that does not exist for them.
 */
interface SlashCommand {
  command: string;
  agent: AskAgent;
}

function slashCommands(agents: AskAgent[]): SlashCommand[] {
  return agents
    .filter((agent) => agent.is_active && typeof agent.slash_command === "string")
    .map((agent) => ({ command: agent.slash_command as string, agent }))
    .sort((first, second) => first.command.localeCompare(second.command));
}

/**
 * What the reader is typing, read as a command query.
 *
 * Only a leading `/` on an otherwise unbroken word opens the menu. Not
 * anywhere in the string: people type URLs, dates and units, and a menu that
 * appears over "8 km/h" is a menu that has to be dismissed constantly. Once
 * a space is typed the reader is writing a sentence, not choosing a command.
 */
function commandQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const rest = value.slice(1);
  if (/\s/.test(rest)) return null;
  return rest.toLowerCase();
}

function matching(commands: SlashCommand[], query: string): SlashCommand[] {
  if (query === "") return commands;
  return commands.filter((entry) => entry.command.startsWith(query));
}

export function Composer() {
  const [value, setValue] = useState("");
  // Set when the reader presses Escape, cleared as soon as they type
  // anything else: a menu that reopens on the next keystroke after being
  // dismissed cannot be dismissed at all.
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const { status, sendMessage, selectedAgent, setSelectedAgent } = useChatContext();
  const { copy } = useAskConfig();
  const { agents } = useAskAgents();
  const isOnline = useOnlineStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const isStreaming = status === "streaming";
  const canSend = selectedAgent !== null && !isStreaming && isOnline;

  const commands = useMemo(() => slashCommands(agents), [agents]);
  const query = commandQuery(value);
  const matches = query === null ? [] : matching(commands, query);
  const menuOpen = !dismissed && canSend && matches.length > 0;
  const active = matches[Math.min(highlight, matches.length - 1)];

  function choose(entry: SlashCommand) {
    // Arms the agent through the picker rather than through state of its own.
    // The picker sits directly above this input and already says who the
    // question goes to, so the command has a visible effect and an obvious
    // way back — and follow-ups ("make that field optional") keep reaching
    // the agent that drafted the thing being followed up on, which a
    // one-shot arming would silently lose.
    setSelectedAgent(entry.agent.name);
    setValue("");
    setDismissed(false);
    setHighlight(0);
    inputRef.current?.focus();
  }

  function handleChange(next: string) {
    setValue(next);
    setHighlight(0);
    if (dismissed) setDismissed(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!menuOpen) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => {
        const next = Math.min(current, matches.length - 1) + step;
        // Wraps, because the list is short enough that running off the end
        // and having to arrow all the way back is the only thing that
        // happens.
        return (next + matches.length) % matches.length;
      });
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (active === undefined) return;
      // Enter would otherwise submit `/form` as the question itself.
      event.preventDefault();
      choose(active);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === "" || !canSend) return;
    sendMessage(trimmed, { agent: selectedAgent ?? undefined });
    setValue("");
  }

  return (
    <form className={styles.composer} onSubmit={handleSubmit} data-offline={!isOnline || undefined}>
      {menuOpen && (
        <div className={styles.menu} id="ask-commands" role="listbox" aria-label="Commands">
          {matches.map((entry, index) => (
            <button
              key={entry.agent.id}
              type="button"
              id={`ask-command-${entry.command}`}
              role="option"
              aria-selected={entry === active}
              className={styles.command}
              data-active={entry === active || undefined}
              // Pointer down, not click: click fires after the input has
              // already lost focus, and a blur handler that closed the menu
              // would take the button with it before the click landed.
              onPointerDown={(pointer) => {
                pointer.preventDefault();
                choose(entry);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              <span className={styles.commandName}>/{entry.command}</span>
              <span className={styles.commandAgent}>{entry.agent.name}</span>
              {entry.agent.description !== undefined && entry.agent.description !== null && (
                <span className={styles.commandDesc}>{entry.agent.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
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
          ref={inputRef}
          type="text"
          className={styles.field}
          placeholder={!isOnline ? "Waiting for connection…" : (copy?.placeholder ?? DEFAULT_PLACEHOLDER)}
          aria-label="Ask a question"
          role={commands.length > 0 ? "combobox" : undefined}
          aria-expanded={commands.length > 0 ? menuOpen : undefined}
          aria-controls={menuOpen ? "ask-commands" : undefined}
          aria-activedescendant={
            menuOpen && active !== undefined ? `ask-command-${active.command}` : undefined
          }
          autoComplete="off"
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!canSend}
        />
      </div>
      {/* Discoverability, and a real control rather than a decoration: a
          slash menu nobody knows about is a slash menu nobody uses, and a
          hint that cannot be clicked is one more thing to read and ignore.
          Only rendered once the tenant actually has a command — otherwise it
          points at a key that does nothing. */}
      {value === "" && commands.length > 0 && canSend && (
        <button
          type="button"
          className={styles.hint}
          title="Commands"
          aria-label="Show commands"
          onClick={() => {
            handleChange("/");
            inputRef.current?.focus();
          }}
        >
          <Slash size={12} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
      <button type="submit" className={styles.send} disabled={!canSend} aria-label={isStreaming ? "Asking" : "Ask"}>
        <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
      </button>
    </form>
  );
}
