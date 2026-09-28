/**
 * Every call here takes its `client` rather than reaching for a module-level
 * one. That is what lets two Ask instances coexist on a page with different
 * base URLs and different credentials — and what removed this package's last
 * import of the admin console's HTTP singleton. Callers get theirs from
 * `useAskClient()`.
 */
import type { GatewayClient } from "../http/gatewayClient.ts";
import type { UsageMetadata } from "./protocol.ts";
import type { ChatMessage, PersistedRunStatus } from "./types.ts";
import { toUIPart } from "./wireParts.ts";

/** Mirrors `agent-service/app/api/conversations.py`'s `MessageOut` — the
 * wire shape `GET /agent/conversations/{id}` actually returns. */
export interface MessageOut {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  agent_id: number | null;
  trace_id: string | null;
  /** Free-form JSON on the server, so every key is read defensively —
   * see `toParts`, `toUsage` and `toRunStatus`. */
  meta: {
    ui_parts?: unknown;
    usage?: unknown;
    run_status?: unknown;
    error_text?: unknown;
  } | null;
  created_at: string;
}

export interface ConversationDetailOut {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  messages: MessageOut[];
}

/** One entry of `messages.meta.ui_parts` exactly as `StreamWriter.
 * persisted_parts` writes it (`protocol.py`'s module docstring: "no
 * `transient` key"): `{type, id?, data}`, `type` always the full wire name
 * (`"data-table"`, not `"table"`). */
interface WireUIPart {
  type: string;
  id?: string;
  data: unknown;
}

/**
 * `messages.meta.usage`, when the run that wrote this row got far enough
 * to persist one. Shape-checked on the two fields the metadata strip can
 * never render without (`total_tokens`, `cost_usd`) rather than trusted
 * wholesale: `meta` is a free-form JSON column, so an older row written
 * before the shape settled — or a complaint turn, whose `meta` carries a
 * different set of keys — must degrade to "no usage" instead of rendering
 * `NaN` and `$NaN`.
 */
function toUsage(raw: unknown): UsageMetadata | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Partial<UsageMetadata>;
  if (typeof usage.total_tokens !== "number" || typeof usage.cost_usd !== "number") return null;
  return usage as UsageMetadata;
}

/**
 * `messages.meta.ui_parts`, adapted — or none at all for a value that is
 * not a list. `meta` is a free-form JSON column, and a row whose
 * `ui_parts` came back as an object or a string used to throw out of
 * `.map`, which failed the whole conversation rather than one row. A
 * malformed entry inside the list is skipped for the same reason.
 */
function toParts(raw: unknown): ChatMessage["parts"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const part = entry as Partial<WireUIPart>;
    if (typeof part.type !== "string") return [];
    const data = typeof part.data === "object" && part.data !== null ? part.data : {};
    const adapted = toUIPart(part.type, data as Record<string, unknown>);
    return adapted === null ? [] : [adapted];
  });
}

/**
 * `messages.meta.run_status`, the backend's record that the run behind a
 * row failed or was cancelled. Anything else — including the field being
 * absent, as it is on every row written before it existed — says nothing,
 * and `Thread` falls back to what the row's content shows.
 */
function toRunStatus(raw: unknown): PersistedRunStatus | undefined {
  return raw === "error" || raw === "cancelled" ? raw : undefined;
}

function toErrorText(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Wire messages -> `ChatMessage[]`, the exact shape a live run's messages
 * converge on too (`types.ts`'s own docstring). No `runSummary` is ever
 * attached here — a reopened message's `data-phase` events never reached
 * `messages.meta.ui_parts` in the first place (`StreamWriter` never adds a
 * transient part to `persisted_parts`), so there is nothing to summarise;
 * this is the concrete mechanism behind "reopening renders sheets but not
 * the expanded rail," not a policy this function has to enforce by hand.
 *
 * `usage` is the exception to "no run metadata survives": `app.api.run`
 * persists `messages.meta.usage` in the same commit as `ui_parts`, so a
 * reopened answer can still say what it cost and which model produced it —
 * just not *how* it got there or the full elapsed time.
 *
 * Each part's wire type/data goes through `wireParts.toUIPart` — the same
 * function `useChat.ts` uses for a *live* part — so a reopened table and a
 * just-streamed one render identically rather than through two adaptations
 * that could drift apart.
 */
export function hydrateMessages(messages: readonly MessageOut[]): ChatMessage[] {
  return messages
    .filter((message): message is MessageOut & { role: "user" | "assistant" } => message.role !== "system")
    .map((message) => ({
      id: String(message.id),
      role: message.role,
      content: message.content,
      parts: toParts(message.meta?.ui_parts),
      createdAt: new Date(message.created_at).getTime(),
      // The two pieces of run metadata that really do survive a reload —
      // see `ChatMessage.usage`/`agentId` for why they sit on the message
      // rather than on `runSummary` (which a reopened message never has).
      usage: toUsage(message.meta?.usage),
      agentId: message.agent_id,
      // How a failed or cancelled run ended. Its `content` is whatever
      // partial answer it got to, often none.
      runStatus: toRunStatus(message.meta?.run_status),
      errorText: toErrorText(message.meta?.error_text),
    }));
}

export async function fetchConversation(
  client: GatewayClient,
  conversationId: number,
): Promise<ChatMessage[]> {
  const detail = await client.agentFetch<ConversationDetailOut>(
    `/agent/conversations/${conversationId}`,
  );
  return hydrateMessages(detail.messages);
}
