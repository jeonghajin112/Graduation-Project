/**
 * Runtime response-contract regressions. Successful HTTP responses with
 * malformed data must fail at the API boundary, never inside React rendering,
 * and ambiguous mutation outcomes must recover with GETs instead of re-POSTing.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  createDashboardOverview,
  fulfillJson
} from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-08-23T10:00:00.000Z";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const resultDetailsSource = await readFile(
  path.join(
    dashboardDirectory,
    "src/components/dashboard/panels/site-dashboard/use-evaluation-result-details.ts"
  ),
  "utf8"
);

assert.match(
  resultDetailsSource,
  /const DETAILS_REQUEST_TIMEOUT_MS\s*=\s*15_000;/,
  "result details must have a bounded network deadline"
);
assert.match(
  resultDetailsSource,
  /timeoutPromise[\s\S]*?window\.setTimeout\([\s\S]*?controller\.abort\(\);[\s\S]*?reject\(new UserFacingError\(DETAILS_REQUEST_TIMEOUT_MESSAGE\)\)/,
  "the shared request owner must abort and surface a safe timeout message"
);
assert.match(
  resultDetailsSource,
  /Promise\.race\(\[[\s\S]*?fetchEvaluationIssueViewModels\(request, controller\.signal\)[\s\S]*?timeoutPromise[\s\S]*?\]\)/,
  "result details must race the shared fetch against its owner timeout"
);
assert.match(
  resultDetailsSource,
  /sharedRequest\.consumers === 0[\s\S]*?sharedRequest\.controller\.abort\(\)[\s\S]*?, 0\)/,
  "StrictMode cleanup must defer a consumerless shared-request abort"
);

function organization(id, name) {
  return {
    id,
    name,
    type: "ETC",
    homepageUrl: null,
    description: "응답 계약 검증용 프로젝트",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function target(id, organizationId, name) {
  return {
    id,
    organizationId,
    name,
    targetType: "WEB",
    accessUrl: `https://example.com/${id}`,
    faviconUrl: null,
    description: "",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function request(id, evaluationTargetId, targetName) {
  return {
    id,
    evaluationTargetId,
    targetName,
    faviconUrl: null,
    status: "COMPLETED",
    requestNote: "응답 계약 검증",
    requestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function summary(evaluationRequest, targetName) {
  return {
    requestId: evaluationRequest.id,
    targetName,
    status: "COMPLETED",
    totalScore: 92,
    totalIssueCount: 1,
    criticalIssueCount: 1,
    requestedAt: timestamp
  };
}

function score(id, evaluationRequestId) {
  return {
    id,
    evaluationRequestId,
    totalScore: 92,
    ruleScore: 90,
    aiScore: 94,
    cvScore: 92,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function collectPageErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function assertNoInternalErrorDetails(text) {
  assert.doesNotMatch(
    text,
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\bHTTP\s+\d{3}\b/i,
    "user-facing errors must not expose request methods or HTTP statuses"
  );
  assert.doesNotMatch(
    text,
    /\/(?:api\/)?(?:dashboard|organizations|requests|results|targets)(?:\/|\b)/i,
    "user-facing errors must not expose API endpoints"
  );
  assert.doesNotMatch(
    text,
    /\bdata(?:\.|\[)|\bsuccess\b|서버 응답 계약|API 응답|captureMode|ApiRequestError/i,
    "user-facing errors must not expose response-contract details"
  );
}

async function runMalformedOverviewScenario(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = collectPageErrors(page);
  const project = organization(1, "Overview recovery project");
  const overview = createDashboardOverview({ organizations: [project] });
  let serveValidOverview = false;
  let overviewGets = 0;
  const unknownRequests = [];

  try {
    await page.route("**/api/**", async (route) => {
      const browserRequest = route.request();
      const pathname = new URL(browserRequest.url()).pathname;
      if (browserRequest.method() === "GET" && pathname === "/api/dashboard/overview") {
        overviewGets += 1;
        await fulfillJson(
          route,
          serveValidOverview
            ? overview
            : { ...overview, organizations: "배열이 아닌 오염된 조직 목록" }
        );
        return;
      }
      unknownRequests.push(`${browserRequest.method()} ${pathname}`);
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    const alert = page.getByRole("alert");
    await alert.waitFor();
    const alertText = await alert.innerText();
    assert.match(alertText, /대시보드를 불러오지 못했습니다/);
    assert.match(alertText, /대시보드 데이터를 가져오지 못했습니다/);
    assertNoInternalErrorDetails(alertText);
    assert.doesNotMatch(alertText, /map is not a function|Cannot read properties/);
    assert.equal(await page.getByText("배열이 아닌 오염된 조직 목록").count(), 0);

    serveValidOverview = true;
    await alert
      .getByRole("button", { name: "대시보드 다시 불러오기", exact: true })
      .click();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: project.name, exact: true })
      .waitFor();
    await alert.waitFor({ state: "hidden" });

    assert.ok(overviewGets >= 2);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unknownRequests, []);
    return { overviewGets, recovered: true };
  } finally {
    await context.close();
  }
}

async function runMalformedOverviewRelationsScenario(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = collectPageErrors(page);
  const project = organization(3, "Overview relation recovery project");
  const pageTarget = target(301, project.id, "Overview relation recovery page");
  const legacyBlankUrlTarget = {
    ...target(302, project.id, "Legacy blank URL page"),
    accessUrl: ""
  };
  const legacyUnsafeUrlTarget = {
    ...target(303, project.id, "Legacy unsafe URL page"),
    accessUrl: "javascript:alert(document.domain)"
  };
  const evaluationRequest = request(701, pageTarget.id, pageTarget.name);
  const scoreResult = score(8001, evaluationRequest.id);
  const validOverview = createDashboardOverview({
    organizations: [project],
    evaluationTargets: [pageTarget, legacyBlankUrlTarget, legacyUnsafeUrlTarget],
    evaluationRequests: [evaluationRequest],
    resultSummaries: [summary(evaluationRequest, pageTarget.name)],
    scoreResults: [scoreResult],
    latestIssueCounts: [
      {
        evaluationTargetId: pageTarget.id,
        requestId: evaluationRequest.id,
        totalIssueCount: 1,
        criticalIssueCount: 1,
        highIssueCount: 0,
        mediumIssueCount: 0,
        lowIssueCount: 0,
        groups: [
          {
            issueCode: "KWCAG-1.1.1",
            issueTitle: "Overview relation fixture issue",
            severity: "CRITICAL",
            count: 1
          }
        ]
      }
    ]
  });
  let responseMode = "missing-envelope";
  let overviewGets = 0;
  const unknownRequests = [];

  try {
    await page.route("**/api/**", async (route) => {
      const browserRequest = route.request();
      const pathname = new URL(browserRequest.url()).pathname;
      if (browserRequest.method() === "GET" && pathname === "/api/dashboard/overview") {
        overviewGets += 1;
        const responseOverview =
          responseMode === "missing-target-reference"
            ? {
                ...validOverview,
                evaluationRequests: [
                  { ...evaluationRequest, evaluationTargetId: pageTarget.id + 999_999 }
                ]
              }
            : responseMode === "invalid-score-type"
              ? {
                  ...validOverview,
                  scoreResults: [{ ...scoreResult, totalScore: "92" }]
                }
              : responseMode === "invalid-score-range"
                ? {
                    ...validOverview,
                    scoreResults: [{ ...scoreResult, totalScore: 101 }]
                  }
              : validOverview;
        // Keep the loading label observable so each retry can prove that it
        // processed a new malformed response rather than reusing the alert
        // left behind by the previous response.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fulfillJson(route, responseOverview, {
          envelope: responseMode !== "missing-envelope"
        });
        return;
      }
      unknownRequests.push(`${browserRequest.method()} ${pathname}`);
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    const envelopeAlert = page
      .getByRole("alert")
      .filter({ hasText: "대시보드를 불러오지 못했습니다" });
    await envelopeAlert.waitFor();
    assert.match(await envelopeAlert.innerText(), /대시보드 데이터를 가져오지 못했습니다/);
    assertNoInternalErrorDetails(await envelopeAlert.innerText());

    const retryAndWaitForDashboardError = async (alert) => {
      const previousOverviewGets = overviewGets;
      const responsePromise = page.waitForResponse((response) => {
        const request = response.request();
        return (
          request.method() === "GET" &&
          new URL(response.url()).pathname === "/api/dashboard/overview"
        );
      });
      await alert
        .getByRole("button", { name: "대시보드 다시 불러오기", exact: true })
        .click();
      await page
        .getByRole("button", { name: "대시보드 불러오는 중", exact: true })
        .waitFor();
      await responsePromise;
      await alert
        .getByRole("button", { name: "대시보드 다시 불러오기", exact: true })
        .waitFor();
      assert.equal(
        overviewGets,
        previousOverviewGets + 1,
        "each malformed response mode must receive its own dashboard request"
      );
    };

    responseMode = "missing-target-reference";
    await retryAndWaitForDashboardError(envelopeAlert);
    const relationAlert = page
      .getByRole("alert")
      .filter({ hasText: "대시보드를 불러오지 못했습니다" });
    await relationAlert.waitFor();
    assertNoInternalErrorDetails(await relationAlert.innerText());

    responseMode = "invalid-score-type";
    await retryAndWaitForDashboardError(relationAlert);
    const scoreAlert = page
      .getByRole("alert")
      .filter({ hasText: "대시보드를 불러오지 못했습니다" });
    await scoreAlert.waitFor();
    assertNoInternalErrorDetails(await scoreAlert.innerText());

    responseMode = "invalid-score-range";
    await retryAndWaitForDashboardError(scoreAlert);
    const scoreRangeAlert = page
      .getByRole("alert")
      .filter({ hasText: "대시보드를 불러오지 못했습니다" });
    await scoreRangeAlert.waitFor();
    const scoreRangeAlertText = await scoreRangeAlert.innerText();
    assertNoInternalErrorDetails(scoreRangeAlertText);
    assert.doesNotMatch(scoreRangeAlertText, /0 이상 100 이하의 점수/);

    responseMode = "valid";
    await scoreRangeAlert
      .getByRole("button", { name: "대시보드 다시 불러오기", exact: true })
      .click();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: project.name, exact: true })
      .waitFor();
    await scoreAlert.waitFor({ state: "hidden" });

    await page
      .getByRole("complementary")
      .getByRole("button", { name: project.name, exact: true })
      .click();
    await page.getByText(legacyUnsafeUrlTarget.name, { exact: true }).waitFor();
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);

    assert.ok(overviewGets >= 5);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unknownRequests, []);
    return { overviewGets, recovered: true };
  } finally {
    await context.close();
  }
}

async function runMalformedIssueScenario(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = collectPageErrors(page);
  const project = organization(2, "Issue contract project");
  const pageTarget = target(201, project.id, "Issue contract page");
  const evaluationRequest = request(601, pageTarget.id, pageTarget.name);
  const artifactId = 8101;
  const artifact = {
    id: artifactId,
    requestId: evaluationRequest.id,
    requestedUrl: pageTarget.accessUrl,
    finalUrl: pageTarget.accessUrl,
    capturedAt: timestamp,
    viewportWidthCssPx: 1280,
    viewportHeightCssPx: 720,
    deviceScaleFactor: 1,
    pageWidthCssPx: 1280,
    pageHeightCssPx: 720,
    captureMode: "DOM_REPLAY",
    contentUrl: `/api/results/artifacts/${artifactId}/content`,
    contentType: "text/html",
    sizeBytes: 128,
    sha256: "a".repeat(64),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const aggregateIssueTitle = "집계 응답에만 포함된 정상 이슈";
  const issueTitle = "렌더링되면 안 되는 오염된 상세 이슈";
  const overview = createDashboardOverview({
    organizations: [project],
    evaluationTargets: [pageTarget],
    evaluationRequests: [evaluationRequest],
    resultSummaries: [summary(evaluationRequest, pageTarget.name)],
    scoreResults: [score(7001, evaluationRequest.id)],
    latestIssueCounts: [
      {
        evaluationTargetId: pageTarget.id,
        requestId: evaluationRequest.id,
        totalIssueCount: 1,
        criticalIssueCount: 1,
        highIssueCount: 0,
        mediumIssueCount: 0,
        lowIssueCount: 0,
        groups: [
          {
            issueCode: "KWCAG-1.1.1",
            issueTitle: aggregateIssueTitle,
            severity: "CRITICAL",
            count: 1
          }
        ]
      }
    ]
  });
  let serveValidIssues = false;
  let issueGets = 0;
  const unknownRequests = [];

  const validIssue = {
    id: 9101,
    requestId: evaluationRequest.id,
    module: "rule_based",
    severity: "CRITICAL",
    title: "검증을 통과한 이슈",
    description: "대체 텍스트가 필요합니다.",
    recommendation: "의미 있는 대체 텍스트를 추가하세요.",
    selector: "img.hero",
    locator: null,
    wcagCode: "KWCAG-1.1.1",
    createdAt: timestamp
  };

  try {
    await page.route("**/api/**", async (route) => {
      const browserRequest = route.request();
      const pathname = new URL(browserRequest.url()).pathname;
      if (browserRequest.method() === "GET" && pathname === "/api/dashboard/overview") {
        await fulfillJson(route, overview);
        return;
      }
      if (
        browserRequest.method() === "GET" &&
        pathname === `/api/results/requests/${evaluationRequest.id}/issues`
      ) {
        issueGets += 1;
        await fulfillJson(
          route,
          serveValidIssues ? [validIssue] : [{ ...validIssue, title: issueTitle, severity: "BLOCKER" }]
        );
        return;
      }
      if (
        browserRequest.method() === "GET" &&
        pathname === `/api/results/requests/${evaluationRequest.id}/artifact`
      ) {
        await fulfillJson(route, artifact);
        return;
      }
      if (
        browserRequest.method() === "GET" &&
        pathname === `/api/results/artifacts/${artifactId}/content`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body><main>응답 계약 검증 재현 문서</main></body></html>"
        });
        return;
      }
      unknownRequests.push(`${browserRequest.method()} ${pathname}`);
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/projects/${project.id}/pages/${pageTarget.id}`, {
      waitUntil: "networkidle"
    });
    const evidenceCard = page.getByRole("article", { name: "페이지 검사 화면" });
    const alert = evidenceCard
      .getByRole("alert")
      .filter({ hasText: "페이지 재현 화면을 불러오지 못했어요" });
    await alert.waitFor();
    const alertText = await alert.innerText();
    assert.match(alertText, /페이지 검사 결과를 불러오지 못했어요/);
    assertNoInternalErrorDetails(alertText);
    assert.equal(await evidenceCard.getByText(issueTitle, { exact: true }).count(), 0);

    serveValidIssues = true;
    await alert.getByRole("button", { name: "다시 시도", exact: true }).click();
    await alert.waitFor({ state: "hidden" });
    await evidenceCard
      .getByRole("region", { name: `${pageTarget.name} 접근성 검사 페이지 재현 화면` })
      .waitFor();

    assert.ok(issueGets >= 2);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unknownRequests, []);
    return { issueGets, recovered: true };
  } finally {
    await context.close();
  }
}

async function runResultDetailsTimeoutScenario(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = collectPageErrors(page);
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler, timeout, ...args) =>
      nativeSetTimeout(handler, timeout === 15_000 ? 100 : timeout, ...args));
  });

  const project = organization(20, "Result timeout project");
  const pageTarget = target(2020, project.id, "Result timeout page");
  const evaluationRequest = request(6020, pageTarget.id, pageTarget.name);
  const overview = createDashboardOverview({
    organizations: [project],
    evaluationTargets: [pageTarget],
    evaluationRequests: [evaluationRequest],
    resultSummaries: [summary(evaluationRequest, pageTarget.name)],
    scoreResults: [score(7020, evaluationRequest.id)]
  });
  const validIssue = {
    id: 9120,
    requestId: evaluationRequest.id,
    module: "rule_based",
    severity: "HIGH",
    title: "timeout 뒤 복구한 이슈",
    description: "공유 요청 timeout 복구 검증",
    recommendation: "검증용 권고",
    selector: "main",
    locator: null,
    wcagCode: "KWCAG-1.1.1",
    createdAt: timestamp
  };
  let issueGets = 0;
  let serveValidIssues = false;
  let releaseStalledIssue = null;
  const unknownRequests = [];

  try {
    await page.route("**/api/**", async (route) => {
      const browserRequest = route.request();
      const pathname = new URL(browserRequest.url()).pathname;
      if (browserRequest.method() === "GET" && pathname === "/api/dashboard/overview") {
        await fulfillJson(route, overview);
        return;
      }
      if (
        browserRequest.method() === "GET" &&
        pathname === `/api/results/requests/${evaluationRequest.id}/issues`
      ) {
        issueGets += 1;
        if (!serveValidIssues) {
          await new Promise((resolve) => {
            releaseStalledIssue = resolve;
          });
          try {
            await fulfillJson(route, [validIssue]);
          } catch {
            // The application-owned timeout already aborted this first route.
          }
          return;
        }
        await fulfillJson(route, [validIssue]);
        return;
      }
      if (
        browserRequest.method() === "GET" &&
        pathname === `/api/results/requests/${evaluationRequest.id}/artifact`
      ) {
        await route.fulfill({ status: 404, contentType: "application/json", body: "null" });
        return;
      }
      unknownRequests.push(`${browserRequest.method()} ${pathname}`);
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/projects/${project.id}/pages/${pageTarget.id}`, {
      waitUntil: "domcontentloaded"
    });
    const evidenceCard = page.getByRole("article", { name: "페이지 검사 화면" });
    const timeoutAlert = evidenceCard
      .getByRole("alert")
      .filter({ hasText: "검사 결과를 불러오는 데 시간이 오래 걸리고 있습니다" });
    await timeoutAlert.waitFor({ timeout: 8_000 });
    assert.equal(issueGets, 1, "StrictMode consumers must share one timed request");

    serveValidIssues = true;
    releaseStalledIssue?.();
    releaseStalledIssue = null;
    await timeoutAlert.getByRole("button", { name: "다시 시도", exact: true }).click();
    await timeoutAlert.waitFor({ state: "hidden" });
    assert.equal(issueGets, 2, "retry after the timeout must acquire one fresh request");
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unknownRequests, []);
    return { issueGets, recovered: true, strictModeShared: true };
  } finally {
    releaseStalledIssue?.();
    await context.close();
  }
}

async function runMalformedMutationScenario(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = collectPageErrors(page);
  const createdProject = organization(78, "Mutation contract recovery");
  let organizationCommitted = false;
  let revealCommittedOrganization = false;
  let organizationPosts = 0;
  let postMutationOverviewGets = 0;
  const unknownRequests = [];

  try {
    await page.route("**/api/**", async (route) => {
      const browserRequest = route.request();
      const method = browserRequest.method();
      const pathname = new URL(browserRequest.url()).pathname;
      if (method === "GET" && pathname === "/api/dashboard/overview") {
        if (organizationCommitted) {
          postMutationOverviewGets += 1;
        }
        await fulfillJson(
          route,
          createDashboardOverview({
            organizations:
              organizationCommitted && revealCommittedOrganization ? [createdProject] : []
          })
        );
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        organizationPosts += 1;
        organizationCommitted = true;
        await fulfillJson(
          route,
          {
            ...organization(77, createdProject.name),
            name: 12345
          },
          { status: 201 }
        );
        return;
      }
      unknownRequests.push(`${method} ${pathname}`);
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();

    const recoveryAlert = dialog
      .getByRole("alert")
      .filter({ hasText: "프로젝트 생성 결과를 확인하지 못했습니다" });
    await recoveryAlert.waitFor();
    assert.equal(organizationPosts, 1);
    assert.ok(postMutationOverviewGets >= 1);

    revealCommittedOrganization = true;
    await dialog
      .getByRole("button", { name: "프로젝트 불러오기 다시 시도", exact: true })
      .click();
    await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 10_000 });
    await page
      .getByRole("heading", { level: 1, name: createdProject.name, exact: true })
      .waitFor();

    assert.equal(organizationPosts, 1);
    assert.ok(postMutationOverviewGets >= 2);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unknownRequests, []);
    return { organizationPosts, postMutationOverviewGets, recoveredProjectId: createdProject.id };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const malformedOverview = await runMalformedOverviewScenario(browser);
  const malformedOverviewRelations = await runMalformedOverviewRelationsScenario(browser);
  const malformedIssue = await runMalformedIssueScenario(browser);
  const resultDetailsTimeout = await runResultDetailsTimeoutScenario(browser);
  const malformedMutation = await runMalformedMutationScenario(browser);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        malformedOverview,
        malformedOverviewRelations,
        malformedIssue,
        resultDetailsTimeout,
        malformedMutation
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
