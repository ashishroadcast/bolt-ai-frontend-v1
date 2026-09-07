/**
 * The lifecycle test this hook never had — which is why a missing
 * `turnstile.remove()` reached production and broke the *second* sign-in of
 * every session.
 *
 * Cloudflare's script keeps its own registry keyed by the id `render`
 * returns. Leaving a widget in it when React unmounts means the next mount
 * renders a second widget into the same container, and the orphan is what
 * logs "Cannot find Widget cf-chl-widget-…". Its callback never fires again,
 * so the token stays empty and sign-in cannot be submitted.
 */
import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TurnstileState } from "./useTurnstile.ts";

// SITE_KEY is read once at module load, so the env has to be stubbed before
// the module is imported — hence the dynamic import and resetModules below.
async function loadHook(): Promise<() => TurnstileState> {
  vi.resetModules();
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "0xTESTKEY");
  const mod = await import("./useTurnstile.ts");
  return mod.useTurnstile;
}

/** Mounts the hook with its ref actually attached to a DOM node — the hook
 *  renders nothing when `containerRef.current` is null, which `renderHook`
 *  alone would leave it. */
function mount(useTurnstile: () => TurnstileState) {
  function Probe() {
    const { containerRef } = useTurnstile();
    return createElement("div", { ref: containerRef });
  }
  return render(createElement(Probe));
}

const rendered: string[] = [];
const removed: string[] = [];

beforeEach(() => {
  rendered.length = 0;
  removed.length = 0;
  let next = 0;

  // The script is loaded via a <script> tag the hook appends; pre-seeding a
  // matching element makes loadTurnstileScript resolve without a network hit.
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
  document.head.appendChild(script);

  vi.stubGlobal("turnstile", {
    render: () => {
      const id = `widget-${++next}`;
      rendered.push(id);
      return id;
    },
    remove: (id: string) => {
      removed.push(id);
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.head.querySelectorAll("script").forEach((node) => node.remove());
});

it("removes its widget on unmount so the next mount does not orphan one", async () => {
  const useTurnstile = await loadHook();
  const first = mount(useTurnstile);
  await waitFor(() => expect(rendered).toHaveLength(1));

  first.unmount();
  await waitFor(() => expect(removed).toEqual(["widget-1"]));

  // The real symptom: mount again (every 401 sends the user back to sign-in)
  // and exactly one live widget should exist, not two.
  const second = mount(useTurnstile);
  await waitFor(() => expect(rendered).toHaveLength(2));
  expect(rendered.length - removed.length).toBe(1);

  second.unmount();
  await waitFor(() => expect(removed).toEqual(["widget-1", "widget-2"]));
});

it("does not throw out of cleanup when the widget is already gone", async () => {
  vi.stubGlobal("turnstile", {
    render: () => "widget-x",
    remove: () => {
      throw new Error("already removed");
    },
  });

  const useTurnstile = await loadHook();
  const view = mount(useTurnstile);
  await waitFor(() => expect(rendered.length + 1).toBeGreaterThan(0));

  // Throwing from a cleanup takes the whole unmount down with it.
  expect(() => view.unmount()).not.toThrow();
});
