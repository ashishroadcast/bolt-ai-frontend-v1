/**
 * Wire types for `/agent/agents`, `/agent/orchestrators` and
 * `/agent/admin/*` — mirrored field-for-field off the real Pydantic models
 * in `agent-service/app/api/agents.py`, `orchestrators.py` and `admin.py`,
 * not invented.
 *
 * `AgentSummary` (`GET /agent/agents`) stays deliberately minimal — a
 * picker surface, gated on the narrower `agent.chat.use` (`app.api.agents`'s
 * own docstring) — but it is no longer true that no endpoint returns an
 * agent's wiring at all: `GET /agent/agents/{id}` does, gated on `agent.
 * agents` instead, and `AgentDetail` below mirrors that response.
 */

/** `app.api.agents.AgentOut`. Deliberately minimal — a picker surface,
 * gated on `agent.chat.use`; an agent's configuration is `AgentDetail`
 * below, gated on the stricter `agent.agents`. */
export interface AgentSummary {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
}

/** `app.agent.models.CodeExecutionCapability`. */
export type CodeExecutionCapability = "none" | "interpreter" | "code";

/** `app.api.agents.AgentDetailOut` — `GET /agent/agents/{id}`, gated on
 * `agent.agents`/`can_read`. What an agent is actually wired to: its
 * datasource, its per-phase model bindings, whether it may run code, which
 * mcp servers it is bound to, and which phases the learning loop has
 * compiled a program for. Every id here (`datasource_id`, the values in
 * `llm_bindings`, `mcp_server_ids`) is resolved to a name by the console
 * where the corresponding list endpoint is reachable — see
 * `agentDetail/ConfigTab.tsx` — never rendered as a bare number. */
export interface AgentDetail {
  id: number;
  name: string;
  description: string | null;
  pipeline_config: Record<string, unknown>;
  datasource_id: number | null;
  /** phase name -> `llm_configs.id`. A phase absent here runs on the
   * tenant's default `LLMConfig` (`is_default=True`), not on "no model". */
  llm_bindings: Record<string, number>;
  code_execution: CodeExecutionCapability;
  is_active: boolean;
  /** phase -> MLflow artifact URI for that phase's compiled BootstrapFewShot
   * program. Empty until `POST /agent/admin/optimize` has compiled at least
   * one phase for this agent. */
  compiled_programs: Record<string, string>;
  mcp_server_ids: number[];
}

/** `app.agent.models.OrchestratorMode`. */
export type OrchestratorMode = "single" | "coordinate";

/** `app.api.orchestrators.OrchestratorOut`. */
export interface Orchestrator {
  id: number;
  name: string;
  description: string | null;
  mode: OrchestratorMode;
  llm_config_id: number;
  member_agent_ids: number[];
  is_active: boolean;
}

/** `app.api.orchestrators.OrchestratorCreate`. */
export interface OrchestratorCreateInput {
  name: string;
  description?: string | null;
  mode: OrchestratorMode;
  llm_config_id: number;
  member_agent_ids: number[];
}

/** `app.api.orchestrators.OrchestratorPatch` — every field optional; only
 * the keys actually present are sent, matching the backend's
 * `model_fields_set` "not sent vs. sent as null" distinction. */
export interface OrchestratorPatchInput {
  name?: string;
  description?: string | null;
  mode?: OrchestratorMode;
  member_agent_ids?: number[];
}

/** `app.agent.prompts.PromptPhase` — the five tunable prompt phases.
 * `SUITE_PHASES` in `app.learning.judge` adds a sixth, "agent" (the whole
 * run graded on its final answer), which is not a phase `POST /agent/
 * admin/tune`/`promote` accept — both take `prompts.PromptPhase`
 * specifically, so it is deliberately excluded here. */
export type PromptPhase = "research" | "plan" | "execute" | "validate" | "guardrail";

export const PROMPT_PHASES: readonly PromptPhase[] = [
  "research",
  "plan",
  "execute",
  "validate",
  "guardrail",
];

/** `app.api.admin.OptimizeOut`. */
export interface OptimizeResult {
  run_id: string;
  artifact_uri: string;
  demo_count: number;
}

/** `app.api.admin.TuneOut`. */
export interface TuneResult {
  prompt_uri: string;
  version: number;
  instructions: string;
}

/** `app.api.admin.PromoteOut`. */
export interface PromoteResult {
  allowed: boolean;
  overridden: boolean;
  reason: string;
  from_version: number | null;
  to_version: number;
  regressed_case_ids: number[];
  improved_case_ids: number[];
}

/** The shape of `AgentApiError.body.detail` on a refused `POST /agent/
 * admin/promote` (`HTTPException(422, detail={"reason": ..., "regressed_
 * cases": [...]})`, `app.api.admin.promote`) — read directly off the error
 * rather than through `PromoteResult`, since a refusal never reaches the
 * 200 response model at all. */
export interface PromoteRefusalDetail {
  reason: string;
  regressed_cases: Array<{
    test_case_id: number;
    question: string;
    baseline_verdict: string;
    candidate_verdict: string;
    candidate_error: string | null;
  }>;
}

/**
 * The subset of `app.api.agents.AgentPatch` this console writes. Every
 * field optional: the server reads `model_fields_set`, so an omitted key
 * is "leave it alone" and an explicit `null` on `datasource_id` is
 * "disconnect", two different requests that must not collapse into one.
 */
export interface AgentPatchInput {
  name?: string;
  description?: string | null;
  datasource_id?: number | null;
  llm_bindings?: Record<string, number>;
  code_execution?: CodeExecutionCapability;
  pipeline_config?: Record<string, unknown>;
  is_active?: boolean;
}
