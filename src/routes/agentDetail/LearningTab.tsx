import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { getAgent, optimizeAgent } from "../../agents/api.ts";
import type { AgentDetail } from "../../agents/types.ts";
import { listLlmConfigs, type LLMConfig } from "../llmConfigsApi.ts";
import { apiErrorMessage, GateRefusedError, listPrompts, listTestCases, promotePrompt, tunePrompt } from "../testing/api.ts";
import { RefusalPanel } from "../testing/RefusalPanel.tsx";
import { SuiteSizeBadge } from "../testing/SuiteSizeBadge.tsx";
import { activeCases, casesForPhase } from "../testing/suite.ts";
import {
  PROMPT_PHASES,
  type AgentTestCase,
  type PromoteRefusal,
  type PromoteResult,
  type PromptPhase,
  type PromptSnapshot,
} from "../testing/types.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import { compileBlockedReason, resolveBoundModel } from "./llmResolution.ts";
import { usePersistentState } from "./usePersistentState.ts";
import styles from "./LearningTab.module.css";

/** The registry-state row every card below leads with — "not observed" is
 * a fetch that hasn't landed (or failed), distinct from `is_fallback`
 * (a real read that found nothing registered) and distinct from a real
 * version, so an operator never mistakes "we don't know" for "nothing is
 * live". */
function servingLabel(snapshot: PromptSnapshot | undefined): string {
  if (snapshot === undefined) return "serving state unavailable";
  if (snapshot.is_fallback) return "not yet promoted — running the signature default";
  return `v${snapshot.version} · ${snapshot.alias}`;
}

function servingVersionShort(snapshot: PromptSnapshot | undefined): string {
  if (snapshot === undefined || snapshot.is_fallback) return "none";
  return `v${snapshot.version}`;
}

/** `agent.compiled_programs[phase]` is an MLflow artifact URI
 * (`runs:/<run_id>/best.json`) — the trailing segment is the one part of
 * it worth reading at a glance; the full URI still appears alongside it
 * once a fresh compile happens (see OptimizePanel's own "artifact" row). */
function compiledLabel(uri: string | undefined): string {
  if (uri === undefined) return "not yet compiled";
  const tail = uri.split("/").pop();
  return `compiled · ${tail !== undefined && tail.length > 0 ? tail : uri}`;
}

interface LearningData {
  detail: AgentDetail | null;
  llmConfigs: LLMConfig[];
  cases: AgentTestCase[];
  prompts: PromptSnapshot[];
  loadError: string | null;
}

/**
 * Everything every card below needs to lead with state instead of prose.
 * `detail`/`llmConfigs` are fetched together and are the one failure this
 * tab surfaces as a page-level error — the Compile card's own model
 * resolution has nothing to say without them. `cases`/`prompts` degrade
 * silently on failure (empty array), the same "never blocks the tab on a
 * secondary read" discipline `PromptsTab.tsx` already established for the
 * identical `listPrompts` call.
 */
