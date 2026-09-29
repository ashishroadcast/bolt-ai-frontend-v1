import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { installRadixPolyfills } from "../test/radix.ts";
import { OrchestratorsRoute } from "./OrchestratorsRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const AGENTS = [
  { id: 1, name: "Analytics", description: "d", is_active: true },
  { id: 2, name: "FAQ", description: "d", is_active: true },
  { id: 3, name: "Complaints", description: "d", is_active: true },
];

/** What `GET /agent/llm-configs` returns. The form used to make an
 * operator type a config's numeric id under help text claiming no
 * endpoint listed them — this fixture is that claim being false. */
const LLM_CONFIGS = [
  { id: 2, name: "Anthropic Haiku", provider: "openrouter", model: "anthropic/haiku", base_url: null, params: {}, kind: "chat", is_default: false, is_active: true, has_api_key: true },
  { id: 4, name: "GPT-5 mini", provider: "openrouter", model: "openai/gpt-5-mini", base_url: null, params: {}, kind: "chat", is_default: true, is_active: true, has_api_key: true },
  { id: 7, name: "Qwen3.7 Flash", provider: "openrouter", model: "qwen/qwen3.7-flash", base_url: null, params: {}, kind: "chat", is_default: false, is_active: true, has_api_key: true },
  { id: 9, name: "Embeddings", provider: "openrouter", model: "text-embedding-3-large", base_url: null, params: {}, kind: "embedding", is_default: false, is_active: true, has_api_key: true },
  { id: 12, name: "Retired", provider: "openrouter", model: "old/model", base_url: null, params: {}, kind: "chat", is_default: false, is_active: false, has_api_key: true },
];

const ORCHESTRATORS = [
  { id: 10, name: "Front desk", description: "Routes general questions", mode: "single", llm_config_id: 1, member_agent_ids: [1, 2], is_active: true },
  { id: 11, name: "Research panel", description: "Synthesises", mode: "coordinate", llm_config_id: 1, member_agent_ids: [1, 2, 3], is_active: true },
];

function renderOrchestrators() {
  return render(
    <MemoryRouter initialEntries={["/orchestrators"]}>
      <OrchestratorsRoute />
    </MemoryRouter>,
  );
}

/** `GatewayClient.agentFetch` always calls `fetch(request)` with a single
 * already-built `Request` — never a separate `(url, init)` pair — so every
 * mock here reads the method off the `Request` object itself, not a
 * second argument that's never actually passed. */
function mockAgentServiceReads(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const request = input as Request;
    if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
    if (request.url.endsWith("/agent/llm-configs")) return Promise.resolve(jsonResponse(LLM_CONFIGS));
    if (request.url.endsWith("/agent/orchestrators") && request.method === "GET") {
      return Promise.resolve(jsonResponse(ORCHESTRATORS));
    }
    if (/\/agent\/orchestrators\/\d+$/.test(request.url) && request.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
  });
}

