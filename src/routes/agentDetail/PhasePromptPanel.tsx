import { useEffect, useState } from "react";
import {
  apiErrorMessage,
  GateRefusedError,
  promotePrompt,
  savePrompt,
  tunePrompt,
} from "../testing/api.ts";
import { latestPromptVersion, versionFromUri } from "../testing/promptVersion.ts";
import { RefusalPanel } from "../testing/RefusalPanel.tsx";
import { SuiteSizeBadge } from "../testing/SuiteSizeBadge.tsx";
import type {
  AgentTestCase,
  PromoteRefusal,
  PromoteResult,
  PromptPhase,
  PromptSnapshot,
} from "../testing/types.ts";
import styles from "./PhasePromptPanel.module.css";

interface PhasePromptPanelProps {
  phase: PromptPhase;
  agentId: number;
  /** This phase's own cases (any agent already filtered by the caller) —
   * both the suite-size badge and the best-effort "serving" version read
   * off these (see `promptVersion.ts` for why it is best-effort). */
  cases: AgentTestCase[];
  activeCount: number;
  /** `GET /agent/admin/prompts/{agent_id}`'s live registry read for this
   * phase. Authoritative once present: it replaces the best-effort guess
   * rather than sitting beside it, and it is what tells "no prompt
   * registered, running the signature default" apart from "a real,
   * versioned prompt is live" (`types.ts` on `PromptSnapshot.is_fallback`). */
  live: PromptSnapshot | null;
  registryError: string | null;
  registryLoading: boolean;
}

/**
 * One phase, open: the exact instructions serving production, then the two
 * things anyone can actually do to them.
 *
 * **The serving text is the content, so it is rendered as text** — full,
 * wrapped, selectable, copyable, in its own scroll container with room to
 * read. It replaces a `<details>` whose body was capped at 90px and cut
 * off mid-sentence, which is what made this screen unusable.
 *
 * **The editor writes a candidate, never the live prompt.** `POST /agent/
 * admin/prompts` registers what is typed here as a new Prompt Registry
 * version and leaves the `production` alias exactly where it was — see
 * `app.agent.prompts.save_prompt`'s own module docstring for why a save is
 * deliberately not a promotion. So this panel has three steps in the order
 * they actually happen: edit and save (a version exists), tune (the
 * optimiser writes a different candidate), promote (the gate replays the
 * suite and one of them goes live). Saving pre-fills the candidate-version
 * field below, because promoting what you just wrote is the next thing
 * anyone wants.
 *
 * **The editor is seeded from the serving text and stays where the operator
 * left it.** Remounting on a phase switch is the caller's `key={openPhase}`;
 * within one phase, a save does not reset the box — the text that was just
 * saved is still the text being worked on.
 */
