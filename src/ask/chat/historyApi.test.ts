import { afterEach, describe, expect, it, vi } from "vitest";
import { testAskClient } from "../testing.tsx";
import { listConversations, readableTitle } from "./historyApi.ts";

describe("listConversations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function requestedUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
    const input = fetchMock.mock.calls[0]![0] as RequestInfo | URL;
    return new URL(input instanceof Request ? input.url : input.toString());
  }

  function stubList() {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends a cursor alongside the search and source it pages", async () => {
    const fetchMock = stubList();
    await listConversations(testAskClient(), " biryani ", "channel", "41");

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/agent/conversations");
    expect(url.searchParams.get("search")).toBe("biryani");
    expect(url.searchParams.get("source")).toBe("channel");
    expect(url.searchParams.get("cursor")).toBe("41");
  });

  it("sends no cursor for a first page", async () => {
    const fetchMock = stubList();
    await listConversations(testAskClient(), "", "mine", null);

    expect(requestedUrl(fetchMock).search).toBe("");
  });
});

describe("readableTitle", () => {
  it("keeps a real question as it was asked, trimmed", () => {
    expect(readableTitle("  Top items last week ")).toBe("Top items last week");
    expect(readableTitle("Sales on 20 Aug vs 20 Jul")).toBe("Sales on 20 Aug vs 20 Jul");
    expect(readableTitle("Monthly 2025 fuel spend")).toBe("Monthly 2025 fuel spend");
  });

  it("drops a blank or missing title", () => {
    expect(readableTitle(null)).toBeNull();
    expect(readableTitle(undefined)).toBeNull();
    expect(readableTitle("   ")).toBeNull();
  });

  it("drops a title that is only a timestamp, however it was formatted", () => {
    for (const stamp of [
      "2026-08-20T10:41:00Z",
      "2026-08-20 10:41",
      "20 Aug, 10:41 am",
      "Aug 20, 2026, 10:41 AM",
      "20/08/2026 10:41",
      "10:41am",
      "Tue Sep 23 2026 10:41:00 GMT+0530",
    ]) {
      expect(readableTitle(stamp), stamp).toBeNull();
    }
  });

  it("keeps a one-word title that happens to be a month or a day", () => {
    expect(readableTitle("March")).toBe("March");
    expect(readableTitle("Sunday")).toBe("Sunday");
  });

  it("drops the placeholders a client or a numbered default would put there", () => {
    for (const placeholder of ["New conversation", "new chat", "Untitled", "(untitled)", "Conversation 12", "Chat #3"]) {
      expect(readableTitle(placeholder), placeholder).toBeNull();
    }
  });
});
