import { describe, expect, it } from "vitest";

import {
  ApiContractValidationError,
  createEvaluationCaptureMetadataParser,
  createEvaluationIssuesResponseParser,
  createEvaluationTargetResponseParser,
  parseDashboardOverviewResponse,
  parseLiveReportSessionResponse
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

function createCaptureMetadata() {
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
    pageHeightCssPx: 1440
  };
}

function createEvaluationIssue() {
  return {
    id: 801,
    requestId: 501,
    module: "rule_based",
    severity: "SERIOUS",
    title: "링크 이름",
    description: "링크 이름이 목적을 설명하지 않습니다.",
    recommendation: "목적을 드러내는 이름을 제공하세요.",
    selector: "a.more",
    locator: {
      kind: "CSS_SELECTOR",
      pathSteps: [{ context: "DOCUMENT", selector: "a.more", frameUrl: null }],
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      coordinateSpace: "CSS_PIXEL",
      visible: true,
      htmlSnippet: "<a class=\"more\">더 보기</a>",
      carouselContext: {
        carouselId: 2,
        slideIndex: 1,
        slideCount: 4
      }
    },
    wcagCode: "KWCAG-2.4.4",
    createdAt: validDate
  };
}

describe("parseDashboardOverviewResponse", () => {
  it("keeps the fields used by the dashboard and recovery guard", () => {
    const parsed = parseDashboardOverviewResponse(createValidOverview(), "$.data");
    expect(parsed.organizations[0]?.updatedAt).toBe(validDate);
    expect(parsed.resultSummaries[0]).toEqual({
      requestId: 501,
      totalScore: 91,
      totalIssueCount: 3,
      requestedAt: validDate
    });
    expect(parsed.scoreResults[0]).toEqual({
      id: 601,
      evaluationRequestId: 501,
      totalScore: 91
    });
    expect(parsed.latestIssueCounts[0]).toEqual({
      evaluationTargetId: 101,
      requestId: 501
    });
  });

  it.each([
    ["2023-02-29T12:00:00Z", "$.data.organizations[0].updatedAt"],
    ["2024-02-29T12:00:00+18:01", "$.data.organizations[0].updatedAt"]
  ])("rejects impossible calendar values: %s", (date, fieldPath) => {
    expectContractError(
      () => parseDashboardOverviewResponse(createValidOverview(date), "$.data"),
      fieldPath
    );
  });

  it.each<[
    string,
    (overview: ReturnType<typeof createValidOverview>) => void,
    string
  ]>([
    [
      "non-positive organization IDs",
      (overview) => { overview.organizations[0]!.id = 0; },
      "$.data.organizations[0].id"
    ],
    [
      "unknown request statuses",
      (overview) => { overview.evaluationRequests[0]!.status = "RUNNING"; },
      "$.data.evaluationRequests[0].status"
    ],
    [
      "unknown target types",
      (overview) => { overview.organizations[0]!.evaluationTargets[0]!.targetType = "BROWSER"; },
      "$.data.organizations[0].evaluationTargets[0].targetType"
    ],
    [
      "duplicate organization IDs",
      (overview) => { overview.organizations.push({ ...overview.organizations[0]! }); },
      "$.data.organizations[1].id"
    ],
    [
      "duplicate target IDs",
      (overview) => {
        overview.organizations[0]!.evaluationTargets.push({
          ...overview.organizations[0]!.evaluationTargets[0]!
        });
      },
      "$.data.organizations[*].evaluationTargets[1].id"
    ],
    [
      "targets owned by another organization",
      (overview) => { overview.organizations[0]!.evaluationTargets[0]!.organizationId = 999; },
      "$.data.organizations[0].evaluationTargets[0].organizationId"
    ],
    [
      "duplicate request IDs",
      (overview) => { overview.evaluationRequests.push({ ...overview.evaluationRequests[0]! }); },
      "$.data.evaluationRequests[1].id"
    ],
    [
      "requests for an unknown target",
      (overview) => { overview.evaluationRequests[0]!.evaluationTargetId = 999; },
      "$.data.evaluationRequests[0].evaluationTargetId"
    ],
    [
      "duplicate summaries for one request",
      (overview) => { overview.resultSummaries.push({ ...overview.resultSummaries[0]! }); },
      "$.data.resultSummaries[1].requestId"
    ],
    [
      "summaries for an unknown request",
      (overview) => { overview.resultSummaries[0]!.requestId = 999; },
      "$.data.resultSummaries[0].requestId"
    ],
    [
      "duplicate scores for one request",
      (overview) => { overview.scoreResults.push({ ...overview.scoreResults[0]!, id: 602 }); },
      "$.data.scoreResults[1].evaluationRequestId"
    ],
    [
      "scores for an unknown request",
      (overview) => { overview.scoreResults[0]!.evaluationRequestId = 999; },
      "$.data.scoreResults[0].evaluationRequestId"
    ],
    [
      "duplicate latest issue references for one target",
      (overview) => { overview.latestIssueCounts.push({ ...overview.latestIssueCounts[0]! }); },
      "$.data.latestIssueCounts[1].evaluationTargetId"
    ],
    [
      "latest issue references for an unknown target",
      (overview) => { overview.latestIssueCounts[0]!.evaluationTargetId = 999; },
      "$.data.latestIssueCounts[0].evaluationTargetId"
    ],
    [
      "latest issue references for an unrelated request",
      (overview) => {
        overview.organizations[0]!.evaluationTargets.push({
          ...overview.organizations[0]!.evaluationTargets[0]!,
          id: 102
        });
        overview.evaluationRequests.push({
          ...overview.evaluationRequests[0]!,
          id: 502,
          evaluationTargetId: 102
        });
        overview.latestIssueCounts[0]!.requestId = 502;
      },
      "$.data.latestIssueCounts[0].requestId"
    ]
  ])("rejects %s", (_label, corrupt, fieldPath) => {
    const overview = createValidOverview();
    corrupt(overview);
    expectContractError(
      () => parseDashboardOverviewResponse(overview, "$.data"),
      fieldPath
    );
  });

  it("quarantines unsafe URLs from imported targets", () => {
    const overview = createValidOverview();
    overview.organizations[0]!.evaluationTargets[0]!.accessUrl = "javascript:alert(1)";
    expect(parseDashboardOverviewResponse(overview, "$.data")
      .organizations[0]?.evaluationTargets[0]?.accessUrl).toBe("");
  });

  it("rejects unsafe URLs for freshly created targets", () => {
    const target = {
      ...createValidOverview().organizations[0]!.evaluationTargets[0]!,
      accessUrl: "javascript:alert(1)"
    };
    expectContractError(
      () => createEvaluationTargetResponseParser({ strictAccessUrl: true })(target, "$.data"),
      "$.data.accessUrl"
    );
  });
});

