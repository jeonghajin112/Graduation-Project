import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const widths = [1440, 1024, 768, 390, 320];

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
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
    const payload =
      pathname === "/api/requests"
        ? [pendingRequest]
        : pathname === "/api/organizations"
          ? [organization]
          : pathname === `/api/organizations/${organization.id}/evaluation-targets`
            ? [evaluationTarget]
            : null;
    assert.notEqual(payload, null, `Unexpected P0 API request: ${pathname}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload)
    });
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#ua-hero-title").waitFor();
  await page.locator(".ua-stage").waitFor();

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
  assert.equal(new URL(page.url()).pathname, "/dashboard");
  await page.locator("#dashboard-main-content").waitFor();
  await page.locator("#dashboard-main-content .dashboard-card").first().waitFor();
  assert.equal(await dashboardSidebar.locator('[aria-current="page"]').count(), 0);
  assert.equal(await analyzeSidebarItem.getAttribute("aria-current"), null);

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