function useLearningData(agentId: number): LearningData {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [llmConfigs, setLlmConfigs] = useState<LLMConfig[]>([]);
  const [cases, setCases] = useState<AgentTestCase[]>([]);
  const [prompts, setPrompts] = useState<PromptSnapshot[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAgent(agentId), listLlmConfigs()])
      .then(([loadedDetail, loadedConfigs]) => {
        if (cancelled) return;
        setDetail(loadedDetail);
        setLlmConfigs(loadedConfigs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    // No `?agent_id=` filter server-side (testing/api.ts's own comment) —
    // filtered down here, same as every other tab that reads this list.
    listTestCases()
      .then((loaded) => {
        if (!cancelled) setCases(loaded.filter((testCase) => testCase.agent_id === agentId));
      })
      .catch(() => {
        // Suite-size context for the Promote card, not a precondition this
        // tab enforces — a failure here just means that badge doesn't show.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    listPrompts(agentId)
      .then((loaded) => {
        if (!cancelled) setPrompts(loaded);
      })
      .catch(() => {
        // Every "Serving" row falls back to servingLabel's "unavailable"
        // wording — see that function's own comment.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return { detail, llmConfigs, cases, prompts, loadError };
}

type OptimizeOutcome =
  | { kind: "idle" }
  | { kind: "done"; runId: string; artifactUri: string; demoCount: number }
  | { kind: "error"; message: string };

interface OptimizePanelProps {
  agentId: number;
  detail: AgentDetail | null;
  llmConfigs: LLMConfig[];
}

function OptimizePanel({ agentId, detail, llmConfigs }: OptimizePanelProps) {
  // Keyed by agent alone — compile is agent-wide, not per-phase (it always
  // compiles the plan phase; app.learning.optimize._PLAN_PHASE). Survives
  // switching to another tab and back — see usePersistentState's own
  // comment for why that matters here specifically (task brief: "it
  // currently vanishes after you navigate away").
  const [outcome, setOutcome] = usePersistentState<OptimizeOutcome>(`compile:${agentId}`, {
    kind: "idle",
  });
  const [running, setRunning] = useState(false);

  const planModel = detail !== null ? resolveBoundModel("plan", detail.llm_bindings, llmConfigs) : null;
  const judgeModel = detail !== null ? resolveBoundModel("judge", detail.llm_bindings, llmConfigs) : null;
  // A hint, not the gate — see llmResolution.ts's own comment. Never
  // covers the exemplar precondition: no endpoint reports that count (see
  // the "Exemplars" row below), so a genuinely empty agent still reaches
  // the server and gets NoExemplarsError's own 422 message back, same as
  // before this redesign.
  const blockedReason = detail !== null ? compileBlockedReason(detail.llm_bindings, llmConfigs) : null;
  const disabled = running || detail === null || blockedReason !== null;

  async function run() {
    setRunning(true);
    try {
      const result = await optimizeAgent(agentId);
      setOutcome({
        kind: "done",
        runId: result.run_id,
        artifactUri: result.artifact_uri,
        demoCount: result.demo_count,
      });
    } catch (err) {
      setOutcome({ kind: "error", message: apiErrorMessage(err) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.step}>Step 1 of 3</span>
        <h3>Compile a plan program</h3>
      </div>

      <dl className={styles.state}>
        <div>
          <dt>Plan model</dt>
          <dd>{detail === null ? "loading…" : (planModel?.name ?? "not configured")}</dd>
        </div>
        <div>
          <dt>Judge model</dt>
          <dd>{detail === null ? "loading…" : (judgeModel?.name ?? "not configured")}</dd>
        </div>
        <div>
          <dt>Exemplars</dt>
          <dd className={styles.unavailable}>not exposed by this API yet</dd>
        </div>
        <div>
          <dt>Compiled</dt>
          <dd>{compiledLabel(detail?.compiled_programs.plan)}</dd>
        </div>
      </dl>

      <button type="button" className={styles.btn} onClick={() => void run()} disabled={disabled}>
        {running ? "Compiling…" : "Compile plan"}
      </button>
      {blockedReason !== null && <p className={styles.blockedReason}>{blockedReason}</p>}

      {outcome.kind === "done" && (
        <>
          <div className={styles.stat}>
            <span className={styles.statValue}>{outcome.demoCount}</span>
            <span className={styles.statLabel}>demos compiled</span>
          </div>
          <dl className={styles.kv}>
            <div>
              <dt>run id</dt>
              <dd>{outcome.runId}</dd>
            </div>
            <div>
              <dt>artifact</dt>
              <dd>{outcome.artifactUri}</dd>
            </div>
          </dl>
        </>
      )}
      {outcome.kind === "error" && <p className={styles.error}>{outcome.message}</p>}
    </section>
  );
}

type TuneOutcome =
  | { kind: "idle" }
  | { kind: "done"; version: number; promptUri: string; instructions: string }
  | { kind: "error"; message: string };

interface TunePanelProps {
  agentId: number;
  detail: AgentDetail | null;
  llmConfigs: LLMConfig[];
  prompts: PromptSnapshot[];
}

function TunePanel({ agentId, detail, llmConfigs, prompts }: TunePanelProps) {
  const [phase, setPhase] = useState<PromptPhase>("plan");
  // Keyed by phase too — switching the dropdown must show *that* phase's
  // own last outcome, never the previous phase's carried over (see
  // usePersistentState's own render-time resync comment).
  const [outcome, setOutcome] = usePersistentState<TuneOutcome>(`tune:${agentId}:${phase}`, {
    kind: "idle",
  });
  const [running, setRunning] = useState(false);

  const snapshot = prompts.find((candidate) => candidate.phase === phase);
  const phaseModel = detail !== null ? resolveBoundModel(phase, detail.llm_bindings, llmConfigs) : null;

  async function run() {
    setRunning(true);
    try {
      const result = await tunePrompt(agentId, phase);
      setOutcome({
        kind: "done",
        version: result.version,
        promptUri: result.prompt_uri,
        instructions: result.instructions,
      });
    } catch (err) {
      setOutcome({ kind: "error", message: apiErrorMessage(err) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.step}>Step 2 of 3</span>
        <h3>Register a tuned prompt</h3>
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="tune-phase">
          Phase
        </label>
        <select
          id="tune-phase"
          className={styles.select}
          value={phase}
          onChange={(event) => setPhase(event.target.value as PromptPhase)}
        >
          {PROMPT_PHASES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <dl className={styles.state}>
        <div>
          <dt>Serving</dt>
          <dd>{servingLabel(snapshot)}</dd>
        </div>
        <div>
          <dt>Runs on</dt>
          <dd>{detail === null ? "loading…" : (phaseModel?.name ?? "not configured")}</dd>
        </div>
      </dl>

      <button type="button" className={styles.btn} onClick={() => void run()} disabled={running}>
        {running ? "Registering…" : "Register tuned version"}
      </button>

      {outcome.kind === "done" && (
        <dl className={styles.kv}>
          <div>
            <dt>version</dt>
            <dd>{outcome.version}</dd>
          </div>
          <div>
            <dt>prompt uri</dt>
            <dd>{outcome.promptUri}</dd>
          </div>
        </dl>
      )}
      {outcome.kind === "error" && <p className={styles.error}>{outcome.message}</p>}
    </section>
  );
}

type PromoteOutcome =
  | { kind: "idle" }
  | { kind: "done"; result: PromoteResult }
  | { kind: "refused"; refusal: PromoteRefusal }
  | { kind: "error"; message: string };

interface PromotePanelProps {
  agentId: number;
  cases: AgentTestCase[];
  prompts: PromptSnapshot[];
}

function PromotePanel({ agentId, cases, prompts }: PromotePanelProps) {
  const [phase, setPhase] = useState<PromptPhase>("plan");
  const [version, setVersion] = useState("1");
  const [override, setOverride] = useState(false);
  // Promotion moves the `production` alias — it changes what serves live
  // traffic. This is the one gate the redesign must not lose (task brief:
  // "Promote still requires confirmation — click once, assert no request
  // went out").
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  // Keyed by phase — a refusal for `execute` must never bleed into what
  // `plan` shows. This is the "vanishes after you navigate away" fix the
  // task brief names directly: a refused promotion is the most useful
  // thing this screen can show, and now it survives a tab switch.
  const [outcome, setOutcome] = usePersistentState<PromoteOutcome>(`promote:${agentId}:${phase}`, {
    kind: "idle",
  });

  const snapshot = prompts.find((candidate) => candidate.phase === phase);
  const phaseCases = casesForPhase(cases, phase);
  const activeCount = activeCases(phaseCases).length;

  const parsedVersion = /^\d+$/.test(version) && Number(version) >= 1 ? Number(version) : null;
  const versionInvalid = parsedVersion === null;

  async function run(overrideThis: boolean) {
    if (parsedVersion === null) return;
    setRunning(true);
    try {
      const result = await promotePrompt({ agentId, phase, version: parsedVersion, override: overrideThis });
      setOutcome({ kind: "done", result });
    } catch (err) {
      if (err instanceof GateRefusedError) {
        setOutcome({ kind: "refused", refusal: err.refusal });
      } else {
        setOutcome({ kind: "error", message: apiErrorMessage(err) });
      }
    } finally {
      setRunning(false);
      setConfirming(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.step}>Step 3 of 3</span>
        <h3>Promote to production</h3>
      </div>

      <dl className={styles.state}>
        <div>
          <dt>Serving now</dt>
          <dd>{servingLabel(snapshot)}</dd>
        </div>
        <div>
          <dt>Test cases</dt>
          <dd>
            <SuiteSizeBadge activeCount={activeCount} />
          </dd>
        </div>
      </dl>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="promote-phase">
          Phase
        </label>
        <select
          id="promote-phase"
          className={styles.select}
          value={phase}
          onChange={(event) => {
            setPhase(event.target.value as PromptPhase);
            setConfirming(false);
          }}
        >
          {PROMPT_PHASES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <label className={styles.label} htmlFor="promote-version">
          Version
        </label>
        <input
          id="promote-version"
          type="number"
          min={1}
          className={styles.numberField}
          value={version}
          onChange={(event) => {
            setVersion(event.target.value);
            setConfirming(false);
          }}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.checkboxRow}>
          <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} />
          Override a regression
        </label>
      </div>

      {confirming ? (
        <div className={styles.row}>
          <span className={styles.hint}>
            Move <code>production</code> for <strong>{phase}</strong> ({servingVersionShort(snapshot)}) to
            version <strong>{version}</strong>?
          </span>
          <button
            type="button"
            className={styles.btn}
            onClick={() => void run(override)}
            disabled={running}
          >
            {running ? "Promoting…" : "Confirm promote"}
          </button>
          <button type="button" className={styles.btn} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className={styles.btn}
            onClick={() => setConfirming(true)}
            disabled={running || versionInvalid}
          >
            {running ? "Promoting…" : "Promote to production"}
          </button>
          {versionInvalid && (
            <p className={styles.blockedReason}>Enter a version number, 1 or higher, to promote.</p>
          )}
        </>
      )}

      {outcome.kind === "done" && (
        <div className={styles.result} role="status">
          <p className={styles.resultTitle}>Promoted</p>
          <p className={styles.resultMove}>
            {outcome.result.from_version !== null ? `v${outcome.result.from_version}` : "none"} → v
            {outcome.result.to_version}
            {outcome.result.overridden ? " (overridden)" : ""}
          </p>
          {outcome.result.from_version !== null && (
            <p className={styles.rollback}>
              Roll back by promoting v{outcome.result.from_version} again — it stays resolvable.
            </p>
          )}
        </div>
      )}

      {outcome.kind === "refused" && (
        <div className={styles.refusalWrap}>
          <RefusalPanel
            reason={outcome.refusal.reason}
            regressedCases={outcome.refusal.regressed_cases}
            onOverride={() => void run(true)}
            overriding={running}
          />
        </div>
      )}

      {outcome.kind === "error" && <p className={styles.error}>{outcome.message}</p>}
    </section>
  );
}

/**
 * The Self-learning tab, redesigned around the task brief's own diagnosis
 * of it: "remote controls with no display" that led with three or four
 * lines of prose per card. State now comes first — plan/judge model,
 * whether a program is compiled, what phase is serving what version, how
 * many active test cases exist — and every card's own action disables
 * itself with the one real precondition this console can check
 * (`llmResolution.ts`), rather than explaining the mechanism in prose an
 * operator has to read past.
 *
 * Compile -> tune -> promote reads as a numbered sequence (Step 1/2/3 of 3,
 * a connecting arrow between cards on wide layouts) rather than three equal
 * peers, matching what the actions actually are: one workflow with a state
 * machine, not three independent tools that happen to share a page.
 *
 * `POST /agent/admin/optimize`, `/tune` and `/promote` are unchanged (see
 * `agent-service/app/api/admin.py`); tune/promote now go through
 * `../testing/api.ts` (the same functions `PromptsTab.tsx` already used)
 * instead of a second, separate copy in `../../agents/api.ts` — one gate
 * refusal renderer (`RefusalPanel`, four distinguishable diagnoses) for
 * both tabs that can refuse a promotion, not two.
 */
export function LearningTab() {
  const { agent } = useOutletContext<AgentDetailContext>();
  const { detail, llmConfigs, cases, prompts, loadError } = useLearningData(agent.id);

  return (
    <div className={styles.page}>
      {loadError !== null && (
        <p role="alert" className={styles.error}>
          {loadError}
        </p>
      )}
      <div className={styles.sequence}>
        <OptimizePanel agentId={agent.id} detail={detail} llmConfigs={llmConfigs} />
        <span className={styles.connector} aria-hidden="true">
          <ArrowRight size={18} strokeWidth={2} />
        </span>
        <TunePanel agentId={agent.id} detail={detail} llmConfigs={llmConfigs} prompts={prompts} />
        <span className={styles.connector} aria-hidden="true">
          <ArrowRight size={18} strokeWidth={2} />
        </span>
        <PromotePanel agentId={agent.id} cases={cases} prompts={prompts} />
      </div>
    </div>
  );
}