describe("createEvaluationCaptureMetadataParser", () => {
  const parseCaptureMetadata = createEvaluationCaptureMetadataParser(501);

  it("accepts capture geometry without stored HTML fields", () => {
    expect(parseCaptureMetadata(createCaptureMetadata(), "$.data")).toEqual(
      createCaptureMetadata()
    );
  });

  it("rejects metadata owned by another evaluation request", () => {
    expectContractError(
      () => parseCaptureMetadata(
        { ...createCaptureMetadata(), requestId: 999 },
        "$.data"
      ),
      "$.data.requestId"
    );
  });

  it.each([
    [{ deviceScaleFactor: 0 }, "$.data.deviceScaleFactor"],
    [{ deviceScaleFactor: 10.1 }, "$.data.deviceScaleFactor"],
    [{ pageWidthCssPx: 1279 }, "$.data.pageWidthCssPx"],
    [{ pageHeightCssPx: 719 }, "$.data.pageHeightCssPx"],
    [{ requestedUrl: "file:///tmp/capture.html" }, "$.data.requestedUrl"],
    [{ finalUrl: "javascript:alert(1)" }, "$.data.finalUrl"]
  ])("rejects invalid capture geometry or URLs", (override, fieldPath) => {
    expectContractError(
      () => parseCaptureMetadata({ ...createCaptureMetadata(), ...override }, "$.data"),
      fieldPath
    );
  });
});

