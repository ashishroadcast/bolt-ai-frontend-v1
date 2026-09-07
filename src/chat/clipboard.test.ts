import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.ts";

describe("copyText", () => {
  afterEach(() => {
    // @ts-expect-error -- test-only teardown of a property we redefine below
    delete navigator.clipboard;
    vi.restoreAllMocks();
  });

  it("writes the exact text to the clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const ok = await copyText("store_count\n299");

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("store_count\n299");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("reports failure, not a throw, when the browser denies clipboard permission", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await expect(copyText("some answer text")).resolves.toBe(false);
  });

  it("reports failure rather than throwing when navigator.clipboard does not exist at all", async () => {
    // The real shape of a non-secure-context page in most browsers: the
    // API is absent, not present-but-rejecting.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

    await expect(copyText("hello")).resolves.toBe(false);
  });
});
