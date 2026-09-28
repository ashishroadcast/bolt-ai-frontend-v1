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

describe("<bolt-ai-ask> credential refresh", () => {
  it("hands Ask a refresh that answers null until the host sets one, then calls the host's", async () => {
    const element = create();
    element.baseUrl = "http://ask.test";
    // Read at call time, so assigning it after the config was built still counts.
    const auth = configOf(element).auth;
    await expect(auth.refreshCredential!()).resolves.toBeNull();

    element.refreshCredential = vi.fn(async () => "renewed");
    await expect(auth.refreshCredential!()).resolves.toBe("renewed");
    expect(element.refreshCredential).toHaveBeenCalledOnce();
  });
});

describe("<bolt-ai-ask> client lifetime", () => {
  it("keeps its client — and its agent list — when only the copy changes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = (input as Request).url;
      const body = url.endsWith("/agent/agents") ? AGENTS : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agentCalls = () =>
      fetchMock.mock.calls.filter(([input]) => (input as Request).url.endsWith("/agent/agents")).length;

    const element = create();
    element.credentialProvider = () => "boltai_test";
    document.body.appendChild(element);
    element.baseUrl = "http://ask.test";
    await waitFor(() => expect(agentCalls()).toBe(1));

    // What bolt-v2 does entering a dashboards screen.
    element.setAttribute("placeholder", "Ask about this dashboard");
    element.setAttribute("empty-title", "Dashboards");
    await waitFor(() => {
      const input = element.shadowRoot?.querySelector("input");
      expect(input?.getAttribute("placeholder")).toBe("Ask about this dashboard");
    });
    expect(agentCalls()).toBe(1);

    // A different backend is a different client, and does fetch again.
    element.baseUrl = "http://other.test";
    await waitFor(() => expect(agentCalls()).toBe(2));
  });
});

describe("<bolt-ai-ask> keyboard containment", () => {
  /** A connected element with a field of the test's choosing inside its
   * shadow root, and a spy on what the host document hears. */
  function mounted() {
    const element = create();
    document.body.appendChild(element);
    const hostHeard = vi.fn();
    document.addEventListener("keydown", hostHeard);
    document.addEventListener("keyup", hostHeard);
    const cleanup = () => {
      document.removeEventListener("keydown", hostHeard);
      document.removeEventListener("keyup", hostHeard);
    };
    return { element, hostHeard, cleanup };
  }

  function press(target: Element, key: string, type = "keydown", init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("keeps keys typed into the widget's own fields from reaching the host's shortcuts", () => {
    const { element, hostHeard, cleanup } = mounted();
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    element.shadowRoot!.append(input, textarea, editable);

    const undo = press(input, "z", "keydown", { ctrlKey: true });
    press(input, "z", "keyup", { ctrlKey: true });
    press(textarea, "ArrowLeft");
    press(editable, "y", "keydown", { ctrlKey: true });

    expect(hostHeard).not.toHaveBeenCalled();
    // Contained, not cancelled: the field still gets its key.
    expect(undo.defaultPrevented).toBe(false);
    cleanup();
  });

  it("still lets Escape and keys outside a field through", () => {
    const { element, hostHeard, cleanup } = mounted();
    const input = document.createElement("input");
    const button = document.createElement("button");
    element.shadowRoot!.append(input, button);

    press(input, "Escape");
    press(button, "ArrowRight");

    expect(hostHeard).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("stops containing once disconnected, and starts again on reconnect", () => {
    const { element, hostHeard, cleanup } = mounted();
    const shadow = element.shadowRoot!;
    const input = document.createElement("input");
    shadow.append(input);

    element.remove();
    // Detached, the event cannot reach the document at all — so listen on
    // the shadow root's host side directly.
    const escaped = vi.fn();
    element.addEventListener("keydown", escaped);
    press(input, "a");
    expect(escaped).toHaveBeenCalledTimes(1);

    document.body.appendChild(element);
    press(input, "a");
    expect(escaped).toHaveBeenCalledTimes(1);
    expect(hostHeard).not.toHaveBeenCalled();
    cleanup();
  });
});
