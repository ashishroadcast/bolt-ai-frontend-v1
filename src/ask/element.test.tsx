import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoltAiAskElement } from "./element.tsx";
import type { AskConfig } from "./config.tsx";

/**
 * The 1.2.0 host surface of `<bolt-ai-ask>`: the four dashboard properties
 * follow `onFormDraft`'s rule (null = off, and the key is then absent from
 * the config the cards read), and `selectAgent` arms an agent from outside
 * the React tree — including before the element has loaded its agents.
 */

const AGENTS = [
  { id: 1, name: "Sales Analyst", is_active: true, slash_command: null },
  { id: 2, name: "Dashboard-Builder", is_active: true, slash_command: "dashboard" },
];

function create(): BoltAiAskElement {
  return document.createElement("bolt-ai-ask") as BoltAiAskElement;
}

/** The config the element would hand `<Ask>` right now. */
function configOf(element: BoltAiAskElement): AskConfig {
  return (element as unknown as { config(): AskConfig }).config();
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("<bolt-ai-ask> dashboards surface", () => {
  it("leaves every unset callback OUT of the config, and puts a set one in", () => {
    const element = create();
    element.baseUrl = "http://ask.test";
    const off = configOf(element);
    for (const key of ["onDashboardDraft", "onWidgetDraft", "onEditWidget", "hostContextProvider"]) {
      expect(Object.hasOwn(off, key)).toBe(false);
    }

    const onDashboardDraft = vi.fn();
    const onEditWidget = vi.fn();
    element.onDashboardDraft = onDashboardDraft;
    element.onWidgetDraft = () => Promise.resolve({ status: "added", widgetId: "w" });
    element.onEditWidget = onEditWidget;
    element.hostContextProvider = () => ({ surface: "dashboard_builder", selectedWidgetId: "w" });
    expect(element.onDashboardDraft).toBe(onDashboardDraft);

    const on = configOf(element);
    on.onDashboardDraft!({ draftId: "d", name: "V", widgets: [] });
    expect(onDashboardDraft).toHaveBeenCalledOnce();
    on.onEditWidget!("w");
    expect(onEditWidget).toHaveBeenCalledWith("w");
    expect(on.hostContextProvider!()).toEqual({ surface: "dashboard_builder", selectedWidgetId: "w" });

    element.onDashboardDraft = null;
    expect(Object.hasOwn(configOf(element), "onDashboardDraft")).toBe(false);
  });

  it("answers a widget draft whose handler was cleared mid-flight as a rejection, not a hang", async () => {
    const element = create();
    element.baseUrl = "http://ask.test";
    element.onWidgetDraft = () => Promise.resolve({ status: "added", widgetId: "w" });
    const wrapper = configOf(element).onWidgetDraft!;
    element.onWidgetDraft = null;
    await expect(
      wrapper({ draftId: "d", widget: { metricKey: "eta.trips_completed", visualization: "kpi" } }),
    ).resolves.toEqual({ status: "rejected", reason: "not_in_builder" });
  });

  it("selectAgent before mount is remembered, then arms the agent once the list loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(AGENTS), { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
    const element = create();
    expect(element.selectAgent("/dashboard")).toBe(true);

    element.credentialProvider = () => "boltai_test";
    document.body.appendChild(element);
    element.baseUrl = "http://ask.test";

    // No `<select>` any more — the picker only ever names an armed agent as
    // static text, "Chatting with X".
    await waitFor(() => {
      const spans = Array.from(element.shadowRoot?.querySelectorAll("span") ?? []);
      expect(spans.some((span) => span.textContent === "Dashboard-Builder")).toBe(true);
    });

    // Loaded now, so an unknown command is a definite no.
    expect(element.selectAgent("nope")).toBe(false);
  });
});
