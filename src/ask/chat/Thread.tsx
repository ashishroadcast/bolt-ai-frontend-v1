import { Copy } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { AgentIcon } from "../AgentIcon.tsx";
import { useAgents } from "./useAskAgents.ts";
import { renderUIPart, type UIPart } from "../parts/catalog.tsx";
import { AnswerText } from "./AnswerText.tsx";
import { motionIsWelcome, useTypewriter } from "./typewriter.ts";
import { useStickToBottom } from "./useStickToBottom.ts";
import { useAskClient, useAskInspector } from "../config.tsx";
import type { GatewayClient } from "../http/gatewayClient.ts";
import { CopyButton } from "./CopyButton.tsx";
import { useChatContext } from "./ChatContext.tsx";
import { arrangeParts } from "./partLayout.ts";
import type { PhaseSegment } from "./phaseTimeline.ts";
import { answerQuestion, forgetCachedPlan } from "./feedbackApi.ts";
import { ReasoningCard } from "./ReasoningCard.tsx";
import { Thinking } from "./Thinking.tsx";
import { useAskDisclosure } from "./useDisclosure.ts";
import { useOnlineStatus } from "./useOnlineStatus.ts";
import { RunWaiting } from "./RunWaiting.tsx";
import { RunDebug } from "./RunDebug.tsx";
import { RerunButton, RunMeta } from "./RunMeta.tsx";
import { EMPTY_TRACE, formatDuration, type RunTrace } from "./runTrace.ts";
import styles from "./Thread.module.css";
import type { ChatMessage } from "./types.ts";

/**
 * Figma's "AI assistant - Network lost": the browser has no connection at
 * all, so there is nothing to wait ON — showing the ordinary spinner would
 * say "still working" about a request that cannot even be sent. Composer
 * already disables itself the same way (`useOnlineStatus.ts`); this is the
 * matching notice for a run that was already in flight when the connection
 * dropped.
 */
