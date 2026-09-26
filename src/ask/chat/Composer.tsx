import { ArrowRight, Mic, Paperclip, Slash, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
 * Sends `selectedAgent` from `ChatContext` when a slash command has
 * explicitly armed one (`choose()` below) — otherwise omits `agent`
 * entirely, so `app.api.run._choose_agent` routes the question itself.
 * Disabled only while there is truly nothing to route to yet: no agents
 * loaded for this tenant, streaming, or offline.
 *
 * Copy rule (task brief): an action keeps its name through the flow —
 * "Ask" becomes "Asking" while a run is in flight, never a spinner with no
 * label of its own.
 */
/** The console's own wording. A host in another domain overrides it —
 * `AskConfig.copy` — because "sales, items, discounts" is nonsense on a
 * screen full of vehicles. */
const DEFAULT_PLACEHOLDER = "How can I help you?";
const VOICE_SILENCE_TIMEOUT_MS = 3_000;

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function voiceErrorMessage(error: string): string {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone access was denied. Allow it in your browser settings.";
  }
  if (error === "audio-capture") return "No microphone was found.";
  if (error === "no-speech") return "No speech detected. Try again.";
  if (error === "network") {
    return "Chrome couldn't reach its speech service. Check your connection, VPN, or firewall.";
  }
  if (error === "language-not-supported") {
    return "Voice input doesn't support this browser language. Try English in Chrome.";
  }
  return `Voice input failed (${error}). Try again.`;
}

function microphoneErrorMessage(error: unknown): string {
  if (!(error instanceof DOMException)) return "Microphone access failed. Try again.";
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Microphone access was denied. Allow it in your browser settings.";
  }
  if (error.name === "NotFoundError") return "No microphone was found.";
  if (error.name === "NotReadableError") {
    return "The microphone is unavailable or already in use by another app.";
  }
  return `Microphone access failed (${error.name}). Try again.`;
}

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
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceBaseRef = useRef("");
  const [isListening, setIsListening] = useState(false);
  const [isStartingVoice, setIsStartingVoice] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const isStreaming = status === "streaming";
  // Not `selectedAgent !== null` — a question with no agent armed is now
  // the normal case, routed automatically once it reaches the server.
  // `agents.length > 0` is what `selectedAgent` used to gate for free (the
  // old picker never resolved a default before the list loaded, and never
  // resolved one at all for a tenant with none): still loading or truly
  // empty must still disable this, since there is nothing to route to.
  const canSend = agents.length > 0 && !isStreaming && isOnline;
  const voiceSupported = speechRecognitionConstructor() !== null;

  useEffect(
    () => () => {
      if (voiceStopTimerRef.current !== null) clearTimeout(voiceStopTimerRef.current);
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const commands = useMemo(() => slashCommands(agents), [agents]);
  const query = commandQuery(value);
  const matches = query === null ? [] : matching(commands, query);
  const menuOpen = !dismissed && canSend && matches.length > 0;
  const active = matches[Math.min(highlight, matches.length - 1)];

  function choose(entry: SlashCommand) {
    // Arms the agent through ChatContext rather than through state of its
    // own, so it outlives this one turn: follow-ups ("make that field
    // optional") keep reaching the agent that drafted the thing being
    // followed up on, which a one-shot arming would silently lose. Shown
    // back to the reader as a "Chatting with X" line above the thread
    // (AgentPicker.tsx) — the one case that bar still has something to say,
    // now that it no longer offers a menu to change it.
    setSelectedAgent(entry.agent.name);
    setValue("");
    setDismissed(false);
    setHighlight(0);
    inputRef.current?.focus();
  }

  function stopListening() {
    if (voiceStopTimerRef.current !== null) {
      clearTimeout(voiceStopTimerRef.current);
      voiceStopTimerRef.current = null;
    }
    recognitionRef.current?.stop();
  }

  async function startListening() {
    if (isListening) {
      stopListening();
      return;
    }

    const Recognition = speechRecognitionConstructor();
    if (Recognition === null || !canSend) return;

    setVoiceError(null);
    setIsStartingVoice(true);
    try {
      const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
      stream?.getTracks().forEach((track) => track.stop());
    } catch (error: unknown) {
      setVoiceError(microphoneErrorMessage(error));
      setIsStartingVoice(false);
      return;
    }
    setIsStartingVoice(false);

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || navigator.language || "en-US";
    voiceBaseRef.current = value.trimEnd();

    recognition.onresult = (event) => {
      const parts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result?.[0];
        if (alternative !== undefined) parts.push(alternative.transcript);
      }
      const spoken = parts.join(" ").trim();
      const separator = voiceBaseRef.current === "" || spoken === "" ? "" : " ";
      setValue(`${voiceBaseRef.current}${separator}${spoken}`);
      setDismissed(false);
      setHighlight(0);
      if (voiceStopTimerRef.current !== null) clearTimeout(voiceStopTimerRef.current);
      voiceStopTimerRef.current = setTimeout(() => {
        voiceStopTimerRef.current = null;
        recognition.stop();
      }, VOICE_SILENCE_TIMEOUT_MS);
    };
    recognition.onerror = (event) => {
      if (voiceStopTimerRef.current !== null) clearTimeout(voiceStopTimerRef.current);
      voiceStopTimerRef.current = null;
      setVoiceError(voiceErrorMessage(event.error));
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognition.onend = () => {
      if (voiceStopTimerRef.current !== null) clearTimeout(voiceStopTimerRef.current);
      voiceStopTimerRef.current = null;
      setIsListening(false);
      recognitionRef.current = null;
      inputRef.current?.focus();
    };

    recognitionRef.current = recognition;
    setIsListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
      setVoiceError("Voice input couldn't start. Try again.");
    }
  }

  function handleChange(next: string) {
    setValue(next);
    setVoiceError(null);
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
    recognitionRef.current?.abort();
    if (voiceStopTimerRef.current !== null) clearTimeout(voiceStopTimerRef.current);
    voiceStopTimerRef.current = null;
    recognitionRef.current = null;
    setIsListening(false);
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
      {voiceError !== null && (
        <span className={styles.voiceMessage} role="status">
          {voiceError}
        </span>
      )}
      <button
        type="button"
        className={styles.voice}
        data-listening={isListening || undefined}
        disabled={!canSend || !voiceSupported}
        aria-label={
          !voiceSupported
            ? "Voice input isn't supported in this browser"
            : isStartingVoice
              ? "Requesting microphone access"
            : isListening
              ? "Stop voice input"
              : "Start voice input"
        }
        title={
          !voiceSupported
            ? "Voice input isn't supported in this browser"
            : isListening
              ? "Listening — stops after 3 seconds of silence"
              : "Use voice input"
        }
        onClick={() => void startListening()}
      >
        {isListening ? (
          <Square size={11} fill="currentColor" aria-hidden="true" />
        ) : (
          <Mic size={15} strokeWidth={2.25} aria-hidden="true" />
        )}
      </button>
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
