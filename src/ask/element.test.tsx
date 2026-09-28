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

describe("<bolt-ai-ask> conversation and scope", () => {
  const CONVERSATION = {
    id: 42,
    title: "Trips",
    created_at: "2026-09-28T09:00:00Z",
    updated_at: "2026-09-28T09:01:00Z",
    messages: [
      {
        id: 1,
        role: "user",
        content: "How many trips ran late yesterday?",
        agent_id: null,
        trace_id: null,
        meta: null,
        created_at: "2026-09-28T09:00:00Z",
      },
    ],
  };

  /** Answers by path; anything unlisted is a 404. Records every request. */
  function routes(table: Record<string, unknown>) {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input as Request;
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (!(path in table)) return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
        return new Response(JSON.stringify(table[path]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return requests;
  }

  function mountElement(configure?: (element: BoltAiAskElement) => void) {
    const element = create();
    const announced: (number | null)[] = [];
    element.addEventListener("conversationchange", (event) => {
      announced.push((event as CustomEvent<{ conversationId: number | null }>).detail.conversationId);
    });
    element.credentialProvider = () => "boltai_test";
    configure?.(element);
    document.body.appendChild(element);
    element.baseUrl = "http://ask.test";
    return { element, announced };
  }

  const text = (element: BoltAiAskElement) => element.shadowRoot?.textContent ?? "";
  const armedName = (element: BoltAiAskElement) =>
    Array.from(element.shadowRoot?.querySelectorAll("span") ?? []).some(
      (span) => span.textContent === "Dashboard-Builder",
    );

  const TABLE = {
    "/agent/agents": AGENTS,
    "/agent/settings/ask": {},
    "/agent/conversations/42": CONVERSATION,
  };

  it("opens the conversation named by conversation-id, and announces it", async () => {
    const requests = routes(TABLE);
    const { element, announced } = mountElement((el) => el.setAttribute("conversation-id", "42"));

    await waitFor(() => expect(text(element)).toContain("How many trips ran late yesterday?"));
    expect(announced).toEqual([42]);
    expect(requests.filter((r) => r.url.endsWith("/agent/conversations/42"))).toHaveLength(1);
  });

  it("opens another one when the attribute changes, and ignores an echo of the current one", async () => {
    const requests = routes(TABLE);
    const { element, announced } = mountElement();
    await waitFor(() => expect(requests.some((r) => r.url.endsWith("/agent/agents"))).toBe(true));

    element.setAttribute("conversation-id", "42");
    await waitFor(() => expect(announced).toEqual([42]));
    // A host binding the attribute to what it was just told.
    element.setAttribute("conversation-id", "42");
    element.removeAttribute("conversation-id");
    element.setAttribute("conversation-id", "42");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.filter((r) => r.url.endsWith("/agent/conversations/42"))).toHaveLength(1);
  });

  it("newConversation() clears the thread and disarms, like the header button, and says so", async () => {
    routes(TABLE);
    const { element, announced } = mountElement((el) => el.setAttribute("conversation-id", "42"));
    await waitFor(() => expect(text(element)).toContain("How many trips ran late yesterday?"));
    element.selectAgent("dashboard");
    await waitFor(() => expect(armedName(element)).toBe(true));

    element.newConversation();

    await waitFor(() => expect(text(element)).not.toContain("How many trips ran late yesterday?"));
    expect(armedName(element)).toBe(false);
    expect(announced).toEqual([42, null]);
  });

  it("clearAgent() disarms but keeps the thread, and cancels a selectAgent still waiting", async () => {
    routes(TABLE);
    const { element } = mountElement((el) => {
      el.setAttribute("conversation-id", "42");
      // Before the list has loaded: remembered…
      expect(el.selectAgent("dashboard")).toBe(true);
      // …and forgotten again.
      el.clearAgent();
    });
    await waitFor(() => expect(text(element)).toContain("How many trips ran late yesterday?"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(armedName(element)).toBe(false);

    element.selectAgent("dashboard");
    await waitFor(() => expect(armedName(element)).toBe(true));
    element.clearAgent();
    await waitFor(() => expect(armedName(element)).toBe(false));
    expect(text(element)).toContain("How many trips ran late yesterday?");
  });

  it("reopens the conversation that was on screen when the host moves the node", async () => {
    routes(TABLE);
    const { element, announced } = mountElement((el) => el.setAttribute("conversation-id", "42"));
    await waitFor(() => expect(text(element)).toContain("How many trips ran late yesterday?"));

    // Angular re-parenting the panel: disconnect, then connect again.
    element.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(text(element)).not.toContain("How many trips ran late yesterday?");
    document.body.appendChild(element);

    await waitFor(() => expect(text(element)).toContain("How many trips ran late yesterday?"));
    expect(announced).toEqual([42]);
    // One mount point, not the old empty one stacked above the new tree.
    expect(Array.from(element.shadowRoot!.children).filter((child) => child.tagName === "DIV")).toHaveLength(1);
  });

  it("announces null for a conversation-id that cannot be opened, so the host forgets it", async () => {
    routes({ "/agent/agents": AGENTS, "/agent/settings/ask": {} });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { announced } = mountElement((el) => el.setAttribute("conversation-id", "7"));

    await waitFor(() => expect(announced).toEqual([null]));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("starts over — thread, armed agent, agent list — when organisation-id changes", async () => {
    const requests = routes(TABLE);
    const { element, announced } = mountElement((el) => {
      el.setAttribute("organisation-id", "org-1");
      el.setAttribute("conversation-id", "42");
    });
    await waitFor(() => expect(text(element)).toContain("How many trips ran late yesterday?"));
    element.selectAgent("dashboard");
    await waitFor(() => expect(armedName(element)).toBe(true));
    const agentLists = () => requests.filter((r) => r.url.endsWith("/agent/agents"));
    expect(agentLists()).toHaveLength(1);

    element.setAttribute("organisation-id", "org-2");

    await waitFor(() => expect(agentLists()).toHaveLength(2));
    expect(agentLists()[1]!.headers.get("Organisation")).toBe("org-2");
    await waitFor(() => expect(text(element)).not.toContain("How many trips ran late yesterday?"));
    expect(armedName(element)).toBe(false);
    expect(announced).toEqual([42, null]);
    // The old scope's conversation is not reopened in the new one.
    expect(requests.filter((r) => r.url.endsWith("/agent/conversations/42"))).toHaveLength(1);
  });

  it("resetScope() does the same for a host that uses organisationProvider", async () => {
    const requests = routes(TABLE);
    let org = "org-1";
    const { element } = mountElement((el) => {
      el.organisationProvider = () => org;
    });
    await waitFor(() => expect(requests.filter((r) => r.url.endsWith("/agent/agents"))).toHaveLength(1));

    org = "org-2";
    element.resetScope();

    await waitFor(() => expect(requests.filter((r) => r.url.endsWith("/agent/agents"))).toHaveLength(2));
    expect(requests.at(-1)!.headers.get("Organisation")).toBe("org-2");
  });
});
