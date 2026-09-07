/**
 * The AI SDK UI Message Stream Protocol, client side (design plan §10.1,
 * task 3 brief). Mirrors `agent-service/app/stream/protocol.py`'s
 * `StreamWriter` byte-for-byte: that module is the actual, verified-against-
 * `ai@7.0.83` producer of every shape below, so this file follows it rather
 * than the AI SDK docs directly — `agent-service` is a from-scratch Python
 * emitter, not the `ai` package, and its own module docstring records more
 * than one place where "the docs say so" and "it actually behaves that way"
 * diverged during that work.
 *
 * `agentFetch` in `../api/gatewayClient.ts` always awaits `response.json()`,
 * so it cannot carry an SSE body — this module's `readDataStream` is the
 * one exception to "route every /agent/* call through GatewayClient", and
 * `runStream.ts` documents why.
 */

export interface StartChunk {
  type: "start";
  messageId: string;
}

export interface TextStartChunk {
  type: "text-start";
  id: string;
}

export interface TextDeltaChunk {
  type: "text-delta";
  id: string;
  delta: string;
}

export interface TextEndChunk {
  type: "text-end";
  id: string;
}

export interface ToolInputAvailableChunk {
  type: "tool-input-available";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolOutputAvailableChunk {
  type: "tool-output-available";
  toolCallId: string;
  output: string;
}

/**
 * One `data-<name>` part. `transient` is only ever present (`true`) on a
 * progress/phase event — `StreamWriter.data()` omits the key entirely for a
 * persisted part, which is why this field is optional rather than
 * `boolean` with a default: "key absent" and "key false" both mean
 * persisted, and callers should not have to care which.
 */
export interface DataChunk {
  type: `data-${string}`;
  id?: string;
  data: Record<string, unknown>;
  transient?: boolean;
}

/**
 * One LLM call inside a run — `app.agent.usage.UsageCall`, verbatim.
 * `model` carries LiteLLM's routing prefix (`openrouter/openai/gpt-5-mini`);
 * `runTrace.modelsFromUsage` is what strips it.
 */
export interface UsageCall {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  priced: boolean;
}

export interface UsageMetadata {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  duration_ms: number;
  /**
   * Optional here, but present on every real run: `app.api.run` sends
   * `dataclasses.asdict(result.usage)`, and `Usage.calls` is part of that
   * dataclass even though §4.1's documented `messages.meta.usage` shape
   * omits it (that shape is a run-level summary; this is the per-call
   * detail that rides along with it). Verified on a captured stream
   * 2026-08-28 — it is the only place the model that answered is named.
   */
  calls?: UsageCall[];
}

export interface FinishChunk {
  type: "finish";
  messageMetadata?: { usage?: UsageMetadata };
}

export interface ErrorChunk {
  type: "error";
  errorText: string;
}

export type StreamChunk =
  | StartChunk
  | TextStartChunk
  | TextDeltaChunk
  | TextEndChunk
  | ToolInputAvailableChunk
  | ToolOutputAvailableChunk
  | DataChunk
  | FinishChunk
  | ErrorChunk;

/** The literal terminator line's body — never JSON-encoded (`protocol.py`'s
 * `_sse` leaves a `str` payload alone), so it is checked before `JSON.parse`
 * rather than after a parse failure. */
export const DONE = "[DONE]";

function isDataType(type: string): type is `data-${string}` {
  return type.startsWith("data-");
}

/**
 * Parses one already-unwrapped frame body (the text after `"data: "`, before
 * the blank line that ends an SSE event). Returns `null` for a body this
 * client has no shape for — forward-compatible the same way `_adapt_event`
 * on the server logs and skips an event type it does not recognise, rather
 * than throwing and taking the whole run down.
 */
export function parseChunk(body: string): StreamChunk | typeof DONE | null {
  if (body === DONE) return DONE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return null;
  const type = (parsed as { type: unknown }).type;
  if (typeof type !== "string") return null;

  if (
    type === "start" ||
    type === "text-start" ||
    type === "text-delta" ||
    type === "text-end" ||
    type === "tool-input-available" ||
    type === "tool-output-available" ||
    type === "finish" ||
    type === "error"
  ) {
    return parsed as StreamChunk;
  }
  if (isDataType(type)) return parsed as DataChunk;
  return null;
}

/**
 * Reads an SSE body framed exactly the way `protocol.py`'s `_sse` writes it
 * (`data: <json|"[DONE]">\n\n`), yielding parsed chunks as they arrive and
 * stopping at the `[DONE]` sentinel. A chunk that doesn't parse (or isn't
 * one of the known types) is dropped silently rather than raising — the
 * same forward-compatibility call `parseChunk` documents.
 *
 * Buffers across reads because a frame boundary (`\n\n`) can land in the
 * middle of a `ReadableStream` chunk — `TextDecoderStream` alone does not
 * guarantee frame alignment, only valid UTF-8 boundaries.
 */
export async function* readDataStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const parsed = parseChunk(line.slice("data: ".length));
          if (parsed === DONE) return;
          if (parsed !== null) yield parsed;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
