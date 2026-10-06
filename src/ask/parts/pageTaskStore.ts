import { useSyncExternalStore } from "react";
import type { PageTaskRequest, PageTaskResult, PageTaskStep } from "../config.tsx";
import type { GatewayClient } from "../http/gatewayClient.ts";

/**
 * Every page task this page has run, by `taskId` — kept OUTSIDE React, for
 * the reasons `widgetDraftStore.ts` gives: the card remounts when the run
 * that streamed it finishes (live turn → answered turn), and the host must be
 * called exactly once per task however many times the card mounts.
 *
 * Unlike a widget draft, the task is started here, not by its card: `useChat`
 * calls `startPageTask` the moment the part arrives on the live stream, so
 * whether a task runs never depends on whether something rendered it.
 *
 * PAGE_ACTIONS_CONTRACT §3–§6: the host's `onPageTask` runs page-agent, the
 * card shows its steps and asks the reader whatever it needs to ask, and the
 * outcome is posted to `/agent/page-tasks/{id}/result` exactly once.
 */

export type PageTaskPrompt =
  | { kind: "confirm"; message: string }
  | { kind: "question"; question: string };

export interface PageTaskState {
  phase: "running" | "finished";
  steps: PageTaskStep[];
  /** What the host is waiting on the reader for, if anything. */
  prompt: PageTaskPrompt | null;
  /** What Ask posted, once it has. */
  result: PageTaskResult | null;
}

interface Entry {
  state: PageTaskState;
  controller: AbortController;
  /** The client that started it: aborting one Ask's tasks leaves another's. */
  owner: GatewayClient | null;
  /** Settles the open prompt: with the reader's answer, or as an abort. */
  settle: ((answer: { ok: true; value: boolean | string } | { ok: false }) => void) | null;
  post: (result: PageTaskResult) => void;
}

/** PAGE_ACTIONS_CONTRACT §6's caps, applied before posting so a talkative
 * host is trimmed rather than refused. */
const MAX_SUMMARY = 2000;
const MAX_STEPS = 60;
const MAX_STEP_TEXT = 300;

const STOPPED_SUMMARY = "Stopped before it finished.";
const NO_HANDLER_SUMMARY = "This screen can't run page actions.";

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(entry: Entry, patch: Partial<PageTaskState>): void {
  entry.state = { ...entry.state, ...patch };
  emit();
}

function runningCount(): number {
  let count = 0;
  for (const entry of entries.values()) if (entry.state.phase === "running") count += 1;
  return count;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function cleanStep(raw: unknown, fallbackN: number): PageTaskStep | null {
  if (raw === null || typeof raw !== "object") return null;
  const step = raw as Partial<PageTaskStep>;
  if (typeof step.action !== "string" || step.action === "") return null;
  return {
    n: typeof step.n === "number" && Number.isFinite(step.n) ? step.n : fallbackN,
    action: clip(step.action, MAX_STEP_TEXT),
    ...(typeof step.detail === "string" && step.detail !== ""
      ? { detail: clip(step.detail, MAX_STEP_TEXT) }
      : {}),
    ok: step.ok !== false,
  };
}

function cleanSteps(raw: unknown): PageTaskStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((step, index) => cleanStep(step, index + 1))
    .filter((step): step is PageTaskStep => step !== null)
    .slice(-MAX_STEPS);
}

/** The host's answer, held to the contract: a status it may send, a string
 * summary, and steps — its own, or the ones it reported along the way. */
function cleanResult(raw: unknown, seen: PageTaskStep[]): PageTaskResult {
  const result = (raw !== null && typeof raw === "object" ? raw : {}) as Partial<PageTaskResult>;
  const status =
    result.status === "done" || result.status === "failed" || result.status === "cancelled"
      ? result.status
      : "failed";
  const steps = Array.isArray(result.steps) ? cleanSteps(result.steps) : seen;
  const summary =
    typeof result.summary === "string" && result.summary.trim() !== ""
      ? result.summary
      : status === "done"
        ? "Done."
        : status === "cancelled"
          ? STOPPED_SUMMARY
          : "The page task didn't finish.";
  return { status, summary: clip(summary, MAX_SUMMARY), steps };
}

function failure(err: unknown, steps: PageTaskStep[]): PageTaskResult {
  const message = err instanceof Error && err.message !== "" ? err.message : "The page task failed.";
  return { status: "failed", summary: clip(message, MAX_SUMMARY), steps };
}

// Escape stops whatever is running. A trusted key only: page-agent itself
// dispatches synthetic keys on the page, and one of those must not cancel
// the task that sent it.
let escapeInstalled = false;

/** Exported for tests, which cannot dispatch a trusted event. */
export function handlePageTaskKey(event: Pick<KeyboardEvent, "key" | "isTrusted">): void {
  if (event.key !== "Escape" || !event.isTrusted) return;
  for (const taskId of entries.keys()) stopPageTask(taskId);
}

function syncEscapeListener(): void {
  if (typeof window === "undefined") return;
  const want = runningCount() > 0;
  if (want === escapeInstalled) return;
  escapeInstalled = want;
  if (want) window.addEventListener("keydown", handlePageTaskKey, true);
  else window.removeEventListener("keydown", handlePageTaskKey, true);
}

export interface StartPageTaskInput {
  taskId: string;
  task: string;
  route?: string;
  client: GatewayClient;
  /** Undefined when the host can't run one; the task is then failed at once. */
  onPageTask?: (request: PageTaskRequest) => Promise<PageTaskResult>;
}

