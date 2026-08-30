import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const outDir = process.env.OUT_DIR ?? "artifacts/site-dashboard-rail";
const capturedAt = "2026-08-11T03:30:00.000Z";

const organization = {
  id: 1,
  name: "Rail Fixture Project",
  type: "ETC",
  homepageUrl: "https://example.com",
  description: "",
  status: "ACTIVE",
  createdAt: capturedAt,
  updatedAt: capturedAt
};
const target = {
  id: 101,
  organizationId: 1,
  name: "Rail Fixture Page",
  targetType: "WEB",
  accessUrl: "https://example.com/fixture",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: capturedAt,
  updatedAt: capturedAt
};
const request = {
  id: 501,
  evaluationTargetId: 101,
  targetName: target.name,
  status: "COMPLETED",
  requestNote: "",
  requestedAt: capturedAt,
  createdAt: capturedAt,
  updatedAt: capturedAt
};
const summary = {
  requestId: 501,
  targetName: target.name,
  status: "COMPLETED",
  totalScore: 37.8,
  totalIssueCount: 6,
  criticalIssueCount: 1,
  requestedAt: capturedAt
};
const scoreResult = {
  id: 1,
  evaluationRequestId: 501,
  totalScore: 37.8,
  ruleScore: 42.8,
  aiScore: 0,
  cvScore: 82,
  createdAt: capturedAt,
  updatedAt: capturedAt
};

function locator(selector, htmlSnippet) {
  return {
    kind: "DOM_PATH",
    pathSteps: [{ context: "MAIN_DOCUMENT", selector, frameUrl: null }],
    x: null,
    y: null,
    width: null,
    height: null,
    coordinateSpace: null,
    visible: true,
    htmlSnippet
  };
}

// Wire-shaped EvaluationIssue records: the dashboard derives analysis results
// and UI severities from these, so the fixture must match the /issues contract.
// Use the identifiers emitted by the real backend: mapped findings use numeric
// KWCAG codes while reading level remains an explicit WCAG reference.
const issues = [
  { id: 9001, severity: "CRITICAL", wcagCode: "5.4.4", title: "콘텐츠 간의 구분", selector: "#a1" },
  { id: 9002, severity: "SERIOUS", wcagCode: "5.4.4", title: "콘텐츠 간의 구분", selector: "#a2" },
  { id: 9003, severity: "MINOR", wcagCode: "5.4.4", title: "콘텐츠 간의 구분", selector: "#a3" },
  { id: 9004, severity: "SERIOUS", wcagCode: "5.4.3", title: "텍스트 명도 대비", selector: "#c1" },
  { id: 9005, severity: "MODERATE", wcagCode: "5.4.3", title: "텍스트 명도 대비", selector: "#c2" },
  { id: 9006, severity: "MODERATE", wcagCode: "WCAG 3.1.5", title: "읽기 수준", selector: "#k1" }
].map((entry) => ({
  id: entry.id,
  requestId: 501,
  module: "rule_based",
  severity: entry.severity,
  title: entry.title,
  description: "설명",
  recommendation: null,
  selector: entry.selector,
  locator: locator(entry.selector, "<div>" + entry.selector + "</div>"),
  wcagCode: entry.wcagCode,
  createdAt: capturedAt
}));

const artifact = {
  id: 77,
  requestId: 501,
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  capturedAt,
  viewportWidthCssPx: 1280,
  viewportHeightCssPx: 720,
  deviceScaleFactor: 1,
  pageWidthCssPx: 1280,
  pageHeightCssPx: 1600,
  captureMode: "DOM_REPLAY",
  contentUrl: "/results/artifacts/77/content",
  contentType: "text/html",
  sizeBytes: 12345,
  sha256: "a".repeat(64),
  createdAt: capturedAt,
  updatedAt: capturedAt
};

