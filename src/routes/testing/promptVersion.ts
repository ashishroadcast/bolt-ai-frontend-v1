import type { AgentTestCase, PromptVersionRef } from "./types.ts";

/**
 * There is no endpoint that reports the version currently behind a phase's
 * `production` alias ahead of a promote attempt (`app.learning.gate.
 * get_active_version` is internal, never exposed over HTTP) — see this
 * task's own report. The freshest `last_prompt_version` among that
 * phase's own test cases is the best real signal available: `run_
 * test_case` (`app/learning/judge.py`) resolves and snapshots it on every
 * run. It can be stale the instant someone else promotes between that
 * run and this page load, which is exactly why the caller labels it "as
 * of last run" rather than presenting it as live.
 */
export function latestPromptVersion(cases: readonly AgentTestCase[]): PromptVersionRef | null {
  let latest: { ref: PromptVersionRef; ranAt: number } | null = null;
  for (const testCase of cases) {
    if (testCase.last_prompt_version === null || testCase.last_ran_at === null) continue;
    const ranAt = Date.parse(testCase.last_ran_at);
    if (latest === null || ranAt > latest.ranAt) {
      latest = { ref: testCase.last_prompt_version, ranAt };
    }
  }
  return latest?.ref ?? null;
}

/** Pulls the trailing `<version>` int off a `prompts:/<agent>-<phase>/<version>` URI. */
export function versionFromUri(uri: string): number | null {
  const match = /\/(\d+)$/.exec(uri);
  return match ? Number(match[1]) : null;
}
