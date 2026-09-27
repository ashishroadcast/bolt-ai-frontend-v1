import {
  Boxes,
  Cable,
  Database,
  FileText,
  FlaskConical,
  FolderDown,
  LayoutDashboard,
  MessageSquareText,
  Plug,
  ScrollText,
  Settings,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { AgentIcon } from "../ask/AgentIcon.tsx";

/**
 * The nav-item -> icon mapping for `Rail.tsx`, kept here rather than
 * inline in that file: the redesign brief has this task install
 * `lucide-react` and put the icon set in place for every screen, but
 * `Rail.tsx`/`Rail.module.css` are a sibling task's live file (moving
 * Prompts and Test suites into agent-detail tabs) this pass stays out of.
 * Wiring one `<Icon />` per `RailItem` in place of its unicode glyph
 * (`▸ ▤ ◇ ◈ ⚑`) is a small, mechanical follow-up against this map — see
 * this task's own report for the exact call.
 *
 * Keyed by route path (`RailItem.to` in Rail.tsx today) rather than by
 * label, since the path is the stable identity a nav item won't rename
 * out from under.
 */
export const NAV_ICONS: Record<
  string,
  LucideIcon | ComponentType<{ className?: string; size?: number; "aria-hidden"?: boolean | "true" | "false" }>
> = {
  "/": LayoutDashboard,
  "/ask": MessageSquareText,
  "/documents": FileText,
  "/databases": Database,
  "/test-suites": FlaskConical,
  "/prompts": ScrollText,
  "/agents": AgentIcon,
  "/orchestrators": Workflow,
  "/channels": Cable,
  "/mcp-servers": Plug,
  "/models": Boxes,
  "/artifacts": FolderDown,
  "/code-executions": Terminal,
  "/audit": ScrollText,
  "/settings": Settings,
};