const replayHtml = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>재현</title>
<style>body{margin:0;min-height:1200px;background:#f4f6f9;font-family:Arial}
section{margin:24px;padding:24px;border-radius:14px;background:#fff}</style></head>
<body>
<section><h1>재현된 페이지</h1><div id="a1">img1</div><div id="a2">img2</div><div id="a3">img3</div></section>
<section><div id="c1">대비1</div><div id="c2">대비2</div><div id="k1">포커스</div></section>
<div id="replay-markers"></div>
<script>
(() => {
  const VIEWER_SOURCE = "accessibility-page-replay";
  const DOCUMENT_TOKEN = "doc_" + Date.now().toString(36);
  const state = { issues: [], selectedIssueId: null };
  window.__replayMessages = [];
  function post(message) {
    parent.postMessage({ ...message, source: VIEWER_SOURCE, documentToken: DOCUMENT_TOKEN }, "*");
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.source !== "accessibility-dashboard") return;
    window.__replayMessages.push(message);
    if (message.type === "INIT_ISSUES" && Array.isArray(message.issues)) {
      state.issues = message.issues;
      post({ type: "REPLAY_READY", documentHeight: document.documentElement.scrollHeight });
    }
    if (message.type === "SELECT_ISSUE") {
      state.selectedIssueId = message.issueId;
      document.title = "selected:" + message.issueId;
    }
  });
  post({ type: "REPLAY_READY", documentHeight: document.documentElement.scrollHeight });
})();
</script>
</body></html>`;

const overview = createDashboardOverview({
  organizations: [organization],
  organizations: [organization],
  evaluationTargets: [target],
  evaluationRequests: [request],
  resultSummaries: [summary],
  scoreResults: [scoreResult],
  latestIssueCounts: [{
    evaluationTargetId: 101,
    requestId: 501,
    totalIssueCount: issues.length,
    criticalIssueCount: 1,
    highIssueCount: 2,
    mediumIssueCount: 2,
    lowIssueCount: 1,
    // The API contract cross-checks every severity tally against the groups,
    // so each group carries the UI severity of its own issue.
    groups: [
      { issueCode: "5.4.4", issueTitle: "콘텐츠 간의 구분", severity: "CRITICAL", count: 1 },
      { issueCode: "5.4.4", issueTitle: "콘텐츠 간의 구분", severity: "HIGH", count: 1 },
      { issueCode: "5.4.4", issueTitle: "콘텐츠 간의 구분", severity: "LOW", count: 1 },
      { issueCode: "5.4.3", issueTitle: "텍스트 명도 대비", severity: "HIGH", count: 1 },
      { issueCode: "5.4.3", issueTitle: "텍스트 명도 대비", severity: "MEDIUM", count: 1 },
      { issueCode: "WCAG 3.1.5", issueTitle: "읽기 수준", severity: "MEDIUM", count: 1 }
    ]
  }]
});

const requestLog = [];

function payloadFor(pathname, artifactAvailable = true) {
  if (pathname === "/api/requests") return [request];
  if (pathname === "/api/organizations") return [organization];
  if (pathname === "/api/organizations/1/evaluation-targets") return [target];
  if (pathname === "/api/results/requests/501/summary") return summary;
  if (pathname === "/api/results/requests/501/issues") return issues;
  if (pathname === "/api/results/requests/501/artifact") {
    return artifactAvailable ? artifact : null;
  }
  if (pathname === "/api/scores/requests/501") return scoreResult;
  if (pathname === "/api/targets/101") return target;
  return [];
}

async function installFixture(page, { artifactAvailable = true } = {}) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requestLog.push(route.request().method() + " " + pathname);
    if (route.request().method() === "GET" && pathname === "/api/dashboard/overview") {
      await fulfillJson(route, overview);
      return;
    }
    if (pathname === "/api/results/artifacts/77/content") {
      await route.fulfill({ status: 200, contentType: "text/html", body: replayHtml });
      return;
    }
    await fulfillJson(route, payloadFor(pathname, artifactAvailable));
  });
}

async function verifyRailWithoutArtifact(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await installFixture(page, { artifactAvailable: false });
    await page.goto(baseUrl + "/projects/1/pages/101", { waitUntil: "domcontentloaded" });

    await page
      .getByText("이 스캔에는 재현 페이지가 없어요", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });

    const pageInformationCard = page.locator(".site-page-information");
    const severityCard = page.locator(".site-rail-card", { hasText: "심각도 분포" });
    await pageInformationCard.waitFor({ state: "visible", timeout: 20_000 });
    await severityCard.waitFor({ state: "visible", timeout: 20_000 });

    assert.equal(
      await page.locator(".site-rail-severity__row").count(),
      4,
      "severity results must remain visible without a replay artifact"
    );
    assert.equal(
      await page.locator(".site-rail-issue").count(),
      0,
      "the removed top-issue shortcut card must not return without a replay artifact"
    );
    assert.equal(
      await pageInformationCard.getByText("Rail Fixture Page", { exact: true }).count(),
      1,
      "page identity must remain available without a replay artifact"
    );
    assert.equal(
      await pageInformationCard.getByText("-", { exact: true }).count(),
      1,
      "missing replay dimensions must use an explicit fallback"
    );
    assert.deepEqual(pageErrors, [], "the artifact-empty page must render without runtime errors");

    return {
      pageInformationCards: await page.locator(".site-page-information").count(),
      severityRows: await page.locator(".site-rail-severity__row").count()
    };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await installFixture(page);
  await page.goto(baseUrl + "/projects/1/pages/101", { waitUntil: "domcontentloaded" });

  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  try {
    await evidence.waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      bodyText: document.body.innerText.slice(0, 600),
      cards: document.querySelectorAll(".dashboard-card").length,
      layout: document.querySelector(".site-dashboard-layout") !== null
    }));
    throw new Error(
      "evidence card never appeared: " +
        JSON.stringify({ diagnostics, requests: requestLog.slice(0, 40), pageErrors })
    );
  }

  const rail = page.locator(".site-dashboard-rail");
  await rail.waitFor({ state: "visible", timeout: 20_000 });

  // Page identity is always available; severity mounts once result details are ready.
  const pageInformationCard = page.locator(".site-page-information");
  const severityCard = page.locator(".site-rail-card", { hasText: "심각도 분포" });
  const issuesCard = page.locator(".site-rail-card", { hasText: "가장 많이 발견된 항목" });
  const moduleCard = page.locator(".site-rail-card", { hasText: "모듈별 점수" });
  await pageInformationCard.waitFor({ state: "visible", timeout: 20_000 });
  await severityCard.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await issuesCard.count(), 0, "the removed top-issue card must not render");
  assert.equal(await moduleCard.count(), 0, "the removed module score card must not render");

  const pageInformation = await pageInformationCard.evaluate((card) => ({
    name: card.querySelector(".site-page-information__title strong")?.textContent?.trim(),
    url: card.querySelector(".site-page-information__title a")?.textContent?.trim(),
    metadata: Array.from(card.querySelectorAll(".site-page-information__metadata > div")).map((row) => ({
      label: row.querySelector("dt")?.textContent?.trim(),
      value: row.querySelector("dd")?.textContent?.trim()
    }))
  }));
  assert.deepEqual(
    pageInformation,
    {
      name: "Rail Fixture Page",
      url: "https://example.com/fixture",
      metadata: [
        { label: "대상", value: "PC 웹" },
        { label: "최근 분석", value: "2026-08-11 12:30" },
        { label: "재현 화면", value: "1,280 × 720 px" }
      ]
    },
    "page information must use the selected target and latest replay metadata"
  );
  const railCardOrder = await page.locator(".site-dashboard-rail > *").evaluateAll((cards) =>
    cards.map((card) => card.textContent?.trim() ?? "")
  );
  assert.ok(railCardOrder[0]?.includes("페이지 정보"), "page information must lead the rail");
  assert.ok(railCardOrder[1]?.includes("최근 분석 추이"), "analysis trend must follow page information");
  assert.ok(railCardOrder[2]?.includes("심각도 분포"), "severity distribution must follow the trend");

  // Severity counts must match the issue list exactly.
  const severityCounts = await page.locator(".site-rail-severity__row").evaluateAll((rows) =>
    rows.map((row) => ({
      label: row.querySelector(".site-rail-severity__name")?.textContent?.trim(),
      count: Number(row.getAttribute("aria-label")?.replace(/[^0-9]/g, ""))
    }))
  );
  assert.deepEqual(
    severityCounts,
    [
      { label: "심각", count: 1 },
      { label: "높음", count: 2 },
      { label: "중간", count: 2 },
      { label: "낮음", count: 1 }
    ],
    "severity distribution must mirror the latest issue list"
  );
  assert.equal(
    await severityCard.getByText(/이번 분석 .*건의 구성/).count(),
    0,
    "the redundant severity composition subtitle must not render"
  );
  assert.equal(
    await severityCard.getByText("발견된 문제를 심각도별로 보여줍니다.", { exact: true }).count(),
    1,
    "the severity card must retain a concise count-free explanation"
  );
  assert.ok(
    !(await severityCard.textContent())?.includes("%"),
    "the vertical severity chart must show counts without percentage labels"
  );
  const severityFillColors = await page.locator(".site-rail-severity__fill").evaluateAll((fills) =>
    fills.map((fill) => getComputedStyle(fill).backgroundColor)
  );
  assert.equal(
    new Set(severityFillColors).size,
    1,
    "all severity bars must use the single dashboard key color"
  );
  assert.equal(
    await page.locator(".site-rail-severity__count").count(),
    0,
    "severity counts must not remain persistently visible above the bars"
  );
  const severityRows = page.locator(".site-rail-severity__row");
  const firstSeverityTooltip = severityRows.first().locator(".site-rail-severity__tooltip");
  assert.equal(await firstSeverityTooltip.isVisible(), false, "severity tooltips must start hidden");
  await severityRows.first().hover();
  await firstSeverityTooltip.waitFor({ state: "visible", timeout: 1_000 });
  assert.equal(await firstSeverityTooltip.textContent(), "심각 · 1건");
  await severityRows.nth(1).focus();
  const focusedSeverityTooltip = severityRows.nth(1).locator(".site-rail-severity__tooltip");
  await focusedSeverityTooltip.waitFor({ state: "visible", timeout: 1_000 });
  assert.equal(await focusedSeverityTooltip.textContent(), "높음 · 2건");
  const severityGeometry = await page
    .locator(".site-rail-severity__row")
    .first()
    .evaluate((row) => {
      const track = row.querySelector(".site-rail-severity__track");
      const fill = row.querySelector(".site-rail-severity__fill");
      if (!(track instanceof HTMLElement) || !(fill instanceof HTMLElement)) {
        return null;
      }

      const trackRect = track.getBoundingClientRect();
      const fillRect = fill.getBoundingClientRect();
      return {
        trackWidth: trackRect.width,
        trackHeight: trackRect.height,
        fillWidth: fillRect.width,
        trackBackground: getComputedStyle(track).backgroundColor
      };
    });
  assert.ok(severityGeometry, "the severity chart geometry must be measurable");
  assert.ok(
    severityGeometry.trackHeight > severityGeometry.trackWidth,
    "severity tracks must be vertical"
  );
  assert.ok(
    Math.abs(severityGeometry.fillWidth - severityGeometry.trackWidth) < 1,
    "severity fills must occupy the vertical track width"
  );
  assert.equal(
    severityGeometry.trackBackground,
    "rgba(0, 0, 0, 0)",
    "vertical severity tracks must not render an empty gray rail"
  );

  // The rail must sit beside the replay card and must not overflow it.
  const geometry = await page.evaluate(() => {
    const layout = document.querySelector(".site-dashboard-layout");
    const railElement = document.querySelector(".site-dashboard-rail");
    const card = document.querySelector(".site-page-evidence-card");
    const layoutRect = layout.getBoundingClientRect();
    const railRect = railElement.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      columns: getComputedStyle(layout).gridTemplateColumns,
      railLeft: Math.round(railRect.left),
      railTop: Math.round(railRect.top),
      railWidth: Math.round(railRect.width),
      railHeight: Math.round(railRect.height),
      cardRight: Math.round(cardRect.right),
      cardHeight: Math.round(cardRect.height),
      layoutRight: Math.round(layoutRect.right),
      horizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    };
  });
  assert.ok(
    geometry.railLeft >= geometry.cardRight - 2,
    "the rail must sit to the right of the replay card, not overlap it"
  );
  assert.ok(
    geometry.railLeft + geometry.railWidth <= geometry.layoutRight + 2,
    "the rail must stay inside the layout"
  );
  assert.equal(geometry.horizontalOverflow, 0, "the rail must not introduce horizontal overflow");
  assert.equal(
    geometry.columns.split(" ").length,
    2,
    "the desktop layout keeps two columns: " + geometry.columns
  );

  // Accessible names must survive: each remaining card is a labelled section.
  const headingCount = await page.locator(".site-rail-card__heading h3").count();
  assert.equal(headingCount, 2, "each remaining detail card exposes a heading");

  // The page URL is actionable and keeps a keyboard-visible focus ring.
  const pageInformationLink = pageInformationCard.locator(".site-page-information__title a");
  await pageInformationLink.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const focusOutline = await pageInformationLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      isFocused: element === document.activeElement,
      matchesFocusVisible: element.matches(":focus-visible"),
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle
    };
  });
  assert.equal(focusOutline.isFocused, true, "tabbing must land on the page URL");
  assert.ok(
    focusOutline.matchesFocusVisible,
    "keyboard focus must satisfy :focus-visible: " + JSON.stringify(focusOutline)
  );
  assert.notEqual(
    focusOutline.outlineStyle,
    "none",
    "the page URL must keep a visible focus ring: " + JSON.stringify(focusOutline)
  );

  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, "rail-desktop.png"), fullPage: false });

  // Narrow viewport: the rail stacks under the replay card without overflow.
  await page.setViewportSize({ width: 900, height: 1100 });
  await page.waitForTimeout(300);
  const narrow = await page.evaluate(() => ({
    columns: getComputedStyle(document.querySelector(".site-dashboard-layout")).gridTemplateColumns,
    horizontalOverflow: Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  }));
  assert.equal(narrow.horizontalOverflow, 0, "the stacked rail must not overflow horizontally");
  await page.screenshot({ path: path.join(outDir, "rail-narrow.png"), fullPage: false });

  assert.deepEqual(pageErrors, [], "the page must render without runtime errors");
  const artifactEmpty = await verifyRailWithoutArtifact(browser);
  console.log(JSON.stringify({
    result: "PASS",
    artifactEmpty,
    pageInformation,
    severityCounts,
    geometry,
    narrow
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
