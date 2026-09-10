import { installApiRouteFixture } from "./api-route-fixture.mjs";

const timestamp = "2026-08-20T10:00:00.000Z";

function toNestedOrganizations(organizations, evaluationTargets) {
  return organizations.map((organization) => ({
    ...organization,
    evaluationTargets: evaluationTargets.filter(
      (target) => target.organizationId === organization.id
    )
  }));
}

export function createDashboardOverview({
  organizations = [],
  evaluationTargets = [],
  evaluationRequests = [],
  resultSummaries = [],
  scoreResults = [],
  latestIssueCounts = []
} = {}) {
  return {
    organizations: toNestedOrganizations(organizations, evaluationTargets),
    evaluationRequests,
    resultSummaries,
    scoreResults,
    latestIssueCounts
  };
}

export function apiEnvelope(data, message = null) {
  return { success: true, data, message };
}

export async function fulfillJson(route, data, { status = 200, envelope = true } = {}) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(envelope ? apiEnvelope(data) : data)
  });
}

export async function installDashboardApiFixture(page) {
  const organization = {
    id: 1,
    name: "CI Fixture Project",
    type: "ETC",
    homepageUrl: "https://example.com",
    description: "Deterministic frontend test fixture",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const target = {
    id: 101,
    organizationId: organization.id,
    name: "CI Fixture Page",
    targetType: "WEB",
    accessUrl: "https://example.com/fixture",
    faviconUrl: null,
    description: "",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const request = {
    id: 501,
    evaluationTargetId: target.id,
    targetName: target.name,
    status: "COMPLETED",
    requestNote: "Deterministic frontend test fixture",
    requestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const summary = {
    requestId: request.id,
    targetName: target.name,
    status: request.status,
    totalScore: 100,
    totalIssueCount: 0,
    criticalIssueCount: 0,
    requestedAt: timestamp
  };
  const score = {
    id: 1,
    evaluationRequestId: request.id,
    totalScore: 100,
    ruleScore: 100,
    aiScore: 100,
    cvScore: 100,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const captureMetadata = {
    id: 701,
    requestId: request.id,
    requestedUrl: target.accessUrl,
    finalUrl: target.accessUrl,
    capturedAt: timestamp,
    viewportWidthCssPx: 1280,
    viewportHeightCssPx: 720,
    deviceScaleFactor: 1,
    pageWidthCssPx: 1280,
    pageHeightCssPx: 1440
  };
  const overview = createDashboardOverview({
    organizations: [organization],
    evaluationTargets: [target],
    evaluationRequests: [request],
    resultSummaries: [summary],
    scoreResults: [score]
  });
  const routing = await installApiRouteFixture(page, [
    { method: "GET", pathname: "/api/dashboard/overview", handle: (route) => fulfillJson(route, overview) },
    { method: "GET", pathname: `/api/results/requests/${request.id}/issues`, handle: (route) => fulfillJson(route, []) },
    { method: "GET", pathname: `/api/results/requests/${request.id}/capture-metadata`, handle: (route) => fulfillJson(route, captureMetadata) },
    { method: "POST", pathname: `/api/results/requests/${request.id}/live-session`, handle: (route) => fulfillJson(route, null) }
  ]);

  return {
    ...routing,
    captureMetadata,
    organization,
    overview,
    request,
    score,
    summary,
    target
  };
}
