import { ArrowRight, Mic, Slash, Square, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useAskConfig, type AskHostContext } from "../config.tsx";
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
 * The box is disabled only while there is truly nothing to route to yet: no
 * agents loaded for this tenant, or offline. A run in flight blocks sending,
 * never typing — runs take minutes, and the next question is often composed
 * while reading the answer to the last one.
 *
 * While a run is in flight, Ask gives way to Stop — the one action that
 * means anything then. It used to become a disabled "Asking", which named
 * the state but left no way out of a run that had stalled or gone wrong.
 */
/** The console's own wording. A host in another domain overrides it —
 * `AskConfig.copy` — because "sales, items, discounts" is nonsense on a
 * screen full of vehicles. */
const DEFAULT_PLACEHOLDER = "How can I help you?";
/** Figma F13: what the field asks once a widget is the subject. */
const REFINE_PLACEHOLDER = "Please specify what you want to change";
/** How often the chip re-reads the host's selection — see useSelectedWidget. */
const HOST_CONTEXT_POLL_MS = 1_000;
const VOICE_SILENCE_TIMEOUT_MS = 3_000;
/**
 * A soft cap: past it the question cannot be sent, but nothing is cut off.
 * `maxlength` would silently truncate a paste, and a question that loses its
 * last paragraph without saying so is worse than one that asks to be
 * shortened. agent-service sets no limit of its own; this one keeps a single
 * turn to something a person wrote rather than a document pasted whole.
 */
const MAX_QUESTION_LENGTH = 4_000;
/** When the counter appears — near the cap, not all the time. */
const SHOW_LENGTH_FROM = 3_600;

/** Sizes the box to its text; see the effects in `Composer` for when. */
function fitFieldHeight(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
  field.style.overflowY = field.scrollHeight > field.offsetHeight ? "auto" : "hidden";
}

/**
 * Whether handing focus back to the box would take it from nothing the
 * reader chose: focus is nowhere (the Stop button that had it just gave way
 * to Ask), or already in the composer.
 *
 * Inside the widget's shadow root the document sees only the host element,
 * so the root's own `activeElement` is what says where focus really is —
 * and focus elsewhere on the HOST page is left alone, always.
 */
function focusIsFree(composer: HTMLElement | null): boolean {
  if (composer === null) return false;
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  if (composer.contains(active)) return true;
  const root = composer.getRootNode();
  if (root instanceof ShadowRoot && active === root.host) {
    return root.activeElement === null || composer.contains(root.activeElement);
  }
  return false;
}

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

type TypedCommand =
  | { kind: "known"; entry: SlashCommand; rest: string }
  | { kind: "unknown"; word: string };

/**
 * A command typed out in full and sent, rather than picked from the menu.
 *
 * The menu closes at the first space, so "/form vehicle checklist" typed in
 * one go never armed anything — it went out as a routed question, slash and
 * all — and a mistyped "/fomr" went out silently the same way.
 *
 * Only a command-shaped first word counts (letters, digits, `-`, `_`), so a
 * question that starts with a path — "/api/v1 returns 500" — is still a
 * question. And only for a tenant that has commands at all: where the menu
 * never opens, a leading slash is just text.
 */
function typedCommand(text: string, commands: SlashCommand[]): TypedCommand | null {
  if (commands.length === 0) return null;
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const word = match[1]!;
  const entry = commands.find((candidate) => candidate.command.toLowerCase() === word.toLowerCase());
  if (entry === undefined) return { kind: "unknown", word };
  return { kind: "known", entry, rest: (match[2] ?? "").trim() };
}

/** "No /foo command. Try /dashboard or /form." — the real ones, in menu order. */
function unknownCommandHint(word: string, commands: SlashCommand[]): string {
  const names = commands.map((entry) => `/${entry.command}`);
  const choices = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `No /${word} command. Try ${choices}.`;
}

interface SelectedWidget {
  id: string;
  title: string;
}

