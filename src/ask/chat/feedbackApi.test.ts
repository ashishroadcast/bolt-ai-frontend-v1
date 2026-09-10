import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageRowId, submitFeedback } from "./feedbackApi.ts";
import { testAskClient } from "../testing.tsx";

// One client for the file. These are plain functions now, not hooks —
// they take the caller's client rather than reaching for a singleton.
const client = testAskClient();

describe("messageRowId", () => {
  it("accepts the real server-assigned id a `start` chunk carries", () => {
    // `{"type":"start","messageId":"400084"}` — a `messages` row id, as a
    // string, from a real captured stream.
    expect(messageRowId("400084")).toBe(400084);
  });

  it("rejects useChat's own local placeholder, which no server row backs", () => {
    expect(messageRowId("run-3")).toBeNull();
    expect(messageRowId("user-1")).toBeNull();
  });

  it("rejects anything that is not a plain positive integer", () => {
    // `Number()` alone would accept every one of these: "" -> 0, " 12 " ->
    // 12, "1e3" -> 1000, "0x10" -> 16. A rating posted against a coerced id
    // would land on some other user's message or 404.
    expect(messageRowId("")).toBeNull();
    expect(messageRowId(" 12 ")).toBeNull();
    expect(messageRowId("1e3")).toBeNull();
    expect(messageRowId("0x10")).toBeNull();
    expect(messageRowId("-4")).toBeNull();
    expect(messageRowId("0")).toBeNull();
    expect(messageRowId("12.5")).toBeNull();
  });
});

describe("submitFeedback", () => {
  beforeEach(() => {
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits `comment` entirely for a plain rating", async () => {
    const agentFetch = vi.spyOn(client, "agentFetch").mockResolvedValue({} as never);

    await submitFeedback(client, 400278, "up");

    const [path, init] = agentFetch.mock.calls.at(-1)!;
    expect(path).toBe("/agent/feedback");
    // Not `comment: null`, not `comment: ""` — `apply_feedback` treats any
    // truthy comment on a down-vote as a correction to record, and the
    // wire shape for a bare rating must stay exactly what it was.
    expect(JSON.parse(String(init?.body))).toEqual({ message_id: 400278, rating: "up" });
  });

  it("sends `comment` when one is given, which is what makes a 👎 a correction", async () => {
    const agentFetch = vi.spyOn(client, "agentFetch").mockResolvedValue({} as never);

    await submitFeedback(client, 400278, "down", "counted cancelled lines");

    const [, init] = agentFetch.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toEqual({
      message_id: 400278,
      rating: "down",
      comment: "counted cancelled lines",
    });
  });
});
