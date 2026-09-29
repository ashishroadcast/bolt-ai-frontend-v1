import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Bot,
  Code2,
  Cpu,
  Database,
  Info,
  Loader2,
  MessageSquare,
  Power,
  Settings2,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import { useAgentFleet, type AgentFleetRow } from "../agents/useAgentFleet.ts";
import type { CodeExecutionCapability } from "../agents/types.ts";
import { useChatContext } from "../ask/chat/ChatContext.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Same tones the Configuration tab gives the same three values, so "code"
 * reads as the riskiest setting on both screens. */
const CODE_EXECUTION_BADGE: Record<CodeExecutionCapability, "secondary" | "warning" | "danger"> = {
  none: "secondary",
  interpreter: "warning",
  code: "danger",
};

/** Cards abreast as the width allows, one on a phone. `auto-fill` with a
 * 20rem floor rather than a fixed count: a card whose description and
 * wiring list have to stay readable has a real minimum, and the shell's own
 * inspector can take a third of the width away without warning. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4";

/**
 * The fleet, one card per agent — replacing a four-column table whose only
 * interaction was clicking the name ("agent screen should be cards with
 * action buttons to edit update etc", Saurabh).
 *
 * **The actions are exactly the ones the API has.** `PATCH /agent/agents/
 * {id}` backs Activate/Deactivate here and every control on the
 * Configuration tab; `POST /agent/run` backs Ask. There is still no
 * `POST` or `DELETE /agent/agents`, so this screen draws no New agent and
 * no Delete — a button that can only ever fail is worse than an absent
 * one, and the honest empty state says where agents come from instead.
 *
 * **Editing lives on the Configuration tab, not in a dialog here.** Every
 * field worth editing (datasource, per-phase model, code execution, tool
 * servers) already has a working control one click away, and duplicating
 * them into a modal would be a second write path to keep in step with the
 * first. The card shows that wiring and links straight into it, so "what
 * is this wired to" and "change it" are one gesture apart.
 */
