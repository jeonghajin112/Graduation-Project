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
    // The live dashboard polls the PENDING request's status every 5s; the
    // extended keyboard checks can outlast the first poll.
    const payload =
      pathname === "/api/requests"
        ? [pendingRequest]
        : pathname === `/api/requests/${pendingRequest.id}`
          ? pendingRequest
          : pathname === "/api/organizations"
          ? [organization]
          : pathname === `/api/organizations/${organization.id}/evaluation-targets`
            ? [evaluationTarget]
            : null;
    assert.notEqual(payload, null, `Unexpected P0 API request: ${pathname}`);
    await fulfillJson(route, payload);
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scroll-world-ready="true"]').waitFor();
  await page.locator("#ua-hero-title").waitFor();
  assert.equal(await page.locator("main#uni-access-main").count(), 1);
  assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
  assert.equal(await page.getByRole("navigation", { name: "현재 장면" }).count(), 0);
  assert.equal(await page.locator(".sw-route").isVisible(), false, "side progress bar must stay hidden");
  assert.equal(await page.locator(".sw-scrollbar").count(), 0, "obsolete top progress bar must stay removed");
  assert.equal(await page.locator("video").count(), 0, "reduced-motion landing must not load videos");
  assert.equal(
    await page.locator('.sw-copy[aria-hidden="true"], .sw-copy[inert]').count(),
    0,
    "every landing scene's copy must stay in the accessibility tree"
  );
  assert.equal(await page.locator('.sw-copy[data-sw-active="true"]').count(), 1);
  assert.equal(
    await page.locator('.sw-copy[data-sw-active="false"] :is(a[href], button):not([tabindex="-1"])').count(),
    0,
    "controls of off-screen scene copy must leave the Tab order"
  );
  assert.equal(
    await page.evaluate(() => document.querySelector(".sw-topbar")?.closest("main")),
    null,
    "the landing banner must stay outside the main landmark"
  );
  for (const selector of [".ua-findings", ".ua-faq", "#ua-hero-title"]) {
    assert.equal(
      await page.evaluate((target) => document.querySelector(target)?.closest("main#uni-access-main") !== null, selector),
      true,
      `${selector} must be inside the landing main landmark`
    );
  }
  assert.equal(
    await page.locator(".ua-findings [aria-hidden='true']:not(.ua-findings__moving-word, .ua-findings__snap-point, .ua-findings__number, svg)").count(),
    0,
    "findings copy must not be hidden from assistive technology by scroll position"
  );
  assert.equal(landingApiRequestCount, 0, "landing unexpectedly called an API");

  // The product preview remains a dedicated route. Keep its read-only product
  // regression coverage without coupling the landing to an iframe again.
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto(`${baseUrl}/product-preview`, { waitUntil: "domcontentloaded" });
  const productPreviewFrame = page;
  const productPreview = page.locator('[data-dashboard-product-preview="true"]');
  await productPreview.waitFor();
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
    replayScrollState.scrollHeight > replayScrollState.viewportHeight,
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
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scroll-world-ready="true"]').waitFor();

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

  await page.setViewportSize({ width: 1440, height: 900 });
  // Scroll to the middle of the report scene without the removed side controls.
  await page.evaluate(() => window.scrollTo(0, innerHeight * 5.15));
  await page.waitForFunction(
    () => document.querySelector('.sw-copy[data-sw-active="true"] .sw-copy__title')?.textContent?.includes("페이지와 분석 결과를 한눈에.")
  );
  assert.equal(
    await page.locator('.sw-copy[data-sw-active="true"]').count(),
    1,
    "scene navigation must keep exactly one interactive copy"
  );

  const landingReducedMotion = await page.evaluate(() => {
    const action = document.querySelector(".sw-topcta");
    return {
      matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      transitionDuration: action ? getComputedStyle(action).transitionDuration : null,
      videos: document.querySelectorAll("video").length
    };
  });

  assert.equal(landingReducedMotion.matches, true);
  assert.equal(landingReducedMotion.scrollBehavior, "auto");
  assert.equal(landingReducedMotion.videos, 0);
  assert.ok(
    Number.parseFloat(landingReducedMotion.transitionDuration ?? "1") <= 0.00001,
    `landing reduced-motion transition is not effectively disabled: ${landingReducedMotion.transitionDuration}`
  );

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scroll-world-ready="true"]').waitFor();
  await page.keyboard.press("Tab");
  assert.deepEqual(
    await page.evaluate(() => ({
      href: document.activeElement?.getAttribute("href"),
      text: document.activeElement?.textContent?.trim()
    })),
    { href: "#uni-access-main", text: "본문으로 바로가기" }
  );
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "uni-access-main");

  const heroCta = page.locator(".sw-topcta");
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

  // Quick-analysis validation errors are announced (persistent live region),
  // linked to the field and rendered in an AA-contrast colour. A clean context
  // is used because the context above restores a stored quick-analysis attempt.
  const quickContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const quickPage = await quickContext.newPage();
  await quickPage.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    assert.equal(pathname, "/api/dashboard/overview", `Unexpected quick-analysis API request: ${pathname}`);
    await fulfillJson(route, createDashboardOverview({ organizations: [] }));
  });
  await quickPage.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  const quickUrl = quickPage.locator("#quick-analyze-url");
  const quickError = quickPage.locator("#quick-analyze-url-error");
  assert.equal(await quickError.getAttribute("aria-live"), "assertive", "the live region must exist before any error");
  assert.equal(await quickError.getAttribute("role"), null, "an empty region must not be reported as an alert");
  await quickUrl.fill("https://");
  await quickUrl.press("Enter");
  await quickError.filter({ hasText: "올바른 페이지 주소" }).waitFor();
  assert.equal(await quickError.getAttribute("role"), "alert");
  assert.equal(await quickUrl.getAttribute("aria-invalid"), "true");
  assert.equal(await quickUrl.getAttribute("aria-describedby"), "quick-analyze-url-error");
  assert.equal(
    await quickError.evaluate((element) => getComputedStyle(element).color),
    "rgb(180, 35, 50)",
    "light-theme error text must use the AA danger token"
  );
  await quickContext.close();

  console.log("Accessibility P0 regression checks passed.");
} finally {
  await browser.close();
}