/**
 * Runs one page task, exactly once per `taskId` for the life of the page. A
 * second call for the same id — the part re-streamed with its final data, a
 * StrictMode double effect — does nothing.
 */
export function startPageTask(input: StartPageTaskInput): void {
  const { taskId, task, route, client, onPageTask } = input;
  if (taskId === "" || entries.has(taskId)) return;

  // Pinned now: the task belongs to the organisation that started it.
  const organisationId = client.currentOrganisationId();
  const controller = new AbortController();
  const entry: Entry = {
    state: { phase: "running", steps: [], prompt: null, result: null },
    controller,
    owner: client,
    settle: null,
    post: (result) => {
      if (entry.state.phase === "finished") return;
      entry.settle?.({ ok: false });
      entry.settle = null;
      update(entry, { phase: "finished", prompt: null, result, steps: result.steps });
      syncEscapeListener();
      client.postPageTaskResult(taskId, result, organisationId).catch((err: unknown) => {
        console.warn(`<bolt-ai-ask> couldn't post the result of page task ${taskId}.`, err);
      });
    },
  };
  entries.set(taskId, entry);
  emit();

  if (onPageTask === undefined) {
    entry.post({ status: "failed", summary: NO_HANDLER_SUMMARY, steps: [] });
    return;
  }
  syncEscapeListener();

  /** Opens a prompt in the card and waits for the reader — or the abort. */
  const ask = (prompt: PageTaskPrompt) =>
    new Promise<{ ok: true; value: boolean | string } | { ok: false }>((resolve) => {
      if (controller.signal.aborted || entry.state.phase === "finished") {
        resolve({ ok: false });
        return;
      }
      // One prompt at a time: a new one settles an unanswered one as refused.
      entry.settle?.({ ok: false });
      entry.settle = (answer) => {
        entry.settle = null;
        if (entry.state.phase === "running") update(entry, { prompt: null });
        resolve(answer);
      };
      update(entry, { prompt });
    });

  const baseURL = client.agentUrl(`/agent/page-tasks/${encodeURIComponent(taskId)}`);
  const request: PageTaskRequest = {
    id: taskId,
    task,
    ...(route === undefined ? {} : { route }),
    llm: {
      baseURL,
      model: "bolt-page-agent",
      fetch: client.scopedFetch(baseURL, { organisationId, signal: controller.signal }),
    },
    signal: controller.signal,
    onStep: (step) => {
      if (entry.state.phase !== "running") return;
      const clean = cleanStep(step, entry.state.steps.length + 1);
      if (clean === null) return;
      update(entry, { steps: [...entry.state.steps, clean].slice(-MAX_STEPS) });
    },
    confirm: async (message) => {
      const answer = await ask({ kind: "confirm", message: String(message) });
      return answer.ok && answer.value === true;
    },
    askUser: async (question) => {
      const answer = await ask({ kind: "question", question: String(question) });
      if (!answer.ok) throw new DOMException("The page task was stopped.", "AbortError");
      return String(answer.value);
    },
  };

  let pending: Promise<PageTaskResult>;
  try {
    pending = Promise.resolve(onPageTask(request));
  } catch (err) {
    pending = Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  pending.then(
    (result) => {
      if (controller.signal.aborted) return; // already posted as cancelled
      entry.post(cleanResult(result, entry.state.steps));
    },
    (err: unknown) => {
      if (controller.signal.aborted) return;
      entry.post(failure(err, entry.state.steps));
    },
  );
}

/**
 * Stops a running task: aborts the host's signal, settles any open prompt
 * (confirm → false, askUser → rejects) and posts `cancelled` with the steps
 * seen so far — straight away, not after the host winds down, so a stop that
 * comes with the run closing (a new conversation, an organisation switch)
 * still reaches agent-service.
 */
export function stopPageTask(taskId: string): void {
  const entry = entries.get(taskId);
  if (entry === undefined || entry.state.phase !== "running") return;
  entry.controller.abort();
  entry.post({ status: "cancelled", summary: STOPPED_SUMMARY, steps: entry.state.steps });
}

/** Stops every running task `owner` started — or every one, with no owner. */
export function abortPageTasks(owner?: GatewayClient): void {
  for (const [taskId, entry] of entries) {
    if (owner === undefined || entry.owner === owner) stopPageTask(taskId);
  }
}

/** The reader's Allow / Deny. */
export function answerPageTaskConfirm(taskId: string, allowed: boolean): void {
  const entry = entries.get(taskId);
  if (entry?.state.prompt?.kind !== "confirm") return;
  entry.settle?.({ ok: true, value: allowed });
}

/** The reader's typed answer. */
export function answerPageTaskQuestion(taskId: string, answer: string): void {
  const entry = entries.get(taskId);
  if (entry?.state.prompt?.kind !== "question") return;
  entry.settle?.({ ok: true, value: answer });
}

/** The recorded state of a task, or null when this page never ran it. */
export function usePageTaskState(taskId: string): PageTaskState | null {
  return useSyncExternalStore(
    subscribe,
    () => entries.get(taskId)?.state ?? null,
    () => null,
  );
}

/** Whether any page task is running — `useChat`'s unload guard reads it. */
export function usePageTaskRunning(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => runningCount() > 0,
    () => false,
  );
}

/** Forgets everything. Tests only. */
export function resetPageTasksForTests(): void {
  for (const entry of entries.values()) entry.controller.abort();
  entries.clear();
  syncEscapeListener();
  emit();
}
