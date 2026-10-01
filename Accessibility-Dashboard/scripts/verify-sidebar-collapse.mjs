import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installDashboardApiFixture } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const browser = await chromium.launch({ headless: true });

async function sidebarWidth(sidebar) {
  return (await sidebar.boundingBox())?.width ?? 0;
}

try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installDashboardApiFixture(page);
  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });

  const sidebar = page.locator("aside");
  const collapse = sidebar.getByRole("button", { name: "사이드바 접기", exact: true });
  const expand = sidebar.getByRole("button", { name: "사이드바 펼치기", exact: true });
  const analyzeLink = sidebar.getByRole("button", { name: "새 페이지 분석", exact: true });
  const addProject = sidebar.getByRole("button", { name: "프로젝트 추가", exact: true });
  const accountTrigger = sidebar.locator(".dashboard-account-menu-trigger");

  await collapse.waitFor();
  assert.equal(await collapse.getAttribute("aria-expanded"), "true");
  const expandedWidth = await sidebarWidth(sidebar);

  // Collapsing closes an open account menu instead of leaving it clipped in the rail.
  await accountTrigger.click();
  await page.getByRole("menu", { name: "계정 메뉴" }).waitFor();
  await collapse.click();
  await page.getByRole("menu", { name: "계정 메뉴" }).waitFor({ state: "detached" });

  await expand.waitFor();
  assert.equal(await expand.getAttribute("aria-expanded"), "false");
  assert.equal(await expand.evaluate((element) => element === document.activeElement), true,
    "the toggle keeps focus after collapsing");
  assert.equal(await accountTrigger.isVisible(), false, "collapsed rail hides the account label");
  assert.equal(await addProject.isVisible(), false, "collapsed rail hides the project tree");
  assert.equal(await analyzeLink.isVisible(), true, "primary navigation stays reachable as an icon");
  const collapsedWidth = await sidebarWidth(sidebar);
  assert.ok(collapsedWidth < 96 && collapsedWidth < expandedWidth / 2,
    `collapsed rail should be narrow (${collapsedWidth}px vs ${expandedWidth}px)`);

  // The labelled account trigger is hidden in the rail, but settings and
  // logout must stay reachable through the avatar-only rail trigger.
  const railAccount = sidebar.getByRole("button", { name: /^계정 메뉴/ });
  assert.equal(await railAccount.isVisible(), true, "collapsed rail keeps an account menu trigger");
  await railAccount.click();
  const railMenu = page.getByRole("menu", { name: "계정 메뉴" });
  await railMenu.waitFor();
  assert.equal(await railMenu.getByRole("menuitem", { name: "설정", exact: true }).isVisible(), true);
  assert.equal(await railMenu.evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  }), true, "rail account menu must not be clipped by the rail");
  await page.keyboard.press("Escape");
  await railMenu.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("dashboard-account-rail-trigger"));

  await analyzeLink.click();
  assert.equal(await analyzeLink.getAttribute("aria-current"), "page");

  await page.reload({ waitUntil: "networkidle" });
  await expand.waitFor();
  assert.equal(await addProject.isVisible(), false, "the collapsed preference survives reload");

  await expand.focus();
  await page.keyboard.press("Enter");
  await collapse.waitFor();
  assert.equal(await addProject.isVisible(), true, "expanding restores the project tree");
  assert.equal(await accountTrigger.isVisible(), true);
  assert.equal(Math.round(await sidebarWidth(sidebar)), Math.round(expandedWidth));

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileExpandedHeight = (await sidebar.boundingBox())?.height ?? 0;
  await collapse.click();
  await expand.waitFor();
  const mobileCollapsedHeight = (await sidebar.boundingBox())?.height ?? 0;
  assert.ok(mobileCollapsedHeight < mobileExpandedHeight && mobileCollapsedHeight < 80,
    `collapsed mobile sidebar should be one row (${mobileCollapsedHeight}px)`);
  assert.equal(await analyzeLink.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    "collapsed mobile sidebar must not overflow horizontally");

  assert.deepEqual(errors, []);
  await context.close();
  console.log("sidebar collapse: desktop rail, persistence, keyboard toggle and mobile row verified");
} finally {
  await browser.close();
}
