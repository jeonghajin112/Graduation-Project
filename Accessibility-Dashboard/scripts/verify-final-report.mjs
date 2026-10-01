import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fulfillJson, installDashboardApiFixture } from "./fixtures/dashboard-api-fixture.mjs";
import { createTestLiveReportSession, createTestLiveReportViewerHtml } from "./fixtures/live-report-viewer-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const createdAt = "2026-09-28T02:14:00Z";

function domLocator(pathSteps, htmlSnippet) {
  return { kind: "DOM_RECT", pathSteps, x: 10, y: 20, width: 100, height: 40, coordinateSpace: "DOCUMENT_CSS_PX", visible: true, htmlSnippet };
}

const issues = [
  {
    id: 9101, requestId: 501, module: "rule_based", severity: "CRITICAL", ruleId: "image-alt", wcagCode: "5.1.1",
    title: "적절한 대체 텍스트 제공", description: "Images must have alternative text", recommendation: null, selector: "#hero",
    locator: domLocator([{ context: "DOCUMENT", selector: "#hero", frameUrl: null }], '<img id="hero" src="hero.png">'), createdAt
  },
  {
    id: 9102, requestId: 501, module: "rule_based", severity: "CRITICAL", ruleId: "image-alt", wcagCode: "5.1.1",
    title: "적절한 대체 텍스트 제공", description: "Images must have alternative text", recommendation: null, selector: "#ad > .banner",
    locator: domLocator([
      { context: "DOCUMENT", selector: "#ad", frameUrl: null },
      { context: "FRAME", selector: ".banner", frameUrl: "about:blank" }
    ], '<img class="banner" src="ad.png">'), createdAt
  },
  {
    id: 9103, requestId: 501, module: "cv_visual", severity: "SERIOUS", ruleId: null, wcagCode: "5.4.3",
    title: "텍스트 콘텐츠의 명도 대비", description: "text=다운로드, contrast=2.10:1, required=4.5", recommendation: null,
    selector: "x=803, y=13, width=39, height=12",
    locator: { kind: "BOUNDING_BOX", pathSteps: [], x: 803, y: 13, width: 39, height: 12, coordinateSpace: "SCREENSHOT_PX", visible: true, htmlSnippet: null },
    createdAt
  },
  {
    id: 9104, requestId: 501, module: "rule_based", severity: "SERIOUS", ruleId: "color-contrast", wcagCode: "5.4.3",
    title: "텍스트 콘텐츠의 명도 대비", description: "Elements must meet minimum color contrast ratio thresholds", recommendation: null,
    selector: ".footer-link", locator: domLocator([{ context: "DOCUMENT", selector: ".footer-link", frameUrl: null }], '<a class="footer-link">회사 소개</a>'),
    createdAt
  },
  {
    id: 9105, requestId: 501, module: "text_difficulty", severity: "MODERATE", ruleId: null, wcagCode: "WCAG 3.1.5",
    title: "읽기 수준", description: "문장이 어렵습니다.", recommendation: "쉬운 단어로 바꾸세요.", selector: "#notice",
    locator: domLocator([{ context: "DOCUMENT", selector: "#notice", frameUrl: null }], '<p id="notice">공지</p>'), createdAt
  },
  // Findings in an ad and in content that changed between two loads: reported
  // separately, never scored, counted or sent to the live viewer.
  {
    id: 9106, requestId: 501, module: "rule_based", severity: "CRITICAL", ruleId: "image-alt", wcagCode: "5.1.1",
    exclusionReason: "AD", title: "적절한 대체 텍스트 제공", description: "Images must have alternative text", recommendation: null,
    selector: "#ad-slot img", locator: domLocator([{ context: "DOCUMENT", selector: "#ad-slot img", frameUrl: null }], '<img src="ad.png">'),
    createdAt
  },
  {
    id: 9107, requestId: 501, module: "cv_visual", severity: "SERIOUS", ruleId: null, wcagCode: "5.4.3", exclusionReason: "DYNAMIC",
    title: "텍스트 콘텐츠의 명도 대비", description: "text=오늘의 뉴스, contrast=2.40:1, required=4.5", recommendation: null,
    selector: "x=40, y=900, width=120, height=16",
    locator: { kind: "BOUNDING_BOX", pathSteps: [], x: 40, y: 900, width: 120, height: 16, coordinateSpace: "SCREENSHOT_PX", visible: true, htmlSnippet: null },
    createdAt
  }
];

