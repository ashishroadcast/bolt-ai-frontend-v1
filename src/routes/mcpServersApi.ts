import { gatewayClient } from "../api/client.ts";

/**
 * Wire types for `GET`/`POST /agent/mcp-servers`, `DELETE /agent/mcp-servers/{id}`,
 * `POST /agent/mcp-servers/{id}/discover` (`agent-service/app/api/mcp_servers.py`).
 * Field names match the FastAPI response verbatim, the same convention every
 * other `*Api.ts` in this directory follows.
 *
 * `McpServer` never carries `auth_config`/`auth_config_encrypted` — `McpServerOut`
 * on the server has no such field, on any endpoint, including the `201` a
 * create returns right after encrypting what the caller just sent (that
 * router's own docstring: "the credential never comes back out — not on
 * create, not on read"). There is no code path in this module or
 * `McpServersRoute.tsx` that could hold or render one.
 */
export type McpAuthType = "none" | "bearer" | "api_key" | "oauth2_cc";

/** A tool's `inputSchema`, already reduced server-side to a flat
 * `{type, properties}` shape (`app.mcp.discover._sanitize_input_schema`) —
 * this client renders it as-is and never re-derives a richer schema from it. */
export interface McpToolInputSchema {
  type: string;
  properties: Record<string, unknown>;
}

/** One `discovered_tools` entry (`app.mcp.discover._sanitize_tool`).
 * `description` is the whole point of this screen — full prose, not a
 * label, and this client never truncates it. `readOnlyHint` is the
 * server's own claim (§6.5), asymmetric trust: `false` also covers "not
 * declared", the same collapse `_sanitize_tool` performs before storing it. */
export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
  readOnlyHint: boolean;
}

/** One approved `code_mode_tools` entry, exactly as
 * `app.mcp.policy.CodeModeTool.to_dict` stored it. Only `name`/
 * `tenant_field`/`store_field` are an operator's own assertion — the rest
 * is filled in server-side from data the caller does not get to claim:
 * `approved_by`/`approved_at` are the acting principal and the moment, and
 * `schema` is the tool's `inputSchema` as discovery had it *at approval
 * time*, so a schema that changes under a still-approved name stays
 * visible to whoever reviews it. This client renders them, never
 * recomputes them. */
export interface McpCodeModeTool {
  name: string;
  tenant_field: string;
  store_field: string | null;
  approved_by: number;
  approved_at: string;
  schema: McpToolInputSchema;
}

/** `app.api.mcp_servers.McpServerOut`.
 *
 * `code_mode_tools` is the operator-curated allow-list of which discovered
 * tools a code-mode sandbox may actually call — stored rather than derived
 * from `discovered_tools` "on purpose" (that model's own docstring: a
 * deny-list fails open on every tool added later). It is a strict subset of
 * `discovered_tools`, enforced server-side at write time by
 * `app.mcp.policy.validate_code_mode_tools`, so this screen shows the two
 * against each other rather than as separate lists.
 */
export interface McpServer {
  id: number;
  name: string;
  base_url: string;
  auth_type: McpAuthType;
  discovered_tools: McpDiscoveredTool[];
  code_mode_tools: McpCodeModeTool[];
  last_discovery_at: string | null;
  is_active: boolean;
}

/** `app.api.mcp_servers.CodeModeToolIn` — the write form, carrying only
 * what an operator actually asserts. `store_field` is optional: a
 * tenant-only binding is valid. */
export interface McpCodeModeToolInput {
  name: string;
  tenant_field: string;
  store_field?: string | null;
}

/**
 * `app.api.mcp_servers.McpServerCreate`. `auth_config`'s shape depends on
 * `auth_type` (`app.mcp.auth.build_headers`, the only place that reads it
 * back out): `bearer` -> `{token}`, `api_key` -> `{header, key}`,
 * `oauth2_cc` -> `{token_url, client_id, client_secret, scope?}`, `none` ->
 * omitted. Plaintext here only for the one request that creates the row —
 * see McpServersRoute.tsx's own docstring for how the form drops every
 * credential field from its own state the instant this call resolves, the
 * same discipline DatabasesRoute.tsx documents for a DSN.
 */
export interface McpServerCreateInput {
  name: string;
  base_url: string;
  auth_type: McpAuthType;
  auth_config?: Record<string, unknown> | null;
}

/**
 * Every call here goes through `gatewayClient.agentFetch`, which always
 * carries `Authorization: Bearer <token>` and never a tenant id — see
 * `agents/api.ts`'s identical docstring for why no function below takes
 * one as a parameter either.
 */

