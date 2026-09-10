import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigTab } from "./ConfigTab.tsx";
import { setSession } from "../../auth/session.ts";

/**
 * The Configuration tab shipped read-only: it resolved every id to a name
 * and offered no way to change any of them, so the console could describe
 * an agent it could not configure. These tests are about the write half —
 * each one asserts the request that actually reaches the API, because a
 * dropdown that changes local state and sends nothing looks identical on
 * screen to one that works.
 */

const AGENT = {
  id: 2,
  name: "Customer-Support",
  description: "Answers a customer's own questions.",
  pipeline_config: {},
  datasource_id: 2,
  secondary_datasource_id: null as number | null,
  llm_bindings: { plan: 5 } as Record<string, number>,
  code_execution: "none",
  is_active: true,
  compiled_programs: {},
  mcp_server_ids: [7],
};

const DATASOURCES = [
  { id: 2, name: "Restaurant Operations", type: "postgres" },
  { id: 6, name: "Reporting Warehouse", type: "postgres" },
  { id: 8, name: "Fleet Positions", type: "redis" },
];

const LLM_CONFIGS = [
  { id: 5, name: "Default OpenRouter", model: "anthropic/claude-sonnet-4.5" },
  { id: 9, name: "Cheap", model: "deepseek/deepseek-chat" },
];

const MCP_SERVERS = [
  { id: 7, name: "Orders", is_active: true, discovered_tools: [{ name: "get_order" }] },
  { id: 8, name: "Reporting", is_active: true, discovered_tools: [] },
];

vi.mock("react-router-dom", () => ({
  useOutletContext: () => ({ agent: { id: AGENT.id, name: AGENT.name } }),
}));

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Records every write so a test can assert what was actually sent. */
interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function routeFetch(options: { failWrites?: boolean; agent?: Record<string, unknown> } = {}) {
  const writes: Recorded[] = [];
  let agent = { ...AGENT, ...options.agent };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const request = input instanceof Request ? input : null;
    const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
    const rawBody = request !== null ? await request.clone().text() : (init?.body as string | undefined);

    if (method !== "GET") {
      writes.push({
        method,
        url,
        body: rawBody === undefined || rawBody === "" ? null : (JSON.parse(rawBody) as Record<string, unknown>),
      });
      if (options.failWrites === true) return jsonResponse({ detail: "nope" }, 500);
    }

    if (/\/agent\/agents\/\d+\/mcp-servers\/(\d+)$/.test(url)) {
      const serverId = Number(/mcp-servers\/(\d+)$/.exec(url)![1]);
      agent = {
        ...agent,
        mcp_server_ids:
          method === "POST"
            ? [...agent.mcp_server_ids, serverId]
            : agent.mcp_server_ids.filter((id) => id !== serverId),
      };
      return method === "POST" ? jsonResponse({ agent_id: agent.id }, 201) : new Response(null, { status: 204 });
    }
    if (/\/agent\/agents\/\d+$/.test(url)) {
      if (method === "PATCH") {
        agent = { ...agent, ...(JSON.parse(rawBody ?? "{}") as Record<string, unknown>) };
      }
      return jsonResponse(agent);
    }
    if (url.includes("/agent/datasources")) return jsonResponse(DATASOURCES);
    if (url.includes("/agent/llm-configs")) return jsonResponse(LLM_CONFIGS);
    if (url.includes("/agent/mcp-servers")) return jsonResponse(MCP_SERVERS);

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return { fetchMock, writes };
}

