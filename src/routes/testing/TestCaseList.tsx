import { Sheet } from "../../ask/parts/Sheet.tsx";
import { Pill } from "./Pill.tsx";
import type { AgentTestCase } from "./types.ts";
import styles from "./TestCaseList.module.css";

interface TestCaseListProps {
  title: string;
  subLabel: string;
  cases: AgentTestCase[];
  onRun: (id: number) => void;
  onDelete: (id: number) => void;
  runningId: number | null;
  /** A run that hit a 422 config defect (JudgeModelNotDistinctError,
   * NoDefaultLLMConfig) rather than producing a graded row — see
   * TestsTab's own comment for why that's kept separate from
   * last_verdict/last_reasoning instead of overwriting them. */
  runErrors: Record<number, string>;
}

function verdictPill(testCase: AgentTestCase) {
  if (testCase.last_verdict === null) return null;
  return <Pill tone={testCase.last_verdict === "pass" ? "pass" : "fail"}>{testCase.last_verdict.toUpperCase()}</Pill>;
}

/**
 * One phase's authored cases, as a paper sheet (reusing `Sheet` per the
 * console's own convention — this reads as an artifact, not chrome). Every
 * case that has been graded shows its judge reasoning inline, never behind
 * an extra click — see TestCaseList.module.css's own comment on
 * `.reasoning` for why: a passing verdict is evidence, not proof, and the
 * reasoning is the only way an operator actually checks it.
 */
export function TestCaseList({ title, subLabel, cases, onRun, onDelete, runningId, runErrors }: TestCaseListProps) {
  return (
    <Sheet title={title} subLabel={subLabel}>
      {cases.length === 0 ? (
        <p className={styles.empty}>No cases yet for this phase.</p>
      ) : (
        <ul className={styles.list}>
          {cases.map((testCase) => (
            <li key={testCase.id} className={styles.row}>
              <div className={styles.top}>
                <span className={`${styles.question} ${testCase.is_active ? "" : styles.inactive}`}>
                  {testCase.question}
                </span>
                <span className={styles.meta}>
                  {testCase.last_score !== null && (
                    <span className={styles.score}>{testCase.last_score.toFixed(2)}</span>
                  )}
                  {verdictPill(testCase)}
                </span>
              </div>

              <p className={styles.expected}>
                <b>Expected</b> {testCase.expected}
              </p>

              {testCase.last_reasoning !== null ? (
                <p className={styles.reasoning}>
                  <b>Judge</b>
                  {testCase.last_reasoning}
                </p>
              ) : (
                <span className={styles.never}>Never run.</span>
              )}

              {runErrors[testCase.id] !== undefined && (
                <p className={styles.runError} role="alert">
                  {runErrors[testCase.id]}
                </p>
              )}

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => onRun(testCase.id)}
                  disabled={runningId === testCase.id}
                >
                  {runningId === testCase.id ? "Running…" : "Run"}
                </button>
                <button
                  type="button"
                  className={`${styles.action} ${styles.danger}`}
                  onClick={() => onDelete(testCase.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
