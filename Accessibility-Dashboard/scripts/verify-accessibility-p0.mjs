import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const widths = [1440, 1024, 768, 390, 320];

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  let landingApiRequestCount = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      landingApiRequestCount += 1;
    }
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      "accessibility-dashboard.quick-analysis-attempt.v1",
      JSON.stringify({
        version: 1,
        attemptId: "landing-preview-privacy-check",
        apiScope: "/api",
        startedAt: Date.now(),
        url: "https://private.example/previous-analysis",
        phase: "posting",
        knownRequestIds: []
      })
    );
  });
  const timestamp = "2026-07-28T10:00:00.000Z";
  const organization = {
    id: 1,
    name: "P0 검증 프로젝트",
    type: "ETC",
    homepageUrl: "https://example.com",
    description: "",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const evaluationTarget = {
    id: 101,
    organizationId: organization.id,
    name: "P0 검증 페이지",
    targetType: "WEB",
    accessUrl: "https://example.com/p0",
    description: "",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const pendingRequest = {
    id: 501,
    evaluationTargetId: evaluationTarget.id,
    targetName: evaluationTarget.name,
    status: "PENDING",
    requestNote: "P0 결정적 검증",
    requestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/dashboard/overview") {
      await fulfillJson(route, createDashboardOverview({
        organizations: [organization],
        evaluationTargets: [evaluationTarget],
        evaluationRequests: [pendingRequest]
      }));
      return;
    }
    const payload =
      pathname === "/api/requests"
        ? [pendingRequest]
        : pathname === "/api/organizations"
          ? [organization]
          : pathname === `/api/organizations/${organization.id}/evaluation-targets`
            ? [evaluationTarget]
            : null;
    assert.notEqual(payload, null, `Unexpected P0 API request: ${pathname}`);
    await fulfillJson(route, payload);
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#ua-hero-title").waitFor();
  await page.locator(".ua-stage").waitFor();
  const productPreviewFrame = page.frameLocator(".ua-stage__frame");
  const productPreview = productPreviewFrame.locator('[data-dashboard-product-preview="true"]');
  await productPreview.waitFor();
  assert.equal(await page.locator(".ua-stage__toolbar").count(), 0, "demo toolbar must stay removed");
  assert.equal(await page.locator(".ua-hero__caption").count(), 0, "demo caption must stay removed");

  const previewFrameElement = page.locator(".ua-stage__frame");
  assert.equal(await previewFrameElement.count(), 1, "product demo must render in one isolated preview frame");
  assert.equal(
    await previewFrameElement.getAttribute("title"),
    "UNI ACCESS 실제 서비스 읽기 전용 미리보기"
  );
  assert.equal(
    await productPreview.locator(".site-page-evidence-replay-frame").count(),
    0,
    "project preview must not load replay HTML early"
  );
  assert.equal(
    await productPreview.locator('a[href="/analyze"]').count(),
    0,
    "read-only product demo must not navigate to the live analysis route"
  );

  const previewRecentList = productPreview.locator(".sidebar-tree-recent-list");
  const previewRecentItems = previewRecentList.getByRole("button");
  assert.equal(await previewRecentItems.count(), 3, "product demo must show recent analysis examples");
  assert.equal(
    await previewRecentList.getByText("분석한 페이지가 없습니다.", { exact: true }).count(),
    0,
    "product demo must not show the recent-analysis empty state"
  );
  assert.deepEqual(
    await previewRecentItems.evaluateAll((items) =>
      items.map((item) => item.getAttribute("aria-label"))
    ),
    [
      "www.hongik.ac.kr 페이지 열기 (홍익대학교 프로젝트)",
      "네이버 페이지 열기 (네이버 프로젝트)",
      "건축학부 페이지 열기 (홍익대학교 프로젝트)"
    ]
  );
  const naverRecentPage = previewRecentList.getByRole("button", {
    name: "네이버 페이지 열기 (네이버 프로젝트)",
    exact: true
  });
  await naverRecentPage.click();
  await productPreview.locator(".site-page-evidence-card").waitFor();
  assert.equal(await naverRecentPage.getAttribute("aria-current"), "page");
  assert.equal(
    await productPreview.getByRole("heading", { name: "네이버", level: 1, exact: true }).count(),
    1
  );
  assert.equal(
    await productPreview.getByRole("region", { name: "네이버 접근성 검사 제품 미리보기 화면" }).count(),
    1
  );
  assert.equal(landingApiRequestCount, 0, "recent preview navigation unexpectedly called an API");

  const previewAnalyzeNav = productPreview.getByRole("button", {
    name: "새 페이지 분석",
    exact: true
  });
  assert.equal(await previewAnalyzeNav.count(), 1);
  await previewAnalyzeNav.click();
  const previewCurrentItems = productPreview.locator('[aria-current="page"]');
  assert.equal(await previewCurrentItems.count(), 1);
  assert.equal((await previewCurrentItems.first().innerText()).trim(), "새 페이지 분석");
  const previewUrlInput = productPreview.getByPlaceholder("https://example.com");
  assert.equal(await previewUrlInput.inputValue(), "", "preview must not expose live recovery URL data");
  assert.equal(await previewUrlInput.getAttribute("readonly"), "");
  assert.equal(
    await productPreview.getByRole("button", { name: /분석 시작/ }).isDisabled(),
    true
  );

  await productPreview.getByRole("button", { name: "홍익대학교", exact: true }).click();
  assert.equal(await productPreview.locator(".dashboard-project-panel").count(), 1);
  assert.equal(await productPreview.locator(".dashboard-project-grid").count(), 1);
  assert.equal(
    await productPreview.getByRole("button", { name: "프로젝트 추가", exact: true }).isDisabled(),
    true
  );
  assert.equal(
    await productPreview.getByRole("button", { name: "페이지 추가", exact: true }).isDisabled(),
    true
  );

  await productPreview.locator(".dashboard-account-menu-trigger").click();
  assert.equal(
    await productPreview.getByRole("menuitem", { name: "로그아웃", exact: true }).isDisabled(),
    true
  );
  await productPreview.getByRole("menuitem", { name: "설정", exact: true }).click();
  const previewSettingsDialog = productPreviewFrame.getByRole("dialog", { name: "설정" });
  await previewSettingsDialog.waitFor();
  await previewSettingsDialog.getByText("다크", { exact: true }).click();
  assert.equal(
    await productPreview.evaluate((root) => root.ownerDocument.documentElement.classList.contains("dark")),
    true,
    "preview dark mode must use the same document-level theme token switch as the dashboard"
  );
  assert.equal(
    await productPreview.evaluate(() => window.localStorage.getItem("bridge-theme")),
    null,
    "preview theme changes must not overwrite the live dashboard preference"
  );
  await previewSettingsDialog.getByText("라이트", { exact: true }).click();
  await previewSettingsDialog.getByRole("button", { name: "닫기", exact: true }).click();

  await productPreview.getByRole("button", { name: "네이버", exact: true }).click();
  assert.equal(
    await productPreview.locator(".dashboard-project-title").innerText(),
    "네이버"
  );
  await productPreview.getByRole("button", { name: "홍익대학교", exact: true }).click();
  await productPreview.getByRole("button", { name: "www.hongik.ac.kr 상세 보기" }).click();
  await productPreview.locator(".site-page-evidence-card").waitFor();
  const replayFrame = productPreview.frameLocator(".site-page-evidence-replay-frame");
  const outerPreviewScrollTopBeforeReplayScroll = await productPreview.evaluate(
    (root) => root.ownerDocument.scrollingElement?.scrollTop ?? 0
  );
  const replayScrollState = await replayFrame.locator("html").evaluate(async (documentElement) => {
    const replayDocument = documentElement.ownerDocument;
    const replayWindow = replayDocument.defaultView;
    const scrollingElement = replayDocument.scrollingElement ?? documentElement;
    const viewportHeight = replayWindow?.innerHeight ?? scrollingElement.clientHeight;

    replayWindow?.scrollTo(0, Math.min(480, scrollingElement.scrollHeight - viewportHeight));
    await new Promise((resolve) => {
      if (!replayWindow) {
        resolve();
        return;
      }
      replayWindow.requestAnimationFrame(() => resolve());
    });

    return {
      scrollHeight: scrollingElement.scrollHeight,
      scrollTop: scrollingElement.scrollTop,
      viewportHeight
    };
  });
  assert.ok(
    replayScrollState.scrollHeight > replayScrollState.viewportHeight + 400,
    "long replay document must overflow its evidence viewport vertically"
  );
  assert.ok(replayScrollState.scrollTop > 0, "long replay document must be internally scrollable");
  assert.equal(
    await productPreview.evaluate((root) => root.ownerDocument.scrollingElement?.scrollTop ?? 0),
    outerPreviewScrollTopBeforeReplayScroll,
    "scrolling the replay document must not move the dashboard preview shell"
  );
  await replayFrame.locator("html").evaluate((documentElement) => {
    documentElement.ownerDocument.defaultView?.scrollTo(0, 0);
  });
  await replayFrame.getByRole("button", { name: "이미지 대체 텍스트가 없습니다" }).click();
  // The rail's top-issue card repeats issue titles, so scope the assertion to
  // the replay fallback detail instead of matching the label document-wide.
  await productPreview
    .locator(".site-page-evidence-fallback-detail__title")
    .getByText("이미지 대체 텍스트가 없습니다", { exact: true })
    .waitFor();
  assert.equal(
    await productPreview.locator('.site-page-evidence-fallback-detail[data-issue-id="10001"]').count(),
    1
  );
  assert.equal(landingApiRequestCount, 0, "read-only product demo unexpectedly called an API");

  await page.evaluate(() => {
    window.sessionStorage.removeItem("accessibility-dashboard.quick-analysis-attempt.v1");
  });

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));

    assert.equal(
      metrics.scrollWidth,
      metrics.clientWidth,
      `landing has page-level horizontal overflow at ${width}px`
    );
  }

  const selectedTab = () => page.locator('[role="tab"][aria-selected="true"]');
  const rulesTab = page.getByRole("tab", { name: "규칙", exact: true });

  assert.equal(await rulesTab.getAttribute("tabindex"), "0");
  assert.equal(await page.locator('[role="tabpanel"][hidden]').count(), 2);

  await rulesTab.press("ArrowRight");
  assert.equal(await selectedTab().innerText(), "난이도");
  await page.getByRole("tab", { name: "난이도", exact: true }).press("End");
  assert.equal(await selectedTab().innerText(), "명암비");
  await page.getByRole("tab", { name: "명암비", exact: true }).press("Home");
  assert.equal(await selectedTab().innerText(), "규칙");
  await rulesTab.press("ArrowLeft");
  assert.equal(await selectedTab().innerText(), "명암비");
  assert.equal(await page.locator('[role="tabpanel"][hidden]').count(), 2);

  const landingReducedMotion = await page.evaluate(() => {
    const tab = document.querySelector(".ua-tabs button");
    return {
      matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      transitionDuration: tab ? getComputedStyle(tab).transitionDuration : null
    };
  });

  assert.equal(landingReducedMotion.matches, true);
  assert.equal(landingReducedMotion.scrollBehavior, "auto");
  assert.ok(
    Number.parseFloat(landingReducedMotion.transitionDuration ?? "1") <= 0.00001,
    `landing reduced-motion transition is not effectively disabled: ${landingReducedMotion.transitionDuration}`
  );

  const heroCta = page.locator(".ua-hero__copy").getByRole("button", {
    name: "새 페이지 분석",
    exact: true
  });
  await Promise.all([
    page.waitForURL("**/analyze"),
    heroCta.click()
  ]);
  await page.locator("#dashboard-main-content").waitFor();

  const dashboardSidebar = page.locator("aside");
  const analyzeSidebarItem = dashboardSidebar.locator(".sidebar-nav-link").first();
  const assertAnalyzeOnlySelected = async () => {
    const selectedItems = dashboardSidebar.locator('[aria-current="page"]');
    assert.equal(await selectedItems.count(), 1);
    assert.equal((await selectedItems.first().innerText()).trim(), "새 페이지 분석");
    assert.equal(await analyzeSidebarItem.getAttribute("aria-current"), "page");
  };
  await assertAnalyzeOnlySelected();

  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/analyze");
  await page.locator("#dashboard-main-content").waitFor();
  assert.equal(
    await dashboardSidebar.getByText("종합 대시보드", { exact: true }).count(),
    0
  );
  await assertAnalyzeOnlySelected();

  await page.goto(`${baseUrl}/unknown-app-path`, { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/analyze");
  await page.locator("#dashboard-main-content").waitFor();
  await assertAnalyzeOnlySelected();

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));

    assert.equal(
      metrics.scrollWidth,
      metrics.clientWidth,
      `dashboard has page-level horizontal overflow at ${width}px`
    );
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("body").press("Home");
  await page.keyboard.press("Tab");

  const skipLinkState = await page.evaluate(() => {
    const activeElement = document.activeElement;
    return {
      href: activeElement?.getAttribute("href"),
      text: activeElement?.textContent?.trim()
    };
  });

  assert.deepEqual(skipLinkState, {
    href: "#dashboard-main-content",
    text: "본문으로 바로가기"
  });

  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "dashboard-main-content");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.closest("#dashboard-main-content") !== null),
    true
  );

  const dashboardReducedMotion = await page.evaluate(() => {
    const skipLink = document.querySelector(".dashboard-skip-link");
    return {
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      transitionDuration: skipLink ? getComputedStyle(skipLink).transitionDuration : null
    };
  });

  assert.equal(dashboardReducedMotion.scrollBehavior, "auto");
  assert.equal(dashboardReducedMotion.transitionDuration, "0s");

  const accountTrigger = page.locator(".dashboard-account-menu-trigger");
  const previousBodyStyle = { overflow: "clip", paddingRight: "11px" };
  await page.evaluate((style) => {
    document.body.style.overflow = style.overflow;
    document.body.style.paddingRight = style.paddingRight;
  }, previousBodyStyle);
  await accountTrigger.click();
  const accountMenu = page.getByRole("menu", { name: "계정 메뉴" });
  await accountMenu.waitFor();
  const settingsMenuItem = accountMenu.getByRole("menuitem", { name: "설정", exact: true });
  const logoutMenuItem = accountMenu.getByRole("menuitem", { name: "로그아웃", exact: true });
  assert.equal(await accountMenu.getByRole("menuitem").count(), 2);
  assert.equal(await accountMenu.getByRole("menuitem", { name: "프로필", exact: true }).count(), 0);
  assert.equal(await settingsMenuItem.count(), 1);
  assert.equal(await logoutMenuItem.count(), 1);
  assert.equal(await accountMenu.getByRole("menuitem", { name: "대시보드", exact: true }).count(), 0);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("role") === "menuitem"
  );
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    () => document.activeElement?.textContent?.trim() === "로그아웃"
  );
  assert.equal(await logoutMenuItem.evaluate((item) => item === document.activeElement), true);
  await page.keyboard.press("Home");
  await page.waitForFunction(
    () => document.activeElement?.textContent?.trim() === "설정"
  );
  assert.equal(await settingsMenuItem.evaluate((item) => item === document.activeElement), true);
  await page.keyboard.press("Escape");
  await accountMenu.waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.classList.contains("dashboard-account-menu-trigger")
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      overflow: document.body.style.overflow,
      paddingRight: document.body.style.paddingRight
    })),
    previousBodyStyle
  );
  assert.equal(await accountTrigger.evaluate((trigger) => trigger === document.activeElement), true);

  await context.close();
  console.log("Accessibility P0 regression checks passed.");
} finally {
  await browser.close();
}
