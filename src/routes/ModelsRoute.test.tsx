import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { ModelsRoute } from "./ModelsRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Real rows off `GET /agent/llm-configs/catalogue`, prices verbatim — the
 * per-million figures in the assertions below are what an operator has to
 * see, so they are checked against the strings OpenRouter actually sends
 * rather than round numbers invented for a test.
 */
const CATALOGUE = [
  {
    id: "z-ai/glm-5.3-flash",
    name: "Z.ai: GLM 5.3 Flash",
    context_length: 1310720,
    pricing: { prompt: "0.000000075", completion: "0.00000025" },
  },
  {
    id: "anthropic/claude-opus-5-fast",
    name: "Claude Opus 5 (Fast)",
    context_length: 1000000,
    pricing: { prompt: "0.00001", completion: "0.00005" },
  },
  {
    id: "openai/o1-pro",
    name: "OpenAI: o1-pro",
    context_length: 200000,
    pricing: { prompt: "0.00015", completion: "0.0006" },
  },
  {
    id: "~anthropic/claude-haiku-latest",
    name: "Anthropic Claude Haiku Latest",
    context_length: 200000,
    pricing: { prompt: "0.000001", completion: "0.000005" },
  },
  {
    // openrouter/auto prices every field at the "-1" sentinel.
    id: "openrouter/auto",
    name: "Auto Router",
    context_length: 2000000,
    pricing: { prompt: "-1", completion: "-1" },
  },
  // `bytedance` and `bytedance-seed` are two separate providers in the live
  // catalogue, and one's name is a prefix of the other's — the case where
  // sorting the raw id string interleaves them.
  {
    id: "bytedance/ui-tars-1.5-7b",
    name: "ByteDance: UI-TARS 7B",
    context_length: 128000,
    pricing: { prompt: "0.0000001", completion: "0.0000002" },
  },
  {
    id: "bytedance-seed/seed-1.6",
    name: "ByteDance: Seed 1.6",
    context_length: 262144,
    pricing: { prompt: "0.0000002", completion: "0.0000008" },
  },
  {
    id: "bytedance-seed/seed-2.0-code",
    name: "ByteDance: Seed 2.0 Code",
    context_length: 262144,
    pricing: { prompt: "0.0000003", completion: "0.0000012" },
  },
];

const CONFIGS = [
  {
    id: 1,
    name: "Default OpenRouter",
    provider: "openrouter",
    model: "anthropic/claude-opus-5-fast",
    base_url: null,
    params: {},
    kind: "chat",
    is_default: true,
    is_active: true,
    has_api_key: true,
  },
];

function mockReads(
  fetchMock: ReturnType<typeof vi.fn>,
  options: { catalogue?: unknown; configs?: unknown; configsStatus?: number } = {},
) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const request = input as Request;
    if (request.url.includes("/agent/llm-configs/catalogue")) {
      return Promise.resolve(jsonResponse(options.catalogue ?? { models: CATALOGUE }));
    }
    if (request.url.endsWith("/agent/llm-configs")) {
      return Promise.resolve(
        jsonResponse(options.configs ?? CONFIGS, options.configsStatus ?? 200),
      );
    }
    return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
  });
}

/** The rendered order of the id column — the thing every sort assertion is
 * really about. */
function idOrder(): string[] {
  const body = screen.getAllByRole("rowgroup")[1]!;
  return within(body)
    .getAllByRole("row")
    .map((row) => within(row).getAllByRole("cell")[1]!.textContent!.trim());
}

function cellsFor(modelId: string): string[] {
  const body = screen.getAllByRole("rowgroup")[1]!;
  const row = within(body)
    .getAllByRole("row")
    .find((candidate) => within(candidate).getAllByRole("cell")[1]!.textContent!.trim() === modelId);
  if (row === undefined) throw new Error(`no row for ${modelId}`);
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent!.trim());
}

