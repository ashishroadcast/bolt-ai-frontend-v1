import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { apiErrorMessage, listPrompts, listTestCases } from "../testing/api.ts";
import { activeCases, casesForPhase } from "../testing/suite.ts";
import { TrainingSignalPanel } from "../testing/TrainingSignalPanel.tsx";
import { PROMPT_PHASES, type AgentTestCase, type PromptSnapshot } from "../testing/types.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import { PhasePromptPanel } from "./PhasePromptPanel.tsx";
import styles from "./PromptsTab.module.css";

/**
 * Where someone reads and moves the prompt that serves live traffic for
 * *this* agent, one phase at a time.
 *
 * **Rebuilt from five stacked cards to a phase list plus one panel**
 * ("too difficult too see and update prompts poor ux", Saurabh). The old
 * shape gave every phase equal, tiny room: the serving text sat behind a
 * collapsed disclosure and then inside a 90px-tall scroller that cut it
 * off mid-sentence, and the candidate-version input was 68px wide, which
 * clipped its own placeholder to "versior". A prompt is several hundred
 * words of the instructions an agent actually follows — it is the content
 * of this screen, not a footnote on it — so exactly one phase is open at a
 * time and it gets the width and height to be read.
 *
 * **Prompt text is editable here now.** `POST /agent/admin/prompts` takes
 * `{agent_id, phase, instructions}` and registers what is typed as a new
 * Prompt Registry version — it never moves the `production` alias, so an
 * edit cannot change what a running agent resolves until someone promotes
 * it through the gate. `PhasePromptPanel` owns that editor; this tab owns
 * only which phase is open.
 *
 * **The training-signal panel closes the other half of the loop.** Tune
 * compiles a new prompt from exactly two stores — promoted exemplars and
 * corrections — and both are written by the thumbs on an answer. Neither
 * was visible anywhere, and a thumbs-down left without a comment never
 * becomes a correction at all, so it never reaches tuning. `TrainingSignal
 * Panel` shows both counts and lists the ratings, offering to record the
 * missing reason on the ones that are going nowhere.
 *
 * `GET /agent/tests` has no `?agent_id=` filter (`testing/api.ts`'s own
 * comment) — it always returns every case for the tenant, so this filters
 * to `agent.id` client-side rather than asking the backend for less.
 *
 * The prompts fetch never blocks the tab on itself: a failure degrades the
 * panel to "couldn't read the registry" while tune and promote — which do
 * not depend on it — stay usable.
 */
export function PromptsTab() {
  const { agent } = useOutletContext<AgentDetailContext>();
  const [cases, setCases] = useState<AgentTestCase[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptSnapshot[] | null>(null);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [openPhase, setOpenPhase] = useState<(typeof PROMPT_PHASES)[number]>(PROMPT_PHASES[0]);

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

  useEffect(() => {
    let cancelled = false;
    listPrompts(agent.id)
      .then((loaded) => {
        if (!cancelled) setPrompts(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPromptsError(apiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const agentCases = (cases ?? []).filter((testCase) => testCase.agent_id === agent.id);
  const promptByPhase = new Map((prompts ?? []).map((snapshot) => [snapshot.phase, snapshot]));
  const openCases = casesForPhase(agentCases, openPhase);

  return (
    <div className={styles.page}>
      <p className={styles.body}>
        The instructions each phase of a run actually follows. Editing here saves a new version;
        nothing you save reaches production until it is promoted and its test suite passes — or
        until you override that here.
      </p>

      {loadError !== null && (
        <p className={styles.alert} role="alert">
          {loadError}
        </p>
      )}

      <div className={styles.split}>
        <nav className={styles.phaseList} aria-label="Prompt phases">
          {PROMPT_PHASES.map((phase) => {
            const phaseCases = casesForPhase(agentCases, phase);
            const live = promptByPhase.get(phase) ?? null;
            const isOpen = phase === openPhase;
            return (
              <button
                key={phase}
                type="button"
                aria-current={isOpen ? "true" : undefined}
                className={`${styles.phaseItem} ${isOpen ? styles.phaseItemOn : ""}`}
                onClick={() => setOpenPhase(phase)}
              >
                <span className={styles.phaseName}>{phase}</span>
                <span className={styles.phaseMeta}>
                  {live === null
                    ? "—"
                    : live.is_fallback
                      ? "default"
                      : `v${live.version}`}
                  {" · "}
                  {activeCases(phaseCases).length} case
                  {activeCases(phaseCases).length === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
        </nav>

        <PhasePromptPanel
          key={openPhase}
          phase={openPhase}
          agentId={agent.id}
          cases={openCases}
          activeCount={activeCases(openCases).length}
          live={promptByPhase.get(openPhase) ?? null}
          registryError={promptsError}
          registryLoading={prompts === null && promptsError === null}
        />
      </div>

      <TrainingSignalPanel agentId={agent.id} />
    </div>
  );
}
