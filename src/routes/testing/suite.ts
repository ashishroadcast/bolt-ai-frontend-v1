import type { AgentTestCase, SuitePhase } from "./types.ts";

/**
 * `app.learning.gate._MINIMUM_SUITE_SIZE` (`agent-service/app/learning/
 * gate.py`), duplicated here the same way that module duplicates
 * `_PROMPT_ALIAS` from `app.agent.prompts` rather than importing across a
 * process boundary that doesn't exist between this console and a Python
 * service anyway. A chosen policy default, not a derived one (see that
 * constant's own comment) — kept in one named place here too, so this
 * screen's "make suite size legible" badge and the gate's own refusal
 * agree on the same number without either hard-coding a bare `5` inline.
 */
export const MIN_SUITE_SIZE = 5;

export function activeCases(cases: readonly AgentTestCase[]): AgentTestCase[] {
  return cases.filter((testCase) => testCase.is_active);
}

export function casesForPhase(
  cases: readonly AgentTestCase[],
  phase: SuitePhase,
): AgentTestCase[] {
  return cases.filter((testCase) => testCase.phase === phase);
}

/** Active-case count below which `gate_promotion` now refuses on its own
 * (`app.learning.gate`'s `below the minimum of 5` reason) — used to show
 * the same warning before anyone attempts a promotion, not to block the
 * attempt client-side (the gate is the one source of truth for whether a
 * promotion is actually allowed; see PhasePromptPanel). */
export function isThinSuite(activeCount: number): boolean {
  return activeCount < MIN_SUITE_SIZE;
}