export function PhasePromptPanel({
  phase,
  agentId,
  cases,
  activeCount,
  live,
  registryError,
  registryLoading,
}: PhasePromptPanelProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ version: number; serving: number | null } | null>(null);

  const [candidateInput, setCandidateInput] = useState("");
  const [tuning, setTuning] = useState(false);
  const [tuneError, setTuneError] = useState<string | null>(null);
  const [tuned, setTuned] = useState<{ version: number; instructions: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<PromoteRefusal | null>(null);
  const [result, setResult] = useState<PromoteResult | null>(null);

  // Seeded once the registry read lands, then left alone: a save must not
  // wipe what the operator is still working on, and neither must a
  // re-render. Switching phases remounts this component (`key={phase}` in
  // PromptsTab), so there is no stale draft to carry across one.
  useEffect(() => {
    if (live !== null) setDraft((current) => (current === null ? live.instructions : current));
  }, [live]);

  const serving = latestPromptVersion(cases);
  const bestEffortServingVersion = serving !== null ? versionFromUri(serving.uri) : null;
  // A fallback counts as "no version to report", the same as the
  // best-effort path finding nothing: it has no version or alias of its
  // own, by construction.
  const servingVersion = live !== null && !live.is_fallback ? live.version : bestEffortServingVersion;
  const candidateVersion = /^\d+$/.test(candidateInput) ? Number(candidateInput) : null;
  const editorText = draft ?? "";
  const isDirty = live !== null && draft !== null && draft !== live.instructions;

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await savePrompt(agentId, phase, editorText);
      setSaved({ version: next.version, serving: next.serving_version });
      // Promoting what you just wrote is the next thing anyone wants, so
      // the candidate field below is filled in rather than retyped.
      setCandidateInput(String(next.version));
    } catch (err) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTune() {
    setTuning(true);
    setTuneError(null);
    try {
      const next = await tunePrompt(agentId, phase);
      setCandidateInput(String(next.version));
      setTuned({ version: next.version, instructions: next.instructions });
    } catch (err) {
      setTuneError(apiErrorMessage(err));
    } finally {
      setTuning(false);
    }
  }

  async function copyServing() {
    if (live === null) return;
    try {
      // What is in the box, not what is on the alias — an operator who has
      // started editing is copying their draft, and silently handing them
      // the old text instead would be worse than no button.
      await navigator.clipboard.writeText(editorText);
      setCopied(true);
    } catch {
      // A denied clipboard permission is not this panel's problem to
      // report: the text is on screen and selectable, which is the
      // guarantee that matters. Copy is the shortcut, not the only way.
      setCopied(false);
    }
  }

  function openConfirm() {
    // Opens the confirm step only — no network call yet. `confirmPromote`
    // below is the one place this panel ever sends a promotion.
    setResult(null);
    setRefusal(null);
    setPromoteError(null);
    setConfirmOpen(true);
  }

  async function confirmPromote(override: boolean) {
    if (candidateVersion === null) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const promoted = await promotePrompt({ agentId, phase, version: candidateVersion, override });
      setResult(promoted);
      setRefusal(null);
      setConfirmOpen(false);
    } catch (err) {
      if (err instanceof GateRefusedError) {
        setRefusal(err.refusal);
      } else {
        setPromoteError(apiErrorMessage(err));
      }
    } finally {
      setPromoting(false);
    }
  }

  return (
    <section className={styles.panel} aria-label={`${phase} prompt`}>
      <header className={styles.head}>
        <h3 className={styles.phase}>{phase}</h3>
        <span className={styles.serving}>
          {live !== null && !live.is_fallback ? (
            `v${live.version} · ${live.alias}`
          ) : live !== null ? (
            "signature default · unregistered"
          ) : servingVersion !== null ? (
            `v${servingVersion} · ${serving!.alias} (as of last run)`
          ) : (
            "not yet observed"
          )}
        </span>
        <SuiteSizeBadge activeCount={activeCount} />
      </header>

      <div className={styles.promptBlock}>
        <div className={styles.promptBar}>
          <span className={styles.promptLabel}>
            {isDirty
              ? "Instructions · edited, unsaved"
              : live !== null && live.is_fallback
                ? "Signature default"
                : "Serving instructions"}
          </span>
          {live !== null && editorText !== "" && (
            <button type="button" className={styles.copyBtn} onClick={() => void copyServing()}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>

        {registryLoading && <p className={styles.promptStatus}>Reading the prompt registry…</p>}

        {registryError !== null && (
          <p className={styles.promptStatus} role="alert">
            Couldn&apos;t read the serving prompt — {registryError}
          </p>
        )}

        {live !== null && (
          <textarea
            className={styles.promptEditor}
            aria-label={`${phase} instructions`}
            spellCheck={false}
            value={editorText}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}

        {live !== null && live.instructions === "" && draft === "" && (
          <p className={styles.promptStatus}>
            Nothing is registered for this phase, so it resolves to an empty instruction block.
            {phase === "guardrail"
              ? " This agent cannot run at all until a guardrail is registered."
              : " It runs on the signature's own built-in default."}
          </p>
        )}

        {live !== null && (
          <div className={styles.saveRow}>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={() => void handleSave()}
              disabled={saving || editorText.trim() === "" || !isDirty}
            >
              {saving ? "Saving…" : "Save as new version"}
            </button>
            {isDirty && (
              <button
                type="button"
                className={styles.revertBtn}
                onClick={() => setDraft(live.instructions)}
                disabled={saving}
              >
                Revert to serving
              </button>
            )}
            <span className={styles.saveHint}>
              {isDirty
                ? "Saving registers a new version. It does not go live until it is promoted."
                : "Edit the text to save a new version."}
            </span>
          </div>
        )}

        {saveError !== null && (
          <p className={styles.error} role="alert">
            {saveError}
          </p>
        )}

        {saved !== null && (
          <p className={styles.savedNote} role="status">
            Saved as v{saved.version} — not serving.{" "}
            {saved.serving !== null
              ? `v${saved.serving} is still live.`
              : "Nothing is live for this phase yet."}{" "}
            Promote v{saved.version} below to put it in front of traffic.
          </p>
        )}
      </div>

      {/* ── Tune ──────────────────────────────────────────────────── */}
      <div className={styles.action}>
        <div className={styles.actionHead}>
          <h4>Tune</h4>
          <button type="button" className={styles.tuneBtn} onClick={() => void handleTune()} disabled={tuning}>
            {tuning ? "Tuning…" : "Tune this phase"}
          </button>
        </div>
        <p className={styles.actionHelp}>
          Compiles a new version from this phase&apos;s promoted exemplars and registers it. Nothing
          serves it until it is promoted.
        </p>
        {tuneError !== null && (
          <p className={styles.error} role="alert">
            {tuneError}
          </p>
        )}
        {tuned !== null && (
          <div className={styles.candidate}>
            <p className={styles.candidateTitle}>Registered v{tuned.version} — not yet serving</p>
            <pre className={styles.promptText}>{tuned.instructions}</pre>
          </div>
        )}
      </div>

      {/* ── Promote ───────────────────────────────────────────────── */}
      <div className={styles.action}>
        <div className={styles.actionHead}>
          <h4>Promote</h4>
        </div>
        <p className={styles.actionHelp}>
          Moves the <code>production</code> alias to a registered version. The gate replays this
          phase&apos;s suite first and refuses a candidate that regresses a case.
        </p>
        <div className={styles.promoteRow}>
          <div className={styles.versionField}>
            <label htmlFor={`candidate-${phase}`}>Candidate version</label>
            <input
              id={`candidate-${phase}`}
              className={styles.versionInput}
              inputMode="numeric"
              placeholder="e.g. 18"
              value={candidateInput}
              onChange={(event) => setCandidateInput(event.target.value.replace(/[^0-9]/g, ""))}
            />
          </div>
          <button
            type="button"
            className={styles.promoteBtn}
            onClick={openConfirm}
            disabled={candidateVersion === null}
          >
            Promote
          </button>
        </div>

        {confirmOpen && (
          <div className={styles.confirm}>
            <p className={styles.confirmTitle}>Confirm promotion</p>
            <p className={styles.confirmMove}>
              production ({servingVersion !== null ? `v${servingVersion}` : "none"}) → v
              {candidateVersion}
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmBtn}
                onClick={() => void confirmPromote(false)}
                disabled={promoting}
              >
                {promoting ? "Promoting…" : "Confirm promote"}
              </button>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => setConfirmOpen(false)}
                disabled={promoting}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {promoteError !== null && (
          <p className={styles.error} role="alert">
            {promoteError}
          </p>
        )}

        {refusal !== null && (
          <div className={styles.refusalWrap}>
            <RefusalPanel
              reason={refusal.reason}
              regressedCases={refusal.regressed_cases}
              onOverride={() => void confirmPromote(true)}
              overriding={promoting}
            />
          </div>
        )}

        {result !== null && (
          <div className={styles.result} role="status">
            <p className={styles.resultTitle}>Promoted</p>
            <p className={styles.resultMove}>
              {result.from_version !== null ? `v${result.from_version}` : "none"} → v
              {result.to_version}
              {result.overridden ? " (overridden)" : ""}
            </p>
            {result.from_version !== null && (
              <p className={styles.rollback}>
                Roll back by promoting v{result.from_version} again — it stays resolvable.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
