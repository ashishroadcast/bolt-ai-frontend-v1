import { vi } from "vitest";

/**
 * The browser APIs Radix overlays (Popover, DropdownMenu, Select, Tooltip)
 * reach for that jsdom does not have. Opt-in, per test file:
 *
 *     beforeEach(() => installRadixPolyfills());
 *
 * Not global in setup.ts, because other tests assert that jsdom has NO
 * `matchMedia` / `ResizeObserver` (typewriter, Composer, useStickToBottom)
 * and would silently change meaning under a global stub.
 *
 * Radix buttons open on `pointerdown`, not `click`: drive them with
 * `@testing-library/user-event`, or `fireEvent.pointerDown(el, { button: 0,
 * ctrlKey: false })` followed by `fireEvent.click(el)`.
 */
export function installRadixPolyfills(): void {
  if (typeof globalThis.ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
}
