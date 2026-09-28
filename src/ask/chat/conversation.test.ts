import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConversation, hydrateMessages, type MessageOut } from "./conversation.ts";
import { testAskClient } from "../testing.tsx";

// One client for the file. These are plain functions now, not hooks —
// they take the caller's client rather than reaching for a singleton.
const client = testAskClient();

describe("hydrateMessages", () => {
  it("carries a persisted data-table part through wireParts.toUIPart into the catalog's own props shape", () => {
    const messages: MessageOut[] = [
      {
        id: 1,
        role: "user",
        content: "top items last week",
        agent_id: null,
        trace_id: null,
        meta: null,
        created_at: "2026-08-20T10:41:00Z",
      },
      {
        id: 2,
        role: "assistant",
        content: "Chicken Biryani led the week.",
        agent_id: 3,
        trace_id: "trace-1",
        meta: {
          ui_parts: [{ type: "data-table", data: { columns: ["item"], rows: [["Chicken Biryani"]] } }],
        },
        created_at: "2026-08-20T10:41:05Z",
      },
    ];

    const hydrated = hydrateMessages(messages);

    expect(hydrated).toHaveLength(2);
    expect(hydrated[1]).toMatchObject({
      id: "2",
      role: "assistant",
      content: "Chicken Biryani led the week.",
      parts: [
        {
          intent: "data-table",
          data: {
            title: "Query results",
            // Headers are written the way a person would (wireParts.headerLabel):
            // the raw column name is how the database spells it, not how the
            // operator reading the table does.
            columns: [{ key: "c0", header: "Item" }],
            rows: [{ c0: "Chicken Biryani" }],
          },
        },
      ],
    });
    // Reopening must never fabricate a run summary — see types.ts's own
    // docstring: only a message this session actually streamed gets one.
    expect(hydrated[1]!.runSummary).toBeUndefined();
  });

  it("carries an empty ui_parts (or a null meta) through as no parts, not a crash", () => {
    const messages: MessageOut[] = [
      {
        id: 5,
        role: "assistant",
        content: "No sources matched.",
        agent_id: 1,
        trace_id: null,
        meta: null,
        created_at: "2026-08-20T10:41:00Z",
      },
    ];
    expect(hydrateMessages(messages)[0]!.parts).toEqual([]);
  });

  it("drops a system message rather than rendering it as a turn", () => {
    const messages: MessageOut[] = [
      {
        id: 9,
        role: "system",
        content: "internal",
        agent_id: null,
        trace_id: null,
        meta: null,
        created_at: "2026-08-20T10:41:00Z",
      },
    ];
    expect(hydrateMessages(messages)).toEqual([]);
  });
});

describe("fetchConversation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes through the real gatewayClient (Authorization header, JSON parsing) rather than a bare fetch", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 42,
          title: null,
          created_at: "2026-08-20T10:41:00Z",
          updated_at: "2026-08-20T10:41:05Z",
          messages: [
            {
              id: 1,
              role: "assistant",
              content: "answer",
              agent_id: 1,
              trace_id: null,
              meta: { ui_parts: [] },
              created_at: "2026-08-20T10:41:05Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const messages = await fetchConversation(client, 42);

    expect(messages).toHaveLength(1);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toContain("/agent/conversations/42");
    // The fixture credential, not a token planted in the console's session
    // store — see `../testing.tsx` for why that store is gone from here.
    expect(request.headers.get("Authorization")).toBe("Bearer boltai_test-credential");
  });
});

describe("hydrateMessages / usage", () => {
  function assistant(meta: unknown) {
    return {
      id: 2,
      role: "assistant" as const,
      content: "answer",
      agent_id: 7,
      trace_id: null,
      meta: meta as never,
      created_at: "2026-08-20T10:41:05Z",
    };
  }

  it("reads back the usage a run persisted, so a reopened answer still reports its cost", () => {
    const [message] = hydrateMessages([
      assistant({ ui_parts: [], usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000, cost_usd: 0.02, duration_ms: 4200 } }),
    ]);

    expect(message!.usage).toMatchObject({ total_tokens: 1000, cost_usd: 0.02 });
  });

  it("carries agent_id through, which is the only record of who answered that survives", () => {
    const [message] = hydrateMessages([assistant({ ui_parts: [] })]);
    expect(message!.agentId).toBe(7);
  });

  it("degrades a malformed usage blob to no usage, never to NaN in the metadata strip", () => {
    // `meta` is a free-form JSON column: an older row, or a complaint turn
    // whose meta carries a different key set, must not reach the strip as
    // "NaN tok" / "$NaN".
    expect(hydrateMessages([assistant({ usage: { duration_ms: 4200 } })])[0]!.usage).toBeNull();
    expect(hydrateMessages([assistant({ usage: "none" })])[0]!.usage).toBeNull();
    expect(hydrateMessages([assistant({ usage: null })])[0]!.usage).toBeNull();
    expect(hydrateMessages([assistant({})])[0]!.usage).toBeNull();
  });
});