export function AgentsRoute() {
  const { rows, loading, error, wiringError, setActive } = useAgentFleet();
  const { setSelectedAgent } = useChatContext();
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  async function toggleActive(row: AgentFleetRow) {
    const id = row.agent.id;
    setBusyId(id);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const failure = await setActive(id, !row.agent.is_active);
    if (failure !== null) setRowError((prev) => ({ ...prev, [id]: failure }));
    setBusyId(null);
  }

  /** Ask is the Ask screen, pointed at this agent — not a second, lesser
   * chat. `selectedAgent` is what `Composer` sends `POST /agent/run`, so
   * setting it here means the picker on /ask already reads this agent's
   * name when the screen arrives. */
  function ask(row: AgentFleetRow) {
    setSelectedAgent(row.agent.name);
    navigate("/ask");
  }

  const activeCount = rows.filter((row) => row.agent.is_active).length;

  return (
    <>
      <PageHeader
        kicker="Build"
        title="Agents"
        description="Every agent this tenant can run, what each is wired to, and which are serving traffic."
      />
      <div className="flex flex-col gap-4">
        {loading && <FleetSkeleton />}

        {!loading && error !== null && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Couldn&apos;t load agents</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* The wiring reads failed but the list did not — the cards below
            are real and correct, just thinner. A warning, not an error:
            nothing is broken for the operator who only wanted to see which
            agents exist. A note rather than an alert for the same reason. */}
        {!loading && error === null && wiringError !== null && (
          <Alert role="note" className="border-warning/30 bg-warning-soft text-warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="text-warning">
              Showing names and status only — couldn&apos;t read what these agents are wired to:{" "}
              {wiringError}
            </AlertDescription>
          </Alert>
        )}

        {!loading && error === null && rows.length === 0 && (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            body="No agents exist for this tenant yet. Agents are seeded by the platform — none has run here."
          />
        )}

        {!loading && error === null && rows.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground tabular-nums">
              {`${rows.length} ${rows.length === 1 ? "agent" : "agents"} · ${activeCount} active`}
            </p>
            <div className={GRID}>
              {rows.map((row) => (
                <AgentCard
                  key={row.agent.id}
                  row={row}
                  busy={busyId === row.agent.id}
                  error={rowError[row.agent.id] ?? null}
                  onToggleActive={() => void toggleActive(row)}
                  onAsk={() => ask(row)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function FleetSkeleton() {
  return (
    <div className={GRID} aria-busy="true">
      <span className="sr-only">Loading agents…</span>
      {[0, 1, 2].map((index) => (
        <Card key={index} className="gap-4" aria-hidden="true">
          <CardHeader className="gap-3">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-lg" />
              <Skeleton className="h-5 w-32" />
            </div>
            <Skeleton className="h-4 w-full" />
          </CardHeader>
          <CardContent className="space-y-2.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
          <CardFooter className="gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-16" />
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}

interface AgentCardProps {
  row: AgentFleetRow;
  busy: boolean;
  error: string | null;
  onToggleActive: () => void;
  onAsk: () => void;
}

function AgentCard({ row, busy, error, onToggleActive, onAsk }: AgentCardProps) {
  const { agent, wiring } = row;
  const shared = agent.owned === false;

  return (
    <article className="flex min-w-0">
      {/* Inactive is carried by the badge, and again here by a flatter,
          sunk card — form as well as colour, so the state survives a
          screenshot. Never a lower opacity: that would dim the text too,
          and an inactive agent's description still has to be readable. */}
      <Card
        className={cn(
          "min-w-0 flex-1 gap-4 transition-shadow",
          agent.is_active ? "hover:shadow-md" : "bg-muted/40 shadow-none",
        )}
      >
        <CardHeader className="gap-1.5">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                agent.is_active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              <Bot className="size-5" />
            </span>
            {/* An agent's name is an identifier: it must not wrap, because
                "Zomato-Complaints" broken across two lines reads as two
                things. */}
            <h3 className="min-w-0 truncate text-base leading-tight font-semibold">
              {shared ? (
                agent.name
              ) : (
                <Link
                  to={`/agents/${agent.id}`}
                  className="rounded-sm outline-none hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {agent.name}
                </Link>
              )}
            </h3>
          </div>
          <CardAction className="row-span-1 flex flex-wrap justify-end gap-1.5">
            {shared && <StatusPill tone="neutral" label="Shared" />}
            {agent.is_active ? (
              <StatusPill tone="good" label="Active" />
            ) : (
              <StatusPill tone="neutral" label="Inactive" />
            )}
          </CardAction>
          {/* Full text, wrapped. The table this replaced clipped it to one
              line because four three-line descriptions made a wall; a card
              has the room the table never did. */}
          <CardDescription className="col-span-full pt-1 leading-relaxed">
            {agent.description ?? "No description set."}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col gap-3">
          {wiring !== null && (
            <dl className="divide-y rounded-lg border bg-background/60 text-sm">
              <WiringRow icon={Database} label="Reads">
                {wiring.datasourceName ?? <Unset>No datasource</Unset>}
              </WiringRow>
              <WiringRow icon={Cpu} label="Models">
                {wiring.pinnedPhaseCount === 0 ? (
                  <Unset>Tenant default, all {wiring.phaseCount} phases</Unset>
                ) : (
                  <>
                    {wiring.modelNames.join(", ")}
                    <span className="text-muted-foreground tabular-nums">
                      {" "}
                      · {wiring.pinnedPhaseCount}/{wiring.phaseCount} phases pinned
                    </span>
                  </>
                )}
              </WiringRow>
              <WiringRow icon={Wrench} label="Tools">
                {wiring.mcpServerNames.length === 0 ? (
                  <Unset>No tool servers</Unset>
                ) : (
                  wiring.mcpServerNames.join(", ")
                )}
              </WiringRow>
              <WiringRow icon={Code2} label="Code">
                <Badge variant={CODE_EXECUTION_BADGE[wiring.codeExecution]} className="font-mono">
                  {wiring.codeExecution}
                </Badge>
              </WiringRow>
            </dl>
          )}

          {/* A shared agent's card says why it has no Configure or
              Deactivate, rather than leaving the reader to wonder where the
              controls went. */}
          {shared && (
            <p className="flex gap-2 text-sm leading-relaxed text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                Shared with this organisation. You can ask it; only the organisation that set it up
                can change it.
              </span>
            </p>
          )}

          {error !== null && (
            <Alert variant="destructive" className="py-2">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="flex-wrap gap-2 border-t [.border-t]:pt-4">
          {!shared && (
            <Button asChild size="sm">
              <Link to={`/agents/${agent.id}/config`}>
                <Settings2 aria-hidden="true" />
                Configure
              </Link>
            </Button>
          )}
          <Button type="button" size="sm" variant={shared ? "default" : "outline"} onClick={onAsk}>
            <MessageSquare aria-hidden="true" />
            Ask
          </Button>
          {!shared && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                "ml-auto",
                agent.is_active ? "text-muted-foreground hover:text-foreground" : "text-primary",
              )}
              disabled={busy}
              onClick={onToggleActive}
              // The label is the verb, the badge above is the state — a
              // button reading "Active" would be ambiguous about which of
              // the two it is saying.
              aria-label={`${agent.is_active ? "Deactivate" : "Activate"} ${agent.name}`}
            >
              {busy ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Power aria-hidden="true" />
              )}
              {busy ? "Saving…" : agent.is_active ? "Deactivate" : "Activate"}
            </Button>
          )}
        </CardFooter>
      </Card>
    </article>
  );
}

function WiringRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3 px-3 py-2">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {label}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** "Not set" is a real, correct state — quiet, never an error colour. */
function Unset({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
