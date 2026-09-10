import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Copy } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton.tsx";

describe("CopyButton", () => {
  afterEach(() => {
    // @ts-expect-error -- test-only teardown of a property redefined below
    delete navigator.clipboard;
  });

  it("writes the exact given text to the clipboard, not just something", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<CopyButton text={"store_count\n299"} icon={Copy} idleLabel="Copy" ariaLabel="Copy answer" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("store_count\n299"));
  });

  it("keeps the action's name through the flow: Copy becomes Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<CopyButton text="hello" icon={Copy} idleLabel="Copy" ariaLabel="Copy answer" />);
    expect(screen.getByRole("button", { name: "Copy answer" })).toHaveTextContent("Copy");

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copy answer" })).toHaveTextContent("Copied"));
  });

  it("shows a visible, selectable fallback rather than doing nothing when the clipboard write is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<CopyButton text="the exact answer text" icon={Copy} idleLabel="Copy" ariaLabel="Copy answer" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    // Not a silent no-op: a real, readable fallback with the same text a
    // person can select and copy by hand.
    const fallback = await screen.findByDisplayValue("the exact answer text");
    expect(fallback).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy answer" })).not.toHaveTextContent("Copied");
  });

  it("reports failure rather than doing nothing when the clipboard API is entirely absent (non-secure context)", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

    render(<CopyButton text="plain http origin text" icon={Copy} idleLabel="Copy" ariaLabel="Copy answer" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    expect(await screen.findByDisplayValue("plain http origin text")).toBeInTheDocument();
  });
});
