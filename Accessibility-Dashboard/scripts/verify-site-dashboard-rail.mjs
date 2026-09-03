import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import {
  TEST_LIVE_REPORT_VIEWER_ORIGIN,
  createTestLiveReportSession,
  createTestLiveReportViewerHtml
} from "./fixtures/live-report-viewer-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const outDir = process.env.OUT_DIR ?? "artifacts/site-dashboard-rail";
const capturedAt = "2026-08-11T03:30:00.000Z";

function parseAlpha(value) {
  const matched = value.match(/-?[\d.]+/g);
  return matched && matched.length >= 4 ? Number(matched[3]) : 1;
}

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

async function readResponsiveRailMetrics(page) {
  return page.evaluate(() => {
    const layout = document.querySelector(".site-dashboard-layout");
    const rail = document.querySelector(".site-dashboard-rail");
    const evidence = document.querySelector(".site-page-evidence-grid-item");
    const card = document.querySelector(".site-page-information");
    const heading = document.querySelector(".site-rail-card__heading h3");
    const body = document.querySelector(".site-page-evidence-trend-heading p");
    const caption = document.querySelector(".site-page-information__title a");
    const metric = document.querySelector(".site-page-evidence-trend-metrics strong");
    const chart = document.querySelector(".site-page-evidence-trend-chart");
    const severityTrack = document.querySelector(".site-rail-severity__track");
    if (!(layout instanceof HTMLElement)
        || !(rail instanceof HTMLElement)
        || !(evidence instanceof HTMLElement)
        || !(card instanceof HTMLElement)
        || !(heading instanceof HTMLElement)
        || !(body instanceof HTMLElement)
        || !(caption instanceof HTMLElement)
        || !(metric instanceof HTMLElement)
        || !(chart instanceof HTMLElement)
        || !(severityTrack instanceof HTMLElement)) {
      return null;
    }

    const layoutStyle = getComputedStyle(layout);
    const cardStyle = getComputedStyle(card);
    return {
      viewportWidth: window.innerWidth,
      layoutWidth: layout.getBoundingClientRect().width,
      evidenceWidth: evidence.getBoundingClientRect().width,
      railWidth: rail.getBoundingClientRect().width,
      cardWidth: card.getBoundingClientRect().width,
      railCardWidths: Array.from(rail.children).map((element) =>
        element.getBoundingClientRect().width
      ),
      railCardOverflows: Array.from(rail.children).map((element) =>
        Math.max(0, element.scrollWidth - element.clientWidth)
      ),
      cardPaddingInline: Number.parseFloat(cardStyle.paddingLeft)
        + Number.parseFloat(cardStyle.paddingRight),
      headingFontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
      bodyFontSize: Number.parseFloat(getComputedStyle(body).fontSize),
      captionFontSize: Number.parseFloat(getComputedStyle(caption).fontSize),
      metricFontSize: Number.parseFloat(getComputedStyle(metric).fontSize),
      chartHeight: chart.getBoundingClientRect().height,
      severityTrackWidth: severityTrack.getBoundingClientRect().width,
      severityTrackHeight: severityTrack.getBoundingClientRect().height,
      columns: layoutStyle.gridTemplateColumns,
      layoutOverflow: Math.max(0, layout.scrollWidth - layout.clientWidth),
      railOverflow: Math.max(0, rail.scrollWidth - rail.clientWidth),
      horizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    };
  });
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

const captureMetadata = {
  id: 77,
  requestId: 501,
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  capturedAt,
  viewportWidthCssPx: 1280,
  viewportHeightCssPx: 720,
  deviceScaleFactor: 1,
  pageWidthCssPx: 1280,
  pageHeightCssPx: 1600
};
const liveSession = createTestLiveReportSession(request.id, "rail_501");
const liveViewerHtml = createTestLiveReportViewerHtml({
  body: "<main><h1>동적 페이지</h1><section>페이지 검사 화면 fixture</section></main>",
  documentToken: "rail_live_document",
  session: liveSession
});

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

function payloadFor(pathname, fixtureTarget = target) {
  if (pathname === "/api/requests") return [request];
  if (pathname === "/api/organizations") return [organization];
  if (pathname === "/api/organizations/1/evaluation-targets") return [fixtureTarget];
  if (pathname === "/api/results/requests/501/summary") return summary;
  if (pathname === "/api/results/requests/501/issues") return issues;
  if (pathname === "/api/results/requests/501/capture-metadata") return captureMetadata;
  if (pathname === "/api/targets/101") return fixtureTarget;
  return [];
}

async function installFixture(
  page,
  { faviconUrl = target.faviconUrl, liveAvailable = true } = {}
) {
  const hasFaviconOverride = faviconUrl !== target.faviconUrl;
  const fixtureTarget = hasFaviconOverride ? { ...target, faviconUrl } : target;
  const fixtureOverview = hasFaviconOverride
    ? {
        ...overview,
        organizations: overview.organizations.map((fixtureOrganization) => ({
          ...fixtureOrganization,
          evaluationTargets: fixtureOrganization.evaluationTargets.map((evaluationTarget) =>
            evaluationTarget.id === fixtureTarget.id ? fixtureTarget : evaluationTarget
          )
        }))
      }
    : overview;

  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const pathname = requestUrl.pathname;
    requestLog.push(route.request().method() + " " + pathname);
    if (requestUrl.origin === TEST_LIVE_REPORT_VIEWER_ORIGIN) {
      await route.fulfill({ status: 200, contentType: "text/html", body: liveViewerHtml });
      return;
    }
    if (route.request().method() === "GET" && pathname === "/api/dashboard/overview") {
      await fulfillJson(route, fixtureOverview);
      return;
    }
    if (route.request().method() === "POST" && pathname === "/api/results/requests/501/live-session") {
      await fulfillJson(route, liveAvailable ? liveSession : null);
      return;
    }
    await fulfillJson(route, payloadFor(pathname, fixtureTarget));
  });
}