describe("ModelsRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("lists every catalogue model with its context window and per-million prices", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);

    await waitFor(() => {
      expect(screen.getByText("Z.ai: GLM 5.3 Flash")).toBeInTheDocument();
    });

    // 0.000000075 USD per token is 0.075 per million, not 0.00 and not 7.5e-8.
    expect(cellsFor("z-ai/glm-5.3-flash")).toEqual([
      "Z.ai: GLM 5.3 Flash",
      "z-ai/glm-5.3-flash",
      "1.31M",
      "0.075",
      "0.25",
    ]);
    expect(cellsFor("openai/o1-pro")).toEqual([
      "OpenAI: o1-pro",
      "openai/o1-pro",
      "200K",
      "150.00",
      "600.00",
    ]);
  });

  it("shows a dash where OpenRouter's -1 sentinel stands in for a price", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);

    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    expect(cellsFor("openrouter/auto")).toEqual(["Auto Router", "openrouter/auto", "2M", "—", "—"]);
  });

  it("counts the whole population beside the title", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);

    await waitFor(() => {
      // Eight rows across six providers — the alias `~anthropic` is filed
      // under anthropic rather than counted as a seventh.
      expect(screen.getByTestId("models-count")).toHaveTextContent("8 models · 6 providers");
    });
  });

  it("marks a model this tenant has already configured", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);

    await waitFor(() => {
      expect(screen.getByText("in use")).toBeInTheDocument();
    });

    expect(cellsFor("anthropic/claude-opus-5-fast")[0]).toContain("in use");
    expect(cellsFor("openai/o1-pro")[0]).not.toContain("in use");
    expect(screen.getByLabelText(/configured only/i).parentElement).toHaveTextContent(
      "Configured only (1)",
    );
  });

  it("keeps the catalogue on screen when the configured-models load fails", async () => {
    mockReads(fetchMock, { configs: { detail: "nope" }, configsStatus: 500 });
    render(<ModelsRoute />);

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load which models you've configured/)).toBeInTheDocument();
    });
    expect(screen.getByText("OpenAI: o1-pro")).toBeInTheDocument();
    expect(screen.queryByText("in use")).not.toBeInTheDocument();
  });

  it("filters by free text across both name and id", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    // Matches an id fragment that appears in no display name — the name is
    // "Claude Opus 5 (Fast)", which does not contain "claude-opus".
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "claude-opus" } });
    expect(idOrder()).toEqual(["anthropic/claude-opus-5-fast"]);
    expect(screen.getByTestId("models-count")).toHaveTextContent("1 of 8 models");

    // Matches a display name that appears in no id.
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "auto router" } });
    expect(idOrder()).toEqual(["openrouter/auto"]);

    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "nothing here" } });
    expect(screen.getByText("No model matches these filters.")).toBeInTheDocument();
  });

  it("filters by provider, filing an alias id under the provider it belongs to", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Filter by provider"), {
      target: { value: "anthropic" },
    });

    expect(idOrder()).toEqual(["~anthropic/claude-haiku-latest", "anthropic/claude-opus-5-fast"]);
  });

  it("shows only configured models when asked, and all of them again when not", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/configured only/i));
    expect(idOrder()).toEqual(["anthropic/claude-opus-5-fast"]);

    fireEvent.click(screen.getByLabelText(/configured only/i));
    expect(idOrder()).toHaveLength(8);
  });

  it("sorts cheapest-first on the very first click of a price column", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Input \$\/1M/ }));

    // 0.075 < 0.10 < 0.20 < 0.30 < 1 < 10 < 150, and the unpriced router
    // last rather than first.
    expect(idOrder()).toEqual([
      "z-ai/glm-5.3-flash",
      "bytedance/ui-tars-1.5-7b",
      "bytedance-seed/seed-1.6",
      "bytedance-seed/seed-2.0-code",
      "~anthropic/claude-haiku-latest",
      "anthropic/claude-opus-5-fast",
      "openai/o1-pro",
      "openrouter/auto",
    ]);
  });

  it("keeps an unpriced model last when the price column is reversed", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    const inputHeader = screen.getByRole("button", { name: /Input \$\/1M/ });
    fireEvent.click(inputHeader);
    fireEvent.click(inputHeader);

    expect(idOrder()).toEqual([
      "openai/o1-pro",
      "anthropic/claude-opus-5-fast",
      "~anthropic/claude-haiku-latest",
      "bytedance-seed/seed-2.0-code",
      "bytedance-seed/seed-1.6",
      "bytedance/ui-tars-1.5-7b",
      "z-ai/glm-5.3-flash",
      "openrouter/auto",
    ]);
  });

  it("sorts biggest-window-first on the very first click of the context column", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Context/ }));

    expect(idOrder().slice(0, 3)).toEqual([
      "openrouter/auto",
      "z-ai/glm-5.3-flash",
      "anthropic/claude-opus-5-fast",
    ]);
  });

  it("tells assistive tech which column is sorted and which way", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    const contextHeader = screen.getByRole("columnheader", { name: /Context/ });
    expect(contextHeader).toHaveAttribute("aria-sort", "none");

    fireEvent.click(screen.getByRole("button", { name: /Context/ }));
    expect(contextHeader).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(screen.getByRole("button", { name: /Context/ }));
    expect(contextHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("browses grouped by provider before any column is clicked", async () => {
    mockReads(fetchMock);
    render(<ModelsRoute />);
    await waitFor(() => {
      expect(screen.getByText("Auto Router")).toBeInTheDocument();
    });

    // The alias id sits with Anthropic rather than off under "~", and
    // bytedance's one model is not interleaved into bytedance-seed's.
    expect(idOrder()).toEqual([
      "~anthropic/claude-haiku-latest",
      "anthropic/claude-opus-5-fast",
      "bytedance/ui-tars-1.5-7b",
      "bytedance-seed/seed-1.6",
      "bytedance-seed/seed-2.0-code",
      "openai/o1-pro",
      "openrouter/auto",
      "z-ai/glm-5.3-flash",
    ]);
  });

  it("reports a catalogue that couldn't be fetched instead of an empty table", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.includes("/agent/llm-configs/catalogue")) {
        return Promise.resolve(jsonResponse({ detail: "OpenRouter is unreachable" }, 502));
      }
      return Promise.resolve(jsonResponse(CONFIGS));
    });
    render(<ModelsRoute />);

    await waitFor(() => {
      expect(screen.getByText(/OpenRouter is unreachable/)).toBeInTheDocument();
    });
    expect(screen.getByText("The catalogue came back empty.")).toBeInTheDocument();
  });
});
