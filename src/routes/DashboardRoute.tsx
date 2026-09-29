import { ArrowRight, Database, FileText, Sparkles, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentIcon } from "../ask/AgentIcon.tsx";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { useOrchestrators } from "../agents/useOrchestrators.ts";
import type { AgentSummary } from "../agents/types.ts";
import { listDatasources, type DataSource } from "./datasourcesApi.ts";
import { listDocuments, type DocumentRecord } from "./documentsApi.ts";

interface Knowledge {
  /** Every datasource that is a connected database (not the corpus). */
  databases: DataSource[];
  /** The documents in the one knowledge corpus, if there is one. */
  documents: DocumentRecord[];
  loading: boolean;
}

/**
 * Reads the same two endpoints Databases and Documents already read
 * (`listDatasources`/`listDocuments`, both `src/routes/*Api.ts` — imported
 * read-only here, not edited: `datasourcesApi.ts` sits inside a sibling
 * task's file list) rather than a dedicated summary endpoint, which
 * doesn't exist. A "knowledge" datasource is the one document corpus
 * (`DocumentsRoute.tsx`'s own docstring); everything else `type !==
 * "knowledge"` is a connected database.
 *
 * The rows are kept, not just counted, so the cards below can say more
 * than a bare number (how many are ready, how many tables were indexed)
 * without a second request.
 */