describe("OrchestratorsRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The form's Radix checkboxes/radios (and the delete AlertDialog) reach
    // for ResizeObserver, which jsdom lacks.
    installRadixPolyfills();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("renders single vs coordinate from real data, with different member counts producing different text", async () => {
    mockAgentServiceReads(fetchMock);

    renderOrchestrators();

    await waitFor(() => expect(screen.getByText("Front desk")).toBeInTheDocument());
    // single, 2 members
    expect(screen.getByText("Picks one best-fit agent from 2 agents")).toBeInTheDocument();
    // coordinate, 3 members — same mode-explaining function, different data
    expect(screen.getByText("Runs 3 agents and synthesises one answer")).toBeInTheDocument();
  });

  it("resolves member_agent_ids to real agent names, not raw ids", async () => {
    mockAgentServiceReads(fetchMock);

    renderOrchestrators();

    await waitFor(() => {
      expect(screen.getByText("Analytics, FAQ")).toBeInTheDocument();
    });
  });

  it("delete requires a second, explicit confirmation before anything is sent", async () => {
    mockAgentServiceReads(fetchMock);

    renderOrchestrators();
    await waitFor(() => expect(screen.getByText("Front desk")).toBeInTheDocument());

    const callsBeforeDelete = fetchMock.mock.calls.length;
    // Front desk is the first orchestrator the mock list returns, so its
    // row's Delete button is the first of the two on screen.
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);

    // First click only reveals a confirmation — no DELETE sent yet.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeDelete);
    expect(screen.getByText(/Delete Front desk\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find((call) => {
        const req = call[0] as Request;
        return req.method === "DELETE";
      });
      expect(deleteCall).toBeDefined();
    });
    const deleteRequest = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "DELETE")![0] as Request;
    expect(deleteRequest.url).toMatch(/\/agent\/orchestrators\/10$/);

    await waitFor(() => expect(screen.queryByText("Front desk")).not.toBeInTheDocument());
  });

  it("cancelling the delete confirmation sends nothing and keeps the row", async () => {
    mockAgentServiceReads(fetchMock);

    renderOrchestrators();
    await waitFor(() => expect(screen.getByText("Front desk")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Front desk")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => (call[0] as Request).method === "DELETE")).toBe(false);
  });

  it("create sends exactly the form's own fields — no tenant or user id from the client", async () => {
    mockAgentServiceReads(fetchMock);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
      if (request.url.endsWith("/agent/llm-configs")) return Promise.resolve(jsonResponse(LLM_CONFIGS));
      if (request.url.endsWith("/agent/orchestrators") && request.method === "GET") {
        return Promise.resolve(jsonResponse(ORCHESTRATORS));
      }
      if (request.url.endsWith("/agent/orchestrators") && request.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            { id: 20, name: "New crew", description: null, mode: "single", llm_config_id: 4, member_agent_ids: [1], is_active: true },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderOrchestrators();
    await waitFor(() => expect(screen.getByText("Front desk")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "New orchestrator" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New crew" } });
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Analytics"));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Create orchestrator" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "POST");
      expect(postCall).toBeDefined();
    });
    const postRequest = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "POST")![0] as Request;
    const body = (await postRequest.clone().json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: "New crew",
      description: null,
      mode: "single",
      llm_config_id: 4,
      member_agent_ids: [1],
    });
    expect(Object.keys(body)).not.toContain("tenant_id");
    expect(Object.keys(body)).not.toContain("user_id");

    await waitFor(() => expect(screen.getByText("New crew")).toBeInTheDocument());
  });

  it("refuses to submit create without at least one member agent", async () => {
    mockAgentServiceReads(fetchMock);

    renderOrchestrators();
    await waitFor(() => expect(screen.getByText("Front desk")).toBeInTheDocument());

    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "New orchestrator" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Empty crew" } });
    // The picker only exists once GET /agent/llm-configs has answered —
    // before that the field says "Loading models…" rather than claiming
    // this tenant has none.
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Create orchestrator" }));

    expect(screen.getByText("An orchestrator needs at least one member agent.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("edit sends a PATCH with only the changed-form fields — never llm_config_id", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
      if (request.url.endsWith("/agent/orchestrators") && request.method === "GET") {
        return Promise.resolve(jsonResponse(ORCHESTRATORS));
      }
      if (request.url.endsWith("/agent/orchestrators/10") && request.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: 10,
            name: "Front desk v2",
            description: "Routes general questions",
            mode: "single",
            llm_config_id: 1,
            member_agent_ids: [1, 2],
            is_active: true,
          }),
        );
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderOrchestrators();
    await waitFor(() => expect(screen.getByText("Front desk")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    const nameField = await screen.findByDisplayValue("Front desk");
    fireEvent.change(nameField, { target: { value: "Front desk v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "PATCH");
      expect(patchCall).toBeDefined();
    });
    const patchRequest = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "PATCH")![0] as Request;
    expect(patchRequest.url).toMatch(/\/agent\/orchestrators\/10$/);
    const body = (await patchRequest.clone().json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: "Front desk v2",
      description: "Routes general questions",
      mode: "single",
      member_agent_ids: [1, 2],
    });
    expect(Object.keys(body)).not.toContain("llm_config_id");

    await waitFor(() => expect(screen.getByText("Front desk v2")).toBeInTheDocument());
  });
});

// --- the model picker ------------------------------------------------------
//
// This field was a bare numeric input under help text reading "no endpoint
// lists LLM configs, so this has to be typed". The endpoint existed the
// whole time — the agent fleet already read it — so an operator was being
// asked to know a database id for no reason.

describe("choosing a model for an orchestrator", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The form's Radix checkboxes/radios (and the delete AlertDialog) reach
    // for ResizeObserver, which jsdom lacks.
    installRadixPolyfills();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  async function openCreateForm() {
    mockAgentServiceReads(fetchMock);
    renderOrchestrators();
    await waitFor(() => expect(screen.getByText("Front desk")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New orchestrator" }));
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeInTheDocument());
  }

  it("lists the tenant's chat models by name and model, not by id", async () => {
    await openCreateForm();

    const picker = screen.getByLabelText("Model");
    expect(picker.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: /GPT-5 mini — openai\/gpt-5-mini/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Qwen3.7 Flash/ })).toBeInTheDocument();
  });

  it("leaves out an embedding config, which could never serve a run", async () => {
    await openCreateForm();

    expect(screen.queryByRole("option", { name: /Embeddings/ })).not.toBeInTheDocument();
  });

  it("leaves out an inactive config", async () => {
    await openCreateForm();

    expect(screen.queryByRole("option", { name: /Retired/ })).not.toBeInTheDocument();
  });

  it("puts the tenant default first, ahead of one that sorts earlier by name", async () => {
    await openCreateForm();

    // "Anthropic Haiku" sorts before "GPT-5 mini" alphabetically, so this
    // fails if the ordering is by name alone.
    const options = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(options[0]).toMatch(/GPT-5 mini/);
    expect(options[0]).toMatch(/\(default\)/);
  });

  it("submits the default without the operator touching the picker", async () => {
    // The property the displayed value cannot prove: a select with no
    // value SHOWS its first option while reporting "" to the form, so
    // reading `.value` passes whether or not the form state was ever set.
    // Only the request body says which it was.
    await openCreateForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Untouched" } });
    fireEvent.click(screen.getByLabelText("Analytics"));
    fireEvent.click(screen.getByRole("button", { name: "Create orchestrator" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => (call[0] as Request).method === "POST"),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "POST")!;
    const body = JSON.parse(await (post[0] as Request).clone().text());
    expect(body.llm_config_id).toBe(4);
  });

  it("says what to do when the tenant has no chat model at all", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
      if (request.url.endsWith("/agent/llm-configs")) return Promise.resolve(jsonResponse([]));
      if (request.url.endsWith("/agent/orchestrators")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderOrchestrators();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New orchestrator" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New orchestrator" }));

    await waitFor(() =>
      expect(screen.getByText(/No chat models are set up yet/)).toBeInTheDocument(),
    );
    // Sent somewhere they can act, not left with a box to guess a number in.
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
  });
});
