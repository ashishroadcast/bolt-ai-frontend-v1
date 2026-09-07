import { describe, expect, it } from "vitest";
import { explainOrchestratorMode } from "./orchestratorMode.ts";

describe("explainOrchestratorMode", () => {
  it("reads differently for single vs coordinate at the same member count", () => {
    const single = explainOrchestratorMode("single", 3);
    const coordinate = explainOrchestratorMode("coordinate", 3);

    expect(single.detail).not.toBe(coordinate.detail);
    expect(single.detail).toContain("Picks one");
    expect(coordinate.detail).toContain("Runs 3 agents");
  });

  it("derives the count from real data, not a fixed string per card", () => {
    const twoMembers = explainOrchestratorMode("coordinate", 2);
    const fourMembers = explainOrchestratorMode("coordinate", 4);

    expect(twoMembers.detail).toContain("2 agents");
    expect(fourMembers.detail).toContain("4 agents");
    expect(twoMembers.detail).not.toBe(fourMembers.detail);
  });

  it("singularises one member instead of reading '1 agents'", () => {
    expect(explainOrchestratorMode("single", 1).detail).toContain("1 agent");
    expect(explainOrchestratorMode("single", 1).detail).not.toContain("1 agents");
  });

  it("names a member-less orchestrator as a gap, not a plural of zero", () => {
    expect(explainOrchestratorMode("single", 0).detail).not.toContain("0 agents");
    expect(explainOrchestratorMode("coordinate", 0).detail).not.toContain("0 agents");
  });
});
