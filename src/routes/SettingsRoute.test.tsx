import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { SettingsRoute } from "./SettingsRoute.tsx";
import type { CatalogueModel, LLMConfig } from "./llmConfigsApi.ts";
import type { SettingsSnapshot } from "./settingsApi.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

const OPENROUTER_CONFIG: LLMConfig = {
  id: 1,
  name: "Default OpenRouter",
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.5",
  base_url: null,
  params: {},
  kind: "chat",
  is_default: true,
  is_active: true,
  has_api_key: true,
};

const SNAPSHOT: SettingsSnapshot = {
  sandbox: {
    max_executions_per_run: 4,
    max_concurrent_executions_per_user: 0,
    concurrent_slot_ttl_seconds: 45,
    concurrency_configured: false,
  },
  agents: [
    { id: 1, name: "Analytics", code_execution: "interpreter" },
    { id: 2, name: "Complaint Broker", code_execution: "none" },
  ],
};

/** Routes the shared `fetch` mock by method + URL — SettingsRoute reads
 * `GET /agent/llm-configs` and `GET /agent/settings` on mount, and can
 * additionally POST/PATCH/DELETE `/agent/llm-configs*` depending on the
 * test. `configs` is mutated in place by create/patch/delete so a
 * `refreshConfigs()` call after a write sees the change, the same way the
 * real backend would.
 *
 * `gatewayClient.agentFetch` calls `fetch(request)` with a single, already
 * -built `Request` — never `fetch(url, init)` — so method and body both
 * come off that one object (`request.method`, `request.clone().text()`),
 * the same shape `llmConfigsApi.test.ts` already reads.
 */
const CATALOGUE: CatalogueModel[] = [
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    context_length: 200000,
    pricing: { prompt: "0.000015", completion: "0.000075" },
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek Chat",
    context_length: 64000,
    pricing: { prompt: "0.00000027", completion: "0.0000011" },
  },
];