describe("ConfigTab", () => {
  beforeEach(() => {
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  async function renderConfig(
    options: { failWrites?: boolean; agent?: Record<string, unknown> } = {},
  ) {
    const routed = routeFetch(options);
    vi.stubGlobal("fetch", routed.fetchMock);
    render(<ConfigTab />);
    await waitFor(() => expect(screen.getByLabelText("Datasource")).toBeInTheDocument());
    return routed;
  }

  it("changing the datasource PATCHes the agent", async () => {
    const { writes } = await renderConfig();

    fireEvent.change(screen.getByLabelText("Datasource"), { target: { value: "6" } });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe("PATCH");
    expect(writes[0].body).toEqual({ datasource_id: 6 });
  });

  it("disconnecting the datasource sends an explicit null, not an omitted field", async () => {
    // The server distinguishes "not sent" from "sent as null" via
    // model_fields_set; omitting the key would leave it connected.
    const { writes } = await renderConfig();

    fireEvent.change(screen.getByLabelText("Datasource"), { target: { value: "" } });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ datasource_id: null });
  });

  it("binding one phase's model sends every other binding back unchanged", async () => {
    // llm_bindings replaces wholesale on the server. A patch carrying only
    // the changed phase would silently unbind every other one.
    const { writes } = await renderConfig();

    fireEvent.change(screen.getByLabelText("Model for the execute phase"), {
      target: { value: "9" },
    });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ llm_bindings: { plan: 5, execute: 9 } });
  });

  it("choosing the tenant default drops that phase from the bindings", async () => {
    const { writes } = await renderConfig();

    fireEvent.change(screen.getByLabelText("Model for the plan phase"), { target: { value: "" } });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ llm_bindings: {} });
  });

  it("offers every phase, including the ones running on the tenant default", async () => {
    await renderConfig();

    for (const phase of ["research", "plan", "execute", "validate", "guardrail"]) {
      expect(screen.getByLabelText(`Model for the ${phase} phase`)).toBeInTheDocument();
    }
  });

  it("attaches an unbound MCP server and detaches a bound one", async () => {
    const { writes } = await renderConfig();

    const reporting = screen.getByText("Reporting").closest("tr")!;
    fireEvent.click(within(reporting).getByRole("button", { name: "Attach" }));

    await waitFor(() => expect(writes[0]?.method).toBe("POST"));
    expect(writes[0].url).toMatch(/\/agent\/agents\/2\/mcp-servers\/8$/);

    const orders = screen.getByText("Orders").closest("tr")!;
    await waitFor(() => expect(within(orders).getByRole("button", { name: "Detach" })).toBeEnabled());
    fireEvent.click(within(orders).getByRole("button", { name: "Detach" }));

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].method).toBe("DELETE");
    expect(writes[1].url).toMatch(/\/agent\/agents\/2\/mcp-servers\/7$/);
  });

  it("a failed write says so and leaves the control showing what the server holds", async () => {
    await renderConfig({ failWrites: true });

    fireEvent.change(screen.getByLabelText("Datasource"), { target: { value: "6" } });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Not switched to "Reporting Warehouse": the write never landed, and a
    // control still showing the new value would claim otherwise.
    expect((screen.getByLabelText("Datasource") as HTMLSelectElement).value).toBe("2");
  });

  // --- the two capabilities ------------------------------------------------
  //
  // They lived only in pipeline_config, so changing one meant a
  // hand-written PATCH. The defaults differ on purpose: vision bills per
  // image and opts in; generative UI is what lets an agent lay an answer
  // out, and opts out.

  it("shows each capability at its documented default when the config is empty", async () => {
    await renderConfig();

    expect(screen.getByRole("switch", { name: "Generative UI" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Vision" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Web search" })).toHaveAttribute("aria-checked", "false");
  });

  it("turns web search on and off like any other capability", async () => {
    const { writes } = await renderConfig();

    fireEvent.click(screen.getByRole("switch", { name: "Web search" }));

    await waitFor(() => expect(writes.some((w) => w.method === "PATCH")).toBe(true));
    const patch = writes.find((w) => w.method === "PATCH")!;
    expect(patch.body?.pipeline_config).toEqual({ web_search: true });
  });

  it("reads a non-boolean web_search value as the default rather than as truthy", async () => {
    await renderConfig({ agent: { pipeline_config: { web_search: "no" } } });

    expect(screen.getByRole("switch", { name: "Web search" })).toHaveAttribute("aria-checked", "false");
  });

  it("sends the whole config, not just the key that changed", async () => {
    // PATCH replaces pipeline_config wholesale, so sending only the changed
    // key would silently drop every other capability the agent has.
    const { writes } = await renderConfig({ agent: { pipeline_config: { vision: true } } });

    fireEvent.click(screen.getByRole("switch", { name: "Generative UI" }));

    await waitFor(() => expect(writes.some((w) => w.method === "PATCH")).toBe(true));
    const patch = writes.find((w) => w.method === "PATCH")!;
    expect(patch.body?.pipeline_config).toEqual({ vision: true, generative_ui: false });
  });

  it("reads a non-boolean as the default rather than as truthy", async () => {
    // pipeline_config is JSON that can hold anything, and treating a stray
    // value as truthy would show Vision as On for a config saying "no".
    await renderConfig({ agent: { pipeline_config: { vision: "no" } } });

    expect(screen.getByRole("switch", { name: "Vision" })).toHaveAttribute("aria-checked", "false");
  });

  it("defaults each phase to what it actually runs", async () => {
    // The four differ, and the table is the only place that says so.
    await renderConfig();

    const value = (phase: string) =>
      (screen.getByLabelText(`Reasoning for the ${phase} phase`) as HTMLSelectElement).value;
    expect(value("research")).toBe("predict");
    expect(value("plan")).toBe("chain_of_thought");
    // execute is not a select at all on a warehouse agent — see the
    // locked-phase tests below.
    expect(value("validate")).toBe("chain_of_thought");
  });

  it("offers ReAct only where there are tools to loop over", async () => {
    // Research retrieves through a fixed pipeline and validation scores an
    // answer that already exists — ReAct there is an empty loop that bills
    // for the privilege, and the server refuses it.
    await renderConfig();

    const choices = (phase: string) =>
      Array.from(
        (screen.getByLabelText(`Reasoning for the ${phase} phase`) as HTMLSelectElement).options,
      ).map((o) => o.value);
    expect(choices("research")).not.toContain("react");
    expect(choices("validate")).not.toContain("react");
    expect(choices("plan")).toContain("react");

  });

  it("keeps the other phases and capabilities when one phase changes", async () => {
    // One pipeline_config, replaced wholesale, so a partial write drops
    // everything it does not name.
    const { writes } = await renderConfig({
      agent: {
        pipeline_config: { vision: true, reasoning_modules: { research: "chain_of_thought" } },
      },
    });

    fireEvent.change(screen.getByLabelText("Reasoning for the validate phase"), {
      target: { value: "predict" },
    });

    await waitFor(() => expect(writes.some((w) => w.method === "PATCH")).toBe(true));
    expect(writes.find((w) => w.method === "PATCH")!.body?.pipeline_config).toEqual({
      vision: true,
      reasoning_modules: { research: "chain_of_thought", validate: "predict" },
    });
  });

  it("reads the scalar key it replaced as the execute phase", async () => {
    // What an agent configured before reasoning became per-phase carries.
    await renderConfig({ agent: { pipeline_config: { reasoning_module: "chain_of_thought" } } });

    // Locked to ReAct by the warehouse datasource, so the stored scalar
    // is not what runs — the lock is, and it says so.
    expect(screen.getByText(/only ReAct can call run_sql/)).toBeInTheDocument();
  });

  it("reads a module this build does not offer as the phase default", async () => {
    // ProgramOfThought and CodeAct are deprecated upstream; a config naming
    // one should run normally rather than showing a blank control.
    await renderConfig({
      agent: { pipeline_config: { reasoning_modules: { execute: "program_of_thought" } } },
    });

    expect(screen.getByText(/only ReAct can call run_sql/)).toBeInTheDocument();
  });

  it("offers no reasoning choice for a phase that does not reason", async () => {
    await renderConfig();

    expect(screen.queryByLabelText("Reasoning for the guardrail phase")).not.toBeInTheDocument();
  });

  it("offers asking as a capability of its own", async () => {
    await renderConfig();

    expect(screen.getByRole("switch", { name: "Ask before answering" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  // --- a setting whose consequence lands on another control ---------------
  //
  // These rules are the server's, and they were invisible here. The
  // selector offered Predict on a warehouse agent, took the click, and
  // surfaced the refusal as an error after the save. Ask before answering
  // was worse: it SILENTLY turns planning and execution into ReAct, and
  // the page went on showing "Chain of thought" for a phase running ReAct.

  it("says why planning cannot be chosen while asking is on", async () => {
    await renderConfig({ agent: { pipeline_config: { human_in_the_loop: true } } });

    expect(screen.queryByLabelText("Reasoning for the plan phase")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask before answering — asking is a tool call/)).toBeInTheDocument();
  });

  it("names the binding constraint when two apply at once", async () => {
    // On a warehouse agent both hold, and naming the wrong one is worse
    // than naming neither: "required by Ask before answering" implies that
    // turning asking off frees the control, and it does not.
    await renderConfig({ agent: { pipeline_config: { human_in_the_loop: true } } });

    expect(screen.getAllByText(/only ReAct can call run_sql/)).toHaveLength(1);
    expect(screen.getAllByText(/Ask before answering — asking is a tool call/)).toHaveLength(1);
  });

  it("lets planning be chosen again once asking is off", async () => {
    await renderConfig({ agent: { pipeline_config: { human_in_the_loop: false } } });

    expect(screen.getByLabelText("Reasoning for the plan phase")).toBeInTheDocument();
  });

  it("names the datasource that forces execution to ReAct", async () => {
    // Not "ReAct is required" — which control do I change? The row names
    // the thing.
    await renderConfig();

    expect(screen.getByText(/only ReAct can call run_sql/)).toBeInTheDocument();
  });

  it("does not force execution to ReAct without a datasource", async () => {
    await renderConfig({ agent: { datasource_id: null } });

    expect(screen.getByLabelText("Reasoning for the execute phase")).toBeInTheDocument();
  });

  it("states the consequence of asking only while it is on", async () => {
    await renderConfig({ agent: { pipeline_config: { human_in_the_loop: true } } });

    expect(screen.getByText(/Plan and execute run as ReAct/)).toBeVisible();
  });

  it("does not state that consequence when asking is off", async () => {
    // Shown permanently it reads as part of the description; shown
    // conditionally it reads as a live fact about this agent.
    await renderConfig();

    expect(
      screen.queryByText(/Plan and execute run as ReAct/),
    ).not.toBeInTheDocument();
  });
});

describe("the second datasource", () => {
  beforeEach(() => {
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  /**
   * An agent may bind a SECOND connector of a different kind so one run can
   * join across two stores — device identity from a SQL warehouse, live
   * position from Redis, joined on the id they share. These tests are about
   * the picker offering only pairs the server will actually accept: it
   * resolves each tool's connector by TYPE and takes the first match, so a
   * same-kind pair is one connector that runs and one that silently never
   * does, and the API answers 422.
   */
  async function renderConfig(agent: Record<string, unknown> = {}) {
    const routed = routeFetch({ agent });
    vi.stubGlobal("fetch", routed.fetchMock);
    render(<ConfigTab />);
    await waitFor(() =>
      expect(screen.getByLabelText("Second datasource")).toBeInTheDocument(),
    );
    return routed;
  }

  it("offers only datasources of a different kind from the one already chosen", async () => {
    await renderConfig();

    const options = within(screen.getByLabelText("Second datasource")).getAllByRole("option");

    // Both postgres rows are gone — the one already bound, and the other
    // one, which would be refused for being the same kind.
    expect(options.map((option) => option.textContent)).toEqual([
      "None",
      "Fleet Positions (redis)",
    ]);
  });

  it("binding one PATCHes only that field", async () => {
    const { writes } = await renderConfig();

    fireEvent.change(screen.getByLabelText("Second datasource"), { target: { value: "8" } });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe("PATCH");
    expect(writes[0].body).toEqual({ secondary_datasource_id: 8 });
  });

  it("unbinding sends an explicit null, not an omitted field", async () => {
    const { writes } = await renderConfig({ secondary_datasource_id: 8 });

    fireEvent.change(screen.getByLabelText("Second datasource"), { target: { value: "" } });

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ secondary_datasource_id: null });
  });
});