function NetworkLostNotice(): ReactElement {
  return (
    <div className={styles.networkLost} role="status">
      <span className={styles.networkLostIcon} aria-hidden="true">
        <AgentIcon size={16} />
      </span>
      <span className={styles.networkLostLabel}>Network connection lost!</span>
    </div>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A question part rendered in a LIVE run gets a way to answer; the same
 * part re-read from history does not, because that run ended long ago and
 * the form would be a control that cannot do anything.
 */
/**
 * Whether the reading is already on screen as a laid-out panel.
 *
 * `show_summary` writes the same words twice on purpose — as a
 * `data-summary` part for the eye, and as prose for the judge, the stored
 * message and Copy. Rendering both prints the answer to the reader twice,
 * once styled and once as a markdown restatement under the evidence. The
 * panel is the rendering; the prose stays in `message.content`, where Copy
 * and the judge read it.
 */
function rendersItsOwnProse(parts: UIPart[]): boolean {
  return parts.some((part) => part.intent === "data-summary");
}

/**
 * Parts that are the ANSWER, and so are never hidden by a disclosure
 * setting.
 *
 * `showQueryResults` exists to keep the working — the tables a run scanned
 * on its way to a figure — off a screen whose reader did not ask for it.
 * That is the right default for evidence. It is the wrong default for a
 * drafted form: the card *is* what was asked for, and it carries the only
 * control on the turn. Observed on a live run against the real widget — the
 * answer read "Here is a draft of the Vehicle Registration Record form" and
 * there was no form anywhere on screen, because a tenant setting about SQL
 * tables had swallowed it.
 */
const NEVER_HIDDEN = new Set([
  "data-form-draft",
  // The same bug waiting to happen twice more: a drafted View or widget is
  // the answer and carries the turn's only controls ("Open in builder",
  // "Edit Widget"), so a tenant setting about SQL tables must not hide it.
  "data-dashboard-draft",
  "data-widget-draft",
]);

function splitByDisclosure(parts: UIPart[]): { answer: UIPart[]; evidence: UIPart[] } {
  return {
    answer: parts.filter((part) => NEVER_HIDDEN.has(part.intent)),
    evidence: parts.filter((part) => !NEVER_HIDDEN.has(part.intent)),
  };
}

function withAnswering(
  client: GatewayClient,
  parts: UIPart[],
  isLive: boolean,
): UIPart[] {
  if (!isLive) return parts;
  return parts.map((part) =>
    part.intent === "data-question"
      ? {
          ...part,
          data: {
            ...(part.data as Record<string, unknown>),
            onAnswer: (questionId: string, answer: string) => answerQuestion(client, questionId, answer),
          },
        }
      : part,
  );
}

function PartList({ parts }: { parts: UIPart[] }): ReactElement {
  return (
    <>
      {parts.map((part, index) => (
        // Positional key: most wire parts carry no stable id of their own
        // (catalog.tsx's UIPart.data is intent-specific, not a keyed
        // entity list) — the same convention DataTable's own row map uses.
        // eslint-disable-next-line react/no-array-index-key
        <div key={index}>{renderUIPart(part)}</div>
      ))}
    </>
  );
}

/**
 * A message's persisted parts, rendered through the catalog — never a
 * second mapping. Identical whether `parts` arrived live (this session's
 * own run) or was hydrated from `messages.meta.ui_parts` on reopen
 * (`conversation.hydrateMessages`) — the two converge on the same
 * `UIPart[]` shape upstream, so this component has no way to tell them
 * apart and does not need to.
 *
 * The arrangement — what leads, what collapses — lives in `partLayout.ts`,
 * where its rules can be read and tested without a render; see that
 * module for why the automatic table is folded away only when the agent
 * actually composed an answer above it.
 */
function Sheets({ parts }: { parts: UIPart[] }): ReactElement {
  const { shown, evidence, evidenceLabel } = arrangeParts(parts);

  return (
    <>
      <PartList parts={shown} />
      {evidence.length > 0 && (
        <details className={styles.evidence}>
          <summary className={styles.evidenceSummary}>{evidenceLabel}</summary>
          <PartList parts={evidence} />
        </details>
      )}
    </>
  );
}

/**
 * The answer, revealed at reading pace rather than pasted in.
 *
 * Its own component so a reveal ticking every frame re-renders this
 * subtree alone — the reasoning card, the sheets and the metadata strip
 * beside it have nothing to say sixty times a second.
 *
 * `animate` is the caller's policy ("did this session watch this run
 * happen"); whether it *has* already played, and how far, belongs to
 * `typewriter.ts`, which is the only thing that can know it across the
 * hand-off from the live run to the message that replaces it.
 */
function RevealedAnswer({
  messageId,
  text,
  animate,
}: {
  messageId: string;
  text: string;
  animate: boolean;
}): ReactElement | null {
  const visibleChars = useTypewriter(messageId, text, animate && motionIsWelcome());
  return <AnswerText text={text} visibleChars={visibleChars} />;
}

interface AskedBubbleProps {
  message: ChatMessage;
  onRerun: () => void;
  rerunDisabled: boolean;
}

/**
 * The question, as one side of a conversation.
 *
 * Saurabh: "chat window not looking like chat window". The two sides were
 * both plain blocks on the page differing only in whether they had a
 * border, so a thread read as an essay rather than an exchange. The side
 * is now carried by three things at once — which edge it sits on, that it
 * is filled rather than outlined, and that it is held to a bubble's width
 * instead of the column's — so it survives greyscale and a screenshot.
 *
 * The stamp and the actions moved below the bubble: inside it they were
 * part of the sentence a reader was trying to read.
 */
function AskedBubble({ message, onRerun, rerunDisabled }: AskedBubbleProps): ReactElement {
  return (
    <div className={styles.askedTurn}>
      <div className={styles.asked}>{message.content}</div>
      <div className={styles.askedFoot}>
        <span className={styles.stamp}>{formatTime(message.createdAt)} · you</span>
        <CopyButton text={message.content} icon={Copy} idleLabel="Copy" ariaLabel="Copy question" />
        <RerunButton onRerun={onRerun} disabled={rerunDisabled} />
      </div>
    </div>
  );
}

/**
 * The answering side's own frame: an agent tile in the gutter, the answer
 * beside it. The tile is the counterweight to the question's bubble —
 * without one, an answer was ink on the page background and the exchange
 * had only one visible participant.
 *
 * Decorative on purpose. Who answered is already named twice in an
 * answer (the reasoning card, and the strip beneath it, deliberately —
 * see RunMeta.tsx), and a third copy of the name in the gutter would be
 * noise rather than identity.
 */
function AgentTurn({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className={styles.answerTurn}>
      <span className={styles.avatar} aria-hidden="true">
        <AgentIcon size={14} />
      </span>
      <div className={styles.answer}>{children}</div>
    </div>
  );
}

/**
 * Turns a reasoning row's phase name back into the `PhaseSegment` the
 * shell inspector takes. The two derivations (`phaseTimeline.ts`'s
 * segments and `runTrace.ts`'s steps) read the same `data-phase` parts in
 * the same order, so matching on the name is exact rather than a
 * best-effort join — and a name with no segment simply doesn't open the
 * inspector, instead of opening it on the wrong phase.
 */
function selectByPhaseName(
  segments: PhaseSegment[],
  selectPhase: (segment: PhaseSegment) => void,
): (phase: string) => void {
  return (phase: string) => {
    const segment = segments.find((candidate) => candidate.phase === phase);
    if (segment !== undefined) selectPhase(segment);
  };
}

interface AnsweredTurnProps {
  message: ChatMessage;
  /**
   * Who answered, when this turn was reopened rather than streamed —
   * resolved from `messages.agent_id` against the agent list the Ask
   * screen already loads. `null` for an id that matches no current agent
   * (one since deleted, or a list that has not loaded yet): the strip then
   * names nobody, which is the only honest option, rather than falling
   * back to whichever agent the picker happens to be showing now. That
   * fallback is the specific bug this prop exists to make impossible —
   * the picker's current selection has nothing to do with who answered a
   * turn from last week.
   */
  hydratedAgentName?: string | null;
  /** Undefined only when this message has no preceding user turn to
   * re-ask — shouldn't happen in practice (every assistant message this
   * console ever produces follows the user turn that started it), but a
   * defensive `undefined` here hides Rerun rather than wiring it to ask
   * nothing. */
  onRerun?: () => void;
  /** Forget the cached plan behind this answer and run it fresh —
   * passed only for an answer that was served from the plan cache. */
  onRetryFresh?: () => void;
  rerunDisabled: boolean;
}

/**
 * One finished answer, top to bottom: what the run did, what it found,
 * then what it cost and how to check it.
 *
 * The order is the point. The reasoning card is inline and first because
 * an analytics answer is only worth as much as the work behind it; the
 * table and the prose come next; the measurements and the debug drawer
 * come last, because they are for the reader who is checking rather than
 * reading. The previous layout put a 150px column of run metadata to the
 * *left* of every answer, which read as chrome and — once the viewport
 * narrowed — stacked above the answer as a stranded chip.
 *
 * A reopened message has no `runSummary` at all (its transient phase
 * parts were never persisted), so it renders no reasoning card and no
 * debug toggle — but it does still carry `usage`, so the strip keeps
 * reporting the run's cost and model. Its persisted duration is not used
 * as end-to-end time because it records provider timings.
 */

/**
 * Whether this answer was served from the plan cache — a plan phase the
 * stream marked `cached`. Only then is there a cached plan to forget.
 */
function usedCachedPlan(message: ChatMessage): boolean {
  const phases = message.runSummary?.trace.phases ?? [];
  return phases.some((phase) => phase.phase === "plan" && phase.state === "cached");
}

/** The actual client-measured elapsed time for this live run. Historical
 * usage.duration_ms is provider model time, so it must not be presented as
 * end-to-end time in the "Worked For" header. */
function workedForMs(message: ChatMessage): number | null {
  if (message.runSummary?.status === "error") return null;
  return message.runSummary?.totalMs ?? null;
}

function AnsweredTurn({
  message,
  onRerun,
  onRetryFresh,
  rerunDisabled,
  hydratedAgentName = null,
}: AnsweredTurnProps): ReactElement {
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const { selection, selectPhase } = useAskInspector();

  const summary = message.runSummary;
  // The run's own record first (this session watched it), the persisted
  // agent_id second. Never the current picker selection.
  const disclosure = useAskDisclosure();
  const agentName = summary?.agentName ?? hydratedAgentName;
  const trace: RunTrace = summary?.trace ?? EMPTY_TRACE;
  const hasDebug = trace.tools.length > 0 || trace.executedSql !== null || trace.reasoning !== null;

  return (
    <AgentTurn>
      {summary !== undefined && summary.status === "error" && (
        <div role="alert" className={styles.failure}>
          <span className={styles.failureIcon} aria-hidden="true">
            <AgentIcon size={16} />
          </span>
          <span className={styles.failureBody}>
            <span className={styles.failureTitle}>Something went wrong</span>
            <span className={styles.failureDetail}>{summary.errorText} Try asking again.</span>
          </span>
        </div>
      )}

      {disclosure.showReasoning && trace.steps.length > 0 && summary !== undefined && (
        <ReasoningCard
          steps={trace.steps}
          agentName={agentName}
          onSelectPhase={selectByPhaseName(summary.segments, selectPhase)}
          selectedPhase={selection?.phase ?? null}
        />
      )}

      {/* Only a run this session actually watched may animate — a
          conversation reopened from history has no runSummary at all
          (types.ts), and text that types itself out on a message from
          last week reads as a bug rather than as a stream. */}
      {/* Panels first, prose last.
          Saurabh: "can the summary come in last?" — and it is the right
          order for more than taste. The panels ARE the figures; the prose
          is a reading OF them, and a reading that arrives before the thing
          it reads has to restate it to make sense. Putting them this way
          round is also the chronological order: the sheets come from tool
          calls made during execute, while the answer is written last. */}
      <Sheets parts={splitByDisclosure(message.parts).answer} />
      {disclosure.showQueryResults && (
        <Sheets parts={splitByDisclosure(message.parts).evidence} />
      )}
      {/* Figma's "Worked For 12m" — the same duration RunMeta's facts strip
          reports below, surfaced again here because Figma places it as the
          answer's own header rather than only in the measurements strip. */}
      {workedForMs(message) !== null && (
        <p className={styles.answerHeader}>
          <span className={styles.answerHeaderLead}>Worked For </span>
          <span className={styles.answerHeaderValue}>{formatDuration(workedForMs(message)!)}</span>
        </p>
      )}
      {!rendersItsOwnProse(message.parts) && (
        <RevealedAnswer
          messageId={message.id}
          text={message.content}
          animate={summary !== undefined}
        />
      )}

      <RunMeta
        messageId={message.id}
        answerText={message.content}
        agentName={agentName}
        toolCount={summary !== undefined ? trace.tools.length : null}
        score={trace.score}
        usage={message.usage ?? null}
        observedMs={summary?.totalMs ?? null}
        onRerun={onRerun}
        onRetryFresh={onRetryFresh}
        rerunDisabled={rerunDisabled}
        isDebugOpen={isDebugOpen}
        onToggleDebug={hasDebug ? () => setIsDebugOpen((open) => !open) : undefined}
      />

      {isDebugOpen && hasDebug && <RunDebug trace={trace} />}
    </AgentTurn>
  );
}

/**
 * The run currently in flight. It renders the same reasoning card the
 * finished turn does, filling in step by step as parts arrive — so the
 * shape of an answer never changes at the moment it completes, which is
 * what made the old rail-then-chip transition read as two different
 * screens.
 */
function LiveTurn(): ReactElement | null {
  const client = useAskClient();
  const { activeRun } = useChatContext();
  const { selection, selectPhase } = useAskInspector();
  const disclosure = useAskDisclosure();
  const isOnline = useOnlineStatus();

  if (activeRun === null) return null;

  const isWaiting = activeRun.text === "";

  return (
    <AgentTurn>
      {/* The connection notice pre-empts both the reasoning card and the
          simple Thinking line while the run is still waiting on an answer
          — there is nothing to report progress ON with no connection at
          all. Once an answer starts arriving the run is clearly still
          getting through, so this never covers real content. */}
      {!isOnline && isWaiting ? (
        <NetworkLostNotice />
      ) : disclosure.showReasoning ? (
        /* One or the other, never both: the card IS the detailed version of
           what `Thinking` says in a line, and showing both would be the
           machinery this setting exists to remove, plus a duplicate. */
        <ReasoningCard
          steps={activeRun.trace.steps}
          agentName={activeRun.agentName}
          isStreaming
          onSelectPhase={selectByPhaseName(activeRun.segments, selectPhase)}
          selectedPhase={selection?.phase ?? null}
        />
      ) : (
        isWaiting && <Thinking steps={activeRun.trace.steps} startedAt={activeRun.startedAt} />
      )}
      {/* What it is doing and for how long, plus the reasoning while it is
          being written — and only until the answer starts. A status line
          still counting beside a finished answer is worse than none, and
          two blocks of live text at once would leave a reader working out
          which one they asked for. */}
      {isOnline && disclosure.showReasoning && isWaiting && (
        <RunWaiting
          trace={activeRun.trace}
          startedAt={activeRun.startedAt}
          thought={activeRun.thought}
        />
      )}
      {/* Same reveal, same id: `ActiveRun.messageId` is the id the
          finished `ChatMessage` carries, so the animation carries on from
          where it was instead of restarting the moment the run ends. */}
      {/* A question is addressed by its own id, so this passes liveness
          rather than an identifier. It used to hand over the run's MESSAGE
          id, which the endpoint accepted only because it never read the
          run segment at all. */}
      <Sheets parts={splitByDisclosure(withAnswering(client, activeRun.parts, true)).answer} />
      {disclosure.showQueryResults && (
        <Sheets parts={splitByDisclosure(withAnswering(client, activeRun.parts, true)).evidence} />
      )}
      {!rendersItsOwnProse(activeRun.parts) && (
        <RevealedAnswer messageId={activeRun.messageId} text={activeRun.text} animate />
      )}
    </AgentTurn>
  );
}

export function Thread(): ReactElement {
  const client = useAskClient();
  const { messages, sendMessage, selectedAgent, status } = useChatContext();
  // Only ever used to turn a *persisted* `agent_id` into the name that id
  // belongs to — never to fill in an agent for a turn whose own record
  // does not name one.
  const { agents } = useAgents();
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  // Same rule `sendMessage` already enforces (useChat.ts: "wait for this
  // run to finish before asking again") — disabling Rerun while one is in
  // flight surfaces that rule at the point someone would hit it, instead
  // of a click that silently turns into `error` text elsewhere.
  const rerunDisabled = status === "streaming";
  // Follows its own tail as an answer streams and its sheets lay out —
  // without this the thing being waited for arrives below the fold and
  // stays there. Dropped the moment a reader scrolls up.
  const threadRef = useStickToBottom<HTMLDivElement>();

  function rerun(questionText: string, agent?: string) {
    sendMessage(questionText, { agent: agent ?? selectedAgent ?? undefined });
  }

  return (
    <div className={styles.thread} ref={threadRef}>
      {messages.map((message, index) => {
        if (message.role === "user") {
          return (
            <AskedBubble
              key={message.id}
              message={message}
              onRerun={() => rerun(message.content)}
              rerunDisabled={rerunDisabled}
            />
          );
        }

        // Messages strictly alternate user -> assistant, one pair per ask
        // (useChat.ts's runTurn appends the user turn immediately, the
        // assistant turn only on finish; conversation.hydrateMessages
        // preserves the same order from the wire) — so the turn this
        // answer belongs to is always the message right before it.
        const question = messages[index - 1];
        const questionText = question?.role === "user" ? question.content : null;
        // Prefer the agent this run actually used (RunSummary.agentName,
        // set for anything streamed this session) over whatever's
        // currently selected in the picker — a rerun should ask the same
        // agent the original answer came from, not whichever one the
        // operator has since switched to. A reopened, hydrated message has
        // no runSummary at all (types.ts's own docstring), so it falls
        // through to `rerun`'s own `selectedAgent` fallback instead.
        return (
          <AnsweredTurn
            key={message.id}
            message={message}
            onRerun={
              questionText !== null
                ? () => rerun(questionText, message.runSummary?.agentName ?? undefined)
                : undefined
            }
            onRetryFresh={
              questionText !== null && usedCachedPlan(message)
                ? () => {
                    const agent = message.runSummary?.agentName ?? selectedAgent ?? null;
                    // Forget first, then re-ask — the re-ask must land AFTER
                    // the plan is gone or it just serves the same cache again.
                    // A forget that fails (nothing cached, a network blip)
                    // must not swallow the retry, so rerun runs regardless.
                    void forgetCachedPlan(client, agent, questionText).finally(() =>
                      rerun(questionText, agent ?? undefined),
                    );
                  }
                : undefined
            }
            rerunDisabled={rerunDisabled}
            hydratedAgentName={
              message.agentId === null || message.agentId === undefined
                ? null
                : (agentNameById.get(message.agentId) ?? null)
            }
          />
        );
      })}
      <LiveTurn />
    </div>
  );
}
