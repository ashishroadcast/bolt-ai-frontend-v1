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
import {
  AlertCircle,
  Check,
  CircleArrowUp,
  CircleCheck,
  Copy,
  Info,
  Loader2,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

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
    <section className="min-w-0" aria-label={`${phase} prompt`}>
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-4 sm:px-6 [.border-b]:pb-4">
          <h3 className="text-base leading-none font-semibold capitalize">{phase}</h3>
          <Badge variant="outline" className="font-mono font-normal text-muted-foreground tabular-nums">
            {live !== null && !live.is_fallback ? (
              `v${live.version} · ${live.alias}`
            ) : live !== null ? (
              "signature default · unregistered"
            ) : servingVersion !== null ? (
              `v${servingVersion} · ${serving!.alias} (as of last run)`
            ) : (
              "not yet observed"
            )}
          </Badge>
          <CardAction className="ml-auto self-center">
            <SuiteSizeBadge activeCount={activeCount} />
          </CardAction>
        </CardHeader>

        {/* ── The serving text ──────────────────────────────────────────
            The point of this screen. It used to sit behind a <details> and
            then inside a 90px scroller that cut it off mid-sentence; here it
            has real height and wraps rather than clipping. */}
        <CardContent className="flex flex-col gap-3 p-4 sm:p-6">
          <div className="flex min-h-8 items-center gap-2">
            <span className="text-sm font-medium">
              {isDirty
                ? "Instructions · edited, unsaved"
                : live !== null && live.is_fallback
                  ? "Signature default"
                  : "Serving instructions"}
            </span>
            {live !== null && editorText !== "" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-muted-foreground"
                onClick={() => void copyServing()}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </div>

          {registryLoading && (
            <div className="flex flex-col gap-2" aria-busy="true">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                Reading the prompt registry…
              </p>
              <Skeleton className="h-40 w-full" aria-hidden="true" />
            </div>
          )}

          {registryError !== null && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>
                Couldn&apos;t read the serving prompt — {registryError}
              </AlertDescription>
            </Alert>
          )}

          {/* Prose type in a sunk well, not mono: the instructions are read
              as paragraphs long before they are edited, so the box must not
              switch to a code face the moment it becomes editable. Tall
              enough for most phase prompts outright; anything longer
              scrolls inside the box, never the page. */}
          {live !== null && (
            <Textarea
              className="max-h-[34rem] min-h-64 resize-y overflow-y-auto bg-muted/30 px-4 py-3 font-sans leading-relaxed md:text-sm"
              aria-label={`${phase} instructions`}
              spellCheck={false}
              value={editorText}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}

          {live !== null && live.instructions === "" && draft === "" && (
            <p className="text-sm text-muted-foreground">
              Nothing is registered for this phase, so it resolves to an empty instruction block.
              {phase === "guardrail"
                ? " This agent cannot run at all until a guardrail is registered."
                : " It runs on the signature's own built-in default."}
            </p>
          )}

          {live !== null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {/* Deliberately not the primary colour: the primary button on
                  this panel is Promote, the one action that changes what
                  production serves. A save is a registration, and dressing
                  it in the same colour would say otherwise. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || editorText.trim() === "" || !isDirty}
              >
                {saving ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Save aria-hidden="true" />
                )}
                {saving ? "Saving…" : "Save as new version"}
              </Button>
              {isDirty && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft(live.instructions)}
                  disabled={saving}
                >
                  <Undo2 aria-hidden="true" />
                  Revert to serving
                </Button>
              )}
              <span className="text-sm text-muted-foreground">
                {isDirty
                  ? "Saving registers a new version. It does not go live until it is promoted."
                  : "Edit the text to save a new version."}
              </span>
            </div>
          )}

          {saveError !== null && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}

          {/* A status, not an alert: the save landed. Amber because what
              landed is NOT live — the single most important thing this
              panel can say after a save. */}
          {saved !== null && (
            <Alert role="status" className="border-warning/30 bg-warning-soft">
              <Info aria-hidden="true" className="text-warning" />
              <AlertDescription className="text-foreground">
                Saved as v{saved.version} — not serving.{" "}
                {saved.serving !== null
                  ? `v${saved.serving} is still live.`
                  : "Nothing is live for this phase yet."}{" "}
                Promote v{saved.version} below to put it in front of traffic.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>

        {/* ── Tune ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 border-t p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h4 className="text-sm font-semibold">Tune</h4>
              <p className="max-w-prose text-sm text-muted-foreground">
                Compiles a new version from this phase&apos;s promoted exemplars and registers it.
                Nothing serves it until it is promoted.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleTune()}
              disabled={tuning}
            >
              {tuning ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Sparkles aria-hidden="true" />
              )}
              {tuning ? "Tuning…" : "Tune this phase"}
            </Button>
          </div>
          {tuneError !== null && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{tuneError}</AlertDescription>
            </Alert>
          )}
          {tuned !== null && (
            <div className="flex flex-col gap-2 border-l-2 border-primary pl-3">
              <p className="text-sm font-medium text-primary tabular-nums">
                Registered v{tuned.version} — not yet serving
              </p>
              {/* `pre` for the element, prose for the type: the
                  instructions are written as paragraphs and their blank
                  lines are meaningful. */}
              <pre className="max-h-[26rem] overflow-y-auto rounded-md border bg-muted/40 px-4 py-3 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
                {tuned.instructions}
              </pre>
            </div>
          )}
        </div>

        {/* ── Promote ──────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 border-t p-4 sm:p-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h4 className="text-sm font-semibold">Promote</h4>
            <p className="max-w-prose text-sm text-muted-foreground">
              Moves the{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">production</code>{" "}
              alias to a registered version. The gate replays this phase&apos;s suite first and
              refuses a candidate that regresses a case.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={`candidate-${phase}`}>Candidate version</Label>
              {/* Wide enough for its own placeholder and a four-digit
                  version. The 68px this replaced clipped "version" to
                  "versior" — the field was narrower than the word telling
                  you what to put in it. */}
              <Input
                id={`candidate-${phase}`}
                className="w-[15ch] font-mono tabular-nums"
                inputMode="numeric"
                placeholder="e.g. 18"
                value={candidateInput}
                onChange={(event) => setCandidateInput(event.target.value.replace(/[^0-9]/g, ""))}
              />
            </div>
            <Button type="button" onClick={openConfirm} disabled={candidateVersion === null}>
              <CircleArrowUp aria-hidden="true" />
              Promote
            </Button>
          </div>

          {/* The one gate between clicking Promote and the request firing.
              Inline rather than a modal: a refusal lands right under it, and
              the override it offers has to sit beside the move it
              overrides. */}
          {confirmOpen && (
            <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-accent/60 p-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-semibold">Confirm promotion</p>
                <p className="font-mono text-sm tabular-nums">
                  production ({servingVersion !== null ? `v${servingVersion}` : "none"}) → v
                  {candidateVersion}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {/* The same variant as the Promote button that opened this
                    step — confirming is still the promote action, not a
                    second, distinct one. Override (in RefusalPanel) is the
                    genuinely riskier action. */}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void confirmPromote(false)}
                  disabled={promoting}
                >
                  {promoting && <Loader2 aria-hidden="true" className="animate-spin" />}
                  {promoting ? "Promoting…" : "Confirm promote"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmOpen(false)}
                  disabled={promoting}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {promoteError !== null && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{promoteError}</AlertDescription>
            </Alert>
          )}

          {refusal !== null && (
            <RefusalPanel
              reason={refusal.reason}
              regressedCases={refusal.regressed_cases}
              onOverride={() => void confirmPromote(true)}
              overriding={promoting}
            />
          )}

          {/* Copy rule: the button said Promote, the result says Promoted. */}
          {result !== null && (
            <div
              className="flex gap-3 rounded-lg border border-success/30 bg-success-soft p-4"
              role="status"
            >
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-semibold">Promoted</p>
                <p className="font-mono text-sm text-muted-foreground tabular-nums">
                  {result.from_version !== null ? `v${result.from_version}` : "none"} → v
                  {result.to_version}
                  {result.overridden ? " (overridden)" : ""}
                </p>
                {result.from_version !== null && (
                  <p className="text-sm text-muted-foreground">
                    Roll back by promoting v{result.from_version} again — it stays resolvable.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
