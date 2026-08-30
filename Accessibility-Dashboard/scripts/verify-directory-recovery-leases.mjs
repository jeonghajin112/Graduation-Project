import assert from "node:assert/strict";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-08-24T10:00:00.000Z";
const existingProject = {
  id: 61,
  name: "Nested recovery project",
  type: "ETC",
  homepageUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const unresolvedProject = {
  ...existingProject,
  id: 62,
  name: "Unresolved nested project"
};
const createdTarget = {
  id: 611,
  organizationId: existingProject.id,
  name: "Nested recovery page",
  targetType: "WEB",
  accessUrl: "https://example.com/nested-recovery",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const pendingRequest = {
  id: 612,
  evaluationTargetId: createdTarget.id,
  targetName: createdTarget.name,
  faviconUrl: null,
  status: "PENDING",
  requestNote: "nested recovery lease regression",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};
const completedRequest = {
  ...pendingRequest,
  status: "COMPLETED",
  updatedAt: "2026-08-24T10:00:05.000Z"
};
const resultSummary = {
  requestId: completedRequest.id,
  targetName: createdTarget.name,
  status: "COMPLETED",
  totalScore: 92,
  totalIssueCount: 0,
  criticalIssueCount: 0,
  requestedAt: completedRequest.requestedAt
};
const score = {
  id: 613,
  evaluationRequestId: completedRequest.id,
  totalScore: 92,
  ruleScore: 91,
  aiScore: 93,
  cvScore: 92,
  createdAt: completedRequest.createdAt,
  updatedAt: completedRequest.updatedAt
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const observed = {
  organizationPosts: 0,
  overviewGets: 0,
  protectedEmptyGets: 0,
  requestPosts: 0,
  requestStatusGets: 0,
  targetPosts: 0,
  unknownRequests: []
};
let targets = [];
let requests = [];
let requestCompleted = false;
let returnIncompleteOverview = false;

function currentOverview() {
  if (returnIncompleteOverview) {
    return createDashboardOverview();
  }
  return createDashboardOverview({
    organizations: [existingProject],
    evaluationTargets: targets,
    evaluationRequests: requests,
    resultSummaries: requestCompleted ? [resultSummary] : [],
    scoreResults: requestCompleted ? [score] : [],
    latestIssueCounts: requestCompleted
      ? [{
          evaluationTargetId: createdTarget.id,
          requestId: completedRequest.id,
          totalIssueCount: 0,
          criticalIssueCount: 0,
          highIssueCount: 0,
          mediumIssueCount: 0,
          lowIssueCount: 0,
          groups: []
        }]
      : []
  });
}

try {
  await page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (handler, timeout = 0, ...args) =>
      nativeSetInterval(handler, timeout === 5_000 ? 60_000 : timeout, ...args);
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/dashboard/overview") {
      observed.overviewGets += 1;
      if (returnIncompleteOverview) {
        observed.protectedEmptyGets += 1;
      }
      await fulfillJson(route, currentOverview());
      return;
    }
    if (method === "GET" && pathname === "/api/organizations") {
      await fulfillJson(route, [existingProject]);
      return;
    }
    if (
      method === "GET" &&
      pathname === `/api/organizations/${existingProject.id}/evaluation-targets`
    ) {
      await fulfillJson(route, targets);
      return;
    }
    if (method === "GET" && pathname === "/api/requests") {
      await fulfillJson(route, requests);
      return;
    }
    if (method === "GET" && pathname === `/api/targets/${createdTarget.id}`) {
      await fulfillJson(route, createdTarget);
      return;
    }
    if (method === "POST" && pathname === "/api/organizations") {
      observed.organizationPosts += 1;
      await fulfillJson(route, unresolvedProject, { status: 201 });
      return;
    }
    if (
      method === "POST" &&
      pathname === `/api/organizations/${existingProject.id}/evaluation-targets`
    ) {
      observed.targetPosts += 1;
      targets = [createdTarget];
      await fulfillJson(route, createdTarget, { status: 201 });
      return;
    }
    if (method === "POST" && pathname === "/api/requests") {
      observed.requestPosts += 1;
      requests = [pendingRequest];
      await fulfillJson(route, pendingRequest, { status: 201 });
      return;
    }
    if (method === "GET" && pathname === `/api/requests/${pendingRequest.id}`) {
      observed.requestStatusGets += 1;
      requestCompleted = true;
      requests = [completedRequest];
      await fulfillJson(route, completedRequest);
      return;
    }

    observed.unknownRequests.push(`${method} ${pathname}`);
    await fulfillJson(route, null, { status: 500 });
  });

  await page.goto(`${baseUrl}/projects/${existingProject.id}`, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { level: 1, name: existingProject.name, exact: true })
    .waitFor();

  const addProjectButton = page
    .locator("aside")
    .getByRole("button", { name: "프로젝트 추가", exact: true });
  await addProjectButton.click();
  let projectDialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
  await projectDialog.getByLabel("프로젝트 이름", { exact: true }).fill(unresolvedProject.name);
  await projectDialog.getByRole("button", { name: "생성", exact: true }).click();
  await projectDialog
    .getByRole("alert")
    .filter({ hasText: "프로젝트는 생성되었지만" })
    .waitFor();
  await projectDialog.getByRole("button", { name: "닫기", exact: true }).click();
  await projectDialog.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  const siteDialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
  await siteDialog.getByLabel("페이지 이름", { exact: true }).fill(createdTarget.name);
  await siteDialog.getByLabel("페이지 주소", { exact: true }).fill(createdTarget.accessUrl);
  await siteDialog.getByRole("button", { name: "분석 시작", exact: true }).click();
  await siteDialog.waitFor({ state: "hidden", timeout: 10_000 });

  assert.equal(observed.organizationPosts, 1);
  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 1);
  assert.equal(observed.requestStatusGets, 1);
  await page
    .getByRole("button", { name: `${createdTarget.name} 상세 보기`, exact: true })
    .waitFor();

  returnIncompleteOverview = true;
  await addProjectButton.click();
  projectDialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
  await projectDialog
    .getByRole("button", { name: "프로젝트 불러오기 다시 시도", exact: true })
    .click();
  await page.waitForFunction(() => {
    const heading = document.querySelector("h1");
    return heading?.textContent?.includes("Nested recovery project") === true;
  });

  assert.equal(new URL(page.url()).pathname, `/projects/${existingProject.id}`);
  assert.equal(
    await page
      .getByRole("button", { name: `${createdTarget.name} 상세 보기`, exact: true })
      .count(),
    1,
    "ending nested target/request leases must not release the older organization lease"
  );
  assert.equal(observed.protectedEmptyGets, 1);
  assert.deepEqual(observed.unknownRequests, []);

  console.log(JSON.stringify({ result: "PASS", ...observed }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
