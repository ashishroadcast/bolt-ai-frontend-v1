import { useState, type FormEvent } from "react";
import { apiErrorMessage } from "./api.ts";
import { SUITE_PHASES, type AgentTestCaseCreate, type SuitePhase } from "./types.ts";
import styles from "./NewTestCaseForm.module.css";

interface NewTestCaseFormProps {
  /** The agent this case is authored against. Always the agent whose Test
   * suites tab this form renders on — the route already resolved it
   * (`AgentDetailRoute`) — so there is nothing here for an operator to
   * pick. */
  agentId: number;
  onSubmit: (payload: AgentTestCaseCreate) => Promise<void>;
}

/**
 * Authors one new case for a single, route-resolved agent — phase and
 * question, always a two-field form. This used to also carry its own
 * `agents: AgentSummary[]` picker (one `<select>` per tenant so a
 * multi-agent tenant could choose which agent a case belonged to); now
 * that the form only ever renders inside one agent's own Test suites tab,
 * that choice is never in doubt, so the field is gone rather than reduced
 * to a disabled/single-option select.
 */
export function NewTestCaseForm({ agentId, onSubmit }: NewTestCaseFormProps) {
  const [phase, setPhase] = useState<SuitePhase>("execute");
  const [question, setQuestion] = useState("");
  const [expected, setExpected] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ agent_id: agentId, phase, question, expected, is_active: true });
      setQuestion("");
      setExpected("");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <h3 className={styles.title}>New test case</h3>

      <div className={styles.field}>
        <label htmlFor="new-case-phase">Phase</label>
        <select
          id="new-case-phase"
          className={styles.select}
          value={phase}
          onChange={(event) => setPhase(event.target.value as SuitePhase)}
        >
          {SUITE_PHASES.map((suitePhase) => (
            <option key={suitePhase} value={suitePhase}>
              {suitePhase}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="new-case-question">Question</label>
        <textarea
          id="new-case-question"
          className={styles.textarea}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          required
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="new-case-expected">Expected</label>
        <textarea
          id="new-case-expected"
          className={styles.textarea}
          value={expected}
          onChange={(event) => setExpected(event.target.value)}
          required
        />
      </div>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? "Adding…" : "Add case"}
        </button>
      </div>
    </form>
  );
}
