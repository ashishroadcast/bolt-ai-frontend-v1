/**
 * Wire types for `/agent/tests`, `/agent/agents` and `/agent/admin/*`
 * (`agent-service/app/api/tests.py`, `agents.py`, `admin.py`). Mirrors each
 * Pydantic model field-for-field rather than reshaping it, the same
 * convention `src/chat/conversation.ts` already follows for `MessageOut`.
 */

/** `app.learning.judge.SUITE_PHASES` — the six evaluation suites a test
 * case can target. A strict superset of `PromptPhase` below (adds
 * `"agent"`, which grades a whole run rather than one phase's own output
 * and has no prompt of its own to tune/promote). */
export const SUITE_PHASES = [
  "research",
  "plan",
  "execute",
  "validate",
  "guardrail",
  "agent",
] as const;
export type SuitePhase = (typeof SUITE_PHASES)[number];

/** `app.agent.prompts.PromptPhase` — the five phases that resolve a real
 * prompt through the `production` alias, i.e. the phases `/agent/admin/
 * tune` and `/agent/admin/promote` accept. `"agent"` is deliberately absent
 * (see `SUITE_PHASES`'s own comment). */
export const PROMPT_PHASES = ["research", "plan", "execute", "validate", "guardrail"] as const;
export type PromptPhase = (typeof PROMPT_PHASES)[number];

export type AgentTestVerdict = "pass" | "fail";

/** `AgentTestCase.last_prompt_version` — `{"uri": "prompts:/<agent>-<phase>/<version>", "alias": "production"}`. */
export interface PromptVersionRef {
  uri: string;
  alias: string;
}

/** `app.api.tests.AgentTestCaseOut`. */
export interface AgentTestCase {
  id: number;
  agent_id: number;
  phase: string;
  question: string;
  expected: string;
  is_active: boolean;
  last_score: number | null;
  last_verdict: AgentTestVerdict | null;
  last_actual: string | null;
  last_reasoning: string | null;
  last_ran_at: string | null;
  last_prompt_version: PromptVersionRef | null;
  last_tools_used: string[] | null;
  last_duration_ms: number | null;
  last_usage: Record<string, unknown> | null;
  trace_id: string | null;
  created_at: string;
  updated_at: string;
}

/** `app.api.tests.AgentTestCaseCreate` — no snapshot fields; see that
 * module's own docstring for why they're structurally absent, not merely
 * ignored. */
export interface AgentTestCaseCreate {
  agent_id: number;
  phase: SuitePhase;
  question: string;
  expected: string;
  is_active?: boolean;
}

/** `app.api.agents.AgentOut` — minimal by design (§10): enough for a
 * picker, never the agent's own configuration. */
export interface AgentSummary {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
}

/** `app.api.admin.TuneOut`. */
export interface TuneResult {
  prompt_uri: string;
  version: number;
  instructions: string;
}

/** `app.api.admin.PromptOut` — one entry of `GET /agent/admin/prompts/
 * {agent_id}`'s response, `app.agent.prompts.PromptSnapshot` mirrored
 * field-for-field. The live registry read `PhasePromptPanel`'s own
 * "Serving" row used to have no better source for than `last_prompt_version`
 * off a test case (`promptVersion.ts`'s own comment — "there is no endpoint
 * that reports the version currently behind a phase's production alias").
 *
 * `is_fallback` is what tells "no prompt registered — this agent is
 * running the signature's own default" apart from "a real, versioned
 * prompt happens to read like the default" — never inferred by comparing
 * `instructions` to anything client-side. `version`/`alias` are `null`
 * together exactly when `is_fallback` is true.
 */
export interface PromptSnapshot {
  phase: PromptPhase;
  instructions: string;
  version: number | null;
  alias: string | null;
  is_fallback: boolean;
}

/** `_regression_detail` in `app.api.admin` — one entry of a refused
 * promote's `regressed_cases`. */
export interface RegressedCaseDetail {
  test_case_id: number;
  question: string;
  baseline_verdict: AgentTestVerdict;
  candidate_verdict: AgentTestVerdict;
  candidate_error: string | null;
}

/** `app.api.admin.PromoteOut` — the 200 shape, only ever returned once
 * `GateVerdict.allowed` is true. */
export interface PromoteResult {
  allowed: true;
  overridden: boolean;
  reason: string;
  from_version: number | null;
  to_version: number;
  regressed_case_ids: number[];
  improved_case_ids: number[];
}

/** The 422 body `POST /agent/admin/promote` sends on a refusal
 * (`app.api.admin.promote`: `detail={"reason": ..., "regressed_cases": [...]}`).
 * Never has `allowed`/`to_version` — those only exist on the 200 shape
 * above; a refused attempt never moved anything, so there is no "to". */
export interface PromoteRefusal {
  reason: string;
  regressed_cases: RegressedCaseDetail[];
}

/** `app.api.admin.SavePromptOut` — what `POST /agent/admin/prompts`
 * returns. `serving_version` is what the `production` alias points at
 * *after* the save, which is whatever it pointed at before: a save
 * registers a new version and never promotes it (`app.agent.prompts.
 * save_prompt`'s own module docstring carries the reasoning). It is on the
 * response so the panel can state "you saved v19; v3 is still serving"
 * from one round trip. `null` when nothing has ever been promoted for the
 * phase. */
export interface SavePromptResult {
  phase: PromptPhase;
  prompt_uri: string;
  version: number;
  serving_version: number | null;
}

/** One entry of `GET /agent/feedback` (`app.api.feedback.FeedbackItemOut`).
 *
 * `comment === null` on a `"down"` row is the state worth acting on: §9.1
 * only turns a thumbs-down into a `CorrectionMeta` row when a comment came
 * with it, and only `CorrectionMeta` rows reach `tune_prompt`. So a bare
 * down-vote is a rating that never reaches prompt tuning — recording the
 * reason is what makes it count.
 *
 * `question` is resolved server-side by the same function the write path
 * uses (`app.learning.policy.preceding_question`), never guessed here, so
 * the text shown and the text a correction is keyed on cannot diverge.
 * `agent_id` is `null` for a multi-agent orchestrator turn. */
export interface FeedbackItem {
  feedback_id: number;
  message_id: number;
  agent_id: number | null;
  rating: "up" | "down";
  comment: string | null;
  created_at: string;
  question: string | null;
  answer: string;
}

/** `app.api.feedback.FeedbackListOut`. `exemplars`/`corrections` count the
 * two stores `POST /agent/admin/tune` actually reads — the answer to "is
 * there anything for tuning to learn from yet", before spending a tuning
 * call to find out. */
export interface FeedbackList {
  exemplars: number;
  corrections: number;
  items: FeedbackItem[];
}
