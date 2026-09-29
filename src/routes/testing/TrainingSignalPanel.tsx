import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, MessageSquarePlus, ThumbsDown, ThumbsUp, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { apiErrorMessage, listFeedback, recordFeedbackReason } from "./api.ts";
import type { FeedbackItem, FeedbackList } from "./types.ts";

/**
 * What tuning will actually learn from, and the ratings that are not
 * reaching it yet.
 *
 * **Why this sits on the Prompts tab.** `POST /agent/admin/tune` reads
 * exactly two stores — promoted exemplars and corrections — and turns them
 * into a new prompt version. Both are written by `POST /agent/feedback`,
 * and until this panel there was nowhere to see either: an operator
 * pressing Tune could not tell whether they were about to compile from a
 * hundred corrections or from none, and a 422 saying "no training signal"
 * was the first and only feedback they got.
 *
 * **The actionable row is a thumbs-down with no comment.** §9.1's write
 * policy turns a bare 👎 into a plan-cache invalidation and stops there;
 * only a 👎 *with* a comment becomes a correction, and only corrections
 * reach the tuner (as "mistakes to avoid", verbatim, in
 * `PromptTuningSignature`). So a bare down-vote is a rating that never
 * influences a prompt. This lists them and offers to record the reason,
 * which posts an ordinary `POST /agent/feedback` — the same door the
 * rating came through, not a second write path (see `recordFeedbackReason`
 * in `api.ts`).
 *
 * A 👍 is shown but never actionable here: it either promoted an exemplar
 * at rating time or it did not, and nothing an operator can type afterwards
 * changes that.
 */
export function TrainingSignalPanel({ agentId }: { agentId: number }) {
  const [signal, setSignal] = useState<FeedbackList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSignal(null);
    setLoadError(null);
    listFeedback(agentId)
      .then((loaded) => {
        if (!cancelled) setSignal(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, reload]);

  return (
    <section className="min-w-0" aria-label="Training signal">
      <Card className="gap-4">
        <CardHeader>
          {/* Title and counts share a row that wraps, rather than a
              CardAction column, so the counts drop under the title on a
              phone instead of squeezing the description beside them. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h3 className="leading-none font-semibold">Training signal</h3>
            {signal !== null && (
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="h-6 font-normal text-muted-foreground">
                  <strong className="font-mono font-semibold text-foreground tabular-nums">{signal.exemplars}</strong>{" "}
                  exemplar{signal.exemplars === 1 ? "" : "s"}
                </Badge>
                <Badge variant="outline" className="h-6 font-normal text-muted-foreground">
                  <strong className="font-mono font-semibold text-foreground tabular-nums">{signal.corrections}</strong>{" "}
                  correction
                  {signal.corrections === 1 ? "" : "s"}
                </Badge>
              </div>
            )}
          </div>
          <CardDescription className="max-w-3xl leading-relaxed">
            Tune reads these two stores and nothing else. A thumbs-up on an answer whose plan was cached
            becomes an exemplar; a thumbs-down becomes a correction only once someone records why.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-3">
          {signal === null && loadError === null && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Reading ratings…
            </p>
          )}

          {loadError !== null && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>Couldn&apos;t read the ratings — {loadError}</AlertDescription>
            </Alert>
          )}

          {signal !== null && signal.items.length === 0 && (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              No one has rated an answer from this agent yet. Ratings are the thumbs on each answer in
              Ask.
            </p>
          )}

          {signal !== null && signal.items.length > 0 && (
            <ul className="grid gap-3">
              {signal.items.map((item) => (
                <RatingRow key={item.feedback_id} item={item} onRecorded={() => setReload((n) => n + 1)} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

interface RatingRowProps {
  item: FeedbackItem;
  onRecorded: () => void;
}

function RatingRow({ item, onRecorded }: RatingRowProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDown = item.rating === "down";
  const needsReason = isDown && item.comment === null;

  async function record() {
    setSaving(true);
    setError(null);
    try {
      await recordFeedbackReason(item.message_id, reason.trim());
      setOpen(false);
      setReason("");
      // Re-reads the list rather than patching it in place: the server is
      // what decides whether a correction was actually written (a turn with
      // no resolvable question records the reason and no correction), and
      // guessing that client-side would show a count that never moved.
      onRecorded();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    // The left edge carries the rating's colour so the list can be scanned
    // for the rows that need work without reading every label.
    <li
      className={cn(
        "grid min-w-0 gap-2 rounded-lg border border-l-4 p-3 sm:p-4",
        isDown ? "border-l-destructive/70" : "border-l-success/70",
      )}
      data-rating={item.rating}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Badge
          variant={isDown ? "danger" : "success"}
          className="mt-0.5"
          aria-label={isDown ? "Rated unhelpful" : "Rated helpful"}
        >
          {isDown ? <ThumbsDown /> : <ThumbsUp />}
          {isDown ? "Unhelpful" : "Helpful"}
        </Badge>
        <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
          {item.question ?? "(no question recorded)"}
        </span>
        {needsReason && !open && (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen(true)}>
            <MessageSquarePlus />
            Record the reason
          </Button>
        )}
      </div>

      {/* Two lines of the answer is enough to recognise the turn; the whole
          answer belongs in the transcript, not in a review queue. */}
      <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
        {item.answer || "(no answer recorded)"}
      </p>

      {item.comment !== null && (
        <p className="border-l-2 pl-3 text-sm leading-relaxed">Correction: {item.comment}</p>
      )}

      {needsReason && !open && (
        <p className="flex items-center gap-1.5 text-sm text-warning">
          <TriangleAlert className="size-4 shrink-0" />
          No reason recorded, so this rating never reached prompt tuning.
        </p>
      )}

      {open && (
        <div className="mt-1 grid gap-2">
          <Label htmlFor={`reason-${item.feedback_id}`}>What was wrong with this answer?</Label>
          <Textarea
            id={`reason-${item.feedback_id}`}
            className="min-h-20 bg-background"
            value={reason}
            placeholder="e.g. counted cancelled lines as sales"
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void record()}
              disabled={saving || reason.trim() === ""}
            >
              {saving && <LoaderCircle className="animate-spin" />}
              {saving ? "Recording…" : "Record"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
          {error !== null && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
