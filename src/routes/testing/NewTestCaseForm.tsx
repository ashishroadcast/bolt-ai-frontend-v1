import { useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "./api.ts";
import { SUITE_PHASES, type AgentTestCaseCreate, type SuitePhase } from "./types.ts";

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
    <form onSubmit={handleSubmit}>
      <Card className="gap-5">
        <CardHeader>
          <h3 className="leading-none font-semibold">New test case</h3>
        </CardHeader>

        <CardContent className="grid gap-4">
          <div className="grid gap-2 sm:max-w-56 *:data-[slot=native-select-wrapper]:w-full">
            <Label htmlFor="new-case-phase">Phase</Label>
            <NativeSelect
              id="new-case-phase"
              value={phase}
              onChange={(event) => setPhase(event.target.value as SuitePhase)}
            >
              {SUITE_PHASES.map((suitePhase) => (
                <NativeSelectOption key={suitePhase} value={suitePhase}>
                  {suitePhase}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid content-start gap-2">
              <Label htmlFor="new-case-question">Question</Label>
              <Textarea
                id="new-case-question"
                className="min-h-20"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                required
              />
            </div>

            <div className="grid content-start gap-2">
              <Label htmlFor="new-case-expected">Expected</Label>
              <Textarea
                id="new-case-expected"
                className="min-h-20"
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
                required
              />
            </div>
          </div>

          {error !== null && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="animate-spin" /> : <Plus />}
            {submitting ? "Adding…" : "Add case"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