function routeFetch(
  options: {
    configs?: LLMConfig[];
    settings?: SettingsSnapshot;
    catalogue?: CatalogueModel[] | "error";
  } = {},
) {
  // Copied, not aliased: the PATCH branch below mutates these objects in
  // place (`other.is_default = ...`, `Object.assign(config, body)`), so
  // sharing the module-level fixture let one test permanently rewrite it for
  // every later one — a test that set a different default left
  // OPENROUTER_CONFIG.is_default false for the rest of the file, and the
  // failures landed on whichever test happened to run next.
  const configs = (options.configs ?? [OPENROUTER_CONFIG]).map((config) => ({ ...config }));
  const settings = options.settings ?? SNAPSHOT;
  const catalogue = options.catalogue ?? CATALOGUE;
  let nextId = Math.max(0, ...configs.map((c) => c.id)) + 1;

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    const request = input instanceof Request ? input : null;
    const method = request?.method.toUpperCase() ?? "GET";

    if (url.includes("/agent/settings")) {
      return jsonResponse(settings);
    }

    // Must precede the CRUD branch: /catalogue is not a numeric id, so it
    // would otherwise fall through and be answered with the config list.
    if (url.includes("/agent/llm-configs/catalogue")) {
      if (catalogue === "error") return jsonResponse({ detail: "upstream down" }, 502);
      return jsonResponse({ models: catalogue });
    }

    if (url.includes("/agent/llm-configs")) {
      const idMatch = /\/agent\/llm-configs\/(\d+)/.exec(url);

      if (method === "GET" && idMatch === null) {
        return jsonResponse(configs);
      }
      if (method === "POST") {
        const raw = request === null ? "{}" : await request.clone().text();
        const body = JSON.parse(raw) as Partial<LLMConfig> & { api_key?: string };
        const created: LLMConfig = {
          id: nextId++,
          name: body.name ?? "",
          provider: body.provider ?? "openrouter",
          model: body.model ?? "",
          base_url: body.base_url ?? null,
          params: {},
          kind: body.kind ?? "chat",
          is_default: body.is_default ?? false,
          is_active: true,
          has_api_key: typeof body.api_key === "string" && body.api_key !== "",
        };
        configs.push(created);
        return jsonResponse(created, 201);
      }
      if (method === "PATCH" && idMatch !== null) {
        const id = Number(idMatch[1]);
        const raw = request === null ? "{}" : await request.clone().text();
        const body = JSON.parse(raw) as Partial<LLMConfig>;
        const config = configs.find((c) => c.id === id);
        if (config === undefined) return jsonResponse({ detail: "not found" }, 404);
        if (body.is_default === true) {
          for (const other of configs) other.is_default = other.id === id;
        }
        Object.assign(config, body);
        return jsonResponse(config);
      }
      if (method === "DELETE" && idMatch !== null) {
        const id = Number(idMatch[1]);
        const index = configs.findIndex((c) => c.id === id);
        if (index !== -1) configs.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function renderSettings(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(<SettingsRoute />);
}

describe("SettingsRoute", () => {
  beforeEach(() => {
    setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("lists configured models with their key, default and active status", async () => {
    renderSettings(routeFetch());

    await waitFor(() => {
      expect(screen.getByText("Default OpenRouter")).toBeInTheDocument();
    });
    expect(screen.getByText(/openrouter · anthropic\/claude-sonnet-4\.5/)).toBeInTheDocument();
    expect(screen.getByText("Own key")).toBeInTheDocument(); // has_api_key badge
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("adds a model, and the key never lands in the DOM after saving", async () => {
    const fetchMock = routeFetch({ configs: [] });
    renderSettings(fetchMock);

    await waitFor(() => expect(screen.getByText(/no models configured/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Add a model" }));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tenant Sonnet" } });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "anthropic/claude-sonnet-4.5" },
    });
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;
    const secretKey = "sk-or-super-secret-value";
    fireEvent.change(keyInput, { target: { value: secretKey } });
    expect(keyInput.value).toBe(secretKey);

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() => {
      expect(screen.getByText("Tenant Sonnet")).toBeInTheDocument();
    });

    // The load-bearing assertions: the key is gone from the field the
    // instant it was submitted, and it never appears anywhere else in the
    // rendered document — not echoed back from the "server" (has_api_key
    // is a boolean, never the value) and not left sitting in this
    // component's own state waiting to be re-rendered.
    expect(keyInput.value).toBe("");
    expect(document.body.textContent).not.toContain(secretKey);

    // And it really was sent, exactly once, over the wire — proving this
    // isn't passing by accident because the field was empty all along.
    const postRequest = fetchMock.mock.calls
      .map(([input]) => input as RequestInfo | URL)
      .find((input): input is Request => input instanceof Request && input.method === "POST");
    expect(postRequest).toBeDefined();
    const sentBody = JSON.parse(await postRequest!.clone().text()) as { api_key?: string };
    expect(sentBody.api_key).toBe(secretKey);
  });

  it("sets a different model as default via PATCH, then reflects it after refresh", async () => {
    const secondConfig: LLMConfig = { ...OPENROUTER_CONFIG, id: 2, name: "Backup Model", is_default: false };
    renderSettings(routeFetch({ configs: [OPENROUTER_CONFIG, secondConfig] }));

    await waitFor(() => expect(screen.getByText("Backup Model")).toBeInTheDocument());

    const backupRow = screen.getByText("Backup Model").closest("tr")!;
    fireEvent.click(within(backupRow).getByRole("button", { name: "Set default" }));

    await waitFor(() => {
      expect(within(backupRow).getByText("Default")).toBeInTheDocument();
    });
    // The old default lost its pill once the new one won — proves this
    // read the server's refreshed state, not just flipped a local flag.
    const originalRow = screen.getByText("Default OpenRouter").closest("tr")!;
    expect(within(originalRow).queryByText("Default")).not.toBeInTheDocument();
  });

  it("removes a model only after a second, explicit confirm click", async () => {
    const fetchMock = routeFetch();
    renderSettings(fetchMock);

    await waitFor(() => expect(screen.getByText("Default OpenRouter")).toBeInTheDocument());
    const callsBeforeDelete = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    // First click only asks for confirmation — no DELETE yet.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeDelete);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.queryByText("Default OpenRouter")).not.toBeInTheDocument();
    });
  });

  it("shows each agent's own code execution capability, read-only", async () => {
    renderSettings(routeFetch());

    await waitFor(() => expect(screen.getByText("Analytics")).toBeInTheDocument());
    const analyticsRow = screen.getByText("Analytics").closest("tr")!;
    expect(within(analyticsRow).getByText("Interpreter")).toBeInTheDocument();

    const brokerRow = screen.getByText("Complaint Broker").closest("tr")!;
    expect(within(brokerRow).getByText("None")).toBeInTheDocument();
  });

  it("shows the effective sandbox limits as plain facts, never as an editable control", async () => {
    renderSettings(routeFetch());

    await waitFor(() => expect(screen.getByText("Max executions per run")).toBeInTheDocument());
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("45s")).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();

    // The load-bearing assertion for "read-only where it is read-only":
    // no input/select/textarea anywhere in the sandbox sheet, only in the
    // (separate) add-a-model form this test never opens.
    const sandboxHeading = screen.getByText("Sandbox limits");
    const sandboxSheet = sandboxHeading.closest("section")!;
    expect(within(sandboxSheet).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(sandboxSheet).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(sandboxSheet.querySelectorAll("input, select, textarea").length).toBe(0);
  });

  // --- the model catalogue picker ---------------------------------------
  //
  // This field was a free-text box, which is the whole reason the picker
  // exists: an operator cannot type a model id they do not already know,
  // and cannot compare two they do.

  it("suggests catalogue models with their context window and price", async () => {
    renderSettings(routeFetch({ configs: [] }));
    await waitFor(() => expect(screen.getByText(/no models configured/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add a model" }));

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "deep" } });

    const list = await screen.findByRole("listbox", { name: "Model catalogue" });
    const option = within(list).getByRole("option", { name: /DeepSeek Chat/ });
    // The two numbers the choice is actually made on, both derived — the
    // wire carries 64000 and per-token USD, neither of which is legible.
    expect(option).toHaveTextContent("64K");
    expect(option).toHaveTextContent("$0.27 in");
    expect(option).toHaveTextContent("$1.10 out");
    // Filtered, not the whole catalogue.
    expect(within(list).queryByRole("option", { name: /Claude Opus 4/ })).not.toBeInTheDocument();
  });

  it("fills the field from a suggestion and summarises the choice", async () => {
    renderSettings(routeFetch({ configs: [] }));
    await waitFor(() => expect(screen.getByText(/no models configured/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add a model" }));

    const field = screen.getByLabelText("Model") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "opus" } });
    const list = await screen.findByRole("listbox", { name: "Model catalogue" });
    fireEvent.click(within(list).getByRole("option", { name: /Claude Opus 4/ }));

    expect(field.value).toBe("anthropic/claude-opus-4");
    expect(screen.getByText(/200K context · \$15\.00 in · \$75\.00 out per 1M tokens/)).toBeInTheDocument();
    // The list collapses once the value is an exact id — it would only be
    // offering back the row just chosen.
    expect(screen.queryByRole("listbox", { name: "Model catalogue" })).not.toBeInTheDocument();
  });

  it("stays typeable when the catalogue cannot be loaded", async () => {
    renderSettings(routeFetch({ configs: [], catalogue: "error" }));
    await waitFor(() => expect(screen.getByText(/no models configured/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add a model" }));

    expect(await screen.findByText(/Couldn't load the model catalogue/)).toBeInTheDocument();

    const field = screen.getByLabelText("Model") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "some/private-model" } });
    expect(field.value).toBe("some/private-model");
    expect(screen.queryByRole("listbox", { name: "Model catalogue" })).not.toBeInTheDocument();
  });


  // The tenant key panel. One credential for the whole tenant, because every
  // keyless config borrows the default's at run time -- so a per-model field
  // on a 260-row catalogue would be asking the same question 260 times.
  it("saves the tenant key onto the default config, and never keeps it", async () => {
    const fetchMock = routeFetch({
      configs: [{ ...OPENROUTER_CONFIG, has_api_key: false }],
    });
    renderSettings(fetchMock);

    const field = await screen.findByLabelText("API key");
    fireEvent.change(field, { target: { value: "sk-or-v1-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        ([input]) => input instanceof Request && input.method === "PATCH",
      );
      expect(patches).toHaveLength(1);
    });

    const patch = fetchMock.mock.calls.find(
      ([input]) => input instanceof Request && input.method === "PATCH",
    )![0] as Request;
    // Onto the DEFAULT config specifically -- that is the only row
    // `build_lm` consults for the fallback every other config borrows.
    expect(patch.url).toContain("/agent/llm-configs/1");
    expect(JSON.parse(await patch.clone().text())).toEqual({ api_key: "sk-or-v1-secret" });

    // The half worth testing: a credential that lingers in the DOM after a
    // save is a credential in every screenshot and screen-share thereafter.
    await waitFor(() => {
      expect(document.body.innerHTML).not.toContain("sk-or-v1-secret");
    });
  });

  it("shows a keyless model as borrowing the tenant key, not as broken", async () => {
    // The regression this replaces: every one of ~260 seeded catalogue rows
    // read "Missing" while running perfectly, because none carries its own
    // key by design. Only a tenant with no key anywhere is actually missing one.
    renderSettings(
      routeFetch({
        configs: [
          OPENROUTER_CONFIG,
          { ...OPENROUTER_CONFIG, id: 2, name: "Qwen Flash", is_default: false, has_api_key: false },
        ],
      }),
    );

    await waitFor(() => expect(screen.getByText("Qwen Flash")).toBeInTheDocument());
    expect(screen.getByText("Tenant key")).toBeInTheDocument();
    expect(screen.queryByText("Missing")).not.toBeInTheDocument();
  });

  it("refuses to pretend there is somewhere to put the key when no default exists", async () => {
    renderSettings(
      routeFetch({ configs: [{ ...OPENROUTER_CONFIG, is_default: false }] }),
    );

    await waitFor(() => expect(screen.getByText(/No default model is set/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Save key" })).not.toBeInTheDocument();
  });
});