const locatorStates = {
  9101: { status: "VISIBLE" },
  9102: { status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" },
  9103: { status: "UNAVAILABLE", reason: "INVALID_SELECTOR" },
  9104: { status: "OFFSCREEN", reason: "OUTSIDE_VIEWPORT_OR_CLIPPED" },
  9105: { status: "HIDDEN_STATE", reason: "DISPLAY_NONE", recoverable: true }
};

async function installReportFixture(page) {
  const fixture = await installDashboardApiFixture(page);
  const session = createTestLiveReportSession(501, "final_report");
  // Built per request so a scenario can change the reported locations.
  const viewer = () => createTestLiveReportViewerHtml({ session, documentToken: "final_report_document" }).replace(
    'if (message.type === "REQUEST_DOCUMENT_STATE") {',
    `if (message.type === "INIT_ISSUES") {
      const states = ${JSON.stringify(locatorStates)};
      message.issues.forEach(issue => send({ type: "LOCATOR_STATUS", issueId: issue.id, ...(states[issue.id] ?? { status: "VISIBLE" }) }));
    }
    if (message.type === "FOCUS_ISSUE") (window.__focusedIssueIds ||= []).push(message.issueId);
    if (message.type === "REQUEST_DOCUMENT_STATE") {`
  );
  let viewerDocumentRequests = 0;
  // Override only these scenarios; every other call stays inside the shared
  // fixture's isolation boundary.
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/results/requests/501/issues") return fulfillJson(route, issues);
    if (request.method() === "POST" && pathname === "/api/results/requests/501/live-session") return fulfillJson(route, session);
    if (request.method() === "GET" && request.url() === session.runtimeUrl) {
      viewerDocumentRequests += 1;
      return route.fulfill({ status: 200, contentType: "text/html", body: viewer() });
    }
    return route.fallback();
  });
  return { fixture, session, viewerDocumentRequests: () => viewerDocumentRequests };
}

async function waitForLocatorStates(page, unavailableCount = 2) {
  await page.waitForFunction((expected) => {
    const preview = document.querySelector(".site-page-evidence-preview");
    return preview?.dataset.loadingPhase === "complete" && preview.dataset.unavailableLocatorCount === String(expected);
  }, unavailableCount, { timeout: 20_000 });
}

// Router updates commit as a transition, so the URL can change first.
async function waitForSelectedView(page, view) {
  await page.waitForFunction((id) => document.getElementById(id)?.getAttribute("aria-selected") === "true",
    `site-dashboard-tab-${view}`);
}

