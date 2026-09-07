import { gatewayClient } from "../api/client.ts";

/**
 * Wire types for `GET /agent/conversations` (`agent-service/app/api/
 * conversations.py`'s `ConversationListOut`/`ConversationSummaryOut`).
 * Field names match the FastAPI response verbatim, the same convention
 * `./conversation.ts`'s own `MessageOut`/`ConversationDetailOut` already
 * use for the sibling `GET .../{id}` endpoint.
 *
 * `title` is `null` for every conversation today — `app.api.run`'s own
 * module docstring is explicit that title generation is out of that
 * task's scope ("No title generation ... Phase 5 adds to this row rather
 * than replacing it"), and `app.api.conversations` never sets one either.
 * `HistoryPanel.tsx` falls back to a formatted date when `title` is
 * `null` rather than rendering a blank row.
 */
export interface ConversationSummary {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_assistant_snippet: string | null;
  /**
   * `complaint:<uuid>` or `chatwoot:<account>:<inbox>` for a run that
   * arrived over a channel binding; `null` for one a person typed here.
   * `null` on every row until agent-service is deployed with the `source`
   * work, which is why this is optional rather than required.
   */
  external_ref?: string | null;
}

/**
 * Which conversations to list. `mine` is the caller's own chats and is the
 * server's default. `channel` is runs that arrived over a channel binding
 * (a Zomato complaint, a Chatwoot thread) — those are scoped to the tenant
 * rather than to one person, because nobody logged in and typed them: their
 * `user_id` is only the binding's `owner_user_id` standing in as an
 * accountable human, so scoping them to the browsing user would hide the
 * tenant's own record of what an agent told a customer.
 */
export type ConversationSource = "mine" | "channel" | "all";

export interface ConversationListResult {
  items: ConversationSummary[];
  next_cursor: string | null;
}

/**
 * `search`, when non-blank, is sent as `?search=` — matches `app.api.
 * conversations.list_conversations`'s own query param exactly. A blank or
 * omitted search sends no param at all rather than `?search=`, so an
 * operator clearing the search box gets the same unfiltered list a first
 * load would.
 */
export function listConversations(
  search?: string,
  source: ConversationSource = "mine",
): Promise<ConversationListResult> {
  const trimmed = search?.trim() ?? "";
  const params = new URLSearchParams();
  if (trimmed !== "") params.set("search", trimmed);
  // Omitted for "mine" rather than sent explicitly: that is the server's
  // own default, and not sending it keeps this request byte-identical to
  // the one this console made before channels existed — so an older
  // agent-service, which would 422 on an unknown enum value, still serves
  // the default tab.
  if (source !== "mine") params.set("source", source);
  const query = params.toString();
  return gatewayClient.agentFetch<ConversationListResult>(
    `/agent/conversations${query === "" ? "" : `?${query}`}`,
  );
}

/**
 * `DELETE /agent/conversations/{id}` (`agent-service/app/api/
 * conversations.py`) — 204 with no body on success, matching every other
 * delete in this API. Not recoverable server-side (the handler's own
 * docstring: messages, code-execution rows and their R2 artifacts are all
 * removed in the same request) — `HistoryPanel.tsx` is what makes the
 * caller confirm before this is ever called.
 */
export function deleteConversation(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/conversations/${id}`, { method: "DELETE" });
}
