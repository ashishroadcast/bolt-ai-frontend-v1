import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import {
  createLlmConfig,
  deleteLlmConfig,
  listLlmConfigs,
  previewModels,
  updateLlmConfig,
  type LLMConfig,
} from "./llmConfigsApi.ts";

const CONFIG: LLMConfig = {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("llmConfigsApi", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("lists configs through the real gatewayClient, never carrying a key field", async () => {
    fetchMock.mockResolvedValue(jsonResponse([CONFIG]));

    const configs = await listLlmConfigs();

    expect(configs).toEqual([CONFIG]);
    // The wire type itself has no key-shaped field to check at runtime —
    // this asserts the actual JSON the mocked server sent back has none
    // either, so a future field addition on either side would fail this
    // rather than pass silently.
    expect(Object.keys(configs[0]!)).not.toContain("api_key");
    expect(Object.keys(configs[0]!)).not.toContain("api_key_encrypted");
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toContain("/agent/llm-configs");
    expect(request.headers.get("Authorization")).toBe("Bearer tok");
  });

  it("sends a create payload's api_key in the request body, exactly once, over POST", async () => {
    fetchMock.mockResolvedValue(jsonResponse(CONFIG, 201));

    await createLlmConfig({
      name: "Default OpenRouter",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      api_key: "sk-or-secret-value",
      is_default: true,
    });

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.method).toBe("POST");
    const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
    expect(body.api_key).toBe("sk-or-secret-value");
    expect(request.url).not.toContain("sk-or-secret-value");
  });

  it("PATCHes a partial update to the config's own id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...CONFIG, is_default: false }));

    await updateLlmConfig(1, { is_default: false });

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.method).toBe("PATCH");
    expect(request.url).toContain("/agent/llm-configs/1");
    const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
    expect(body).toEqual({ is_default: false });
  });

  it("DELETEs a config by id", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await deleteLlmConfig(1);

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.method).toBe("DELETE");
    expect(request.url).toContain("/agent/llm-configs/1");
  });

  it("POSTs a preview-models request and unwraps the models array", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ models: [{ id: "antigravity/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }] }),
    );

    const models = await previewModels({
      provider: "omniroute",
      base_url: "https://ai.track360.net.in/v1",
      api_key: "typed-key",
    });

    expect(models).toEqual([{ id: "antigravity/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }]);
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/agent/llm-configs/preview-models");
    expect(JSON.parse(await request.clone().text())).toEqual({
      provider: "omniroute",
      base_url: "https://ai.track360.net.in/v1",
      api_key: "typed-key",
    });
  });
});
