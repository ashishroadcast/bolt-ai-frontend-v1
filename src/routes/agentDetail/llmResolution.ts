import type { LLMConfig } from "../llmConfigsApi.ts";

/**
 * A client-side *hint*, mirroring `app.agent.lm.resolve_lm`
 * (`agent-service`): an explicit `bindings[key]` id wins when it still
 * names a config; otherwise the tenant's own `is_default && is_active`
 * config; otherwise unresolved (`NoDefaultLLMConfig`, server-side). This is
 * what lets the Compile card disable itself with a real reason instead of
 * a paragraph explaining the mechanism — but it is a hint, not the source
 * of truth: the server resolves this for real at request time, and a
 * config deleted or deactivated between this render and that request still
 * gets the server's own 422, not a client-side promise this component
 * cannot keep.
 */
export function resolveBoundModel(
  key: string,
  bindings: Record<string, number>,
  configs: readonly LLMConfig[],
): LLMConfig | null {
  const boundId = bindings[key];
  if (boundId !== undefined) {
    return configs.find((candidate) => candidate.id === boundId) ?? null;
  }
  return configs.find((candidate) => candidate.is_default && candidate.is_active) ?? null;
}

/**
 * Why `POST /agent/admin/optimize` would refuse before ever calling a
 * model — mirrors `app.learning.judge.resolve_judge_lm`'s distinctness
 * check for the `plan` phase specifically, the only phase `optimize_plan`
 * ever compiles (`app.learning.optimize._PLAN_PHASE`). Compares `.model`,
 * not config id or name: two different `LLMConfig` rows pointing at the
 * identical underlying model still fail the judge's "cannot grade its own
 * output" rule server-side, so a check that compared ids instead would
 * clear a case the server refuses.
 *
 * Deliberately silent on exemplars — whether this agent has any promoted
 * exemplars to bootstrap from is the compile's *other* precondition
 * (`NoExemplarsError`), and no endpoint reports that count (see
 * LearningTab's own comment). This function only covers what the console
 * can actually verify; the exemplar precondition still surfaces at attempt
 * time, from the server's own 422.
 */
export function compileBlockedReason(
  bindings: Record<string, number>,
  configs: readonly LLMConfig[],
): string | null {
  const planModel = resolveBoundModel("plan", bindings, configs);
  if (planModel === null) {
    return "No model resolves for the plan phase — bind one or set a tenant default.";
  }
  const judgeModel = resolveBoundModel("judge", bindings, configs);
  if (judgeModel === null) {
    return "No judge model resolves — bind agent.llm_bindings.judge or set a tenant default.";
  }
  if (planModel.model === judgeModel.model) {
    return `Judge and plan both resolve to ${planModel.model} — bind a distinct judge model.`;
  }
  return null;
}