function readSelectedWidget(
  provider: (() => AskHostContext | null) | undefined,
): SelectedWidget | null {
  let context: AskHostContext | null;
  try {
    context = provider?.() ?? null;
  } catch {
    return null;
  }
  const id = context?.selectedWidgetId;
  if (typeof id !== "string" || id === "") return null;
  const title = context?.dashboard?.widgets?.find((widget) => widget.id === id)?.title;
  return { id, title: typeof title === "string" && title.trim() !== "" ? title : "Selected widget" };
}

/**
 * The widget the host has selected, for the context chip (Figma F13).
 *
 * The host API is a provider, not an event: the builder answers "what is
 * selected?" when asked and never announces a change. So this asks on mount,
 * whenever a run starts or finishes (an acknowledged insert usually selects
 * the new widget), and on a slow poll in between — a sync call returning a
 * small object, cheap enough that a second of lag is the only cost. State is
 * only replaced when the answer actually changes, so the poll re-renders
 * nothing while the selection sits still.
 */
function useSelectedWidget(
  provider: (() => AskHostContext | null) | undefined,
  status: string,
): SelectedWidget | null {
  const [selected, setSelected] = useState<SelectedWidget | null>(() => readSelectedWidget(provider));

  useEffect(() => {
    const sync = () =>
      setSelected((previous) => {
        const next = readSelectedWidget(provider);
        if (previous?.id === next?.id && previous?.title === next?.title) return previous;
        return next;
      });
    sync();
    if (provider === undefined) return;
    const timer = setInterval(sync, HOST_CONTEXT_POLL_MS);
    return () => clearInterval(timer);
  }, [provider, status]);

  return selected;
}

