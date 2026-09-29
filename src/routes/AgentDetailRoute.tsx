import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  FileText,
  FlaskConical,
  GraduationCap,
  SearchX,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useAgents } from "../agents/useAgents.ts";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import type { AgentSummary } from "../agents/types.ts";
import { useChatContext } from "../ask/chat/ChatContext.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** What every tab reads via `useOutletContext<AgentDetailContext>()`. */
export interface AgentDetailContext {
  agent: AgentSummary;
}

const TABS: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "config", label: "Configuration", icon: SlidersHorizontal },
  { to: "prompts", label: "Prompts & tuning", icon: FileText },
  { to: "tests", label: "Test suites", icon: FlaskConical },
  { to: "learning", label: "Self-learning", icon: GraduationCap },
];

/**
 * An agent's own detail page: header + four tabs + `<Outlet/>`.
 *
 * **The tabs are router links, not Radix Tabs.** Each tab is its own URL
 * (`/agents/:id/config`, …) so it can be bookmarked and the back button
 * walks between them; they only borrow the look of shadcn's TabsList.
 *
 * **There is no Run tab, and its absence is the fix.** It was one text
 * input and an Ask button alone on a full-height page ("run tab extremely
 * poor too much space wastage", Saurabh) whose submit handler navigated
 * straight to /ask — a launcher, not a workspace, and a strictly worse one
 * than the screen it launched: /ask has the same composer plus the agent
 * picker, the thread, the run's own trace and history. Running an agent is
 * now the header's Ask action, which points /ask at this agent and goes
 * there. `/agents/:id/run` still resolves (App.tsx redirects it) because
 * the URL may be bookmarked.
 */
export function AgentDetailRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  const { agents, loading, error } = useAgents();
  const { setSelectedAgent } = useChatContext();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <span className="sr-only">Loading agent…</span>
        <div className="space-y-2 border-b pb-5" aria-hidden="true">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-full max-w-md rounded-lg" aria-hidden="true" />
        <Skeleton className="h-48 w-full rounded-xl" aria-hidden="true" />
      </div>
    );
  }
  if (error !== null) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Couldn&apos;t load this agent</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const numericId = Number(agentId);
  const agent = agents.find((candidate) => candidate.id === numericId);

  if (agent === undefined) {
    return (
      <EmptyState
        icon={SearchX}
        title="Agent not found"
        body={`No agent with id ${agentId} in this tenant.`}
        actionLabel="Back to agents"
        onAction={() => navigate("/agents")}
      />
    );
  }

  return (
    <>
      <PageHeader
        kicker="Build · Agents"
        title={agent.name}
        titleAdornment={
          agent.is_active ? (
            <StatusPill tone="good" label="Active" />
          ) : (
            <StatusPill tone="neutral" label="Inactive" />
          )
        }
        description={agent.description ?? "No description set."}
        actionLabel={`Ask ${agent.name}`}
        onAction={() => {
          // `selectedAgent` is what Composer sends as `RunIn.agent`, so
          // setting it here is what makes /ask arrive already pointed at
          // this agent rather than whichever the picker defaulted to.
          setSelectedAgent(agent.name);
          navigate("/ask");
        }}
      />

      {/* Scrolls sideways on a phone rather than wrapping: four labels do
          not fit in 360px, and a wrapped tab bar reads as two rows of
          unrelated buttons. */}
      <div className="-mt-2 max-w-full overflow-x-auto">
        <nav
          aria-label={`${agent.name} sections`}
          className="inline-flex h-9 w-max items-center rounded-lg bg-muted p-[3px] text-muted-foreground"
        >
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  "inline-flex h-full items-center justify-center gap-1.5 rounded-md border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
                  isActive
                    ? "bg-background text-foreground shadow-sm"
                    : "text-foreground/60 hover:text-foreground",
                )
              }
            >
              <tab.icon aria-hidden="true" />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="min-w-0">
        <Outlet context={{ agent } satisfies AgentDetailContext} />
      </div>
    </>
  );
}
