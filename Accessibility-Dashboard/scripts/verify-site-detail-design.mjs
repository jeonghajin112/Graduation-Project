/**
 * Verifies the site-detail contract after the page was reduced to the replay
 * inspector only. The global sidebar remains, while the site header, rescan
 * action, score trend, summaries, and recent-issues card must not render.
 *
 * Usage: BASE_URL=http://localhost:41905 node scripts/verify-site-detail-design.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:41905";
const outDir = process.env.OUT_DIR ?? "artifacts/design-migration/site-detail";
const timestamp = "2026-07-29T04:09:00.000Z";

const organization = {
  id: 1,
  name: "페이지 검사 프로젝트",
  type: "ETC",
  homepageUrl: "https://example.com/",
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const target = {
  id: 101,
  organizationId: 1,
  name: "검사 대상",
  targetType: "WEB",
  accessUrl: "https://example.com/",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const request = {
  id: 501,
  evaluationTargetId: 101,
  targetName: target.name,
  status: "COMPLETED",
  requestNote: "검증",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};

const summary = {
  requestId: 501,
  targetName: target.name,
  status: "COMPLETED",
  totalScore: 35,
  totalIssueCount: 1,
  criticalIssueCount: 1,
  requestedAt: timestamp
};

const scoreResult = {
  id: 1,
  evaluationRequestId: 501,
  totalScore: 35,
  ruleScore: 30,
  aiScore: 40,
  cvScore: 35,
  createdAt: timestamp,
  updatedAt: timestamp
};

const issues = [
  {
    id: 9001,
    requestId: 501,
    module: "rule_based",
    severity: "CRITICAL",
    title: "대체 텍스트 누락",
    description: "이미지에 대체 텍스트가 없습니다.",
    recommendation: "대체 텍스트를 추가하세요.",
    selector: "#hero-image",
    wcagCode: "5.1.1",
    createdAt: timestamp
  }
];

function payloadFor(pathname) {
  if (pathname === "/api/requests") return [request];
  if (pathname === "/api/organizations") return [organization];
  if (pathname === "/api/organizations/1/evaluation-targets") return [target];
  if (pathname === "/api/results/requests/501/summary") return summary;
  if (pathname === "/api/results/requests/501/issues") return issues;
  if (pathname === "/api/scores/requests/501") return scoreResult;
  if (pathname === "/api/targets/101") return target;
  return [];
}

async function installFixture(page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/results/requests/501/artifact") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ success: false, message: "artifact not found" })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payloadFor(pathname))
    });
  });
}

async function auditViewport(browser, theme, viewport, report) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript((mode) => window.localStorage.setItem("bridge-theme", mode), theme);
  await installFixture(page);
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "networkidle" });

  const evidence = page.locator(".site-page-evidence-card");
  await evidence.waitFor({ state: "visible" });
  const facts = await page.evaluate(() => {
    const evidenceElement = document.querySelector(".site-page-evidence-card");
    const contentZone = document.querySelector(".dashboard-site-content-zone");
    const topZone = document.querySelector(".dashboard-top-zone");
    const controls = [...document.querySelectorAll(".site-page-evidence-toolbar button")];
    const evidenceRect = evidenceElement?.getBoundingClientRect();
    const contentRect = contentZone?.getBoundingClientRect();
    const contentStyle = contentZone ? getComputedStyle(contentZone) : null;
    const contentInnerTop = contentRect
      ? contentRect.top + Number.parseFloat(contentStyle?.paddingTop || "0")
      : 0;
    const contentInnerBottom = contentRect
      ? contentRect.bottom - Number.parseFloat(contentStyle?.paddingBottom || "0")
      : 0;
    const contentInnerHeight = Math.max(1, contentInnerBottom - contentInnerTop);
    return {
      contentCardCount: document.querySelectorAll(".dashboard-site-content-zone .dashboard-card").length,
      evidenceCount: document.querySelectorAll(".site-page-evidence-card").length,
      scoreCardCount: document.querySelectorAll(".site-score-trend-card").length,
      recentIssuesCount: document.querySelectorAll(".site-recent-issues-card").length,
      siteTitleCount: document.querySelectorAll("#dashboard-site-page-title").length,
      scanActionCount: document.querySelectorAll(".dashboard-site-scan-action").length,
      topZoneHeight: topZone?.getBoundingClientRect().height ?? -1,
      evidenceWidth: evidenceRect?.width ?? 0,
      evidenceHeight: evidenceRect?.height ?? 0,
      cardFillRatio: (evidenceRect?.height ?? 0) / contentInnerHeight,
      unusedBottom: Math.max(0, contentInnerBottom - (evidenceRect?.bottom ?? 0)),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controlHeights: controls.map((control) => control.getBoundingClientRect().height)
    };
  });

  assert.equal(facts.contentCardCount, 1);
  assert.equal(facts.evidenceCount, 1);
  assert.equal(facts.scoreCardCount, 0);
  assert.equal(facts.recentIssuesCount, 0);
  assert.equal(facts.siteTitleCount, 0);
  assert.equal(facts.scanActionCount, 0);
  assert.equal(facts.topZoneHeight, 0);
  assert.ok(facts.evidenceWidth > 0 && facts.evidenceWidth <= viewport.width);
  assert.ok(facts.horizontalOverflow <= 1);
  if (viewport.width >= 1024) {
    assert.ok(facts.cardFillRatio >= 0.9);
    assert.ok(facts.unusedBottom <= Math.max(4, viewport.height * 0.01));
  }
  if (viewport.width <= 767) {
    assert.ok(facts.controlHeights.every((height) => height >= 44));
  }

  mkdirSync(outDir, { recursive: true });
  await page.screenshot({
    path: `${outDir}/evidence-only-${theme}-${viewport.width}x${viewport.height}.png`,
    fullPage: false
  });
  report.push({ theme, viewport: `${viewport.width}x${viewport.height}`, ...facts });
  await page.close();
}

const browser = await chromium.launch({ headless: true });
const report = [];

try {
  await auditViewport(browser, "light", { width: 1440, height: 900 }, report);
  await auditViewport(browser, "dark", { width: 1440, height: 900 }, report);
  await auditViewport(browser, "light", { width: 1920, height: 1080 }, report);
  await auditViewport(browser, "light", { width: 1024, height: 768 }, report);
  await auditViewport(browser, "light", { width: 390, height: 844 }, report);
  console.log(JSON.stringify({ result: "PASS", report }, null, 2));
} finally {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/design-facts.json`, JSON.stringify({ report }, null, 2), "utf8");
  await browser.close();
}
