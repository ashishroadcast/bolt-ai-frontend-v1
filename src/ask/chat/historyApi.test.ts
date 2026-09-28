import { describe, expect, it } from "vitest";
import { readableTitle } from "./historyApi.ts";

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
