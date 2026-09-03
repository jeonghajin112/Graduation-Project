import assert from "node:assert/strict";

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
  const journal = [];
  const unexpectedRequests = [];

  await page.route("**/api/**", async (route) => {
    const browserRequest = route.request();
    const requestUrl = new URL(browserRequest.url());
    const pathname = requestUrl.pathname;
    const method = browserRequest.method();
    journal.push({ method, pathname, search: requestUrl.search });

    if (method === "GET" && pathname === "/api/dashboard/overview") {
      await fulfillJson(route, overview);
      return;
    }

    if (method === "GET" && pathname === `/api/results/requests/${request.id}/issues`) {
      await fulfillJson(route, []);
      return;
    }

    if (method === "GET" && pathname === `/api/results/requests/${request.id}/capture-metadata`) {
      await fulfillJson(route, captureMetadata);
      return;
    }

    if (method === "POST" && pathname === `/api/results/requests/${request.id}/live-session`) {
      await fulfillJson(route, null);
      return;
    }

    const requestLabel = `${method} ${pathname}${requestUrl.search}`;
    unexpectedRequests.push(requestLabel);
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ success: false, data: null, message: `Unexpected fixture request: ${requestLabel}` })
    });
  });

  return {
    journal,
    captureMetadata,
    organization,
    overview,
    request,
    score,
    summary,
    target,
    countRequests({ method, pathname }) {
      return journal.filter(
        (entry) =>
          (method === undefined || entry.method === method) &&
          (pathname === undefined || entry.pathname === pathname)
      ).length;
    },
    assertIsolated() {
      assert.deepEqual(unexpectedRequests, [], "The dashboard fixture received an undeclared API request");
    }
  };
}
