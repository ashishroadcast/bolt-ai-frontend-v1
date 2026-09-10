import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayClient } from "../../api/client.ts";
import { setSession } from "../../auth/session.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import type { AgentTestCase } from "../testing/types.ts";
import { PromptsTab } from "./PromptsTab.tsx";

function testCase(overrides: Partial<AgentTestCase>): AgentTestCase {
  return {
    id: 1,
    agent_id: 42,
    phase: "execute",
    question: "q",
    expected: "e",
    is_active: true,
    last_score: null,
    last_verdict: null,
    last_actual: null,
    last_reasoning: null,
    last_ran_at: null,
    last_prompt_version: null,
    last_tools_used: null,
    last_duration_ms: null,
    last_usage: null,
    trace_id: null,
    created_at: "2026-08-27T00:00:00Z",
    updated_at: "2026-08-27T00:00:00Z",
    ...overrides,
  };
}

/** Stands in for `AgentDetailRoute` — supplies the same
 * `useOutletContext<AgentDetailContext>()` shape a real render would, so
 * `PromptsTab` reads its agent from the route exactly the way it does in
 * production, with no picker of its own. */
function DetailContextStub() {
  const agent: AgentDetailContext["agent"] = { id: 42, name: "Analytics", description: "d", is_active: true };
  return <Outlet context={{ agent } satisfies AgentDetailContext} />;
}

