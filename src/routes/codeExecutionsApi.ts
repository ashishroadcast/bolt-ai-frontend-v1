import { gatewayClient } from "../api/client.ts";

/** `app.api.code_executions.outcome_of` — a label for `exit_status`, so this
 * client never re-derives one from a bare integer and gets `-3` wrong. Any
 * value the server does not recognise is the executed program's own nonzero
 * exit: it ran and raised. */
export type CodeExecutionOutcome =
  | "ok"
  | "error"
  | "timeout"
  | "killed"
  | "unreachable"
  | "pending"
  | "refused"
  | "breaker_open";

/** `app.api.code_executions.CodeExecutionSummary` — `GET /agent/code-executions`.
 * Carries no `code`/`stdout`/`stderr`: those three are what make a row big
 * (that module's own docstring), so the list is cheap and
 * `getCodeExecution` below is the second call. */
export interface CodeExecutionSummary {
  id: number;
  agent_id: number;
  conversation_id: number;
  message_id: number;
  mode: "interpreter" | "code";
  exit_status: number;
  outcome: CodeExecutionOutcome;
  duration_ms: number;
  artifact_count: number;
  created_at: string;
}

/** `app.api.code_executions.CodeExecutionArtifactOut`. No `url` — minting one
 * is `GET /agent/artifacts/{id}`'s own job, per request (see
 * `artifactsApi.getArtifactDownload`). */
export interface CodeExecutionArtifactRef {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

/** `app.api.code_executions.CodeExecutionDetail` — `GET /agent/code-executions/{id}`. */
export interface CodeExecutionDetail extends CodeExecutionSummary {
  code: string;
  stdout: string | null;
  stderr: string | null;
  trace_id: string | null;
  tool_calls: Record<string, unknown>[];
  artifacts: CodeExecutionArtifactRef[];
}

/** `GET /agent/code-executions` — every sandbox run the caller's own tenant
 * has made, newest first. `conversationId` narrows it to one transcript. */
export function listCodeExecutions(conversationId?: number): Promise<CodeExecutionSummary[]> {
  const query = conversationId === undefined ? "" : `?conversation_id=${conversationId}`;
  return gatewayClient.agentFetch<CodeExecutionSummary[]>(`/agent/code-executions${query}`);
}

/** `GET /agent/code-executions/{id}` — the program, its output and anything
 * it produced. */
export function getCodeExecution(id: number): Promise<CodeExecutionDetail> {
  return gatewayClient.agentFetch<CodeExecutionDetail>(`/agent/code-executions/${id}`);
}
