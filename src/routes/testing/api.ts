import { gatewayClient } from "../../api/client.ts";
import { submitFeedback, type FeedbackResult } from "../../ask/chat/feedbackApi.ts";
import { AgentApiError, stringDetailMessage } from "../../ask/http/gatewayClient.ts";
import type {
  AgentSummary,
  AgentTestCase,
  AgentTestCaseCreate,
  FeedbackList,
  PromoteRefusal,
  PromoteResult,
  PromptPhase,
  PromptSnapshot,
  SavePromptResult,
  TuneResult,
} from "./types.ts";

/**
 * Every network call this screen pair makes, in one place — thin wrappers
 * over `gatewayClient.agentFetch`, never a second fetch mechanism (that
 * was this task's own plan before `AgentApiError`/`stringDetailMessage`
 * landed in `../../api/gatewayClient.ts`; now that they carry the parsed
 * body, a duplicate wrapper would just be a second copy of the same auth
 * contract for no reason).
 */

export function listTestCases(): Promise<AgentTestCase[]> {
  // Tenant-scoped server-side; no agent_id filter — the two screens read
  // every case for the tenant and group by phase/agent themselves, since a
  // tenant may run more than one agent (GET /agent/agents).
  return gatewayClient.agentFetch<AgentTestCase[]>("/agent/tests");
}

export function listAgents(): Promise<AgentSummary[]> {
  return gatewayClient.agentFetch<AgentSummary[]>("/agent/agents");
}

export function createTestCase(payload: AgentTestCaseCreate): Promise<AgentTestCase> {
  return gatewayClient.agentFetch<AgentTestCase>("/agent/tests", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteTestCase(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/tests/${id}`, { method: "DELETE" });
}

export function runTestCase(id: number): Promise<AgentTestCase> {
  return gatewayClient.agentFetch<AgentTestCase>(`/agent/tests/${id}/run`, { method: "POST" });
}

/** `GET /agent/admin/prompts/{agent_id}` — every `PromptPhase`'s live
 * registry state for this agent, in declared-phase order. Read-only
 * (`app.agent.prompts.read_prompt` never touches MLflow's alias cache or
 * this service's own serving cache — see that function's own docstring),
 * so callers can poll it after a tune/promote with no staleness budget to
 * reason about. */
export function listPrompts(agentId: number): Promise<PromptSnapshot[]> {
  return gatewayClient.agentFetch<PromptSnapshot[]>(`/agent/admin/prompts/${agentId}`);
}

export function tunePrompt(agentId: number, phase: PromptPhase): Promise<TuneResult> {
  return gatewayClient.agentFetch<TuneResult>("/agent/admin/tune", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, phase }),
  });
}

export interface PromoteArgs {
  agentId: number;
  phase: PromptPhase;
  version: number;
  override?: boolean;
}

/**
 * `POST /agent/admin/promote`. Resolves with `PromoteResult` when the gate
 * allows it (200) and rejects with `GateRefusedError` when it does not
 * (422, `detail={reason, regressed_cases}`) — a distinct type from any
 * other failure (auth, network, a malformed request) so a caller can
 * `instanceof` for "the gate refused" specifically rather than string-
 * matching a generic error message.
 */
export async function promotePrompt(args: PromoteArgs): Promise<PromoteResult> {
  try {
    return await gatewayClient.agentFetch<PromoteResult>("/agent/admin/promote", {
      method: "POST",
      body: JSON.stringify({
        agent_id: args.agentId,
        phase: args.phase,
        version: args.version,
        override: args.override ?? false,
      }),
    });
  } catch (error) {
    const refusal = readGateRefusal(error);
    if (refusal !== null) throw new GateRefusedError(refusal);
    throw error;
  }
}

/** Raised by `promotePrompt` specifically for a 422 gate refusal — see
 * that function's own comment for why this is a distinct type. */
export class GateRefusedError extends Error {
  readonly refusal: PromoteRefusal;

  constructor(refusal: PromoteRefusal) {
    super(refusal.reason);
    this.name = "GateRefusedError";
    this.refusal = refusal;
  }
}

/** Narrows an `AgentApiError`'s parsed `body` down to `{reason,
 * regressed_cases}` — `promotePrompt`'s only non-2xx shape that carries a
 * structured `detail` rather than a plain string (every other endpoint
 * here uses `stringDetailMessage`/`.message` instead). Returns null for
 * anything else so `promotePrompt` can fall back to rethrowing the
 * original error unchanged. */
function readGateRefusal(error: unknown): PromoteRefusal | null {
  if (!(error instanceof AgentApiError) || error.status !== 422) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null || !("detail" in body)) return null;
  const detail = (body as { detail: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const { reason, regressed_cases: regressedCases } = detail as Record<string, unknown>;
  if (typeof reason !== "string" || !Array.isArray(regressedCases)) return null;
  return { reason, regressed_cases: regressedCases as PromoteRefusal["regressed_cases"] };
}

/** The operator-facing message for any error this module's calls can
 * throw that isn't a `GateRefusedError` (already handled on its own
 * terms): a plain-string FastAPI `detail` (409 duplicate, 422 config
 * defect from tune/run) when there is one, else the error's own message. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof AgentApiError) {
    return stringDetailMessage(error.body) ?? error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * `POST /agent/admin/prompts` — registers `instructions` as a new version
 * of `<agent>-<phase>`.
 *
 * **This does not put the text live.** The response's `version` is a
 * candidate; `serving_version` is what the `production` alias still points
 * at. Promoting it is `promotePrompt` above, which runs the gate. See
 * `app.agent.prompts.save_prompt`'s module docstring for why saving is
 * deliberately not promoting.
 *
 * A 422 carries a plain-string `detail` (`apiErrorMessage` reads it): blank
 * text, or an agent whose name contains whitespace and therefore can never
 * key a prompt at all.
 */
export function savePrompt(
  agentId: number,
  phase: PromptPhase,
  instructions: string,
): Promise<SavePromptResult> {
  return gatewayClient.agentFetch<SavePromptResult>("/agent/admin/prompts", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, phase, instructions }),
  });
}

/** `GET /agent/feedback` — the ratings this agent has collected, plus how
 * much training signal they have turned into. Tenant-scoped server-side;
 * `agentId` narrows to single-agent turns (a multi-agent orchestrator turn
 * carries no `agent_id` and correctly appears under none of them). */
export function listFeedback(agentId: number): Promise<FeedbackList> {
  return gatewayClient.agentFetch<FeedbackList>(`/agent/feedback?agent_id=${agentId}`);
}

/**
 * Records the reason behind a thumbs-down that was left without one.
 *
 * Deliberately the *same* `POST /agent/feedback` the rating itself went
 * through, not a patch of the existing row: `app.learning.policy.
 * apply_feedback` is the only writer allowed to turn a rating into a
 * correction (enforced by a static AST test over the whole service), so a
 * second endpoint that edited the comment in place would either duplicate
 * that policy or bypass it. Feedback rows are an append-only trail — "an
 * operator recorded a reason" is a real second event, and it lands the
 * `CorrectionMeta` row that `POST /agent/admin/tune` reads.
 */
export function recordFeedbackReason(messageId: number, comment: string): Promise<FeedbackResult> {
  // The console's own client. `submitFeedback` moved into the Ask package
  // and takes its client explicitly now, precisely so it has no opinion
  // about whose it is — the console passes the console's, an embedded Ask
  // passes the host's.
  return submitFeedback(gatewayClient, messageId, "down", comment);
}
