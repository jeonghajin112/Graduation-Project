/**
 * Regression check: a newer pending or failed rescan must not hide the latest
 * materialized score and issues. Once a newer result is available, the UI must
 * switch to it, including the valid zero-issue case.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-rescan-result-retention.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const completedAt = "2026-08-09T10:00:00.000Z";
const rescanAt = "2026-08-10T10:00:00.000Z";
const oldIssueTitle = "기존 완료 검사에서 발견된 대체 텍스트 이슈";

const organization = {
  id: 1,
  name: "재스캔 회귀 검증 프로젝트",
  type: "ETC",
  homepageUrl: "https://example.com",
  description: "",
  status: "ACTIVE",
  createdAt: completedAt,
  updatedAt: rescanAt
};

const target = {
  id: 101,
  organizationId: organization.id,
  name: "재스캔 검증 페이지",
  targetType: "WEB",
  accessUrl: "https://example.com/page",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: completedAt,
  updatedAt: rescanAt
};

const completedRequest = {
  id: 501,
  evaluationTargetId: target.id,
  targetName: target.name,
  status: "COMPLETED",
  requestNote: "기존 완료 검사",
  requestedAt: completedAt,
  createdAt: completedAt,
  updatedAt: completedAt
};

const replacementRequest = {
  id: 502,
  evaluationTargetId: target.id,
  targetName: target.name,
  status: "PENDING",
  requestNote: "새 재스캔",
  requestedAt: rescanAt,
  createdAt: rescanAt,
  updatedAt: rescanAt
};

const oldSummary = {
  requestId: completedRequest.id,
  targetName: target.name,
  status: "COMPLETED",
  totalScore: 84,
  totalIssueCount: 1,
  criticalIssueCount: 1,
  requestedAt: completedAt
};

const newSummary = {
  requestId: replacementRequest.id,
  targetName: target.name,
  status: "COMPLETED",
  totalScore: 96,
  totalIssueCount: 0,
  criticalIssueCount: 0,
  requestedAt: rescanAt
};

const oldScore = {
  id: 1,
  evaluationRequestId: completedRequest.id,
  totalScore: 84,
  ruleScore: 82,
  aiScore: 85,
  cvScore: 86,
  createdAt: completedAt,
  updatedAt: completedAt
};

const newScore = {
  id: 2,
  evaluationRequestId: replacementRequest.id,
  totalScore: 96,
  ruleScore: 95,
  aiScore: 97,
  cvScore: 96,
  createdAt: rescanAt,
  updatedAt: rescanAt
};

const oldIssues = [
  {
    id: 9001,
    requestId: completedRequest.id,
    module: "rule_based",
    severity: "CRITICAL",
    title: oldIssueTitle,
    description: "이미지에 대체 텍스트가 필요합니다.",
    recommendation: "의미를 전달하는 대체 텍스트를 추가하세요.",
    selector: "main img:first-of-type",
    wcagCode: "5.1.1",
    createdAt: completedAt
  }
];

let phase = "pending";
const unknownPaths = new Set();

function currentReplacementRequest() {
  return {
    ...replacementRequest,
    status: phase === "completed" ? "COMPLETED" : phase === "failed" ? "FAILED" : "PENDING"
  };
}

function payloadFor(pathname) {
  if (/^\/api\/results\/requests\/\d+\/artifact$/.test(pathname)) return null;
  if (pathname === "/api/requests") return [completedRequest, currentReplacementRequest()];
  if (pathname === "/api/organizations") return [organization];
  if (pathname === `/api/organizations/${organization.id}/evaluation-targets`) return [target];
  if (pathname === `/api/targets/${target.id}`) return target;
  if (pathname === `/api/results/requests/${completedRequest.id}/summary`) return oldSummary;
  if (pathname === `/api/results/requests/${completedRequest.id}/issues`) return oldIssues;
  if (pathname === `/api/scores/requests/${completedRequest.id}`) return oldScore;

  if (phase === "completed") {
    if (pathname === `/api/results/requests/${replacementRequest.id}/summary`) return newSummary;
    if (pathname === `/api/results/requests/${replacementRequest.id}/issues`) return [];
    if (pathname === `/api/scores/requests/${replacementRequest.id}`) return newScore;
  }

  unknownPaths.add(pathname);
  return [];
}

function compactText(value) {
  return value.replace(/\s+/g, "");
}

async function openProjectPage(page) {
  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  const card = page.locator("article.dashboard-project-card").filter({
    has: page.getByRole("button", { name: `${target.name} 상세 보기`, exact: true })
  });
  await card.waitFor();
  return card;
}

async function assertProjectSnapshot(page, expectedStatus, expectedScore) {
  const card = await openProjectPage(page);
  assert.equal(
    compactText(await card.locator(".dashboard-project-card-status").innerText()),
    expectedStatus
  );
  assert.equal(
    await card.locator(".dashboard-project-card-score").getAttribute("aria-label"),
    `점수 ${expectedScore}점`
  );
}

async function openSitePage(page) {
  await page.goto(`${baseUrl}/projects/${organization.id}/pages/${target.id}`, {
    waitUntil: "networkidle"
  });
  const scoreCard = page.getByRole("article", { name: "접근성 점수 추이" });
  await scoreCard.waitFor();
  return {
    scoreCard,
    issueCard: page.getByRole("article", { name: "최근 발견 이슈" })
  };
}

async function assertSiteSnapshot(page, expectedScore, { keepsOldIssue }) {
  const { scoreCard, issueCard } = await openSitePage(page);
  const latestScore = scoreCard.locator(".site-summary-stat-item").filter({ hasText: "최신 점수" });
  assert.match(compactText(await latestScore.innerText()), new RegExp(`최신점수${expectedScore}점`));

  if (keepsOldIssue) {
    await issueCard.getByText(oldIssueTitle, { exact: true }).waitFor();
    assert.equal(compactText(await issueCard.locator(".site-recent-issue-count").innerText()), "총1건");
  } else {
    assert.equal(await issueCard.getByText(oldIssueTitle, { exact: true }).count(), 0);
    await issueCard.getByText("표시할 이슈가 없습니다.", { exact: true }).waitFor();
    assert.equal(compactText(await issueCard.locator(".site-recent-issue-count").innerText()), "총0건");
  }
}

async function assertDashboardIssues(page, expectedCount, { keepsOldIssue }) {
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  const openIssuesCard = page.locator("article.dashboard-card").filter({
    has: page.getByText("현재 미해결 이슈", { exact: true })
  });
  await openIssuesCard.waitFor();
  await openIssuesCard
    .getByRole("img", { name: new RegExp(`^현재 미해결 이슈 ${expectedCount}건\\.`) })
    .waitFor();

  if (keepsOldIssue) {
    await page.getByText(oldIssueTitle, { exact: true }).waitFor();
  } else {
    assert.equal(await page.getByText(oldIssueTitle, { exact: true }).count(), 0);
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payloadFor(pathname))
    });
  });

  phase = "pending";
  await assertProjectSnapshot(page, "진행중", 84);
  await assertSiteSnapshot(page, 84, { keepsOldIssue: true });
  await assertDashboardIssues(page, 1, { keepsOldIssue: true });

  phase = "failed";
  await assertProjectSnapshot(page, "실패", 84);
  await assertSiteSnapshot(page, 84, { keepsOldIssue: true });

  phase = "completed";
  await assertProjectSnapshot(page, "완료", 96);
  await assertSiteSnapshot(page, 96, { keepsOldIssue: false });
  await assertDashboardIssues(page, 0, { keepsOldIssue: false });

  assert.deepEqual([...unknownPaths], []);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        pending: { status: "진행중", retainedScore: 84, retainedIssues: 1 },
        failed: { status: "실패", retainedScore: 84, retainedIssues: 1 },
        completed: { status: "완료", score: 96, issues: 0 }
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
