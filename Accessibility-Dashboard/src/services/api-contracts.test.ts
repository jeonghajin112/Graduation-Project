import { describe, expect, it } from "vitest";

import {
  ApiContractValidationError,
  createEvaluationArtifactParser,
  parseDashboardOverviewResponse
} from "./api-contracts";

const validDate = "2024-02-29T23:59:59+18:00";

function createValidOverview(date = validDate) {
  return {
    organizations: [{
      id: 1,
      name: "계약 테스트 조직",
      type: "ETC",
      homepageUrl: null,
      description: "",
      status: "ACTIVE",
      createdAt: date,
      updatedAt: date,
      evaluationTargets: [{
        id: 101,
        organizationId: 1,
        name: "계약 테스트 페이지",
        targetType: "WEB",
        accessUrl: "https://example.com/contract",
        faviconUrl: null,
        description: "",
        status: "ACTIVE",
        createdAt: date,
        updatedAt: date
      }]
    }],
    evaluationRequests: [{
      id: 501,
      evaluationTargetId: 101,
      targetName: "계약 테스트 페이지",
      faviconUrl: null,
      status: "COMPLETED",
      requestNote: "contract test",
      requestedAt: date,
      createdAt: date,
      updatedAt: date
    }],
    resultSummaries: [{
      requestId: 501,
      targetName: "계약 테스트 페이지",
      status: "COMPLETED",
      totalScore: 91,
      totalIssueCount: 3,
      criticalIssueCount: 1,
      requestedAt: date
    }],
    scoreResults: [{
      id: 601,
      evaluationRequestId: 501,
      totalScore: 91,
      ruleScore: 90,
      aiScore: 92,
      cvScore: 91,
      createdAt: date,
      updatedAt: date
    }],
    latestIssueCounts: [{
      evaluationTargetId: 101,
      requestId: 501,
      totalIssueCount: 3,
      criticalIssueCount: 1,
      highIssueCount: 2,
      mediumIssueCount: 0,
      lowIssueCount: 0,
      groups: [
        { issueCode: "image-alt", issueTitle: "대체 텍스트", severity: "CRITICAL", count: 1 },
        { issueCode: "contrast", issueTitle: "명도 대비", severity: "HIGH", count: 2 }
      ]
    }]
  };
}

function expectContractError(run: () => unknown, fieldPath: string): void {
  try {
    run();
    throw new Error("expected the contract parser to reject the fixture");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiContractValidationError);
    expect((error as ApiContractValidationError).fieldPath).toBe(fieldPath);
  }
}

function createArtifact(contentUrl: string) {
  return {
    id: 701,
    requestId: 501,
    requestedUrl: "https://example.com/requested",
    finalUrl: "https://example.com/final",
    capturedAt: validDate,
    viewportWidthCssPx: 1280,
    viewportHeightCssPx: 720,
    deviceScaleFactor: 1,
    pageWidthCssPx: 1280,
    pageHeightCssPx: 1440,
    captureMode: "DOM_REPLAY",
    contentUrl,
    contentType: "text/html",
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    createdAt: validDate,
    updatedAt: validDate
  };
}

describe("parseDashboardOverviewResponse", () => {
  it("accepts leap-day timestamps and the maximum legal UTC offset", () => {
    const parsed = parseDashboardOverviewResponse(createValidOverview(), "$.data");
    expect(parsed.organizations[0]?.createdAt).toBe(validDate);
  });

  it.each([
    ["2023-02-29T12:00:00Z", "$.data.organizations[0].createdAt"],
    ["2024-02-29T12:00:00+18:01", "$.data.organizations[0].createdAt"]
  ])("rejects impossible calendar values: %s", (date, fieldPath) => {
    expectContractError(
      () => parseDashboardOverviewResponse(createValidOverview(date), "$.data"),
      fieldPath
    );
  });

  it("rejects a critical summary count larger than the total", () => {
    const overview = createValidOverview();
    overview.resultSummaries[0]!.criticalIssueCount = 4;
    expectContractError(
      () => parseDashboardOverviewResponse(overview, "$.data"),
      "$.data.resultSummaries[0].criticalIssueCount"
    );
  });

  it("rejects severity totals that disagree with issue groups", () => {
    const overview = createValidOverview();
    overview.latestIssueCounts[0]!.highIssueCount = 1;
    expectContractError(
      () => parseDashboardOverviewResponse(overview, "$.data"),
      "$.data.latestIssueCounts[0].highIssueCount"
    );
  });

  it("rejects requests that reference a target outside the organization tree", () => {
    const overview = createValidOverview();
    overview.evaluationRequests[0]!.evaluationTargetId = 999;
    expectContractError(
      () => parseDashboardOverviewResponse(overview, "$.data"),
      "$.data.evaluationRequests[0].evaluationTargetId"
    );
  });
});

describe("createEvaluationArtifactParser", () => {
  const parseArtifact = createEvaluationArtifactParser(501);

  it.each([
    "/results/artifacts/701/content",
    "/api/results/artifacts/701/content"
  ])("accepts the supported artifact content path: %s", (contentUrl) => {
    expect(parseArtifact(createArtifact(contentUrl), "$.data").contentUrl).toBe(contentUrl);
  });

  it("rejects external or mismatched artifact content URLs", () => {
    expectContractError(
      () => parseArtifact(createArtifact("https://attacker.example/artifact"), "$.data"),
      "$.data.contentUrl"
    );
  });
});
