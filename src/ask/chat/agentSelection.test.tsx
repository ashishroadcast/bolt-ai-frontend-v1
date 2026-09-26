import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionChannel } from "./agentSelection.ts";
import type { AskAgent } from "./useAskAgents.ts";
import { Ask } from "../Ask.tsx";
import { testAskConfig } from "../testing.tsx";

const SALES: AskAgent = { id: 1, name: "Sales Analyst", is_active: true, slash_command: null };
const DASHBOARD: AskAgent = { id: 2, name: "Dashboard-Builder", is_active: true, slash_command: "dashboard" };
const FORMS: AskAgent = { id: 3, name: "Form-Builder", is_active: true, slash_command: "form" };
const RETIRED: AskAgent = { id: 4, name: "Old", is_active: false, slash_command: "old" };

/** Answers `/agent/agents` only when the test says so. */
function agentsOnDemand(agents: AskAgent[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetchMock = vi.fn(async () => {
    await gate;
    return new Response(JSON.stringify(agents), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { release };
}

function mount(channel: AgentSelectionChannel) {
  render(<Ask config={{ ...testAskConfig, agentSelection: channel }} />);
}

/** The name on the picker's "Chatting with X" line, or `null` when nothing
 * has armed an agent yet — `AgentPicker` renders nothing in that case (it no
 * longer defaults to anything, auto-routing being the point). */
function armedName(): string | null {
  const label = screen.queryByText("Chatting with");
  return label === null ? null : (label.nextElementSibling?.textContent ?? null);
}

afterEach(() => vi.unstubAllGlobals());

describe("AgentSelectionChannel", () => {
  it("remembers a request until something can answer it", () => {
    const channel = new AgentSelectionChannel();
    expect(channel.request("/Dashboard ")).toBe(true);
    expect(channel.pendingCommand).toBe("dashboard");

    const resolver = vi.fn(() => "armed" as const);
    channel.connect(resolver);
    expect(resolver).toHaveBeenCalledWith("dashboard");
    expect(channel.pendingCommand).toBeNull();
  });

  it("answers false, and remembers nothing, for a command that is not available", () => {
    const channel = new AgentSelectionChannel();
    channel.connect(() => "unavailable");
    expect(channel.request("nope")).toBe(false);
    expect(channel.pendingCommand).toBeNull();
    expect(channel.request("")).toBe(false);
  });

  it("drops a remembered request with a warning when the tenant turns out not to have it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = new AgentSelectionChannel();
    channel.request("dashboard");
    channel.connect(() => "unavailable");
    expect(channel.pendingCommand).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("selectAgent inside Ask", () => {
  it("arms the agent immediately once the list has loaded, as the / menu would", async () => {
    const { release } = agentsOnDemand([SALES, DASHBOARD, FORMS, RETIRED]);
    const channel = new AgentSelectionChannel();
    mount(channel);
    release();
    // Agents loaded, nothing armed yet — the bar has nothing to say.
    await waitFor(() => expect(screen.getByLabelText("Ask a question")).toBeEnabled());
    expect(armedName()).toBeNull();

    let armed = false;
    act(() => {
      armed = channel.request("dashboard");
    });
    expect(armed).toBe(true);
    expect(armedName()).toBe("Dashboard-Builder");

    // Unknown and deactivated commands are unavailable, and change nothing.
    act(() => {
      armed = channel.request("report");
    });
    expect(armed).toBe(false);
    act(() => {
      armed = channel.request("old");
    });
    expect(armed).toBe(false);
    expect(armedName()).toBe("Dashboard-Builder");
  });

  it("defers a request made before the agents load, and applies it once they do", async () => {
    const { release } = agentsOnDemand([SALES, DASHBOARD]);
    const channel = new AgentSelectionChannel();
    mount(channel);

    // The host's "Create with AI": open the panel and arm in the same tick.
    expect(channel.request("dashboard")).toBe(true);
    expect(channel.pendingCommand).toBe("dashboard");

    await act(async () => release());
    await waitFor(() => expect(armedName()).toBe("Dashboard-Builder"));
    expect(channel.pendingCommand).toBeNull();
  });

  it("works when requested before Ask has mounted at all", async () => {
    const { release } = agentsOnDemand([SALES, FORMS]);
    const channel = new AgentSelectionChannel();
    expect(channel.request("form")).toBe(true);
    mount(channel);
    await act(async () => release());
    await waitFor(() => expect(armedName()).toBe("Form-Builder"));
  });
});