export function Composer() {
  const { status, sendMessage, stop, notice, selectedAgent, setSelectedAgent, draft, setDraft } =
    useChatContext();
  // Starts from whatever was left half-typed when this composer last
  // unmounted (opening History, leaving /ask), and hands the text back as it
  // unmounts again — see `UseChatResult.draft` for why not on every keystroke.
  const [value, setValue] = useState(draft);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => () => setDraft(valueRef.current), [setDraft]);
  // Set when the reader presses Escape, cleared as soon as they type
  // anything else: a menu that reopens on the next keystroke after being
  // dismissed cannot be dismissed at all.
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const { copy, hostContextProvider } = useAskConfig();
  const { agents } = useAskAgents();
  const selectedWidget = useSelectedWidget(hostContextProvider, status);
  // The widget whose chip the reader dismissed. Keyed by id so selecting a
  // DIFFERENT widget in the builder brings the chip back for that one.
  const [dismissedWidgetId, setDismissedWidgetId] = useState<string | null>(null);
  const chip = selectedWidget !== null && selectedWidget.id !== dismissedWidgetId ? selectedWidget : null;
  const isOnline = useOnlineStatus();
  const stackRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Held from the mic click until the recognition exists. The permission
  // prompt in between can take seconds, and a second click in that window —
  // a double-click is enough — used to start a second recognition over the
  // first.
  const startingVoiceRef = useRef(false);
  const voiceStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceBaseRef = useRef("");
  const [isListening, setIsListening] = useState(false);
  const [isStartingVoice, setIsStartingVoice] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Set when an unknown `/word` is sent; cleared by the next keystroke.
  const [commandHint, setCommandHint] = useState<string | null>(null);
  const isStreaming = status === "streaming";
  // Not `selectedAgent !== null` — a question with no agent armed is now
  // the normal case, routed automatically once it reaches the server.
  // `agents.length > 0` is what `selectedAgent` used to gate for free (the
  // old picker never resolved a default before the list loaded, and never
  // resolved one at all for a tenant with none): still loading or truly
  // empty must still disable this, since there is nothing to route to.
  const canType = agents.length > 0 && isOnline;
  const overLimit = value.length > MAX_QUESTION_LENGTH;
  const canSend = canType && !isStreaming && !overLimit;
  const voiceSupported = speechRecognitionConstructor() !== null;

  // Grows with what is typed or pasted, up to the CSS max-height, then
  // scrolls — and shows a scrollbar only then, not a stray pair of arrows on
  // a one-line box. Measured after layout so the height never lags a
  // keystroke, and again whenever the box changes width: a panel resized
  // narrower rewraps the same text onto more lines.
  useLayoutEffect(() => {
    if (inputRef.current !== null) fitFieldHeight(inputRef.current);
  }, [value]);
  useEffect(() => {
    const field = inputRef.current;
    if (field === null || typeof ResizeObserver === "undefined") return;
    let width = field.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (field.offsetWidth === width) return;
      width = field.offsetWidth;
      fitFieldHeight(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  // Focus back to the box when a run ends, so the next question can be typed
  // straight away — unless the reader has since put it somewhere else.
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming && focusIsFree(stackRef.current)) inputRef.current?.focus();
  }, [isStreaming]);

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
  const menuOpen = !dismissed && canType && matches.length > 0;
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
    // Off the ref, not `isListening`: a click that lands before the re-render
    // would read a stale `false` and start a second recognition.
    if (recognitionRef.current !== null) {
      stopListening();
      return;
    }
    if (startingVoiceRef.current) return;

    const Recognition = speechRecognitionConstructor();
    if (Recognition === null || !canType) return;

    startingVoiceRef.current = true;
    setVoiceError(null);
    setIsStartingVoice(true);
    try {
      const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
      stream?.getTracks().forEach((track) => track.stop());
    } catch (error: unknown) {
      setVoiceError(microphoneErrorMessage(error));
      return;
    } finally {
      // Released here, and nothing below awaits: from this line to
      // `recognitionRef.current = recognition` no second click can interleave.
      startingVoiceRef.current = false;
      setIsStartingVoice(false);
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || navigator.language || "en-US";
    // Read now, not from this click's render: the permission prompt may have
    // sat open while the reader kept typing.
    voiceBaseRef.current = valueRef.current.trimEnd();

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
    setCommandHint(null);
    setHighlight(0);
    if (dismissed) setDismissed(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter mid-composition confirms an IME candidate (Japanese, Chinese,
    // Korean input); it is not the reader pressing send. 229 is what Safari
    // reports for that same keydown.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (menuOpen) handleMenuKey(event);
    if (event.isDefaultPrevented()) return;
    // Enter sends and Shift+Enter starts a new line — the convention every
    // chat box follows, now that the box can hold more than one.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function handleMenuKey(event: KeyboardEvent<HTMLTextAreaElement>) {
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
    submit();
  }

  function submit() {
    const trimmed = value.trim();
    // Blocked, not cleared: text typed during a run, or past the cap, stays
    // in the box for when it can go.
    if (trimmed === "" || !canSend) return;

    let question = trimmed;
    let agent = selectedAgent ?? undefined;
    const typed = typedCommand(trimmed, commands);
    if (typed?.kind === "unknown") {
      // Not sent: the reader meant a command, and the question as routed
      // would reach an agent with a stray "/fomr" at its front.
      setCommandHint(unknownCommandHint(typed.word, commands));
      return;
    }
    if (typed?.kind === "known") {
      // Armed exactly as choosing it from the menu would, so follow-ups keep
      // reaching it (see `choose`); whatever followed the command is the
      // question.
      setSelectedAgent(typed.entry.agent.name);
      if (typed.rest === "") {
        setValue("");
        inputRef.current?.focus();
        return;
      }
      question = typed.rest;
      agent = typed.entry.agent.name;
    }

    recognitionRef.current?.abort();
    if (voiceStopTimerRef.current !== null) clearTimeout(voiceStopTimerRef.current);
    voiceStopTimerRef.current = null;
    recognitionRef.current = null;
    setIsListening(false);
    // A dismissed chip means THIS question is not about that widget, so the
    // run is sent without it. For this one message only: the builder still
    // has it selected, and the next question may well be about it again.
    const omitSelectedWidget = selectedWidget !== null && chip === null;
    sendMessage(question, {
      agent,
      ...(omitSelectedWidget ? { omitSelectedWidget: true } : {}),
    });
    setDismissedWidgetId(null);
    setValue("");
  }

  const placeholder = !isOnline
    ? "Waiting for connection…"
    : chip !== null
      ? REFINE_PLACEHOLDER
      : (copy?.placeholder ?? DEFAULT_PLACEHOLDER);

  const lengthId = "ask-question-length";
  const showLength = value.length >= SHOW_LENGTH_FROM;

  return (
    <div className={styles.stack} ref={stackRef}>
    {chip !== null && (
      // F13's "Operation Widget ×": what the next question will be about.
      <div className={styles.context}>
        <span className={styles.contextChip}>
          <span className={styles.contextLabel} title={chip.title}>
            {chip.title}
          </span>
          <button
            type="button"
            className={styles.contextDismiss}
            aria-label={`Don't ask about ${chip.title}`}
            title="Ask about something else"
            onClick={() => {
              setDismissedWidgetId(chip.id);
              inputRef.current?.focus();
            }}
          >
            <X size={12} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </span>
      </div>
    )}
    {notice !== null && (
      // In the flow, above the pill, not a floating bubble: it explains the
      // turn just sent — "this started a new one" — and stays until the next.
      <p className={styles.notice} role="status">
        {notice}
      </p>
    )}
    {showLength && (
      <p id={lengthId} className={styles.length} data-over={overLimit || undefined}>
        {value.length.toLocaleString()} / {MAX_QUESTION_LENGTH.toLocaleString()}
        {overLimit && " — shorten it to send"}
      </p>
    )}
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
        {/* No attachment button: there is nowhere for an attachment to go
            yet — no upload endpoint exists in agent-service's wire protocol.
            Re-add the disabled Paperclip button (see git history) when one
            does. */}
        {/* A textarea, not an input: a pasted question kept its line
            breaks only as far as the paste — an <input> flattens them. */}
        <textarea
          ref={inputRef}
          rows={1}
          className={styles.field}
          placeholder={placeholder}
          aria-label="Ask a question"
          aria-describedby={showLength ? lengthId : undefined}
          aria-invalid={overLimit || undefined}
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
          disabled={!canType}
        />
      </div>
      {(voiceError ?? commandHint) !== null && (
        <span className={styles.inlineMessage} role="status">
          {voiceError ?? commandHint}
        </span>
      )}
      <button
        type="button"
        className={styles.voice}
        data-listening={isListening || undefined}
        disabled={!canType || !voiceSupported || isStartingVoice}
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
      {value === "" && commands.length > 0 && canType && (
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
          <Slash size={14} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
      {isStreaming ? (
        // In Ask's place, not beside it: while a run is in flight there is
        // nothing to send, and the one thing worth doing is ending it. Runs
        // take minutes, and before this the only way out was a reload.
        //
        // Keyed apart from Ask so React builds two elements instead of
        // retyping one. Stopping ends the run in the same click's microtasks,
        // and a single reused <button> was already type="submit" again by the
        // time the browser ran the click's default action — so Stop also
        // sent whatever had been typed meanwhile.
        <button
          key="stop"
          type="button"
          className={styles.stop}
          aria-label="Stop"
          title="Stop this answer"
          onClick={(click) => {
            // The second click of a double-click on Ask lands here, on the
            // button that just replaced it. `detail` is the platform's click
            // count, so that one is ignored rather than cancelling the run it
            // started; a keyboard press reports 0 and always counts.
            if (click.detail > 1) return;
            stop();
          }}
        >
          <Square size={10} fill="currentColor" aria-hidden="true" />
        </button>
      ) : (
        <button key="send" type="submit" className={styles.send} disabled={!canSend} aria-label="Ask">
          <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
        </button>
      )}
    </form>
    </div>
  );
}
