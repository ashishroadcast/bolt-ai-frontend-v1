import { useState, type ReactElement } from "react";
import { PASS_SCORE, type RunTrace, type TraceTool } from "./runTrace.ts";
import styles from "./RunDebug.module.css";

/**
 * What the run actually did, for the reader who needs to check it: the
 * tool calls it made, the SQL as it was really scoped and run, and the
 * judge's own reasoning.
 *
 * **Every section here renders only when the stream carried it.** The plan
 * is the one that is always shown: its steps ride the plan phase's own
 * `data-phase` part, and when there are none the section says why rather
 * than disappearing, because a debug panel that quietly omits the plan is
 * indistinguishable from a run that had one and lost it.
 */
export interface RunDebugProps {
  trace: RunTrace;
}

function ToolCall({ tool }: { tool: TraceTool }): ReactElement {
  const [showResult, setShowResult] = useState(false);
  // `sql` for run_sql, `query` for find_schema — rendered as the code it
  // is when the tool is SQL-shaped, and as plain text otherwise, rather
  // than dumping the whole argument object as JSON in both cases.
  const sql = typeof tool.input.sql === "string" ? tool.input.sql : null;
  const query = typeof tool.input.query === "string" ? tool.input.query : null;

  return (
    <li className={styles.tool}>
      <div className={styles.toolHead}>
        <span className={styles.toolName}>{tool.name}</span>
        {tool.output !== null && (
          <button
            type="button"
            className={styles.resultToggle}
            onClick={() => setShowResult((open) => !open)}
            aria-expanded={showResult}
          >
            {showResult ? "Hide result" : "Result"}
          </button>
        )}
      </div>
      {sql !== null && <pre className={styles.code}>{sql}</pre>}
      {sql === null && query !== null && <p className={styles.argText}>{query}</p>}
      {sql === null && query === null && Object.keys(tool.input).length > 0 && (
        <pre className={styles.code}>{JSON.stringify(tool.input, null, 2)}</pre>
      )}
      {showResult && tool.output !== null && <pre className={styles.result}>{tool.output}</pre>}
    </li>
  );
}

export function RunDebug({ trace }: RunDebugProps): ReactElement {
  const hasParams = trace.executedSqlParams !== null && Object.keys(trace.executedSqlParams).length > 0;
  const planPhase = trace.phases.find((phase) => phase.phase === "plan");
  const planSteps = planPhase?.plan ?? [];

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>Plan</h4>
        {planSteps.length > 0 ? (
          <>
            <ol className={styles.tools}>
              {planSteps.map((step, index) => (
                <li key={index} className={styles.argText}>
                  {step}
                </li>
              ))}
            </ol>
            {planPhase?.rationale && <p className={styles.absent}>{planPhase.rationale}</p>}
          </>
        ) : (
          <p className={styles.absent}>
            {planPhase === undefined
              ? "No plan was written: this agent answers in one step, or the question was a plain lookup the planner is skipped for."
              : "The planner ran but wrote no steps for this run."}
          </p>
        )}
      </section>

      {trace.tools.length > 0 && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>Tool calls</h4>
          <ol className={styles.tools}>
            {trace.tools.map((tool) => (
              <ToolCall key={tool.callId} tool={tool} />
            ))}
          </ol>
        </section>
      )}

      {trace.executedSql !== null && (
        <section className={styles.section}>
          {/* Not the same string as the run_sql call above: the model drafts
              a query, and the service scopes and clamps it before running
              it (`PhaseContext.sql_run` vs `executed_sql`). This is the one
              that touched the database. */}
          <h4 className={styles.sectionTitle}>SQL as run</h4>
          <pre className={styles.code}>{trace.executedSql}</pre>
          {hasParams && <pre className={styles.result}>{JSON.stringify(trace.executedSqlParams, null, 2)}</pre>}
        </section>
      )}

      {(trace.score !== null || trace.reasoning !== null) && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>Validation</h4>
          {trace.score !== null && (
            <p className={styles.verdict}>
              <span className={styles.scorePill} data-tone={trace.score >= PASS_SCORE ? "good" : "weak"}>
                {trace.score >= PASS_SCORE ? "passed" : "below bar"} · {trace.score.toFixed(2)}
              </span>
              {/* The judge's own pass/fail word (`verdict`) and its issues
                  list are not on the wire — only the score and this prose
                  are — so the pill reads the score against the same 0.7 the
                  service itself gates on, and says which it did. */}
              <span className={styles.scoreNote}>judged against a {PASS_SCORE.toFixed(2)} bar</span>
            </p>
          )}
          {trace.reasoning !== null && <p className={styles.reasoning}>{trace.reasoning}</p>}
        </section>
      )}
    </div>
  );
}