async function readPageInformationFaviconPresentation(page) {
  return page.locator(".site-page-information__icon").evaluate((element) => {
    const style = getComputedStyle(element);
    const image = element.querySelector("img");
    const bounds = element.getBoundingClientRect();
    const imageBounds = image?.getBoundingClientRect();
    return {
      loaded: element.dataset.faviconLoaded,
      borderTopWidth: style.borderTopWidth,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      fallbackIconCount: element.querySelectorAll("svg").length,
      imageCount: element.querySelectorAll("img").length,
      imageOpacity: image ? getComputedStyle(image).opacity : null,
      imageObjectFit: image ? getComputedStyle(image).objectFit : null,
      imageFillsContainer: imageBounds
        ? Math.abs(imageBounds.width - bounds.width) < 0.5
          && Math.abs(imageBounds.height - bounds.height) < 0.5
        : null
    };
  });
}

async function verifyPageInformationFaviconPresentation(browser) {
  const faviconUrl = `${baseUrl}/__test-assets__/page-information-favicon.svg`;
  const missingFaviconUrl = `${baseUrl}/__test-assets__/missing-page-information-favicon.svg`;
  const loadedPage = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await loadedPage.route("**/__test-assets__/page-information-favicon.svg", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#0071e3"/></svg>'
    })
  );
  await installFixture(loadedPage, { liveAvailable: false, faviconUrl });
  await loadedPage.goto(baseUrl + "/projects/1/pages/101", { waitUntil: "domcontentloaded" });
  await loadedPage
    .locator('.site-page-information__icon[data-favicon-loaded="true"]')
    .waitFor({ timeout: 20_000 });
  const loaded = await readPageInformationFaviconPresentation(loadedPage);
  await loadedPage.close();

  const fallbackPage = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await fallbackPage.route("**/__test-assets__/missing-page-information-favicon.svg", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "missing" })
  );
  await installFixture(fallbackPage, {
    liveAvailable: false,
    faviconUrl: missingFaviconUrl
  });
  await fallbackPage.goto(baseUrl + "/projects/1/pages/101", { waitUntil: "domcontentloaded" });
  await fallbackPage.waitForFunction(() => {
    const favicon = document.querySelector(
      '.site-page-information__icon[data-favicon-loaded="false"]'
    );
    return favicon && !favicon.querySelector("img");
  });
  const fallback = await readPageInformationFaviconPresentation(fallbackPage);
  await fallbackPage.close();

  assert.equal(loaded.loaded, "true", "a loaded page favicon must enter the loaded state");
  assert.equal(loaded.borderTopWidth, "0px", "a loaded page favicon must not keep its tile border");
  assert.equal(loaded.borderRadius, "0px", "a loaded page favicon must keep its native silhouette");
  assert.equal(parseAlpha(loaded.backgroundColor), 0, "a loaded page favicon must use a transparent surface");
  assert.equal(loaded.fallbackIconCount, 0, "a loaded page favicon must hide the fallback icon");
  assert.equal(loaded.imageCount, 1, "a loaded page favicon image must remain rendered");
  assert.equal(loaded.imageOpacity, "1", "a loaded page favicon image must be visible");
  assert.equal(loaded.imageObjectFit, "contain", "a loaded page favicon must preserve its aspect ratio");
  assert.equal(loaded.imageFillsContainer, true, "a loaded page favicon must use the full icon area");

  assert.equal(fallback.loaded, "false", "a failed page favicon must remain in the fallback state");
  assert.ok(
    Number.parseFloat(fallback.borderTopWidth) > 0,
    "a failed page favicon must retain the fallback tile border"
  );
  assert.ok(
    parseAlpha(fallback.backgroundColor) > 0,
    "a failed page favicon must retain the fallback tile surface"
  );
  assert.equal(fallback.fallbackIconCount, 1, "a failed page favicon must retain the globe fallback");
  assert.equal(fallback.imageCount, 0, "a failed page favicon image must be removed");

  return { loaded, fallback };
}