function useKnowledge(): Knowledge {
  const [state, setState] = useState<Knowledge>({ databases: [], documents: [], loading: true });

  useEffect(() => {
    let cancelled = false;
    listDatasources()
      .then(async (rows) => {
        const databases = rows.filter((row) => row.type !== "knowledge");
        const corpus = rows.find((row) => row.type === "knowledge");
        const documents = corpus ? await listDocuments(corpus.id).catch(() => []) : [];
        if (!cancelled) setState({ databases, documents, loading: false });
      })
      .catch(() => {
        if (cancelled) return;
        // A failed count reads as "0" rather than a route-level error
        // banner — a landing page's tiles degrade quietly; the route each
        // tile links to is where the real error (if any) shows up.
        setState({ databases: [], documents: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "12 ready · 1 failed · 2 processing" — only the parts that are non-zero
 * after "ready", so a healthy corpus reads as one short fact. */
function documentsDetail(documents: DocumentRecord[]): string {
  const ready = documents.filter((doc) => doc.status === "ready").length;
  const failed = documents.filter((doc) => doc.status === "failed").length;
  const processing = documents.length - ready - failed;
  const parts = [`${ready} ready`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (processing > 0) parts.push(`${processing} processing`);
  return parts.join(" · ");
}

interface StatCardProps {
  icon: LucideIcon | ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  value: number | null;
  /** The secondary line under the count — "3 active". Omitted while loading. */
  detail?: string;
  /** What the count is, in a few words, for someone new to the console. */
  hint: string;
  to: string;
}

/**
 * The landing page's whole point: a count that reads before anything else
 * on the card does (redesign brief, "give numbers presence... set it
 * large") — large tabular figures, and a tinted icon tile so the accent
 * shows up here rather than only in charts. The whole card is the link to
 * the screen that manages what it counts.
 */
function StatCard({ icon: Icon, label, value, detail, hint, to }: StatCardProps) {
  return (
    <Link
      to={to}
      className="group/stat rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Card className="h-full gap-4 transition-[border-color,box-shadow] group-hover/stat:border-primary/40 group-hover/stat:shadow-md">
        <CardHeader>
          <CardDescription className="font-medium">{label}</CardDescription>
          <CardTitle className="text-3xl font-semibold tracking-tight tabular-nums">
            {value === null ? (
              <>
                <Skeleton aria-hidden="true" className="h-8 w-14" />
                <span className="sr-only">Loading</span>
              </>
            ) : (
              value
            )}
          </CardTitle>
          <CardAction>
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"
            >
              <Icon size={18} strokeWidth={2} aria-hidden="true" />
            </span>
          </CardAction>
        </CardHeader>
        <CardFooter className="mt-auto flex-col items-start gap-1 text-sm">
          {detail === undefined ? (
            <Skeleton aria-hidden="true" className="h-4 w-20" />
          ) : (
            <span className="font-medium tabular-nums">{detail}</span>
          )}
          <span className="text-muted-foreground">{hint}</span>
        </CardFooter>
      </Card>
    </Link>
  );
}

/** Long database names would run off the chart's left edge — recharts
 * does not truncate a category tick on its own. */
function shortName(name: string): string {
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

const CHART_ROW_HEIGHT = 36;

/**
 * What each connected database has indexed — `total_tables` straight off
 * the rows `useKnowledge` already fetched, so this is the same number the
 * Databases screen shows, drawn rather than listed.
 */
function IndexedTablesCard({ databases, loading }: { databases: DataSource[]; loading: boolean }) {
  const data = databases.map((ds) => ({ name: ds.name, tables: ds.total_tables }));
  const totalTables = databases.reduce((sum, ds) => sum + ds.total_tables, 0);
  const totalColumns = databases.reduce((sum, ds) => sum + ds.total_columns, 0);
  const height = Math.max(160, data.length * CHART_ROW_HEIGHT + 40);

  return (
    <Card className="min-w-0 lg:col-span-4">
      <CardHeader>
        <CardTitle>
          <h3>Indexed tables by database</h3>
        </CardTitle>
        <CardDescription>What each connected database has indexed for an agent to query.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/databases">
              Databases
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton aria-hidden="true" className="h-40 w-full" />
        ) : data.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
            <Database aria-hidden="true" className="size-5" />
            No databases connected yet.
          </div>
        ) : (
          <div className="w-full" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
                <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={128}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={shortName}
                  tick={{ fill: "var(--foreground)", fontSize: 12 }}
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)" }}
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    color: "var(--popover-foreground)",
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--foreground)", fontWeight: 500 }}
                />
                <Bar
                  dataKey="tables"
                  name="Tables"
                  fill="var(--chart-1)"
                  radius={4}
                  maxBarSize={22}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
      {!loading && data.length > 0 && (
        <CardFooter className="mt-auto text-sm text-muted-foreground tabular-nums">
          {plural(totalTables, "table", "tables")} · {plural(totalColumns, "column", "columns")} across{" "}
          {plural(data.length, "database", "databases")}
        </CardFooter>
      )}
    </Card>
  );
}

const AGENT_PREVIEW_LIMIT = 5;

function AgentsCard({ agents, loading }: { agents: AgentSummary[]; loading: boolean }) {
  // Active first — the agents Ask can actually route to are the ones worth
  // reading on a landing page.
  const preview = [...agents]
    .sort((a, b) => (a.is_active === b.is_active ? 0 : a.is_active ? -1 : 1))
    .slice(0, AGENT_PREVIEW_LIMIT);

  return (
    <Card className="min-w-0 lg:col-span-3">
      <CardHeader>
        <CardTitle>
          <h3>Agents</h3>
        </CardTitle>
        <CardDescription>The agents a question in Ask can be answered by.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/agents">
              View all
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-3" aria-hidden="true">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-9 w-full" />
            ))}
          </div>
        ) : preview.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
            <AgentIcon size={20} aria-hidden="true" />
            No agents yet.
          </div>
        ) : (
          <ul className="divide-y">
            {preview.map((agent) => (
              <li key={agent.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"
                >
                  <AgentIcon size={16} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/agents/${agent.id}`}
                    className="block truncate text-sm font-medium underline-offset-4 hover:underline"
                  >
                    {agent.name}
                  </Link>
                  {agent.description !== null && agent.description !== "" && (
                    <p className="truncate text-xs text-muted-foreground">{agent.description}</p>
                  )}
                </div>
                <StatusPill
                  tone={agent.is_active ? "good" : "neutral"}
                  label={agent.is_active ? "Active" : "Inactive"}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {!loading && agents.length > AGENT_PREVIEW_LIMIT && (
        <CardFooter className="mt-auto text-sm text-muted-foreground">
          Showing {AGENT_PREVIEW_LIMIT} of {agents.length}
        </CardFooter>
      )}
    </Card>
  );
}

/**
 * The default route (`/`, App.tsx) and the first screen anyone sees —
 * previously an empty Ask composer (redesign brief: "there is no landing
 * page... build one; it is the first screen anyone sees, make it earn
 * that"). Every count is real, fetched from the same endpoints their own
 * screens use — no seeded/placeholder numbers, and no trend line, because
 * none of these endpoints has any history to draw one from.
 */
export function DashboardRoute() {
  const { agents, loading: agentsLoading } = useAgents();
  const { orchestrators, loading: orchestratorsLoading } = useOrchestrators();
  const knowledge = useKnowledge();

  const activeAgents = agents.filter((agent) => agent.is_active).length;
  const activeOrchestrators = orchestrators.filter((orchestrator) => orchestrator.is_active).length;
  const indexedTables = knowledge.databases.reduce((sum, ds) => sum + ds.total_tables, 0);

  return (
    <>
      <PageHeader
        kicker="Overview"
        title="Dashboard"
        description="What this tenant has running: agents, orchestrators, connected databases and documents. Open any tile to manage it."
      />
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={AgentIcon}
            label="Agents"
            value={agentsLoading ? null : agents.length}
            detail={agentsLoading ? undefined : `${activeAgents} active`}
            hint="Answer questions in Ask"
            to="/agents"
          />
          <StatCard
            icon={Workflow}
            label="Orchestrators"
            value={orchestratorsLoading ? null : orchestrators.length}
            detail={orchestratorsLoading ? undefined : `${activeOrchestrators} active`}
            hint="Route a question to the best-fit agent"
            to="/orchestrators"
          />
          <StatCard
            icon={Database}
            label="Databases"
            value={knowledge.loading ? null : knowledge.databases.length}
            detail={knowledge.loading ? undefined : `${plural(indexedTables, "table", "tables")} indexed`}
            hint="Connected for agents to query"
            to="/databases"
          />
          <StatCard
            icon={FileText}
            label="Documents"
            value={knowledge.loading ? null : knowledge.documents.length}
            detail={knowledge.loading ? undefined : documentsDetail(knowledge.documents)}
            hint="In the knowledge corpus"
            to="/documents"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-7">
          <IndexedTablesCard databases={knowledge.databases} loading={knowledge.loading} />
          <AgentsCard agents={agents} loading={agentsLoading} />
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
              >
                <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
              </span>
              <CardTitle>
                <h3>What this agent does</h3>
              </CardTitle>
            </div>
            <CardAction>
              <Button variant="outline" size="sm" asChild>
                <Link to="/ask">
                  Open Ask
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Ask a question in plain language on the Ask screen and the agent researches, plans and
              runs a real query against your connected databases and documents — then shows its work
              as it goes, phase by phase, and cites where an answer came from. Agents are configured
              here in Build; an orchestrator routes a question to the best-fit agent, or coordinates
              several and synthesises one answer.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