describe("createEvaluationIssuesResponseParser", () => {
  const parseIssues = createEvaluationIssuesResponseParser(501);

  it("keeps the recorded element evidence as well as the live marker path", () => {
    const parsed = parseIssues([createEvaluationIssue()], "$.data");
    expect(parsed[0]?.locator).toEqual({
      pathSteps: [{ context: "DOCUMENT", selector: "a.more", frameUrl: null }],
      htmlSnippet: '<a class="more">더 보기</a>',
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      coordinateSpace: "CSS_PIXEL",
      carouselContext: {
        carouselId: 2,
        slideIndex: 1,
        slideCount: 4
      }
    });
  });

  it.each([
    [{ x: "10" }, "x"],
    [{ width: Number.POSITIVE_INFINITY }, "width"],
    [{ htmlSnippet: { html: "<img>" } }, "htmlSnippet"]
  ])("rejects malformed recorded element evidence %#", (override, field) => {
    const issue = createEvaluationIssue();
    expectContractError(
      () => parseIssues([{ ...issue, locator: { ...issue.locator, ...override } }], "$.data"),
      `$.data[0].locator.${field}`
    );
  });

  it.each([
    [{ carouselId: 0, slideIndex: 1, slideCount: 4 }, "carouselId"],
    [{ carouselId: 2, slideIndex: -1, slideCount: 4 }, "slideIndex"],
    [{ carouselId: 2, slideIndex: 2, slideCount: 2 }, "slideIndex"],
    [{ carouselId: 2, slideIndex: 0, slideCount: 1 }, "slideCount"],
    [{ carouselId: 2, slideIndex: 0, slideCount: 10_001 }, "slideCount"]
  ])("rejects an invalid carousel locator context %#", (carouselContext, field) => {
    const issue = createEvaluationIssue();
    expectContractError(
      () => parseIssues([{ ...issue, locator: { ...issue.locator, carouselContext } }], "$.data"),
      `$.data[0].locator.carouselContext.${field}`
    );
  });

  it.each([
    [{ requestId: 999 }, "$.data[0].requestId"],
    [{ module: "legacy_engine" }, "$.data[0].module"],
    [{ severity: "HIGH" }, "$.data[0].severity"],
    [{ id: 0 }, "$.data[0].id"]
  ])("rejects invalid issue identity and enums", (override, fieldPath) => {
    expectContractError(
      () => parseIssues([{ ...createEvaluationIssue(), ...override }], "$.data"),
      fieldPath
    );
  });
});

describe("parseLiveReportSessionResponse", () => {
  const validSession = {
    sessionId: "session_501",
    runtimeUrl: "https://viewer.example.test/reports/session_501",
    viewerOrigin: "https://viewer.example.test",
    nonce: "n".repeat(32),
    bridgeSecret: "s".repeat(43),
    expiresAt: validDate
  };

  it("accepts an isolated runtime URL and matching viewer origin", () => {
    expect(parseLiveReportSessionResponse(validSession, "$.data")).toEqual(validSession);
    expect(parseLiveReportSessionResponse(
      { ...validSession, viewerOrigin: "null" },
      "$.data"
    ).viewerOrigin).toBe("null");
  });

  it.each([
    [
      { ...validSession, viewerOrigin: "https://viewer.example.test/path" },
      "$.data.viewerOrigin"
    ],
    [
      { ...validSession, runtimeUrl: "https://attacker.example.test/report" },
      "$.data.runtimeUrl"
    ],
    [{ ...validSession, nonce: "too-short" }, "$.data.nonce"],
    [{ ...validSession, bridgeSecret: "too-short" }, "$.data.bridgeSecret"],
    [{ ...validSession, bridgeSecret: validSession.nonce }, "$.data.bridgeSecret"]
  ])("rejects an unsafe live viewer contract", (session, fieldPath) => {
    expectContractError(
      () => parseLiveReportSessionResponse(session, "$.data"),
      fieldPath
    );
  });
});
