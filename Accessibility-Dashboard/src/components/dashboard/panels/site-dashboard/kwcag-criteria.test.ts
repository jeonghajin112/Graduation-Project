import { describe, expect, it } from "vitest";

import type { AnalyzerType } from "@/types/accessibility-domain";

import { severityChartItems } from "./constants";
import { buildCriteriaOverview, KWCAG_PRINCIPLES } from "./kwcag-criteria";
import type { RecentIssueRow } from "./types";

function row(id: number, issueCode: string, analyzerType: AnalyzerType = "RULE_BASED"): RecentIssueRow {
  return {
    severity: severityChartItems[1]!,
    analyzerType,
    issue: {
      id, analysisResultId: 1, issueCode, issueTitle: "", ruleId: null, severity: "HIGH", locationPath: "",
      message: "", recommendation: null, resolved: false, createdAt: "", updatedAt: ""
    }
  };
}

const all = new Set<AnalyzerType>(["RULE_BASED", "AI_TEXT", "CV_VISION"]);
const status = (overview: ReturnType<typeof buildCriteriaOverview>, code: string) =>
  overview.principles.flatMap((principle) => principle.criteria).find((criterion) => criterion.code === code);

describe("KWCAG criteria overview", () => {
  it("lists the 33 criteria once", () => {
    const codes = KWCAG_PRINCIPLES.flatMap((principle) => principle.criteria.map(({ code }) => code));
    expect(codes).toHaveLength(33);
    expect(new Set(codes).size).toBe(33);
  });

  it("marks found issues, checked criteria and criteria no engine checks", () => {
    const overview = buildCriteriaOverview([row(1, "5.1.1"), row(2, "5.1.1"), row(3, "KWCAG 6.4.3", "AI_TEXT")], all);
    expect(status(overview, "5.1.1")).toMatchObject({ status: "fail", count: 2 });
    expect(status(overview, "6.4.3")).toMatchObject({ status: "fail", count: 1 });
    expect(status(overview, "7.1.1")?.status).toBe("pass");
    expect(status(overview, "6.1.2")?.status).toBe("manual");
    expect(overview.counts).toEqual({ fail: 2, pass: 19, skipped: 0, manual: 12 });
  });

  it("treats a legacy issue code as its criterion", () => {
    expect(status(buildCriteriaOverview([row(1, "img-alt")], all), "5.1.1")?.status).toBe("fail");
  });

  it("reports criteria only a failed engine checks as not checked", () => {
    const overview = buildCriteriaOverview([], new Set<AnalyzerType>(["RULE_BASED"]));
    // Only the text engine checks 5.3.3; the rule engine also covers 5.4.3.
    expect(status(overview, "5.3.3")?.status).toBe("skipped");
    expect(status(overview, "5.4.3")?.status).toBe("pass");
    expect(status(overview, "6.4.2")?.status).toBe("pass");
  });

  it("keeps codes outside the 33 criteria apart", () => {
    const overview = buildCriteriaOverview([row(1, "WCAG 3.1.5", "AI_TEXT"), row(2, "WCAG 3.1.5", "AI_TEXT"), row(3, "meta-viewport")], all);
    expect(overview.others).toEqual([{ code: "WCAG 3.1.5", count: 2 }, { code: "meta-viewport", count: 1 }]);
    expect(overview.counts.fail).toBe(0);
  });
});
