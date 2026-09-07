import { gatewayClient } from "../api/client.ts";
import type {
  AgentDetail,
  AgentPatchInput,
  AgentSummary,
  Orchestrator,
  OrchestratorCreateInput,
  OrchestratorPatchInput,
  OptimizeResult,
  PromoteResult,
  PromptPhase,
  TuneResult,
} from "./types.ts";

/**
 * Every call here goes through `gatewayClient.agentFetch`, which always
 * carries `Authorization: Bearer <token>` and never a tenant or user id —
 * tenancy and identity come from the token alone, the same rule every
 * `agent-service` router enforces server-side (`Agent.tenant_id ==
 * principal.tenant_id`, never an argument). No function below accepts a
 * tenant/user parameter to pass through, on purpose: there is nothing to
 * pass, and adding a parameter nobody should fill in is how a client-sent
 * tenant id sneaks in later.
 */

/** `GET /agent/agents` — every agent in the caller's own tenant. */
export function listAgents(): Promise<AgentSummary[]> {
  return gatewayClient.agentFetch<AgentSummary[]>("/agent/agents");
}

/** `GET /agent/agents/{id}` — one agent's full configuration: datasource,
 * model bindings, code-execution capability, compiled programs and bound
 * mcp servers. Gated on `agent.agents`/`can_read`, stricter than
 * `listAgents`'s picker-scoped `agent.chat.use` — see `AgentDetail`'s own
 * comment in `./types.ts`. */
export function getAgent(id: number): Promise<AgentDetail> {
  return gatewayClient.agentFetch<AgentDetail>(`/agent/agents/${id}`);
}

/**
 * `PATCH /agent/agents/{id}` — the write half of the Configuration tab.
 *
 * Partial by design on the server (`AgentPatch` distinguishes "not sent"
 * from "sent as null" via `model_fields_set`), so send only the field being
 * changed. Two fields honour an explicit null and mean it: `datasource_id`
 * null disconnects the agent, `description` null clears it. `llm_bindings`
 * replaces the whole map rather than merging, so a caller changing one
 * phase sends every other phase back unchanged.
 */
export function updateAgent(id: number, patch: AgentPatchInput): Promise<AgentDetail> {
  return gatewayClient.agentFetch<AgentDetail>(`/agent/agents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** `POST /agent/agents/{id}/mcp-servers/{serverId}` — bind one tool server
 * to this agent. Already bound is not an error the console has to guard
 * against; the server answers idempotently. */
export function attachMcpServer(agentId: number, serverId: number): Promise<unknown> {
  return gatewayClient.agentFetch<unknown>(`/agent/agents/${agentId}/mcp-servers/${serverId}`, {
    method: "POST",
  });
}

/** `DELETE /agent/agents/{id}/mcp-servers/{serverId}`. */
export function detachMcpServer(agentId: number, serverId: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/agents/${agentId}/mcp-servers/${serverId}`, {
    method: "DELETE",
  });
}

/** `GET /agent/orchestrators`. */
export function listOrchestrators(): Promise<Orchestrator[]> {
  return gatewayClient.agentFetch<Orchestrator[]>("/agent/orchestrators");
}

/** `POST /agent/orchestrators`. */
export function createOrchestrator(input: OrchestratorCreateInput): Promise<Orchestrator> {
  return gatewayClient.agentFetch<Orchestrator>("/agent/orchestrators", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `PATCH /agent/orchestrators/{id}` — only the fields present on `patch`
 * are sent, matching the backend's `model_fields_set` contract. */
export function updateOrchestrator(id: number, patch: OrchestratorPatchInput): Promise<Orchestrator> {
  return gatewayClient.agentFetch<Orchestrator>(`/agent/orchestrators/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** `DELETE /agent/orchestrators/{id}` — 204, no body. */
export function deleteOrchestrator(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/orchestrators/${id}`, { method: "DELETE" });
}

/** `POST /agent/admin/optimize` — compile a `BootstrapFewShot` plan program
 * from promoted exemplars. */
export function optimizeAgent(agentId: number): Promise<OptimizeResult> {
  return gatewayClient.agentFetch<OptimizeResult>("/agent/admin/optimize", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId }),
  });
}

/** `POST /agent/admin/tune` — register a new prompt version for one phase.
 * Registering, not promoting: the `production` alias only moves through
 * `promoteAgentPrompt` below, and only after the gate allows it. */
export function tuneAgentPrompt(agentId: number, phase: PromptPhase): Promise<TuneResult> {
  return gatewayClient.agentFetch<TuneResult>("/agent/admin/tune", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, phase }),
  });
}

/** `POST /agent/admin/promote` — the one alias move meant to stick. A
 * refused promotion (the gate found a regression, or `override` is not
 * set) is not this function's business to normalise away: it throws
 * `AgentApiError` with `body.detail = {reason, regressed_cases}`, which the
 * caller reads directly (`PromoteRefusalDetail`) so the refusal's real
 * reason and the specific cases that regressed reach the operator, not a
 * generic failure message. */
export function promoteAgentPrompt(
  agentId: number,
  phase: PromptPhase,
  version: number,
  override: boolean,
): Promise<PromoteResult> {
  return gatewayClient.agentFetch<PromoteResult>("/agent/admin/promote", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, phase, version, override }),
  });
}