async function verifyRailWithoutLiveSession(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await installFixture(page, { liveAvailable: false });
    await page.goto(baseUrl + "/projects/1/pages/101", { waitUntil: "domcontentloaded" });

    await page
      .getByText("현재 동적 페이지를 열지 못했어요", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });

    const pageInformationCard = page.locator(".site-page-information");
    const severityCard = page.locator(".site-rail-card", { hasText: "심각도 분포" });
    await pageInformationCard.waitFor({ state: "visible", timeout: 20_000 });
    await severityCard.waitFor({ state: "visible", timeout: 20_000 });

    assert.equal(
      await page.locator(".site-rail-severity__row").count(),
      4,
      "severity results must remain visible when the live page is unavailable"
    );
    assert.equal(
      await page.locator(".site-rail-issue").count(),
      0,
      "the removed top-issue shortcut card must not return when the live page is unavailable"
    );
    assert.equal(
      await pageInformationCard.getByText("Rail Fixture Page", { exact: true }).count(),
      1,
      "page identity must remain available when the live page is unavailable"
    );
    assert.deepEqual(
      await pageInformationCard.locator(".site-page-information__metadata dt").allTextContents(),
      ["최근 분석"],
      "page information must omit target type and capture dimensions"
    );
    assert.deepEqual(pageErrors, [], "the live-only error state must render without runtime errors");

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
      metadata: [{ label: "최근 분석", value: "2026-08-11 12:30" }]
    },
    "page information must keep only the selected page identity and latest analysis time"
  );
  assert.equal(
    (await evidence.textContent())?.includes("2026-08-11 12:30"),
    false,
    "the replay card must not repeat the latest analysis time"
  );
  assert.equal(
    (await pageInformationCard.textContent())?.match(/2026-08-11 12:30/g)?.length,
    1,
    "the latest analysis time must appear once in page information"
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

  // The right rail must scale with the layout instead of staying frozen at its
  // former 22rem cap on 4K-class viewports.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(300);
  const fullHdRail = await readResponsiveRailMetrics(page);
  assert.ok(fullHdRail, "the Full HD rail geometry must be measurable");

  await page.setViewportSize({ width: 3840, height: 1800 });
  await page.waitForTimeout(300);
  const fourKRail = await readResponsiveRailMetrics(page);
  assert.ok(fourKRail, "the 4K rail geometry must be measurable");
  assert.equal(fullHdRail.horizontalOverflow, 0, "the Full HD rail must not overflow horizontally");
  assert.equal(fourKRail.horizontalOverflow, 0, "the 4K rail must not overflow horizontally");
  assert.equal(fullHdRail.columns.split(" ").length, 2, "Full HD must retain the two-column layout");
  assert.equal(fourKRail.columns.split(" ").length, 2, "4K must retain the two-column layout");
  assert.ok(
    fullHdRail.railWidth >= 330 && fullHdRail.railWidth <= 360,
    "Full HD must retain the established compact rail width: " + JSON.stringify(fullHdRail)
  );
  assert.ok(
    fourKRail.railWidth >= fullHdRail.railWidth * 1.75,
    "the 4K rail must grow in proportion to the larger evidence canvas: "
      + JSON.stringify({ fullHdRail, fourKRail })
  );
  assert.ok(
    fourKRail.railWidth >= 640,
    "the 4K rail must provide a readable supporting column instead of stopping at 32rem: "
      + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.railWidth / fourKRail.layoutWidth >= 0.21
      && fourKRail.railWidth / fourKRail.layoutWidth <= 0.24,
    "the 4K rail must stay balanced with the replay canvas: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.evidenceWidth >= fourKRail.layoutWidth * 0.74,
    "the wider rail must still leave most of the 4K layout to the replay canvas: "
      + JSON.stringify(fourKRail)
  );
  assert.equal(fullHdRail.layoutOverflow, 0, "the Full HD layout must not clip internal content");
  assert.equal(fullHdRail.railOverflow, 0, "the Full HD rail must not clip internal content");
  assert.equal(fourKRail.layoutOverflow, 0, "the 4K layout must not clip internal content");
  assert.equal(fourKRail.railOverflow, 0, "the 4K rail must not clip internal content");
  assert.ok(
    fourKRail.railCardWidths.every((width) => Math.abs(width - fourKRail.railWidth) < 2),
    "every rail card must consume the responsive rail width: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.railCardOverflows.every((overflow) => overflow === 0),
    "responsive rail cards must not overflow internally: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.cardPaddingInline >= 52,
    "4K cards must use proportionate internal padding: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.headingFontSize >= 17.5,
    "4K rail headings must remain readable at normal viewing distance: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.captionFontSize >= 13.5,
    "4K supporting text must not remain at the compact desktop size: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.bodyFontSize >= 14.5,
    "4K explanatory text must scale with its card: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.metricFontSize >= 31,
    "4K headline metrics must keep their visual hierarchy: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.chartHeight >= 188,
    "the trend chart must scale with the wider 4K rail card: " + JSON.stringify(fourKRail)
  );
  assert.ok(
    fourKRail.severityTrackWidth >= 20 && fourKRail.severityTrackHeight >= 136,
    "the 4K severity chart must scale with the larger card: " + JSON.stringify(fourKRail)
  );
  await page.screenshot({ path: path.join(outDir, "rail-4k.png"), fullPage: false });

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
  const faviconPresentation = await verifyPageInformationFaviconPresentation(browser);
  const liveUnavailable = await verifyRailWithoutLiveSession(browser);
  console.log(JSON.stringify({
    result: "PASS",
    liveUnavailable,
    faviconPresentation,
    pageInformation,
    severityCounts,
    geometry,
    fullHdRail,
    fourKRail,
    narrow
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
