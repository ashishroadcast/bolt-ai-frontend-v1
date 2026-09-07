import { gatewayClient } from "../api/client.ts";

/** `app.agent.models.ConfigAuditAction`. */
export type ConfigAuditAction = "create" | "update" | "delete";

/** `app.api.audit.ConfigAuditOut` — `GET /agent/audit`. Read-only: this
 * console has no way to write one, the same way `record_config_write`
 * (`app.agent.models`) is the only writer on the backend side. */
export interface ConfigAuditEntry {
  id: number;
  tenant_id: number;
  actor_user_id: number;
  entity_type: string;
  entity_id: string;
  action: ConfigAuditAction;
  changed_fields: Record<string, unknown>;
  created_at: string;
}

/** `GET /agent/audit`, optionally filtered to one `entity_type`
 * (`?entity_type=channel_binding`) — the same optional-query-parameter
 * shape `listTestCases`-style endpoints elsewhere in this codebase use. */
export function listAuditEntries(entityType?: string): Promise<ConfigAuditEntry[]> {
  const query = entityType !== undefined ? `?entity_type=${encodeURIComponent(entityType)}` : "";
  return gatewayClient.agentFetch<ConfigAuditEntry[]>(`/agent/audit${query}`);
}
