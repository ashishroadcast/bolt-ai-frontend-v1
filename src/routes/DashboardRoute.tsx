import { Database, FileText, Sparkles, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { AgentIcon } from "../ask/AgentIcon.tsx";
import { PageHeader } from "../agents/PageHeader.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { useOrchestrators } from "../agents/useOrchestrators.ts";
import { listDatasources } from "./datasourcesApi.ts";
import { listDocuments } from "./documentsApi.ts";
import styles from "./DashboardRoute.module.css";

interface KnowledgeCounts {
  databases: number;
  documents: number;
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
 */
function useKnowledgeCounts(): KnowledgeCounts {
  const [state, setState] = useState<KnowledgeCounts>({ databases: 0, documents: 0, loading: true });

  useEffect(() => {
    let cancelled = false;
    listDatasources()
      .then(async (rows) => {
        const databases = rows.filter((row) => row.type !== "knowledge").length;
        const corpus = rows.find((row) => row.type === "knowledge");
        const documents = corpus ? (await listDocuments(corpus.id).catch(() => [])).length : 0;
        if (!cancelled) setState({ databases, documents, loading: false });
      })
      .catch(() => {
        if (cancelled) return;
        // A failed count reads as "0" rather than a route-level error
        // banner — a landing page's tiles degrade quietly; the route each
        // tile links to is where the real error (if any) shows up.
        setState({ databases: 0, documents: 0, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

interface StatTileProps {
  icon: LucideIcon | ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  value: number | null;
  detail?: string;
  to: string;
}

/**
 * The landing page's whole point: a count that reads before anything else
 * on the card does (redesign brief, "give numbers presence... set it
 * large") — `--text-stat`, tabular figures, and a tinted icon tile so the
 * accent shows up here rather than only in charts.
 */
function StatTile({ icon: Icon, label, value, detail, to }: StatTileProps) {
  return (
    <Link to={to} className={styles.tile}>
      <span className={styles.tileIcon} aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className={`${styles.tileValue} tabular-nums`}>{value === null ? "—" : value}</span>
      <span className={styles.tileLabel}>{label}</span>
      {detail !== undefined && <span className={styles.tileDetail}>{detail}</span>}
    </Link>
  );
}

/**
 * The default route (`/`, App.tsx) and the first screen anyone sees —
 * previously an empty Ask composer (redesign brief: "there is no landing
 * page... build one; it is the first screen anyone sees, make it earn
 * that"). Every count is real, fetched from the same endpoints their own
 * screens use — no seeded/placeholder numbers.
 */
export function DashboardRoute() {
  const { agents, loading: agentsLoading } = useAgents();
  const { orchestrators, loading: orchestratorsLoading } = useOrchestrators();
  const knowledge = useKnowledgeCounts();

  const activeAgents = agents.filter((agent) => agent.is_active).length;

  return (
    <>
      <PageHeader
        kicker="Overview"
        title="Dashboard"
        description="What this tenant has running: agents, orchestrators, connected databases and documents. Open any tile to manage it."
      />
      <div className={styles.body}>
        <div className={styles.grid}>
          <StatTile
            icon={AgentIcon}
            label="Agents"
            value={agentsLoading ? null : agents.length}
            detail={agentsLoading ? undefined : `${activeAgents} active`}
            to="/agents"
          />
          <StatTile
            icon={Workflow}
            label="Orchestrators"
            value={orchestratorsLoading ? null : orchestrators.length}
            to="/orchestrators"
          />
          <StatTile
            icon={Database}
            label="Databases"
            value={knowledge.loading ? null : knowledge.databases}
            to="/databases"
          />
          <StatTile
            icon={FileText}
            label="Documents"
            value={knowledge.loading ? null : knowledge.documents}
            to="/documents"
          />
        </div>

        <section className={styles.about}>
          <span className={styles.aboutIcon} aria-hidden="true">
            <Sparkles size={18} strokeWidth={2} />
          </span>
          <div>
            <h3 className={styles.aboutTitle}>What this agent does</h3>
            <p className={styles.aboutBody}>
              Ask a question in plain language on the Ask screen and the agent researches, plans and
              runs a real query against your connected databases and documents — then shows its work
              as it goes, phase by phase, and cites where an answer came from. Agents are configured
              here in Build; an orchestrator routes a question to the best-fit agent, or coordinates
              several and synthesises one answer.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
