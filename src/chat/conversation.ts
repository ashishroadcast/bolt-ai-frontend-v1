import { gatewayClient } from "../api/client.ts";
import type { UsageMetadata } from "./protocol.ts";
import type { ChatMessage } from "./types.ts";
import { toUIPart } from "./wireParts.ts";

/** Mirrors `agent-service/app/api/conversations.py`'s `MessageOut` — the
 * wire shape `GET /agent/conversations/{id}` actually returns. */
export interface MessageOut {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  agent_id: number | null;
  trace_id: string | null;
  meta: { ui_parts?: WireUIPart[]; usage?: unknown } | null;
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
 * reopened answer can still say what it cost, how long it took and which
 * model produced it — just not *how* it got there.
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
      parts: (message.meta?.ui_parts ?? []).map((part) =>
        toUIPart(part.type, (part.data ?? {}) as Record<string, unknown>),
      ),
      createdAt: new Date(message.created_at).getTime(),
      // The two pieces of run metadata that really do survive a reload —
      // see `ChatMessage.usage`/`agentId` for why they sit on the message
      // rather than on `runSummary` (which a reopened message never has).
      usage: toUsage(message.meta?.usage),
      agentId: message.agent_id,
    }));
}

export async function fetchConversation(conversationId: number): Promise<ChatMessage[]> {
  const detail = await gatewayClient.agentFetch<ConversationDetailOut>(
    `/agent/conversations/${conversationId}`,
  );
  return hydrateMessages(detail.messages);
}
