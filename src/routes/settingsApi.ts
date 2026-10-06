import { gatewayClient } from "../api/client.ts";

/**
 * Wire types for `GET /agent/settings` (`agent-service/app/api/
 * settings.py`) — the two facts a Settings screen can show about the
 * sandbox without lying: the process-level execution caps every tenant
 * shares, and which of a tenant's own agents may run model-written code at
 * all. Field names match the FastAPI response verbatim, the same
 * convention `./datasourcesApi.ts` already uses.
 */
export type CodeExecutionCapability = "none" | "interpreter" | "code";

export interface SandboxLimits {
  max_executions_per_run: number;
  max_concurrent_executions_per_user: number;
  concurrent_slot_ttl_seconds: number;
  /**
   * False exactly when `SANDBOX_MAX_CONCURRENT_EXECUTIONS_PER_USER` is
   * unset on the server — `max_concurrent_executions_per_user` still reads
   * back as a real `0` in that case (fails closed), not `null`, so this is
   * the only way to tell "deliberately zero" apart from "nobody has
   * measured the real number yet" (see the backend module's own
   * docstring).
   */
  concurrency_configured: boolean;
}

export interface AgentCodeExecution {
  id: number;
  name: string;
  code_execution: CodeExecutionCapability;
}

/**
 * How much of a run Ask shows this tenant's readers.
 *
 * Both off unless someone turns them on — see `TenantUiSettings` in
 * agent-service for why. The people these govern are mostly operators who
 * cannot configure anything, so the decision is a tenant-wide one made here.
 */
export interface AskDisclosure {
  show_reasoning: boolean;
  show_query_results: boolean;
  /**
   * Whether the built-in `/do` agent may act on the bolt-v2 screen a reader
   * has open (PAGE_ACTIONS_CONTRACT §1). Off by default. Absent from an
   * agent-service that predates page actions, which reads as off.
   */
  page_actions_enabled?: boolean;
  /** An organisation above this one set these for its whole tree, and this
   * one cannot change them (the PATCH answers 409). Absent from an older
   * agent-service, which treats every organisation as its own. */
  set_by_ancestor?: boolean;
}

export interface SettingsSnapshot {
  sandbox: SandboxLimits;
  agents: AgentCodeExecution[];
  ask: AskDisclosure;
}

export function fetchSettings(): Promise<SettingsSnapshot> {
  return gatewayClient.agentFetch<SettingsSnapshot>("/agent/settings");
}

/**
 * Turn one of Ask's panels on or off for the whole tenant.
 *
 * Only the changed flag is sent: agent-service reads `model_fields_set`, so
 * an omitted field is left alone rather than reset to a default the caller
 * never chose.
 */
export function updateAskDisclosure(patch: Partial<AskDisclosure>): Promise<AskDisclosure> {
  return gatewayClient.agentFetch<AskDisclosure>("/agent/settings/ask", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}
