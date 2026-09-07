import { describe, expect, it } from "vitest";
import type { LLMConfig } from "../llmConfigsApi.ts";
import { compileBlockedReason, resolveBoundModel } from "./llmResolution.ts";

function config(overrides: Partial<LLMConfig>): LLMConfig {
  return {
    id: 1,
    name: "GPT-5 mini",
    provider: "openrouter",
    model: "openai/gpt-5-mini",
    base_url: null,
    params: {},
    kind: "chat",
    is_default: false,
    is_active: true,
    has_api_key: true,
    ...overrides,
  };
}

describe("resolveBoundModel", () => {
  it("returns the explicitly bound config when its id exists", () => {
    const configs = [config({ id: 1, name: "Mini" }), config({ id: 2, name: "Judge" })];
    expect(resolveBoundModel("plan", { plan: 2 }, configs)?.name).toBe("Judge");
  });

  it("returns null for a binding whose id no longer exists — never a made-up model", () => {
    const configs = [config({ id: 1 })];
    expect(resolveBoundModel("plan", { plan: 99 }, configs)).toBeNull();
  });

  it("falls back to the tenant's active default when the phase has no explicit binding", () => {
    const configs = [
      config({ id: 1, is_default: false }),
      config({ id: 2, name: "Default", is_default: true, is_active: true }),
    ];
    expect(resolveBoundModel("judge", {}, configs)?.name).toBe("Default");
  });

  it("ignores a default config that has been deactivated", () => {
    const configs = [config({ id: 1, is_default: true, is_active: false })];
    expect(resolveBoundModel("plan", {}, configs)).toBeNull();
  });

  it("is null when there is no binding and no active default — the NoDefaultLLMConfig case", () => {
    expect(resolveBoundModel("plan", {}, [])).toBeNull();
  });
});

describe("compileBlockedReason", () => {
  it("is null when the plan and judge models resolve to different underlying models", () => {
    const configs = [
      config({ id: 1, model: "openai/gpt-5-mini", is_default: true, is_active: true }),
      config({ id: 2, model: "openai/gpt-5", name: "Judge" }),
    ];
    expect(compileBlockedReason({ judge: 2 }, configs)).toBeNull();
  });

  it("names the shared model when judge and plan resolve to the same underlying model", () => {
    // Two different LLMConfig rows can still point at the identical model —
    // app.learning.judge.resolve_judge_lm compares `.model`, not config id,
    // so this must too or it would clear a case the server refuses.
    const configs = [
      config({ id: 1, model: "openai/gpt-5-mini", is_default: true, is_active: true }),
      config({ id: 2, name: "Also mini", model: "openai/gpt-5-mini" }),
    ];
    const reason = compileBlockedReason({ judge: 2 }, configs);
    expect(reason).toMatch(/openai\/gpt-5-mini/);
  });

  it("flags an unresolvable plan model", () => {
    const reason = compileBlockedReason({}, []);
    expect(reason).toMatch(/plan/i);
  });

  it("flags an unresolvable judge model even when plan resolves fine", () => {
    const configs = [config({ id: 1, is_default: true, is_active: true })];
    const reason = compileBlockedReason({ judge: 404 }, configs);
    expect(reason).toMatch(/judge/i);
  });
});
