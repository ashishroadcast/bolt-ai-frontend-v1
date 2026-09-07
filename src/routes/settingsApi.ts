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

export interface SettingsSnapshot {
  sandbox: SandboxLimits;
  agents: AgentCodeExecution[];
}

export function fetchSettings(): Promise<SettingsSnapshot> {
  return gatewayClient.agentFetch<SettingsSnapshot>("/agent/settings");
}
