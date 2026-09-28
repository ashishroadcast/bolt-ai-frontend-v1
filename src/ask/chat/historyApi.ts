/**
 * Every call here takes its `client` rather than reaching for a module-level
 * one. That is what lets two Ask instances coexist on a page with different
 * base URLs and different credentials — and what removed this package's last
 * import of the admin console's HTTP singleton. Callers get theirs from
 * `useAskClient()`.
 */
import type { GatewayClient } from "../http/gatewayClient.ts";

/**
 * Wire types for `GET /agent/conversations` (`agent-service/app/api/
 * conversations.py`'s `ConversationListOut`/`ConversationSummaryOut`).
 * Field names match the FastAPI response verbatim, the same convention
 * `./conversation.ts`'s own `MessageOut`/`ConversationDetailOut` already
 * use for the sibling `GET .../{id}` endpoint.
 *
 * `title` is the conversation's first question, trimmed to 80 characters,
 * on an agent-service that derives one. Nothing ever stored a title, so an
 * older agent-service sends `null` on every row — and a list of rows all
 * headed by their own timestamp is exactly what people saw. There is no
 * separate "first question" field to fall back to: this IS that field.
 * Read it through `readableTitle` below, never raw.
 */
export interface ConversationSummary {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  /**
   * The latest question asked in the conversation. Absent (not `null`) on
   * an agent-service that predates it, which is how `HistoryPanel.tsx`
   * tells "no question to show" from "this server cannot say" and falls
   * back to `last_assistant_snippet` only for the second.
   */
  preview?: string | null;
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

// Month and weekday names, and the words that ride along with a clock time.
// Stripped before asking "is anything left?", so "20 Aug, 10:41 am" and
// "Tue Sep 23 2026 10:41:00 GMT+0530" both reduce to nothing. Whole words
// only: "Monthly" must not lose its "Mon".
const DATE_WORDS =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|utc|gmt|ist)\b|(?:\b|(?<=\d))(?:am|pm)\b/gi;
// Uppercase T and Z are ISO 8601's own separators ("2026-08-20T10:41:00Z").
const DATE_PUNCTUATION = /[\d\s:/.,TZ+()-]/g;

// Titles something other than a person wrote: a client's placeholder, or a
// row numbered by its id. Each reads as a real heading and says nothing, so
// a list of them is the timestamp problem again in different words.
const DEFAULT_TITLES = /^(?:\(?untitled\)?|new|new chat|new conversation|new thread|untitled (?:chat|conversation|thread)|(?:chat|conversation|thread)(?: #?\d+)?)$/i;

/**
 * `title`, or `null` when there is no title worth heading a row with.
 *
 * Null for a blank title, and for one that is really a timestamp or a
 * generated default. A date is not a name: the row already shows when the
 * conversation happened on its own muted line, so a timestamp heading
 * just says it twice and leaves every row looking the same. The caller
 * picks the fallback; this only decides whether the title can be trusted.
 */
export function readableTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") return null;
  if (DEFAULT_TITLES.test(trimmed)) return null;
  // A timestamp is digits, date words and punctuation, and nothing else.
  // Requiring a digit keeps a title that is only a month or a day
  // ("March", "Sunday") a title.
  const residue = trimmed.replace(DATE_WORDS, "").replace(DATE_PUNCTUATION, "");
  if (residue === "" && /\d/.test(trimmed)) return null;
  return trimmed;
}

export interface ConversationListResult {
  items: ConversationSummary[];
  /**
   * Where the next, older page starts, or `null` when this page is the
   * last. Opaque here: it happens to be the last row's id, but only the
   * server decides that, so it is handed back verbatim as `?cursor=`.
   */
  next_cursor: string | null;
}

/**
 * `search`, when non-blank, is sent as `?search=` — matches `app.api.
 * conversations.list_conversations`'s own query param exactly. A blank or
 * omitted search sends no param at all rather than `?search=`, so an
 * operator clearing the search box gets the same unfiltered list a first
 * load would.
 *
 * `cursor` is a previous page's `next_cursor`, and fetches the page after
 * it. It pages whatever `search` and `source` select, so the caller must
 * send the same two it got the cursor with — a cursor from the unfiltered
 * list applied to a search would skip every match newer than it.
 */
export function listConversations(
  client: GatewayClient,
  search?: string,
  source: ConversationSource = "mine",
  cursor?: string | null,
): Promise<ConversationListResult> {
  const trimmed = search?.trim() ?? "";
  const params = new URLSearchParams();
  if (trimmed !== "") params.set("search", trimmed);
  if (cursor !== undefined && cursor !== null) params.set("cursor", cursor);
  // Omitted for "mine" rather than sent explicitly: that is the server's
  // own default, and not sending it keeps this request byte-identical to
  // the one this console made before channels existed — so an older
  // agent-service, which would 422 on an unknown enum value, still serves
  // the default tab.
  if (source !== "mine") params.set("source", source);
  const query = params.toString();
  return client.agentFetch<ConversationListResult>(
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
export function deleteConversation(client: GatewayClient, id: number): Promise<void> {
  return client.agentFetch<void>(`/agent/conversations/${id}`, { method: "DELETE" });
}