function viewerFrame(page, session) {
  const frame = page.frames().find((candidate) => candidate.url() === session.runtimeUrl);
  assert.ok(frame, "the live viewer frame must exist");
  return frame;
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__printSnapshots = [];
    window.print = () => {
      window.__printSnapshots.push({
        collapsed: document.querySelectorAll('.site-final-report__group-toggle[aria-expanded="false"]').length,
        issues: document.querySelectorAll(".site-final-report__issue").length
      });
    };
  });
  const { fixture, session, viewerDocumentRequests } = await installReportFixture(page);

  await page.goto(`${baseUrl}/projects/1/pages/101`);
  await waitForLocatorStates(page);
  const tablist = page.getByRole("tablist", { name: "페이지 분석 보기" });
  const resultsTab = tablist.getByRole("tab", { name: "분석 결과" });
  const reportTab = tablist.getByRole("tab", { name: "최종 리포트" });
  assert.equal(await resultsTab.getAttribute("aria-selected"), "true");
  assert.equal(await reportTab.getAttribute("tabindex"), "-1", "only the selected tab is in the Tab order");
  assert.equal(await page.getByRole("tabpanel", { name: "분석 결과" }).isVisible(), true);
  assert.equal(await page.locator("#site-dashboard-panel-report").isHidden(), true);
  console.log("PASS results tab is selected by default");

  const iframe = await page.locator("iframe.site-page-evidence-replay-frame").elementHandle();
  await resultsTab.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForURL(/\?view=report$/);
  await waitForSelectedView(page, "report");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "site-dashboard-tab-report");
  const report = page.getByRole("article", { name: "최종 리포트" });
  await report.waitFor();
  assert.equal(await page.locator("#site-dashboard-panel-results").evaluate((element) => getComputedStyle(element).visibility), "hidden");
  assert.equal(await page.evaluate((frame) => frame.isConnected, iframe), true, "switching views keeps the live viewer mounted");
  await page.keyboard.press("Home");
  await page.waitForURL((url) => !url.search.includes("view="));
  await waitForSelectedView(page, "results");
  await page.keyboard.press("End");
  await page.waitForURL(/\?view=report$/);
  await waitForSelectedView(page, "report");
  console.log("PASS tabs follow the WAI-ARIA keyboard pattern and the URL");

  const metrics = report.locator(".site-final-report__summary dl > div");
  const metricText = async (label) => (await metrics.filter({ has: page.getByText(label, { exact: true }) }).locator("dd").innerText()).trim();
  assert.equal(await metricText("접근성 점수"), "100점");
  assert.equal(await metricText("발견된 문제"), "5건");
  assert.equal(await metricText("페이지에서 확인 가능"), "3건");
  assert.equal(await metricText("위치 표시 불가"), "2건");
  assert.equal(await metricText("점수에서 제외"), "2건");
  assert.match(await report.locator(".site-final-report__headline").first().innerText(), /검사 항목 3개에서 문제 5건을 발견했습니다/);
  assert.match(await report.locator(".site-final-report__summary > .site-final-report__lead").innerText(), /심각·높음 문제 4건/);
  assert.deepEqual(
    (await report.getByRole("list", { name: "심각도별 문제 수" }).locator("li").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
    ["심각 2건 40%", "높음 2건 40%", "중간 1건 20%", "낮음 0건 0%"]
  );
  const firstPriority = report.locator(".site-final-report__priorities > li").first();
  assert.match(await firstPriority.innerText(), /적절한 대체 텍스트 제공[\s\S]*2건/);
  console.log("PASS summary and fix priorities");

  const legend = report.getByRole("list", { name: "항목 상태별 개수" });
  assert.deepEqual((await legend.locator("li").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
    ["문제 있음 2", "문제 없음 19", "검사 못 함 0", "직접 확인 12"]);
  assert.equal(await report.locator('.site-final-report__principle li[data-status]').count(), 33);
  assert.match(await report.locator('.site-final-report__principle li[data-status="manual"]').first().innerText(), /5\.3\.2[\s\S]*직접 확인/);
  assert.match(await report.locator(".site-final-report__criteria-others").innerText(), /WCAG 3\.1\.5 1건/);
  await report.locator('.site-final-report__principle li[data-status="fail"]', { hasText: "5.4.3" }).getByRole("button").click();
  assert.equal(await report.getByRole("button", { name: /KWCAG 5\.4\.3/ }).getAttribute("aria-expanded"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-criterion-toggle")), "5.4.3",
    "a criterion with issues jumps to its group in the list");
  await page.keyboard.press("Enter");
  console.log("PASS KWCAG criteria overview");

  const groupToggles = report.locator(".site-final-report__group-toggle");
  assert.deepEqual(await groupToggles.locator(".site-final-report__code").allInnerTexts(), ["KWCAG 5.1.1", "KWCAG 5.4.3", "WCAG 3.1.5"]);
  await firstPriority.getByRole("button", { name: /목록에서 보기/ }).click();
  const imageGroup = report.getByRole("button", { name: /KWCAG 5\.1\.1/ });
  assert.equal(await imageGroup.getAttribute("aria-expanded"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-criterion-toggle")), "5.1.1");
  const frameIssue = report.locator('.site-final-report__issue[data-issue-id="9102"]');
  assert.match(await frameIssue.innerText(), /위치 표시 불가 · 내부 프레임의 요소/);
  assert.match(await frameIssue.innerText(), /프레임 내부\s*\.banner/);
  assert.match(await frameIssue.innerText(), /규칙 image-alt[\s\S]*문제 번호 9102/);
  assert.match(await frameIssue.innerText(), /현재 위치\s*내부 프레임의 요소/, "the report explains why the location cannot be shown");
  assert.equal(await frameIssue.getByRole("button", { name: /페이지에서 보기/ }).count(), 0);
  await page.keyboard.press("Enter");
  assert.equal(await imageGroup.getAttribute("aria-expanded"), "false", "Enter collapses the focused group");
  console.log("PASS criterion groups, priorities and unavailable locations");

  await report.getByLabel("위치 상태").selectOption("unavailable");
  assert.match(await report.locator(".site-final-report__result-count").innerText(), /전체 5건 중 2건/);
  const coordinateIssue = report.locator('.site-final-report__issue[data-issue-id="9103"]');
  assert.match(await coordinateIssue.innerText(), /화면 좌표 x 803, y 13 · 39×12 \(요소 경로 없음\)/);
  assert.match(await coordinateIssue.innerText(), /측정한 글자\s*“다운로드”[\s\S]*명도 대비\s*2\.10:1[\s\S]*기준\s*4\.5:1 이상/,
    "visual findings read as measured values, not the raw engine string");
  assert.doesNotMatch(await coordinateIssue.innerText(), /contrast=/);
  await report.getByLabel("위치 상태").selectOption("ALL");
  await report.getByLabel("검색").fill("footer-link");
  assert.match(await report.locator(".site-final-report__result-count").innerText(), /전체 5건 중 1건/);
  await report.getByLabel("검색").fill("");
  console.log("PASS filters by location and text");

  const excludedToggle = report.getByRole("button", { name: /점수에서 제외된 문제/ });
  assert.equal(await excludedToggle.getAttribute("aria-expanded"), "false", "excluded findings start collapsed");
  assert.match(await excludedToggle.innerText(), /광고 1건 · 동적 영역 1건/);
  await excludedToggle.click();
  const adIssue = report.locator('.site-final-report__issue[data-issue-id="9106"]');
  assert.match(await adIssue.innerText(), /광고/);
  assert.match(await report.locator('.site-final-report__issue[data-issue-id="9107"]').innerText(), /동적 영역[\s\S]*오늘의 뉴스/);
  assert.equal(await adIssue.getByRole("button").count(), 0, "excluded findings have no page marker");
  assert.equal(await page.locator("#site-dashboard-panel-results .site-page-evidence-preview").getAttribute("data-unavailable-locator-count"), "2");
  await excludedToggle.click();
  console.log("PASS ads and dynamic regions are listed outside the score");

  await report.getByRole("button", { name: "모두 펼치기" }).click();
  await report.locator('.site-final-report__issue[data-issue-id="9101"]').getByRole("button", { name: /문제 상세/ }).click();
  const dialog = page.getByRole("dialog", { name: "문제 상세" });
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /문제 상세/);
  console.log("PASS issue details open from the report and restore focus");

  await report.getByRole("button", { name: "인쇄 · PDF 저장" }).click();
  assert.deepEqual(await page.evaluate(() => window.__printSnapshots), [{ collapsed: 0, issues: 7 }],
    "printing renders every group, issue and excluded finding");
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".dashboard-sidebar").first().isVisible(), false, "print hides the dashboard chrome");
  assert.equal(await page.getByRole("tablist").isVisible(), false, "print hides the tabs");
  assert.equal(await report.getByRole("heading", { name: "최종 리포트" }).isVisible(), true);
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  console.log("PASS print includes only the expanded report");

  const visibleIssue = report.locator('.site-final-report__issue[data-issue-id="9101"]');
  await visibleIssue.getByRole("button", { name: /페이지에서 보기/ }).click();
  await page.waitForURL((url) => !url.search.includes("view="));
  await waitForSelectedView(page, "results");
  await page.waitForFunction(() => document.activeElement?.classList.contains("site-report-focus-guard") ||
    document.activeElement?.tagName === "IFRAME");
  const frame = viewerFrame(page, session);
  await frame.waitForFunction(() => window.__focusedIssueIds?.includes(9101));
  assert.equal(viewerDocumentRequests(), 1, "moving to the page must not reload the live viewer");
  assert.equal(await page.evaluate((element) => element.isConnected, iframe), true);
  await page.goBack();
  await page.waitForURL(/\?view=report$/);
  await waitForSelectedView(page, "report");
  console.log("PASS show on page focuses the live marker without reloading");

  await page.goto(`${baseUrl}/projects/1/pages/101?view=report`);
  await report.waitFor();
  assert.equal(await reportTab.getAttribute("aria-selected"), "true", "a report link opens the report view");
  await waitForLocatorStates(page);
  assert.equal(await metricText("위치 표시 불가"), "2건", "the hidden live viewer still reports locations");
  console.log("PASS direct report links");

  // A failed text analysis is excluded from the score; the report must not
  // present it as a clean result with zero text issues.
  fixture.score.textStatus = "FAILED";
  await page.goto(`${baseUrl}/projects/1/pages/101?view=report`);
  await report.waitFor();
  const textEngine = report.locator(".site-final-report__engine-list li", { hasText: "텍스트" });
  assert.equal((await textEngine.locator("strong").innerText()).trim(), "검사 실패");
  assert.match(await report.getByRole("note").first().innerText(), /텍스트 검사가 실패해/);
  assert.match(await report.locator('.site-final-report__principle li[data-status="skipped"]').innerText(), /5\.3\.3[\s\S]*검사 못 함/,
    "a criterion only the failed text engine checks is not reported as clean");
  delete fixture.score.textStatus;
  console.log("PASS failed text analysis is shown as not checked");

  // Findings shown on their owner and page settings get their own place;
  // findings the page no longer matches join the unavailable list and still
  // trigger the re-analysis hint.
  issues.push(
    {
      id: 9108, requestId: 501, module: "rule_based", severity: "SERIOUS", ruleId: "meta-viewport", wcagCode: "meta-viewport",
      title: "Zooming and scaling must not be disabled", description: "Ensure <meta name=\"viewport\"> does not disable zooming",
      recommendation: null, selector: 'meta[name="viewport"]',
      locator: domLocator([{ context: "DOCUMENT", selector: 'meta[name="viewport"]', frameUrl: null }], '<meta name="viewport">'), createdAt
    },
    {
      id: 9109, requestId: 501, module: "text_difficulty", severity: "MODERATE", ruleId: null, wcagCode: "WCAG 3.1.5",
      title: "읽기 수준", description: "문장이 어렵습니다.", recommendation: null, selector: "#news li:nth-of-type(3)",
      locator: domLocator([{ context: "DOCUMENT", selector: "#news li:nth-of-type(3)", frameUrl: null }], "<li>지난 뉴스</li>"), createdAt
    }
  );
  Object.assign(locatorStates, {
    9101: { status: "VISIBLE", reason: "SCREEN_READER_ONLY", ownerKind: "BUTTON" },
    9108: { status: "UNAVAILABLE", reason: "DOCUMENT_METADATA" },
    9109: { status: "UNAVAILABLE", reason: "ELEMENT_CONTENT_CHANGED" }
  });
  await page.goto(`${baseUrl}/projects/1/pages/101`);
  // The changed finding joins the two findings that cannot be shown.
  await waitForLocatorStates(page, 3);
  assert.match(await page.getByRole("region", { name: "페이지 전체 설정" }).innerText(), /1건[\s\S]*페이지 전체 설정/);
  assert.equal(await page.getByRole("region", { name: "분석 이후 바뀐 문제" }).count(), 0,
    "changed findings have no separate list");
  assert.equal(await page.locator(".site-page-analysis-actions__stale").count(), 0, "the header does not claim the page changed");
  console.log("PASS rail lists changed findings as not shown and keeps page settings apart");

  await reportTab.click();
  await report.waitFor();
  assert.equal(await metricText("위치 표시 불가"), "4건", "page settings and changed findings have no position either");
  assert.match(await report.getByRole("note").filter({ hasText: "분석 이후 페이지 내용이 바뀌어" }).innerText(), /문제 1건/);
  await report.getByRole("button", { name: "모두 펼치기" }).click();
  assert.match(await report.locator('.site-final-report__issue[data-issue-id="9101"] .site-final-report__location').innerText(),
    /페이지에서 확인 가능 · 버튼의 스크린리더 전용 텍스트/);
  assert.match(await report.locator('.site-final-report__issue[data-issue-id="9108"] .site-final-report__location').innerText(),
    /페이지 전체 설정 · 화면 위치 없음/);
  assert.match(await report.locator('.site-final-report__issue[data-issue-id="9109"] .site-final-report__location').innerText(),
    /위치 표시 불가 · 분석 이후 내용이 바뀜/);
  await report.getByLabel("위치 상태").selectOption("unavailable");
  assert.match(await report.locator(".site-final-report__result-count").innerText(), /전체 7건 중 4건/,
    "the filter matches the 위치 표시 불가 metric");
  await report.getByLabel("위치 상태").selectOption("ALL");
  console.log("PASS report labels moved markers, page settings and changed findings");

  fixture.assertIsolated();
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
}
