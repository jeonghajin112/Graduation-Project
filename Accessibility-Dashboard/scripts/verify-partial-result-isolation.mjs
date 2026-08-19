/**
 * Regression checks for result isolation and cache recovery: one unavailable
 * completed-request summary cannot reject the dashboard, transient issues or
 * score-detail failures retain and retry the complete stale bundle, and
 * backwards clock adjustments invalidate both directory and result caches.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-partial-result-isolation.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const timestamp = "2026-08-10T10:00:00.000Z";

const organization = {
  id: 1,
  name: "Result isolation project",
  type: "ETC",
  homepageUrl: "https://example.com",
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const unresolvedRecoveryOrganization = {
  ...organization,
  id: 2,
  name: "Result recovery checkpoint"
};

const brokenTarget = {
  id: 101,
  organizationId: organization.id,
  name: "Unavailable summary page",
  targetType: "WEB",
  accessUrl: "https://example.com/broken-summary",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const healthyTarget = {
  id: 102,
  organizationId: organization.id,
  name: "Healthy result page",
  targetType: "WEB",
  accessUrl: "https://example.com/healthy-result",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

function completedRequest(id, target) {
  return {
    id,
    evaluationTargetId: target.id,
    targetName: target.name,
    status: "COMPLETED",
    requestNote: "result isolation regression",
    requestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

const brokenRequest = completedRequest(501, brokenTarget);
const healthyRequest = completedRequest(502, healthyTarget);
const healthyIssueTitle = "정상 결과에서 유지되어야 하는 대체 텍스트 이슈";
const brokenIssueTitle = "요약 없는 요청에서 제외되어야 하는 이슈";

const healthySummary = {
  requestId: healthyRequest.id,
  targetName: healthyTarget.name,
  status: "COMPLETED",
  totalScore: 88,
  totalIssueCount: 1,
  criticalIssueCount: 0,
  requestedAt: timestamp
};

const healthyScore = {
  id: 8001,
  evaluationRequestId: healthyRequest.id,
  totalScore: 88,
  ruleScore: 86,
  aiScore: 89,
  cvScore: 89,
  createdAt: timestamp,
  updatedAt: timestamp
};

const healthyIssues = [
  {
    id: 7001,
    requestId: healthyRequest.id,
    module: "rule_based",
    severity: "SERIOUS",
    title: healthyIssueTitle,
    description: "이미지에 대체 텍스트가 필요합니다.",
    recommendation: "의미를 전달하는 대체 텍스트를 추가하세요.",
    selector: "main img:first-of-type",
    wcagCode: "5.1.1",
    createdAt: timestamp
  }
];

const brokenIssues = [
  {
    id: 7002,
    requestId: brokenRequest.id,
    module: "rule_based",
    severity: "CRITICAL",
    title: brokenIssueTitle,
    description: "요약이 없는 요청의 이슈입니다.",
    recommendation: "완전한 결과가 준비된 뒤 표시해야 합니다.",
    selector: "main",
    wcagCode: "5.2.1",
    createdAt: timestamp
  }
];

const observed = {
  brokenSummaryFailures: 0,
  organizationLoads: 0,
  organizationPosts: 0,
  healthyIssueFailures: 0,
  healthyIssueLoads: 0,
  healthyScoreFailures: 0,
  healthyScoreLoads: 0,
  healthySummaryLoads: 0,
  healthySummaryFailures: 0,
  unknownRequests: new Set()
};
let healthySummaryAvailable = true;
let healthyIssuesAvailable = true;
let healthyScoreAvailable = false;

function compactText(value) {
  return value.replace(/\s+/g, "");
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    globalThis.__setCacheTestClockOffset = (nextOffset) => {
      offset = nextOffset;
    };
    Date.now = () => realNow() + offset;
  });
  const setClockOffset = (offset) =>
    page.evaluate((nextOffset) => globalThis.__setCacheTestClockOffset(nextOffset), offset);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/organizations") {
      observed.organizationLoads += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([organization]) });
      return;
    }
    if (method === "GET" && pathname === `/api/organizations/${organization.id}/evaluation-targets`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([brokenTarget, healthyTarget])
      });
      return;
    }
    if (method === "GET" && pathname === "/api/requests") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([brokenRequest, healthyRequest])
      });
      return;
    }
    if (method === "POST" && pathname === "/api/organizations") {
      observed.organizationPosts += 1;
      // The organization response succeeds, but its reconciliation refresh
      // loses the previously materialized partial result bundle.
      healthySummaryAvailable = false;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(unresolvedRecoveryOrganization)
      });
      return;
    }
    if (method === "GET" && pathname === `/api/results/requests/${brokenRequest.id}/summary`) {
      observed.brokenSummaryFailures += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "summary unavailable" })
      });
      return;
    }
    if (method === "GET" && pathname === `/api/results/requests/${brokenRequest.id}/issues`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(brokenIssues) });
      return;
    }
    if (method === "GET" && pathname === `/api/results/requests/${healthyRequest.id}/summary`) {
      if (!healthySummaryAvailable) {
        observed.healthySummaryFailures += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "healthy summary temporarily unavailable" })
        });
        return;
      }

      observed.healthySummaryLoads += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(healthySummary) });
      return;
    }
    if (method === "GET" && pathname === `/api/results/requests/${healthyRequest.id}/issues`) {
      if (!healthyIssuesAvailable) {
        observed.healthyIssueFailures += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "healthy issues temporarily unavailable" })
        });
        return;
      }

      observed.healthyIssueLoads += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(healthyIssues) });
      return;
    }
    if (method === "GET" && pathname === `/api/scores/requests/${healthyRequest.id}`) {
      if (!healthyScoreAvailable) {
        observed.healthyScoreFailures += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "healthy score temporarily unavailable" })
        });
        return;
      }

      observed.healthyScoreLoads += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(healthyScore) });
      return;
    }

    observed.unknownRequests.add(`${method} ${pathname}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();

  const brokenCard = page.locator("article.dashboard-project-card").filter({
    has: page.getByRole("button", { name: `${brokenTarget.name} 상세 보기`, exact: true })
  });
  const healthyCard = page.locator("article.dashboard-project-card").filter({
    has: page.getByRole("button", { name: `${healthyTarget.name} 상세 보기`, exact: true })
  });
  await brokenCard.waitFor();
  await healthyCard.waitFor();

  assert.equal(
    await brokenCard.locator(".dashboard-project-card-score").getAttribute("aria-label"),
    "점수 없음"
  );
  assert.equal(
    await healthyCard.locator(".dashboard-project-card-score").getAttribute("aria-label"),
    "점수 없음"
  );
  assert.equal(compactText(await brokenCard.locator(".dashboard-project-card-status").innerText()), "완료");
  assert.equal(compactText(await healthyCard.locator(".dashboard-project-card-status").innerText()), "완료");
  assert.ok(observed.healthyScoreFailures >= 1, "the cold score-detail request must fail");

  // A cold score-detail failure keeps summary/issues but must not synthesize
  // zero category values. While an organization recovery lease is active, a
  // later summary failure must retain that partial baseline instead of
  // erasing the already visible issue.
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  await page.getByText(healthyIssueTitle, { exact: true }).waitFor();
  const addProjectButton = page
    .locator("aside")
    .getByRole("button", { name: "프로젝트 추가", exact: true });
  await addProjectButton.click();
  const recoveryDialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
  await recoveryDialog
    .getByLabel("프로젝트 이름", { exact: true })
    .fill(unresolvedRecoveryOrganization.name);
  await recoveryDialog.getByRole("button", { name: "생성", exact: true }).click();
  await recoveryDialog
    .getByRole("alert")
    .filter({ hasText: "프로젝트는 생성되었지만" })
    .waitFor();
  await page.getByText(healthyIssueTitle, { exact: true }).waitFor();
  assert.equal(observed.organizationPosts, 1);
  assert.ok(
    observed.healthySummaryFailures >= 1,
    "the recovery refresh must exercise a missing partial result bundle"
  );

  const coldScoreLoadsBeforeRecovery = observed.healthyScoreLoads;
  healthySummaryAvailable = true;
  healthyScoreAvailable = true;
  await recoveryDialog
    .getByRole("button", { name: "프로젝트 불러오기 다시 시도", exact: true })
    .click();
  const coldScoreRecoveryDeadline = Date.now() + 8_000;
  while (
    observed.healthyScoreLoads <= coldScoreLoadsBeforeRecovery &&
    Date.now() < coldScoreRecoveryDeadline
  ) {
    await page.waitForTimeout(100);
  }
  assert.ok(
    observed.healthyScoreLoads > coldScoreLoadsBeforeRecovery,
    "an incomplete cold score bundle must stay uncached and retry"
  );
  await recoveryDialog.getByRole("button", { name: "닫기", exact: true }).click();
  await recoveryDialog.waitFor({ state: "hidden" });
  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await healthyCard.waitFor();
  assert.equal(
    await healthyCard.locator(".dashboard-project-card-score").getAttribute("aria-label"),
    "점수 88점"
  );

  // A backwards wall-clock adjustment must invalidate both directory and
  // result caches. Treating a negative age as fresh can pin either cache until
  // the clock catches up.
  const clockRollbackBaseline = {
    organizationLoads: observed.organizationLoads,
    healthySummaryLoads: observed.healthySummaryLoads
  };
  await setClockOffset(-10_000);
  const clockRollbackDeadline = Date.now() + 8_000;
  while (
    (observed.organizationLoads <= clockRollbackBaseline.organizationLoads ||
      observed.healthySummaryLoads <= clockRollbackBaseline.healthySummaryLoads) &&
    Date.now() < clockRollbackDeadline
  ) {
    await page.waitForTimeout(100);
  }
  assert.ok(
    observed.organizationLoads > clockRollbackBaseline.organizationLoads,
    "negative directory-cache age must force a fresh organization request"
  );
  assert.ok(
    observed.healthySummaryLoads > clockRollbackBaseline.healthySummaryLoads,
    "negative result-cache age must force a fresh result request"
  );
  const clockRollbackReloads = {
    organizations: observed.organizationLoads - clockRollbackBaseline.organizationLoads,
    results: observed.healthySummaryLoads - clockRollbackBaseline.healthySummaryLoads
  };
  // Route fulfillment is observed before the shared bundle has necessarily
  // committed its fetchedAt timestamp. Let that load settle before changing
  // the virtual clock again so the expiry assertion is deterministic.
  await page.waitForTimeout(500);
  await setClockOffset(0);

  // Expire the successful result cache, then make its refresh fail. The next
  // 5-second dashboard poll must retain the last good 88-point bundle while
  // continuing to attempt a fresh summary.
  const healthySummaryFailuresBeforeStaleRefresh = observed.healthySummaryFailures;
  healthySummaryAvailable = false;
  await setClockOffset(61_000);
  const staleFallbackDeadline = Date.now() + 8_000;
  while (
    observed.healthySummaryFailures <= healthySummaryFailuresBeforeStaleRefresh &&
    Date.now() < staleFallbackDeadline
  ) {
    await page.waitForTimeout(100);
  }
  assert.ok(
    observed.healthySummaryFailures > healthySummaryFailuresBeforeStaleRefresh,
    "expected an expired healthy bundle refresh to fail"
  );
  await page.waitForTimeout(500);
  assert.equal(
    await healthyCard.locator(".dashboard-project-card-score").getAttribute("aria-label"),
    "점수 88점"
  );

  healthySummaryAvailable = true;

  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  const openIssuesCard = page.locator("article.dashboard-card").filter({
    has: page.getByText("현재 미해결 이슈", { exact: true })
  });
  await openIssuesCard
    .getByRole("img", { name: /^현재 미해결 이슈 1건\./ })
    .waitFor();
  await page.getByText(healthyIssueTitle, { exact: true }).waitFor();
  assert.equal(await page.getByText(brokenIssueTitle, { exact: true }).count(), 0);
  assert.equal(await page.getByText("대시보드 로드 실패", { exact: true }).count(), 0);

  // Expire the bundle and fail only the issues subrequest. The last complete
  // bundle must remain visible, and the unchanged stale timestamp must make
  // the next poll retry issues instead of caching an empty array for 60s.
  const healthyIssueLoadsBeforeFailure = observed.healthyIssueLoads;
  healthyIssuesAvailable = false;
  await setClockOffset(61_000);
  const issueFailureDeadline = Date.now() + 8_000;
  while (observed.healthyIssueFailures < 1 && Date.now() < issueFailureDeadline) {
    await page.waitForTimeout(100);
  }
  assert.ok(observed.healthyIssueFailures >= 1, "expected the expired issues refresh to fail");
  await page.waitForTimeout(500);
  await page.getByText(healthyIssueTitle, { exact: true }).waitFor();

  healthyIssuesAvailable = true;
  const issueRecoveryDeadline = Date.now() + 8_000;
  while (
    observed.healthyIssueLoads <= healthyIssueLoadsBeforeFailure &&
    Date.now() < issueRecoveryDeadline
  ) {
    await page.waitForTimeout(100);
  }
  assert.ok(
    observed.healthyIssueLoads > healthyIssueLoadsBeforeFailure,
    "the next poll must retry issues after a partial bundle failure"
  );
  await page.getByText(healthyIssueTitle, { exact: true }).waitFor();

  // A score-detail outage must follow the same rule. Replacing the last full
  // score with a summary-derived partial value would cache zero category
  // scores for 60 seconds. Keep the full stale bundle and retry next poll.
  const healthyScoreLoadsBeforeFailure = observed.healthyScoreLoads;
  const healthyScoreFailuresBeforeStaleRefresh = observed.healthyScoreFailures;
  healthyScoreAvailable = false;
  await setClockOffset(122_000);
  const scoreFailureDeadline = Date.now() + 8_000;
  while (
    observed.healthyScoreFailures <= healthyScoreFailuresBeforeStaleRefresh &&
    Date.now() < scoreFailureDeadline
  ) {
    await page.waitForTimeout(100);
  }
  assert.ok(
    observed.healthyScoreFailures > healthyScoreFailuresBeforeStaleRefresh,
    "expected the expired score refresh to fail"
  );
  await page.getByText(healthyIssueTitle, { exact: true }).waitFor();

  healthyScoreAvailable = true;
  const scoreRecoveryDeadline = Date.now() + 8_000;
  while (
    observed.healthyScoreLoads <= healthyScoreLoadsBeforeFailure &&
    Date.now() < scoreRecoveryDeadline
  ) {
    await page.waitForTimeout(100);
  }
  assert.ok(
    observed.healthyScoreLoads > healthyScoreLoadsBeforeFailure,
    "the next poll must retry score details after a partial bundle failure"
  );
  await setClockOffset(0);

  await page.goto(`${baseUrl}/projects/${organization.id}/pages/${brokenTarget.id}`, {
    waitUntil: "networkidle"
  });
  await page.getByRole("heading", { level: 1, name: brokenTarget.name, exact: true }).waitFor();
  const scoreTrendCard = page.getByRole("article", { name: "접근성 점수 추이" });
  await scoreTrendCard.waitFor();
  const latestScore = scoreTrendCard.locator(".site-summary-stat-item").filter({ hasText: "최신 점수" });
  assert.equal(compactText(await latestScore.innerText()), "최신점수-점");
  const evaluationCount = scoreTrendCard.locator(".site-summary-stat-item").filter({ hasText: "평가 횟수" });
  assert.equal(compactText(await evaluationCount.innerText()), "평가횟수1건");
  const recentIssuesCard = page.getByRole("article", { name: "최근 발견 이슈" });
  assert.equal(compactText(await recentIssuesCard.locator(".site-recent-issue-count").innerText()), "총0건");
  assert.equal(await recentIssuesCard.getByText(brokenIssueTitle, { exact: true }).count(), 0);

  assert.ok(observed.brokenSummaryFailures >= 1);
  assert.ok(observed.healthySummaryLoads >= 1);
  assert.deepEqual([...observed.unknownRequests], []);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        brokenTarget: { retained: true, score: null },
        healthyTarget: { score: 88, issues: 1 },
        coldScoreRecovery: {
          failures: observed.healthyScoreFailures,
          successfulLoads: observed.healthyScoreLoads,
          partialBaselineRetained: true
        },
        brokenSummaryFailures: observed.brokenSummaryFailures,
        staleFallbacks: observed.healthySummaryFailures,
        issueFailureRecovery: {
          failures: observed.healthyIssueFailures,
          successfulLoads: observed.healthyIssueLoads
        },
        scoreFailureRecovery: {
          failures: observed.healthyScoreFailures,
          successfulLoads: observed.healthyScoreLoads
        },
        clockRollbackReloads,
        finalPath: new URL(page.url()).pathname
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
