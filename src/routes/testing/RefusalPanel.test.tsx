import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RefusalPanel } from "./RefusalPanel.tsx";
import type { RegressedCaseDetail } from "./types.ts";

// Real reason strings, copied verbatim from
// agent-service/app/learning/gate.py's own construction — see
// refusal.test.ts for the same fixtures used against the classifier
// directly. This file proves the *rendering*: four different headings,
// not one "Promotion blocked" for all of them (task brief, verbatim).
const EMPTY_SUITE_REASON =
  "no active test cases for agent 3 ('analytics') phase 'execute' — nothing to evaluate, refusing rather than allowing by default";
const THIN_SUITE_REASON =
  "only 3 active test case(s) for agent 3 ('analytics') phase 'execute' — below the minimum of 5, refusing rather than trusting a verdict too small to average out judge noise or catch a single fabrication (see the module docstring)";
const JUDGE_BROKEN_REASON =
  "baseline suite for phase 'execute' produced no usable signal (6 case(s), all errored) — refusing rather than treating an unusable baseline as evidence of no regression";
const REGRESSED_REASON = "2 case(s) regressed: 14, 22";
const REGRESSED_CASES: RegressedCaseDetail[] = [
  { test_case_id: 14, question: "top items last week", baseline_verdict: "pass", candidate_verdict: "fail", candidate_error: null },
  { test_case_id: 22, question: "discount spike at Bandra", baseline_verdict: "pass", candidate_verdict: "fail", candidate_error: null },
];

describe("RefusalPanel", () => {
  it("renders a suite with zero cases as its own distinct state", () => {
    render(<RefusalPanel reason={EMPTY_SUITE_REASON} regressedCases={[]} />);
    expect(screen.getByText("No cases to evaluate")).toBeInTheDocument();
    expect(screen.getByText(EMPTY_SUITE_REASON)).toBeInTheDocument();
  });

  it("renders a suite below the 5-case floor as its own distinct state", () => {
    render(<RefusalPanel reason={THIN_SUITE_REASON} regressedCases={[]} />);
    expect(screen.getByText("Write more test cases")).toBeInTheDocument();
    expect(screen.getByText(THIN_SUITE_REASON)).toBeInTheDocument();
  });

  it("renders an all-errored baseline as 'your judge is broken', not a generic block", () => {
    render(<RefusalPanel reason={JUDGE_BROKEN_REASON} regressedCases={[]} />);
    expect(screen.getByText("Your judge is broken")).toBeInTheDocument();
    expect(screen.getByText(JUDGE_BROKEN_REASON)).toBeInTheDocument();
  });

  it("renders a real regression as 'this candidate is worse', naming the regressed cases", () => {
    render(<RefusalPanel reason={REGRESSED_REASON} regressedCases={REGRESSED_CASES} />);
    expect(screen.getByText("This candidate is worse")).toBeInTheDocument();
    expect(screen.getByText("top items last week")).toBeInTheDocument();
    expect(screen.getByText("discount spike at Bandra")).toBeInTheDocument();
  });

  // The correctness bar this whole component exists to clear: four
  // genuinely different headings, not the same "Promotion blocked" copy
  // wearing four different reason strings underneath it.
  it("gives all four refusal reasons a different heading from one another", () => {
    const headings = [
      { reason: EMPTY_SUITE_REASON, cases: [] },
      { reason: THIN_SUITE_REASON, cases: [] },
      { reason: JUDGE_BROKEN_REASON, cases: [] },
      { reason: REGRESSED_REASON, cases: REGRESSED_CASES },
    ].map(({ reason, cases }) => {
      const { container, unmount } = render(<RefusalPanel reason={reason} regressedCases={cases} />);
      const heading = container.querySelector("p")?.textContent;
      unmount();
      return heading;
    });

    expect(new Set(headings).size).toBe(4);
  });

  it("offers an override action that a caller can wire up, for a real refusal", () => {
    let overrideClicked = false;
    render(
      <RefusalPanel
        reason={REGRESSED_REASON}
        regressedCases={REGRESSED_CASES}
        onOverride={() => {
          overrideClicked = true;
        }}
      />,
    );

    screen.getByRole("button", { name: /override and promote anyway/i }).click();
    expect(overrideClicked).toBe(true);
  });

  it("renders no override control at all when the caller doesn't offer one", () => {
    render(<RefusalPanel reason={REGRESSED_REASON} regressedCases={REGRESSED_CASES} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
