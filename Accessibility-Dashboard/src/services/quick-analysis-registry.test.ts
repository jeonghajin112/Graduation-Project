import { describe, expect, it } from "vitest";

import type { EvaluationRequestModel, OrganizationModel } from "@/types/accessibility-domain";

import { buildRecentAnalyzedPages } from "./quick-analysis-registry";

function project(id: number, pageIds: number[], systemManaged = false): OrganizationModel {
  return {
    id, name: `프로젝트 ${id}`, systemManaged,
    evaluationTargets: pageIds.map((pageId) => ({ id: pageId, name: `페이지 ${pageId}` }))
  } as unknown as OrganizationModel;
}

function request(id: number, pageId: number, requestedAt: string, quickAnalysis = true): EvaluationRequestModel {
  return { id, evaluationTargetId: pageId, requestedAt, quickAnalysis } as unknown as EvaluationRequestModel;
}

const at = (minute: number) => Date.parse(`2026-10-07T10:${String(minute).padStart(2, "0")}:00Z`);

describe("recent analyzed pages", () => {
  const organizations = [project(1, [11, 12]), project(2, [21, 22, 23], true)];

  it("lists each page once at its latest analysis, newest first", () => {
    const pages = buildRecentAnalyzedPages({
      organizations,
      quickAnalysisResults: [
        { projectId: 1, pageId: 11, timestamp: at(1) },
        { projectId: 1, pageId: 11, timestamp: at(5) },
        { projectId: 2, pageId: 21, timestamp: at(3) }
      ]
    });
    expect(pages.map((page) => [page.pageId, page.sortTimestamp])).toEqual([[11, at(5)], [21, at(3)]]);
    expect(pages[1]).toMatchObject({ pageName: "페이지 21", projectId: 2, projectName: "프로젝트 2", systemManaged: true });
  });

  it("adds quick-analysis receipts from the server and ignores other requests", () => {
    const pages = buildRecentAnalyzedPages({
      organizations,
      quickAnalysisResults: [{ projectId: 1, pageId: 12, timestamp: at(2) }],
      evaluationRequests: [
        request(1, 22, "2026-10-07T10:04:00Z"),
        request(2, 23, "2026-10-07T10:09:00Z", false),
        request(3, 12, "2026-10-07T10:06:00Z"),
        request(4, 99, "2026-10-07T10:08:00Z"),
        request(5, 21, "not a date")
      ]
    });
    expect(pages.map((page) => [page.pageId, page.projectId, page.sortTimestamp])).toEqual([
      [12, 1, at(6)], [22, 2, at(4)]
    ]);
  });

  it("drops records whose project or page no longer exists", () => {
    const pages = buildRecentAnalyzedPages({
      organizations,
      quickAnalysisResults: [
        { projectId: 9, pageId: 11, timestamp: at(7) },
        { projectId: 1, pageId: 21, timestamp: at(7) },
        { projectId: 2, pageId: 23, timestamp: at(1) }
      ]
    });
    expect(pages.map((page) => page.pageId)).toEqual([23]);
  });

  it("breaks ties by page id and honours the limit", () => {
    const quickAnalysisResults = [22, 11, 23, 12, 21].map((pageId) => ({
      projectId: pageId > 20 ? 2 : 1, pageId, timestamp: at(1)
    }));
    expect(buildRecentAnalyzedPages({ organizations, quickAnalysisResults }).map((page) => page.pageId))
      .toEqual([11, 12, 21, 22, 23]);
    expect(buildRecentAnalyzedPages({ organizations, quickAnalysisResults, limit: 2 }).map((page) => page.pageId))
      .toEqual([11, 12]);
    // A non-positive or fractional limit falls back to the default of five.
    expect(buildRecentAnalyzedPages({ organizations, quickAnalysisResults, limit: 0 })).toHaveLength(5);
  });
});
