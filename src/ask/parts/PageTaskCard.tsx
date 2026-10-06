import { Check, MousePointerClick, Square, X } from "lucide-react";
import { useState, type FormEvent, type ReactElement } from "react";
import type { PageTaskStep } from "../config.tsx";
import {
  answerPageTaskConfirm,
  answerPageTaskQuestion,
  stopPageTask,
  usePageTaskState,
  type PageTaskPrompt,
} from "./pageTaskStore.ts";
import a11y from "../a11y.module.css";
import styles from "./PageTaskCard.module.css";

/**
 * The `data-page-task` part (PAGE_ACTIONS_CONTRACT §3), plus `live`: whether
 * this card is rendering a part this session watched stream in. Set by
 * `wireParts.toUIPart` from where the part came from, never from the payload.
 */
export interface PageTaskCardProps {
  taskId: string;
  task: string;
  route?: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled" | "expired";
  summary?: string;
  steps: PageTaskStep[];
  live?: boolean;
}

type View =
  | { kind: "running"; steps: PageTaskStep[]; prompt: PageTaskPrompt | null }
  | { kind: "ended"; status: string; summary?: string; steps: PageTaskStep[] }
  | { kind: "interrupted" }
  | { kind: "starting" };

const STATUS_TEXT: Record<string, string> = {
  running: "Working on the page…",
  starting: "Starting…",
  done: "Done",
  failed: "Couldn't finish",
  cancelled: "Stopped",
  expired: "Timed out",
  interrupted: "Interrupted",
};

/**
 * What to show, in order of authority: the server's final word on the part;
 * else this page's own run of the task; else, for a part re-read from
 * history, "Interrupted" — that task never ran here and never will.
 */
function viewOf(props: PageTaskCardProps, state: ReturnType<typeof usePageTaskState>): View {
  const { status, summary, steps, live = false } = props;
  if (status !== "pending" && status !== "running") {
    return {
      kind: "ended",
      status,
      ...(summary === undefined ? {} : { summary }),
      steps: steps.length > 0 ? steps : (state?.steps ?? []),
    };
  }
  if (!live) return { kind: "interrupted" };
  if (state === null) return { kind: "starting" };
  if (state.phase === "running") return { kind: "running", steps: state.steps, prompt: state.prompt };
  // Posted, and waiting for the server's final part.
  return {
    kind: "ended",
    status: state.result?.status ?? "failed",
    ...(state.result === null ? {} : { summary: state.result.summary }),
    steps: state.steps,
  };
}

function StepList({ steps }: { steps: PageTaskStep[] }): ReactElement | null {
  if (steps.length === 0) return null;
  return (
    <ol className={styles.steps} aria-label="Steps">
      {steps.map((step, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <li key={index} className={styles.step} data-ok={step.ok}>
          <span className={styles.stepMark} aria-hidden="true">
            {step.ok ? <Check size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
          </span>
          <span className={styles.stepText}>
            <span className={styles.stepAction}>{step.action}</span>
            {step.detail !== undefined && <span className={styles.stepDetail}> — {step.detail}</span>}
            {!step.ok && <span className={a11y.visuallyHidden}> (failed)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ConfirmPrompt({ taskId, message }: { taskId: string; message: string }): ReactElement {
  return (
    <div className={styles.prompt} role="group" aria-label="Needs your go-ahead">
      <p className={styles.promptText}>{message}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={() => answerPageTaskConfirm(taskId, true)}
        >
          Allow
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => answerPageTaskConfirm(taskId, false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function QuestionPrompt({ taskId, question }: { taskId: string; question: string }): ReactElement {
  const [answer, setAnswer] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (answer.trim() === "") return;
    answerPageTaskQuestion(taskId, answer.trim());
    setAnswer("");
  };
  return (
    <form className={styles.prompt} onSubmit={submit}>
      <label className={styles.promptText} htmlFor={`page-task-answer-${taskId}`}>
        {question}
      </label>
      <div className={styles.answerRow}>
        <input
          id={`page-task-answer-${taskId}`}
          className={styles.answer}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          autoComplete="off"
        />
        <button type="submit" className={styles.primary} disabled={answer.trim() === ""}>
          Send
        </button>
      </div>
    </form>
  );
}

/**
 * A task the `/do` agent is carrying out on the host's screen.
 *
 * While it runs: the task, a live status, the steps page-agent reports, a
 * Stop button, and — when the host asks — an Allow/Deny prompt before
 * anything is saved or a box for a free-text answer. Once it ends: the
 * outcome and the steps. A `pending` part reopened from history renders
 * "Interrupted" and does nothing: the run that owned it is gone.
 *
 * The card never starts the task itself — `useChat` does, once per task id,
 * off the live stream — so mounting it twice can never run it twice.
 */
export function PageTaskCard(props: PageTaskCardProps): ReactElement {
  const { taskId, task } = props;
  const state = usePageTaskState(taskId);
  const view = viewOf(props, state);
  const statusKey = view.kind === "ended" ? view.status : view.kind;

  return (
    <section className={styles.card} aria-label={`Page task: ${task || "untitled"}`}>
      <header className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <MousePointerClick size={14} strokeWidth={2.25} />
        </span>
        <div className={styles.heading}>
          <h3 className={styles.title}>{task || "Page task"}</h3>
          <p className={styles.status} role="status" data-status={statusKey}>
            {STATUS_TEXT[statusKey] ?? statusKey}
          </p>
        </div>
        {view.kind === "running" && (
          <button
            type="button"
            className={styles.stop}
            onClick={() => stopPageTask(taskId)}
            aria-label="Stop the page task"
          >
            <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden="true" />
            Stop
          </button>
        )}
      </header>

      {view.kind === "running" && (
        <div className={styles.body}>
          <StepList steps={view.steps} />
          {view.prompt?.kind === "confirm" && (
            <ConfirmPrompt taskId={taskId} message={view.prompt.message} />
          )}
          {view.prompt?.kind === "question" && (
            <QuestionPrompt
              // A new question is a new box, never the last one's half-typed text.
              key={view.prompt.question}
              taskId={taskId}
              question={view.prompt.question}
            />
          )}
        </div>
      )}

      {/* The summary is not repeated here: the assistant's reply under the card carries it,
          rendered as markdown, where the card could only show it raw. */}
      {view.kind === "ended" && view.steps.length > 0 && (
        <div className={styles.body}>
          <StepList steps={view.steps} />
        </div>
      )}

      {view.kind === "interrupted" && (
        <div className={styles.body}>
          <p className={styles.summary}>
            This task stopped when its conversation was closed. Ask again to run it.
          </p>
        </div>
      )}
    </section>
  );
}
