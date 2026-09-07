import { gatewayClient } from "../api/client.ts";

/** `app.agent.models.ChannelTargetKind`. `workflow` exists on the wire
 * (the column has to name both possibilities now, per that enum's own
 * docstring) but `app.api.channels._validate_target` rejects it at write
 * time — the DAG interpreter hasn't shipped — so nothing here ever sends
 * or expects it. */
export type ChannelTargetKind = "orchestrator" | "workflow";

/** `app.api.channels.ChannelBindingOut` — every read/patch response.
 * Neither `webhook_token` nor `api_access_token` is a field here: the
 * backend never echoes either back past the one moment described on
 * `ChannelBindingCreated` below (module docstring, `app/api/channels.py`:
 * "the webhook token and the access token never come back out"). There is
 * also no `name` field — a binding is identified by its Chatwoot
 * account/inbox, not a label this table never grew. */
export interface ChannelBinding {
  id: number;
  provider: string;
  base_url: string;
  account_id: number;
  inbox_id: number;
  owner_user_id: number;
  target_kind: ChannelTargetKind;
  target_id: number;
  handoff_team_id: number | null;
  score_threshold: number;
  handoff_keywords: string[];
  is_active: boolean;
}

/** `app.api.channels.ChannelBindingCreated` — the `POST` response only.
 * `webhook_token` appears here and nowhere else on the wire: the operator
 * has exactly this one moment to copy it into Chatwoot's own webhook URL
 * field before it is gone from every later response for good. */
export interface ChannelBindingCreated extends ChannelBinding {
  webhook_token: string;
}

/** `app.api.channels.ChannelBindingCreate`. `target_kind` is left off this
 * input type on purpose — every caller in this console sends
 * `"orchestrator"`, the only value the backend will ever accept
 * (`_WORKFLOW_NOT_SUPPORTED`), so there is nothing for a form to choose
 * between yet. */
export interface ChannelBindingCreateInput {
  base_url: string;
  account_id: number;
  inbox_id: number;
  // Plaintext here only for the one request that creates the binding —
  // see ChannelsRoute.tsx's own docstring for how the form drops it from
  // its own state the instant this call resolves, the same discipline
  // DatabasesRoute.tsx documents for a DSN.
  api_access_token: string;
  target_id: number;
  handoff_team_id?: number | null;
  score_threshold?: number;
}

/** `app.api.channels.ChannelBindingPatch` — only the keys actually present
 * are sent, matching the backend's `model_fields_set` "not sent vs. sent
 * as null" contract (same convention `OrchestratorPatchInput` documents). */
export interface ChannelBindingPatchInput {
  is_active?: boolean;
}

/** `app.api.channels.test_channel`'s response body. */
export interface ChannelTestResult {
  ok: boolean;
}

/**
 * Every call here goes through `gatewayClient.agentFetch`, which always
 * carries `Authorization: Bearer <token>` and never a tenant id — see
 * `agents/api.ts`'s identical docstring for why no function below takes
 * one as a parameter either.
 */

/** `GET /agent/channels`. */
export function listChannels(): Promise<ChannelBinding[]> {
  return gatewayClient.agentFetch<ChannelBinding[]>("/agent/channels");
}

/** `POST /agent/channels`. */
export function createChannel(input: ChannelBindingCreateInput): Promise<ChannelBindingCreated> {
  return gatewayClient.agentFetch<ChannelBindingCreated>("/agent/channels", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** `PATCH /agent/channels/{id}`. */
export function updateChannel(id: number, patch: ChannelBindingPatchInput): Promise<ChannelBinding> {
  return gatewayClient.agentFetch<ChannelBinding>(`/agent/channels/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** `DELETE /agent/channels/{id}` — 204, no body. */
export function deleteChannel(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/channels/${id}`, { method: "DELETE" });
}

/** `POST /agent/channels/{id}/test` — a live Chatwoot reachability check
 * over the binding's own stored (encrypted) token; never sends or returns
 * a credential itself. */
export function testChannel(id: number): Promise<ChannelTestResult> {
  return gatewayClient.agentFetch<ChannelTestResult>(`/agent/channels/${id}/test`, {
    method: "POST",
  });
}
