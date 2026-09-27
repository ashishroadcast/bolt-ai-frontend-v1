import { NavLink } from "react-router-dom";
import { NAV_ICONS } from "./navIcons.tsx";
import styles from "./Rail.module.css";

interface RailItem {
  to: string;
  label: string;
}

// Grouped the way the work divides, and the way the reference console
// Saurabh asked us to match does it. Dashboard leads because it is the
// default route and the first thing anyone sees.
const workItems: RailItem[] = [
  { to: "/", label: "Dashboard" },
  { to: "/ask", label: "Ask" },
];

// Prompts and Test suites used to be their own "Tuning" group here — moved
// onto the agent detail page as tabs instead: a prompt belongs to one agent
// and one phase, so listing it at top level forced every screen to open with
// "which agent?". The "Tuning" label went with them rather than being left
// behind empty.
const buildItems: RailItem[] = [
  { to: "/agents", label: "Agents" },
  { to: "/orchestrators", label: "Orchestrators" },
];

const connectionItems: RailItem[] = [
  { to: "/databases", label: "Databases" },
  { to: "/documents", label: "Knowledge" },
  { to: "/channels", label: "Channels" },
  // The last Connections surface that was planned and never built — see
  // McpServersRoute.tsx's own docstring for why (Saurabh's own "where can
  // i see mcp server list?").
  { to: "/mcp-servers", label: "MCP servers" },
  { to: "/models", label: "Models" },
];

const adminItems: RailItem[] = [
  { to: "/artifacts", label: "Artifacts" },
  // A read-only record of every program an agent ran, with its source and
  // output. Admin rather than Connections: it answers "what ran under whose
  // scope", which is the same question Audit answers.
  { to: "/code-executions", label: "Code runs" },
  { to: "/audit", label: "Audit" },
  { to: "/settings", label: "Settings" },
];

function RailLink({ to, label }: RailItem) {
  const Icon = NAV_ICONS[to];
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) => `${styles.link} ${isActive ? styles.on : ""}`}
    >
      {Icon !== undefined && <Icon className={styles.glyph} size={16} aria-hidden="true" />}
      {label}
    </NavLink>
  );
}

const GROUPS: { label: string; items: RailItem[] }[] = [
  { label: "Work", items: workItems },
  { label: "Build", items: buildItems },
  { label: "Connections", items: connectionItems },
  { label: "Admin", items: adminItems },
];

export function Rail() {
  return (
    <nav className={styles.rail} aria-label="Console sections">
      {GROUPS.map((group) => (
        <div key={group.label} className={styles.group}>
          <div className={styles.label}>{group.label}</div>
          {group.items.map((item) => (
            <RailLink key={item.to} {...item} />
          ))}
        </div>
      ))}
    </nav>
  );
}
