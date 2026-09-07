import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, vi } from "vitest";
import { setSession } from "../auth/session.ts";

/*
 * Recharts sizes itself from its container, and jsdom reports every
 * element as 0x0 — so `ResponsiveContainer` renders an empty chart and any
 * assertion about one passes vacuously against nothing at all. That is an
 * environment fact, not a property of any single test, so the fix belongs
 * here rather than repeated in every file that happens to render a chart
 * (it first bit `catalog.test.tsx`, which only wanted to prove routing).
 *
 * Only the SIZING is replaced. The real axes, scales, lines and bars still
 * run, so a test can assert on what was actually drawn.
 */
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    // createElement, not a direct call: ResponsiveContainer is a real
    // component, and invoking one as a plain function renders nothing and
    // fails no assertion loudly — it just leaves an empty chart again.
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      createElement(actual.ResponsiveContainer, { width: 600, height: 240, children }),
  };
});

// Every test starts signed out and unmounts its own tree — otherwise a
// session set by one test (or a component left mounted) would leak into
// the next test file's assertions.
afterEach(() => {
  cleanup();
  setSession(null);
});
