import { ArrowRight, GitFork, type LucideIcon } from "lucide-react";
import type { OrchestratorMode } from "./types.ts";

export interface ModeExplanation {
  /** A real icon, not the unicode glyphs (→ / ⇉) this console shipped
   * with — see the redesign brief's icon-library instruction. */
  icon: LucideIcon;
  label: string;
  /** A sentence derived from the orchestrator's own `mode` and its real
   * member count — never a fixed string per mode. Two `coordinate`
   * orchestrators with different membership read differently, because the
   * count is real data, not a hardcoded card (task brief, "On
   * correctness": "the orchestrator mode difference is rendered from
   * data, not hardcoded per card"). */
  detail: string;
}

/**
 * `single` vs `coordinate` is the one thing about an orchestrator a
 * person must understand (task brief) — so this renders as a glyph plus a
 * sentence, not a bare mode word in a badge. `memberCount` of 0 reads as
 * "no agents assigned yet" rather than "0 agents", since a member-less
 * orchestrator is a configuration gap (the backend refuses to create one
 * with zero members — `_require_member_agents`), not a normal state to
 * describe in the plural.
 */
export function explainOrchestratorMode(mode: OrchestratorMode, memberCount: number): ModeExplanation {
  const agents = memberCount === 0 ? "no agents" : memberCount === 1 ? "1 agent" : `${memberCount} agents`;

  if (mode === "single") {
    return {
      icon: ArrowRight,
      label: "Single",
      detail: memberCount === 0 ? "Routes to no agents" : `Picks one best-fit agent from ${agents}`,
    };
  }

  return {
    icon: GitFork,
    label: "Coordinate",
    detail: memberCount === 0 ? "Runs no agents" : `Runs ${agents} and synthesises one answer`,
  };
}
