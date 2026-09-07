import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { apiErrorMessage, createTestCase, deleteTestCase, listTestCases, runTestCase } from "../testing/api.ts";
import { NewTestCaseForm } from "../testing/NewTestCaseForm.tsx";
import { SuiteSizeBadge } from "../testing/SuiteSizeBadge.tsx";
import { activeCases, casesForPhase } from "../testing/suite.ts";
import { TestCaseList } from "../testing/TestCaseList.tsx";
import { SUITE_PHASES, type AgentTestCase, type AgentTestCaseCreate } from "../testing/types.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import styles from "./TestsTab.module.css";

/**
 * This agent's own test cases — moved here from the standalone
 * `/test-suites` screen (task brief: "a test suite grades one agent's
 * phase"). One question, one expected answer, graded across the six
 * evaluation phases; every phase's suite is shown with its size legible up
 * front (`SuiteSizeBadge`), not only at the moment a promotion is refused
 * on the Prompts &amp; tuning tab.
 *
 * `GET /agent/tests` returns every case for the tenant (`testing/api.ts`'s
 * own comment) — the old screen mixed every agent's cases into the same
 * phase lists (it had no agent filter of its own, only `NewTestCaseForm`'s
 * own picker for *authoring* a case). That was fine when the screen had no
 * agent context to filter by; now that it renders inside one agent's own
 * page, showing another agent's cases here would be a bug, not a feature —
 * so this filters to `agent.id` before grouping by phase.
 */
export function TestsTab() {
  const { agent } = useOutletContext<AgentDetailContext>();
  const [cases, setCases] = useState<AgentTestCase[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [runErrors, setRunErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    listTestCases()
      .then((loaded) => {
        if (!cancelled) setCases(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(payload: AgentTestCaseCreate) {
    const created = await createTestCase(payload);
    setCases((current) => [...(current ?? []), created]);
  }

  async function handleRun(id: number) {
    setRunningId(id);
    setRunErrors((current) => {
      const { [id]: _dropped, ...rest } = current;
      return rest;
    });
    try {
      const graded = await runTestCase(id);
      setCases((current) => (current ?? []).map((testCase) => (testCase.id === id ? graded : testCase)));
    } catch (err) {
      // A 422 here is JudgeModelNotDistinctError/NoDefaultLLMConfig — a
      // configuration defect app.api.tests never turns into a graded row
      // (see that module's own docstring). Kept in its own map, not
      // written onto the case's last_verdict/last_reasoning, so a config
      // defect never masquerades as a judged failure.
      setRunErrors((current) => ({ ...current, [id]: apiErrorMessage(err) }));
    } finally {
      setRunningId(null);
    }
  }

  async function handleDelete(id: number) {
    await deleteTestCase(id);
    setCases((current) => (current ?? []).filter((testCase) => testCase.id !== id));
  }

  const agentCases = (cases ?? []).filter((testCase) => testCase.agent_id === agent.id);

  return (
    <div className={styles.page}>
      <p className={styles.body}>
        A test suite is a set of questions with known-good answers. Run it against a prompt candidate
        before promoting it on Prompts &amp; tuning, and the verdict — pass, fail, and why — shows up
        here.
      </p>

      {loadError !== null && (
        <p className={styles.alert} role="alert">
          {loadError}
        </p>
      )}

      {cases === null && loadError === null && <p className={styles.status}>Loading test suites…</p>}

      {cases !== null && (
        <>
          <NewTestCaseForm agentId={agent.id} onSubmit={handleCreate} />

          {SUITE_PHASES.map((phase) => {
            const phaseCases = casesForPhase(agentCases, phase);
            const activeCount = activeCases(phaseCases).length;
            return (
              <section key={phase}>
                <div className={styles.phaseHead}>
                  <h3 className={styles.phaseName}>{phase}</h3>
                  <SuiteSizeBadge activeCount={activeCount} />
                </div>
                <TestCaseList
                  title={phase}
                  subLabel={`${phaseCases.length} case${phaseCases.length === 1 ? "" : "s"}`}
                  cases={phaseCases}
                  onRun={handleRun}
                  onDelete={handleDelete}
                  runningId={runningId}
                  runErrors={runErrors}
                />
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