function renderPromptsTab() {
  return render(
    <MemoryRouter initialEntries={["/x"]}>
      <Routes>
        <Route path="/x" element={<DetailContextStub />}>
          <Route index element={<PromptsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const LONG_INSTRUCTIONS = [
  "You are the research step for a customer-support agent.",
  "",
  "Decide what the customer is actually asking. Most questions are one of: where is my order, what did I order, why was I charged this, or a policy question about timings, cancellation or refunds.",
  "",
  "Never invent an order id. If the customer has not given one, say so and stop.",
].join("\n");

const NO_SIGNAL = { exemplars: 0, corrections: 0, items: [] };

function mockApi(prompts: unknown, cases: AgentTestCase[] = [], signal: unknown = NO_SIGNAL) {
  return vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path) => {
    if (path === "/agent/tests") return cases as never;
    if (path === "/agent/feedback?agent_id=42") {
      if (signal instanceof Error) throw signal;
      return signal as never;
    }
    if (path === "/agent/admin/prompts/42") {
      if (prompts instanceof Error) throw prompts;
      return prompts as never;
    }
    throw new Error(`unexpected path ${path}`);
  });
}

/** The phase panel's instruction box. It is a real editor now, so its
 * content is a textarea `value` rather than a text node — `getByText`
 * cannot see it, which is exactly why every assertion about the prompt
 * text goes through here. */
function editor(): HTMLTextAreaElement {
  return within(panel()).getByLabelText(/instructions$/) as HTMLTextAreaElement;
}

/** The open phase's panel, so an assertion can't be satisfied by the
 * phase list's own summary text. */
function panel(): HTMLElement {
  return screen.getByRole("region", { name: /prompt$/ });
}

describe("PromptsTab", () => {
  beforeEach(() => {
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setSession(null);
  });

  it("lists the five prompt phases, never the sixth 'agent' suite phase", async () => {
    mockApi([]);

    renderPromptsTab();

    for (const phase of ["research", "plan", "execute", "validate", "guardrail"]) {
      await waitFor(() => {
        expect(screen.getByRole("button", { name: new RegExp(`^${phase}`) })).toBeInTheDocument();
      });
    }
    expect(screen.queryByRole("button", { name: /^agent/ })).not.toBeInTheDocument();
  });

  // The whole point of the rebuild: the serving instructions are on
  // screen as text, in full, not behind a disclosure and not truncated.
  it("shows the serving instructions in full, as selectable text", async () => {
    mockApi([
      {
        phase: "research",
        instructions: LONG_INSTRUCTIONS,
        version: 17,
        alias: "production",
        is_fallback: false,
      },
    ]);

    renderPromptsTab();

    await waitFor(() => expect(editor().value).toContain("You are the research step"));
    // Every paragraph, including the last — a max-height clip would still
    // hold them, so this asserts the *text* is whole rather than that it
    // is visible; the clipping itself is a CSS rule.
    expect(editor().value).toBe(LONG_INSTRUCTIONS);
    expect(within(panel()).getByText("v17 · production")).toBeInTheDocument();
  });

  // A `<details>` would hide it until clicked, which is what this screen
  // used to do and what made it unusable.
  it("needs no click to reveal the prompt", async () => {
    mockApi([
      { phase: "research", instructions: LONG_INSTRUCTIONS, version: 17, alias: "production", is_fallback: false },
    ]);

    const { container } = renderPromptsTab();
    await waitFor(() => expect(editor().value).toContain("You are the research step"));

    expect(container.querySelector("details")).toBeNull();
  });

  it("selecting a phase swaps the panel to that phase's own prompt", async () => {
    mockApi([
      { phase: "research", instructions: "Research instructions.", version: 17, alias: "production", is_fallback: false },
      { phase: "execute", instructions: "Execute instructions.", version: 4, alias: "production", is_fallback: false },
    ]);

    renderPromptsTab();
    await waitFor(() => expect(editor().value).toBe("Research instructions."));

    fireEvent.click(screen.getByRole("button", { name: /^execute/ }));

    // One phase at a time — the wall of five cards is the thing removed.
    await waitFor(() => expect(editor().value).toBe("Execute instructions."));
    expect(within(panel()).getByText("v4 · production")).toBeInTheDocument();
  });

  it("distinguishes an unregistered phase running the signature default from a versioned one", async () => {
    mockApi([
      { phase: "research", instructions: "Real prompt.", version: 17, alias: "production", is_fallback: false },
      { phase: "guardrail", instructions: "Signature text.", version: null, alias: null, is_fallback: true },
    ]);

    renderPromptsTab();
    await waitFor(() => expect(editor().value).toBe("Real prompt."));

    fireEvent.click(screen.getByRole("button", { name: /^guardrail/ }));

    await waitFor(() => {
      expect(within(panel()).getByText("signature default · unregistered")).toBeInTheDocument();
    });
    expect(within(panel()).getByText("Signature default")).toBeInTheDocument();
    // Its text is still shown — "unregistered" is not "unknowable".
    expect(editor().value).toBe("Signature text.");
  });

  // ── The editor ──────────────────────────────────────────────────────

  it("saves the edited text as a new version of the open phase", async () => {
    const agentFetch = mockApi([
      { phase: "research", instructions: "Real prompt.", version: 17, alias: "production", is_fallback: false },
    ]);

    renderPromptsTab();
    await waitFor(() => expect(editor().value).toBe("Real prompt."));

    fireEvent.change(editor(), { target: { value: "Rewritten prompt." } });
    agentFetch.mockResolvedValue({
      phase: "research",
      prompt_uri: "prompts:/Analytics-research/18",
      version: 18,
      serving_version: 17,
    } as never);
    fireEvent.click(within(panel()).getByRole("button", { name: "Save as new version" }));

    await waitFor(() => expect(within(panel()).getByText(/Saved as v18/)).toBeInTheDocument());
    const [path, init] = agentFetch.mock.calls.at(-1)!;
    expect(path).toBe("/agent/admin/prompts");
    expect(JSON.parse(String(init?.body))).toEqual({
      agent_id: 42,
      phase: "research",
      instructions: "Rewritten prompt.",
    });
  });

  // The single most important thing this screen can say. A save that read
  // as "done, it is live" would send someone away believing traffic had
  // changed when the alias had not moved at all.
  it("says the saved version is not serving, and names what still is", async () => {
    const agentFetch = mockApi([
      { phase: "research", instructions: "Real prompt.", version: 17, alias: "production", is_fallback: false },
    ]);

    renderPromptsTab();
    await waitFor(() => expect(editor().value).toBe("Real prompt."));
    fireEvent.change(editor(), { target: { value: "Rewritten." } });
    agentFetch.mockResolvedValue({
      phase: "research",
      prompt_uri: "prompts:/Analytics-research/18",
      version: 18,
      serving_version: 17,
    } as never);
    fireEvent.click(within(panel()).getByRole("button", { name: "Save as new version" }));

    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("not serving");
    expect(note).toHaveTextContent("v17 is still live");
    // And the candidate is queued up for the promote step, so the operator
    // does not retype a number they were just given.
    expect(within(panel()).getByLabelText("Candidate version")).toHaveValue("18");
  });

  it("will not save text identical to what is already serving, or blank text", async () => {
    mockApi([
      { phase: "research", instructions: "Real prompt.", version: 17, alias: "production", is_fallback: false },
    ]);

    renderPromptsTab();
    await waitFor(() => expect(editor().value).toBe("Real prompt."));

    // Unedited: nothing to register.
    expect(within(panel()).getByRole("button", { name: "Save as new version" })).toBeDisabled();

    // Blank: the server refuses it (a registered-but-empty guardrail runs
    // an agent unguarded), so the button must not offer to try.
    fireEvent.change(editor(), { target: { value: "   " } });
    expect(within(panel()).getByRole("button", { name: "Save as new version" })).toBeDisabled();

    fireEvent.change(editor(), { target: { value: "Rewritten." } });
    expect(within(panel()).getByRole("button", { name: "Save as new version" })).toBeEnabled();
  });

  it("reverts an edit back to the text that is actually serving", async () => {
    mockApi([
      { phase: "research", instructions: "Real prompt.", version: 17, alias: "production", is_fallback: false },
    ]);

    renderPromptsTab();
    await waitFor(() => expect(editor().value).toBe("Real prompt."));

    fireEvent.change(editor(), { target: { value: "Rewritten." } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Revert to serving" }));

    expect(editor().value).toBe("Real prompt.");
    expect(within(panel()).queryByRole("button", { name: "Revert to serving" })).not.toBeInTheDocument();
  });

  it("surfaces the service's own refusal rather than claiming a save happened", async () => {
    const agentFetch = mockApi([
      { phase: "research", instructions: "Real prompt.", version: 17, alias: "production", is_fallback: false },
    ]);

    renderPromptsTab();
    await waitFor(() => expect(editor().value).toBe("Real prompt."));
    fireEvent.change(editor(), { target: { value: "Rewritten." } });
    agentFetch.mockRejectedValue(new Error("agent name contains whitespace"));
    fireEvent.click(within(panel()).getByRole("button", { name: "Save as new version" }));

    await waitFor(() =>
      expect(within(panel()).getByRole("alert")).toHaveTextContent("whitespace"),
    );
    expect(within(panel()).queryByText(/Saved as v/)).not.toBeInTheDocument();
  });

  // `GET /agent/tests` has no server-side agent filter (testing/api.ts's
  // own comment) — it always returns every case for the tenant — so this
  // proves the tab filters to the route's agent (42) rather than mixing
  // in another agent's (99) cases.
  it("scopes suite size to the agent in the route, not the whole tenant", async () => {
    mockApi(
      [],
      [
        testCase({ id: 1, agent_id: 42, phase: "execute" }),
        testCase({ id: 2, agent_id: 42, phase: "execute" }),
        testCase({ id: 3, agent_id: 99, phase: "execute" }),
        testCase({ id: 4, agent_id: 99, phase: "execute" }),
        testCase({ id: 5, agent_id: 99, phase: "execute" }),
      ],
    );

    renderPromptsTab();

    await waitFor(() => expect(screen.getByRole("button", { name: /^execute/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^execute/ })).toHaveTextContent("2 cases");
    fireEvent.click(screen.getByRole("button", { name: /^execute/ }));
    await waitFor(() => expect(within(panel()).getByText(/2 active/)).toBeInTheDocument());
    expect(within(panel()).queryByText(/5 active/)).not.toBeInTheDocument();
  });

  it("shows no agent picker anywhere on the tab — the agent comes from the route", async () => {
    mockApi([]);

    renderPromptsTab();
    await waitFor(() => expect(screen.getByRole("button", { name: /^execute/ })).toBeInTheDocument());

    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /agent/i })).not.toBeInTheDocument();
  });

  // A registry read that fails must not take tune and promote down with
  // it: neither depends on it.
  it("keeps tune and promote usable when the prompt registry can't be read", async () => {
    mockApi(new Error("registry unreachable"));

    renderPromptsTab();

    await waitFor(() => {
      expect(within(panel()).getByText(/Couldn't read the serving prompt/)).toBeInTheDocument();
    });
    expect(within(panel()).getByRole("button", { name: "Tune this phase" })).toBeEnabled();
    expect(within(panel()).getByLabelText("Candidate version")).toBeInTheDocument();
  });

  it("still requires a second, explicit confirmation before promoting anything", async () => {
    const agentFetch = mockApi([]);

    renderPromptsTab();
    await waitFor(() => expect(within(panel()).getByLabelText("Candidate version")).toBeInTheDocument());

    fireEvent.change(within(panel()).getByLabelText("Candidate version"), { target: { value: "9" } });
    agentFetch.mockClear();
    fireEvent.click(within(panel()).getByRole("button", { name: "Promote" }));

    expect(agentFetch).not.toHaveBeenCalled();
    expect(within(panel()).getByText("Confirm promotion")).toBeInTheDocument();
  });

  it("promotes the version typed in, for the phase that is open", async () => {
    const agentFetch = mockApi([]);

    renderPromptsTab();
    await waitFor(() => expect(screen.getByRole("button", { name: /^validate/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^validate/ }));

    fireEvent.change(within(panel()).getByLabelText("Candidate version"), { target: { value: "12" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Promote" }));

    agentFetch.mockResolvedValue({
      allowed: true,
      overridden: false,
      reason: "ok",
      from_version: 11,
      to_version: 12,
      regressed_case_ids: [],
      improved_case_ids: [],
    } as never);
    fireEvent.click(within(panel()).getByRole("button", { name: "Confirm promote" }));

    await waitFor(() => expect(within(panel()).getByText("Promoted")).toBeInTheDocument());
    const [path, init] = agentFetch.mock.calls.at(-1)!;
    expect(path).toBe("/agent/admin/promote");
    expect(JSON.parse(String(init?.body))).toEqual({
      agent_id: 42,
      phase: "validate",
      version: 12,
      override: false,
    });
  });
});
