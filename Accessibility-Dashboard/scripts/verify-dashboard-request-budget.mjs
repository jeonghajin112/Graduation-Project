/**
 * Regression check for the dashboard overview boundary.
 *
 * A large directory must still bootstrap through one aggregate endpoint. Full
 * issue bodies are loaded only after the user opens the selected page, and the
 * latest completed request is chosen by updatedAt with id as the tie-breaker.
 *
 * Usage: npm test
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  createDashboardOverview,
  fulfillJson
} from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();

async function waitForJournal(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!journal.some(predicate)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for API journal entry: ${JSON.stringify(journal)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const timestamp = "2026-08-20T10:00:00.000Z";
const tiedUpdatedAt = "2026-08-20T12:00:00.000Z";
const organizations = [];
const evaluationTargets = [];
const evaluationRequests = [];
const resultSummaries = [];
const scoreResults = [];
const latestIssueCounts = [];

for (let organizationIndex = 0; organizationIndex < 10; organizationIndex += 1) {
  const organizationId = organizationIndex + 1;
  organizations.push({
    id: organizationId,
    name: organizationId === 1 ? "Request Budget Project" : `Scale Project ${organizationId}`,
    type: "ETC",
    homepageUrl: `https://project-${organizationId}.example.com`,
    description: "Large deterministic overview fixture",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: tiedUpdatedAt
  });

  for (let targetIndex = 0; targetIndex < 3; targetIndex += 1) {
    const targetId = organizationId * 100 + targetIndex + 1;
    const targetName = targetId === 101 ? "Request Budget Page" : `Scale Page ${targetId}`;
    evaluationTargets.push({
      id: targetId,
      organizationId,
      name: targetName,
      targetType: "WEB",
      accessUrl: `https://page-${targetId}.example.com`,
      faviconUrl: null,
      description: "",
      status: "ACTIVE",
      createdAt: timestamp,
      updatedAt: tiedUpdatedAt
    });

    const olderRequestId = targetId * 10 + 1;
    const latestRequestId = targetId * 10 + 2;
    for (const [requestId, requestedAt] of [
      [latestRequestId, "2026-08-20T10:00:00.000Z"],
      [olderRequestId, "2026-08-22T10:00:00.000Z"]
    ]) {
      evaluationRequests.push({
        id: requestId,
        evaluationTargetId: targetId,
        targetName,
        faviconUrl: null,
        status: "COMPLETED",
        requestNote: "Request budget fixture",
        requestedAt,
        createdAt: timestamp,
        updatedAt: tiedUpdatedAt
      });
      resultSummaries.push({
        requestId,
        targetName,
        status: "COMPLETED",
        totalScore: requestId === latestRequestId ? 91 : 87,
        totalIssueCount: requestId === latestRequestId ? 3 : 5,
        criticalIssueCount: requestId === latestRequestId ? 1 : 2,
        requestedAt
      });
      scoreResults.push({
        id: requestId,
        evaluationRequestId: requestId,
        totalScore: requestId === latestRequestId ? 91 : 87,
        ruleScore: 90,
        aiScore: 92,
        cvScore: 91,
        createdAt: timestamp,
        updatedAt: tiedUpdatedAt
      });
    }

    latestIssueCounts.push({
      evaluationTargetId: targetId,
      requestId: latestRequestId,
      totalIssueCount: 3,
      criticalIssueCount: 1,
      highIssueCount: 1,
      mediumIssueCount: 1,
      lowIssueCount: 0,
      groups: [
        {
          issueCode: "KWCAG-1.1.1",
          issueTitle: "대체 텍스트 누락",
          severity: "CRITICAL",
          count: 1
        },
        {
          issueCode: "KWCAG-1.4.3",
          issueTitle: "명도 대비 부족",
          severity: "HIGH",
          count: 1
        },
        {
          issueCode: "KWCAG-2.4.6",
          issueTitle: "제목 구조 오류",
          severity: "MEDIUM",
          count: 1
        }
      ]
    });
  }
}

const selectedOrganization = organizations[0];
const selectedTarget = evaluationTargets.find((target) => target.id === 101);
const selectedOlderRequestId = 1011;
const selectedLatestRequestId = 1012;
assert.ok(selectedOrganization);
assert.ok(selectedTarget);

const overview = createDashboardOverview({
  organizations,
  evaluationTargets,
  evaluationRequests,
  resultSummaries,
  scoreResults,
  latestIssueCounts
});
const selectedIssues = [
  {
    id: 9001,
    requestId: selectedLatestRequestId,
    module: "rule_based",
    severity: "CRITICAL",
    title: "Request budget lazy issue",
    description: "This full issue body must not be requested during bootstrap.",
    recommendation: "Add an accessible text alternative.",
    selector: "img.hero",
    locator: null,
    wcagCode: "KWCAG-1.1.1",
    createdAt: tiedUpdatedAt
  }
];
const journal = [];
const unexpectedRequests = [];
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route("**/api/**", async (route) => {
    const browserRequest = route.request();
    const url = new URL(browserRequest.url());
    const entry = { method: browserRequest.method(), pathname: url.pathname, search: url.search };
    journal.push(entry);

    if (entry.method === "GET" && entry.pathname === "/api/dashboard/overview") {
      await fulfillJson(route, overview);
      return;
    }

    if (
      entry.method === "GET" &&
      entry.pathname === `/api/results/requests/${selectedLatestRequestId}/issues`
    ) {
      await fulfillJson(route, selectedIssues);
      return;
    }

    if (
      entry.method === "GET" &&
      entry.pathname === `/api/results/requests/${selectedLatestRequestId}/artifact`
    ) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ success: false, data: null, message: "No artifact in request budget fixture." })
      });
      return;
    }

    if (entry.method === "GET" && entry.pathname === `/api/targets/${selectedTarget.id}`) {
      await fulfillJson(route, selectedTarget);
      return;
    }

    unexpectedRequests.push(`${entry.method} ${entry.pathname}${entry.search}`);
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        data: null,
        message: `Unexpected request budget API call: ${entry.method} ${entry.pathname}${entry.search}`
      })
    });
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
  const sidebar = page.getByRole("complementary");
  const main = page.getByRole("main");
  await sidebar.getByRole("button", { name: "새 페이지 분석", exact: true }).waitFor();
  await sidebar.getByRole("button", { name: selectedOrganization.name, exact: true }).waitFor();

  const bootstrapJournal = [...journal];
  const bootstrapOverviewCount = bootstrapJournal.filter(
    (entry) => entry.method === "GET" && entry.pathname === "/api/dashboard/overview"
  ).length;
  assert.ok(bootstrapOverviewCount >= 1 && bootstrapOverviewCount <= 2);
  assert.deepEqual(
    bootstrapJournal.filter((entry) => entry.method === "GET").map((entry) => entry.pathname),
    Array.from({ length: bootstrapOverviewCount }, () => "/api/dashboard/overview"),
    "dashboard bootstrap must use only the aggregate overview endpoint"
  );
  assert.equal(
    bootstrapJournal.filter((entry) => entry.pathname.endsWith("/issues")).length,
    0,
    "full issues must stay lazy before a page detail is opened"
  );

  await sidebar.getByRole("button", { name: selectedOrganization.name, exact: true }).click();
  await page.waitForURL(`**/projects/${selectedOrganization.id}`);
  const openPageButton = main.getByRole("button", {
    name: `${selectedTarget.name} 상세 보기`,
    exact: true
  });
  await openPageButton.waitFor();
  await openPageButton.click({ position: { x: 12, y: 12 } });
  await page.waitForURL(`**/projects/${selectedOrganization.id}/pages/${selectedTarget.id}`);
  await waitForJournal(
    (entry) =>
      entry.method === "GET" &&
      entry.pathname === `/api/results/requests/${selectedLatestRequestId}/issues`
  );
  await main
    .getByText("이 스캔에는 재현 페이지가 없어요", { exact: true })
    .waitFor({ state: "visible" });

  await page.evaluate((projectId) => {
    history.pushState({}, "", `/projects/${projectId}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, selectedOrganization.id);
  await page.waitForURL(`**/projects/${selectedOrganization.id}`);
  await openPageButton.waitFor({ state: "visible" });
  await openPageButton.click({ position: { x: 12, y: 12 } });
  await page.waitForURL(`**/projects/${selectedOrganization.id}/pages/${selectedTarget.id}`);
  await main
    .getByText("이 스캔에는 재현 페이지가 없어요", { exact: true })
    .waitFor({ state: "visible" });

  const finalOverviewCount = journal.filter(
    (entry) => entry.method === "GET" && entry.pathname === "/api/dashboard/overview"
  ).length;
  const issueRequestPaths = journal
    .filter((entry) => entry.method === "GET" && entry.pathname.endsWith("/issues"))
    .map((entry) => entry.pathname);
  const artifactRequestPaths = journal
    .filter((entry) => entry.method === "GET" && entry.pathname.endsWith("/artifact"))
    .map((entry) => entry.pathname);
  assert.equal(
    finalOverviewCount,
    bootstrapOverviewCount,
    "opening a page detail must not refetch the dashboard overview"
  );
  assert.deepEqual(issueRequestPaths, [
    `/api/results/requests/${selectedLatestRequestId}/issues`
  ], "a recent completed-detail cache entry must avoid refetching issues on re-entry");
  assert.deepEqual(artifactRequestPaths, [
    `/api/results/requests/${selectedLatestRequestId}/artifact`
  ], "an old request must use one immediate artifact lookup and reuse the fresh empty cache");
  assert.equal(
    issueRequestPaths.includes(`/api/results/requests/${selectedOlderRequestId}/issues`),
    false,
    "the requestedAt value must not override the updatedAt/id latest-result contract"
  );
  assert.deepEqual(unexpectedRequests, []);

  const forbiddenFanOut = journal.filter(
    (entry) =>
      entry.method === "GET" &&
      (entry.pathname === "/api/organizations" ||
        entry.pathname === "/api/requests" ||
        /^\/api\/organizations\/\d+\/evaluation-targets$/.test(entry.pathname) ||
        /^\/api\/results\/requests\/\d+\/summary$/.test(entry.pathname) ||
        /^\/api\/scores\/requests\/\d+$/.test(entry.pathname))
  );
  assert.deepEqual(forbiddenFanOut, []);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        organizationCount: organizations.length,
        targetCount: evaluationTargets.length,
        completedRequestCount: evaluationRequests.length,
        bootstrapOverviewCount,
        detailIssueRequestCount: issueRequestPaths.length,
        artifactRequestCount: artifactRequestPaths.length,
        selectedLatestRequestId,
        additionalOverviewCount: finalOverviewCount - bootstrapOverviewCount,
        forbiddenFanOutCount: forbiddenFanOut.length
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
