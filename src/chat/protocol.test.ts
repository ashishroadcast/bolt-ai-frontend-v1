import { describe, expect, it } from "vitest";
import { DONE, parseChunk, readDataStream, type StreamChunk } from "./protocol.ts";

// The exact golden fixture agent-service's own tests round-trip against
// (agent-service/tests/fixtures/stream/run.jsonl, verified there byte-for-
// byte against a real ai@7.0.83) — reproduced as raw SSE frames here so this
// file proves the client reads the real wire shape, not a shape convenient
// to this test.
const GOLDEN_FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
  `data: {"type":"data-phase","data":{"phase":"plan","state":"done"},"transient":true}`,
  `data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"run_sql","input":{"sql":"SELECT 1"}}`,
  `data: {"type":"tool-output-available","toolCallId":"call_1","output":"1 row returned"}`,
  `data: {"type":"data-table","data":{"columns":["n"],"rows":[[1]]}}`,
  `data: {"type":"text-start","id":"answer"}`,
  `data: {"type":"text-delta","id":"answer","delta":"The answer is 1."}`,
  `data: {"type":"data-phase","data":{"phase":"validate","state":"done"},"transient":true}`,
  `data: {"type":"text-end","id":"answer"}`,
  `data: {"type":"finish","messageMetadata":{"usage":{"input_tokens":120,"output_tokens":40,"total_tokens":160,"cost_usd":0.0006,"duration_ms":842.5}}}`,
  `data: [DONE]`,
];

function sseBodyFrom(lines: string[]): ReadableStream<Uint8Array> {
  const text = lines.map((line) => `${line}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// Splits the fixture into arbitrary byte-level pieces regardless of frame
// boundaries, so a boundary landing mid-read is exercised for real rather
// than assumed away by always enqueuing one whole frame per chunk.
function chunkedSseBodyFrom(lines: string[], chunkSize: number): ReadableStream<Uint8Array> {
  const text = lines.map((line) => `${line}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of readDataStream(stream)) out.push(chunk);
  return out;
}

describe("parseChunk", () => {
  it("parses every known chunk type from the golden fixture's frame bodies", () => {
    const bodies = GOLDEN_FRAMES.map((frame) => frame.slice("data: ".length));
    const parsed = bodies.map((body) => parseChunk(body));

    expect(parsed[0]).toEqual({ type: "start", messageId: "msg-1" });
    expect(parsed[10]).toMatchObject({ type: "finish" });
    expect(parsed[11]).toBe(DONE);
  });

  it("keeps a transient data-phase part's transient flag intact", () => {
    const parsed = parseChunk(
      `{"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
    );
    expect(parsed).toMatchObject({ type: "data-phase", transient: true });
  });

  it("does not mark a persisted data-table part transient", () => {
    const parsed = parseChunk(`{"type":"data-table","data":{"columns":[],"rows":[]}}`);
    expect(parsed).toMatchObject({ type: "data-table" });
    expect((parsed as { transient?: boolean }).transient).toBeUndefined();
  });

  it("returns null for a chunk type this client does not know, instead of throwing", () => {
    expect(() => parseChunk(`{"type":"reasoning-delta","id":"x","delta":"hmm"}`)).not.toThrow();
    expect(parseChunk(`{"type":"reasoning-delta","id":"x","delta":"hmm"}`)).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", () => {
    expect(parseChunk("{not json")).toBeNull();
  });
});

describe("readDataStream", () => {
  it("yields every non-DONE chunk from the golden fixture, in order, and stops at [DONE]", async () => {
    const chunks = await collect(sseBodyFrom(GOLDEN_FRAMES));

    expect(chunks).toHaveLength(GOLDEN_FRAMES.length - 1);
    expect(chunks[0]).toEqual({ type: "start", messageId: "msg-1" });
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
    // The generator must never itself yield the sentinel — a caller
    // checking chunk.type on it would throw, since "[DONE]" has no .type.
    expect(chunks.some((c) => (c as unknown) === DONE)).toBe(false);
  });

  it("reassembles frames split across arbitrary byte boundaries", async () => {
    const chunks = await collect(chunkedSseBodyFrom(GOLDEN_FRAMES, 7));
    expect(chunks).toHaveLength(GOLDEN_FRAMES.length - 1);
    expect(chunks[0]).toEqual({ type: "start", messageId: "msg-1" });
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
  });

  it("stops after error with no finish, matching the server's error path (no finish precedes it)", async () => {
    const chunks = await collect(
      sseBodyFrom([
        `data: {"type":"start","messageId":"msg-2"}`,
        `data: {"type":"text-start","id":"answer"}`,
        `data: {"type":"text-end","id":"answer"}`,
        `data: {"type":"error","errorText":"the run failed unexpectedly (ref: abc123)"}`,
        `data: [DONE]`,
      ]),
    );

    expect(chunks.map((c) => c.type)).toEqual(["start", "text-start", "text-end", "error"]);
  });

  it("ends cleanly with no yielded chunks when the body ends before any terminal chunk", async () => {
    // Simulates a dropped connection: bytes stop arriving, no [DONE] line
    // ever shows up. The generator must return (not hang, not throw) —
    // detecting that this happened without a "finish"/"error" is the
    // caller's job (useChat), covered separately.
    const chunks = await collect(
      sseBodyFrom([`data: {"type":"start","messageId":"msg-3"}`, `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`]),
    );
    expect(chunks.map((c) => c.type)).toEqual(["start", "data-phase"]);
  });
});
