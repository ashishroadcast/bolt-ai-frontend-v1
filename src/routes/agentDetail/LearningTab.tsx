import { useEffect, useState, type ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
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

/** One numbered step of the compile → tune → promote sequence, as a card
 * inside a `<section>` (the unit the tests scope a card's contents by). */
function StepCard({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0">
      <Card className="w-full gap-5">
        <CardHeader className="gap-1.5">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Step {step} of 3
          </span>
          <h3 className="leading-none font-semibold">{title}</h3>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">{children}</CardContent>
      </Card>
    </section>
  );
}

/** The state block every card leads with — real figures first, the action
 * underneath (task brief): label left, value right. `mono` for the rows
 * that are ids/URIs rather than names. */
function StateList({ mono = false, children }: { mono?: boolean; children: ReactNode }) {
  return (
    <dl className={cn("divide-y rounded-lg border text-sm", mono && "font-mono text-xs tabular-nums")}>
      {children}
    </dl>
  );
}

function StateRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-right font-medium break-words", className)}>{children}</dd>
    </div>
  );
}

/** An action's own failure — the server's reason, verbatim. Not an ARIA
 * alert (it never was one); the page-level load failure is. */
function ActionError({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm leading-relaxed text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

/** An action that cannot run says why, right on it — not enabled with the
 * reason left in a paragraph above (task brief). Warning, not destructive:
 * "needs attention before you can act", the same role SuiteSizeBadge
 * already gives a thin-suite warning. */
function BlockedReason({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
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
    <StepCard step={1} title="Compile a plan program">
      <StateList>
        <StateRow label="Plan model">{detail === null ? "loading…" : (planModel?.name ?? "not configured")}</StateRow>
        <StateRow label="Judge model">{detail === null ? "loading…" : (judgeModel?.name ?? "not configured")}</StateRow>
        {/* An honest gap, not a fabricated number — no endpoint reports the
            exemplar count (see the comment on `blockedReason` above).
            Italic and muted so it reads as "not available", not as a zero. */}
        <StateRow label="Exemplars" className="font-normal text-muted-foreground italic">
          not exposed by this API yet
        </StateRow>
        <StateRow label="Compiled">{compiledLabel(detail?.compiled_programs.plan)}</StateRow>
      </StateList>

      <div className="grid gap-2">
        <Button type="button" className="w-fit" onClick={() => void run()} disabled={disabled}>
          {running && <LoaderCircle className="animate-spin" />}
          {running ? "Compiling…" : "Compile plan"}
        </Button>
        {blockedReason !== null && <BlockedReason>{blockedReason}</BlockedReason>}
      </div>

      {outcome.kind === "done" && (
        <>
          {/* The one number this screen has ahead of any action: a compiled
              run's demo count. Large and tabular — a count is the point of
              a stat and has to read before anything else on the card. */}
          <div className="flex items-baseline gap-2">
            <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">
              {outcome.demoCount}
            </span>
            <span className="text-sm text-muted-foreground">demos compiled</span>
          </div>
          <StateList mono>
            <StateRow label="run id">{outcome.runId}</StateRow>
            <StateRow label="artifact">{outcome.artifactUri}</StateRow>
          </StateList>
        </>
      )}
      {outcome.kind === "error" && <ActionError message={outcome.message} />}
    </StepCard>
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
    <StepCard step={2} title="Register a tuned prompt">
      <div className="grid gap-2 sm:max-w-48 *:data-[slot=native-select-wrapper]:w-full">
        <Label htmlFor="tune-phase">Phase</Label>
        <NativeSelect
          id="tune-phase"
          value={phase}
          onChange={(event) => setPhase(event.target.value as PromptPhase)}
        >
          {PROMPT_PHASES.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {p}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      <StateList>
        <StateRow label="Serving">{servingLabel(snapshot)}</StateRow>
        <StateRow label="Runs on">{detail === null ? "loading…" : (phaseModel?.name ?? "not configured")}</StateRow>
      </StateList>

      <div>
        <Button type="button" onClick={() => void run()} disabled={running}>
          {running && <LoaderCircle className="animate-spin" />}
          {running ? "Registering…" : "Register tuned version"}
        </Button>
      </div>

      {outcome.kind === "done" && (
        <StateList mono>
          <StateRow label="version">{outcome.version}</StateRow>
          <StateRow label="prompt uri">{outcome.promptUri}</StateRow>
        </StateList>
      )}
      {outcome.kind === "error" && <ActionError message={outcome.message} />}
    </StepCard>
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
    <StepCard step={3} title="Promote to production">
      <StateList>
        <StateRow label="Serving now">{servingLabel(snapshot)}</StateRow>
        <StateRow label="Test cases">
          <SuiteSizeBadge activeCount={activeCount} />
        </StateRow>
      </StateList>

      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
        <div className="grid gap-2 *:data-[slot=native-select-wrapper]:w-full">
          <Label htmlFor="promote-phase">Phase</Label>
          <NativeSelect
            id="promote-phase"
            value={phase}
            onChange={(event) => {
              setPhase(event.target.value as PromptPhase);
              setConfirming(false);
            }}
          >
            {PROMPT_PHASES.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {p}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="promote-version">Version</Label>
          <Input
            id="promote-version"
            type="number"
            min={1}
            className="font-mono tabular-nums"
            value={version}
            onChange={(event) => {
              setVersion(event.target.value);
              setConfirming(false);
            }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="promote-override"
          checked={override}
          onCheckedChange={(checked) => setOverride(checked === true)}
        />
        <Label htmlFor="promote-override" className="font-normal">
          Override a regression
        </Label>
      </div>

      {confirming ? (
        <div className="grid gap-3 rounded-lg border border-warning/30 bg-warning-soft p-3">
          <span className="text-sm leading-relaxed">
            Move <code className="rounded bg-background/70 px-1 py-0.5 font-mono text-xs">production</code> for{" "}
            <strong className="font-semibold">{phase}</strong> ({servingVersionShort(snapshot)}) to version{" "}
            <strong className="font-semibold">{version}</strong>?
          </span>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void run(override)} disabled={running}>
              {running && <LoaderCircle className="animate-spin" />}
              {running ? "Promoting…" : "Confirm promote"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          <Button
            type="button"
            className="w-fit"
            onClick={() => setConfirming(true)}
            disabled={running || versionInvalid}
          >
            {running && <LoaderCircle className="animate-spin" />}
            {running ? "Promoting…" : "Promote to production"}
          </Button>
          {versionInvalid && <BlockedReason>Enter a version number, 1 or higher, to promote.</BlockedReason>}
        </div>
      )}

      {/* Success — the same visual contract as PhasePromptPanel's own
          result, so a promotion reads the same way on both tabs that can
          do one. */}
      {outcome.kind === "done" && (
        <div className="flex gap-3 rounded-lg border border-success/30 bg-success-soft p-3" role="status">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="grid min-w-0 gap-1">
            <p className="text-sm font-medium">Promoted</p>
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              {outcome.result.from_version !== null ? `v${outcome.result.from_version}` : "none"} → v
              {outcome.result.to_version}
              {outcome.result.overridden ? " (overridden)" : ""}
            </p>
            {outcome.result.from_version !== null && (
              <p className="text-sm text-muted-foreground">
                Roll back by promoting v{outcome.result.from_version} again — it stays resolvable.
              </p>
            )}
          </div>
        </div>
      )}

      {outcome.kind === "refused" && (
        <RefusalPanel
          reason={outcome.refusal.reason}
          regressedCases={outcome.refusal.regressed_cases}
          onOverride={() => void run(true)}
          overriding={running}
        />
      )}

      {outcome.kind === "error" && <ActionError message={outcome.message} />}
    </StepCard>
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
    <div className="flex flex-col gap-4">
      {loadError !== null && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {/* Three cards, but a sequence, not three peers (task brief: "compile
          -> tune -> promote is a sequence with a state machine. Side-by-side
          equal cards hide that entirely"). Sized by the tab's own width (a
          container query), not the viewport's, since the sidebar takes a
          variable share of it. Narrow: the cards stack, which still reads
          top-to-bottom as a sequence. Wide: one row, with an arrow between
          steps — decorative, so hidden from assistive readers. */}
      <div className="@container">
        <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
          <OptimizePanel agentId={agent.id} detail={detail} llmConfigs={llmConfigs} />
          <StepConnector />
          <TunePanel agentId={agent.id} detail={detail} llmConfigs={llmConfigs} prompts={prompts} />
          <StepConnector />
          <PromotePanel agentId={agent.id} cases={cases} prompts={prompts} />
        </div>
      </div>
    </div>
  );
}

function StepConnector() {
  return (
    <span className="hidden items-start pt-7 text-muted-foreground/70 @4xl:flex" aria-hidden="true">
      <ArrowRight className="size-4" />
    </span>
  );
}