/** `GET /agent/mcp-servers`. */
export function listMcpServers(): Promise<McpServer[]> {
  return gatewayClient.agentFetch<McpServer[]>("/agent/mcp-servers");
}

/** `POST /agent/mcp-servers`. */
export function createMcpServer(input: McpServerCreateInput): Promise<McpServer> {
  return gatewayClient.agentFetch<McpServer>("/agent/mcp-servers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `DELETE /agent/mcp-servers/{id}` — 204, no body. A server still bound to
 * an agent (`AgentMcpServer`) comes back as a 409 whose `detail` names what
 * to do first ("mcp server is bound to an agent; detach it from every
 * agent first") — `AgentApiError.message` already carries that string
 * verbatim (`gatewayClient.ts`'s own `stringDetailMessage`), so this
 * function does nothing special with it; the caller renders `err.message`. */
export function deleteMcpServer(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/mcp-servers/${id}`, { method: "DELETE" });
}

/** `PATCH /agent/mcp-servers/{id}` with a `code_mode_tools` array —
 * REPLACES the whole allow-list, never merges into it, which is why this
 * function takes the complete intended set rather than a single entry:
 * a merge-shaped write has no way to express "revoke this one", so an
 * allow-list that could only grow would fail open. `[]` is how code mode
 * is turned off for a server.
 *
 * A rejected entry — a tool the server never discovered, one it declares
 * writes (`readOnlyHint: false`), or a tenant/store field the tool's own
 * `inputSchema` does not declare — comes back as a 400 whose `detail`
 * names the offending tool, and the whole PATCH is discarded rather than
 * partially applied. `AgentApiError.message` already carries that string
 * verbatim, so the caller renders `err.message`. */
export function setMcpCodeModeTools(
  id: number,
  tools: McpCodeModeToolInput[],
): Promise<McpServer> {
  return gatewayClient.agentFetch<McpServer>(`/agent/mcp-servers/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ code_mode_tools: tools }),
  });
}

/** `POST /agent/mcp-servers/{id}/discover` — re-runs `tools/list` against
 * the server's live `base_url` and returns the full row with
 * `discovered_tools`/`last_discovery_at` refreshed. A failed live call
 * surfaces as a 502 (`McpDiscoveryError` on the server), same as any other
 * `AgentApiError` here. */
export function discoverMcpServer(id: number): Promise<McpServer> {
  return gatewayClient.agentFetch<McpServer>(`/agent/mcp-servers/${id}/discover`, {
    method: "POST",
  });
}

/** The minimal slice of `app.api.agents.AgentDetailOut` this screen reads —
 * not the whole shape, which lives wherever agent configuration ends up
 * being owned; this module only needs an id, a name to display, and which
 * servers that agent binds. */
interface AgentBindingDetail {
  id: number;
  name: string;
  mcp_server_ids: number[];
}

/**
 * "Which agents use this server" (task brief) has no single endpoint to
 * ask. `GET /agent/agents` (the picker-scoped list) never carries
 * `mcp_server_ids` — that field is configuration, gated on `agent.agents`
 * and deliberately kept off the narrower list endpoint
 * (`app.api.agents`'s own docstring). The only way to learn it is
 * `GET /agent/agents/{id}` per agent, so this fetches the list for names
 * and ids, then one detail call per agent in parallel. Bounded by how many
 * agents a tenant has — an admin screen with no pagination, not a hot
 * path; a tenant running enough agents for N+1 to matter does not exist
 * yet in this codebase.
 *
 * Returns a map of `mcp_server_id -> [agent name, ...]`, empty for a
 * server no agent has bound. Callers that can't reach `/agent/agents/{id}`
 * at all (a permission gap, a network failure) get the thrown error and
 * decide for themselves whether that should block the rest of the screen —
 * this function does not swallow it.
 */
export async function listMcpServerBindings(): Promise<Map<number, string[]>> {
  const agents = await gatewayClient.agentFetch<{ id: number; name: string }[]>("/agent/agents");
  const details = await Promise.all(
    agents.map((agent) => gatewayClient.agentFetch<AgentBindingDetail>(`/agent/agents/${agent.id}`)),
  );

  const byServer = new Map<number, string[]>();
  details.forEach((detail, index) => {
    const name = agents[index]?.name ?? detail.name;
    for (const serverId of detail.mcp_server_ids) {
      const names = byServer.get(serverId) ?? [];
      names.push(name);
      byServer.set(serverId, names);
    }
  });
  return byServer;
}
