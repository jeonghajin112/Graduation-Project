import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installDashboardApiFixture } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const registryKey = "uni-access.quick-analysis-results.v2";
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const fixture = await installDashboardApiFixture(page);
  const consoleErrors = [];
  const externalFontErrors = [];
  const pageErrors = [];
  const sidebar = page.getByRole("complementary");
  const main = page.getByRole("main");
  const currentItems = () => sidebar.locator('[aria-current="page"]');
  const recentPageItems = () => sidebar.getByRole("button", { name: /페이지 열기 \(.+ 프로젝트\)$/ });

  page.on("console", (message) => {
    if (message.type() === "error") {
      const locationUrl = message.location().url;
      if (
        locationUrl.startsWith(
          "https://cdn.jsdelivr.net/gh/orioncactus/pretendard/"
        )
      ) {
        externalFontErrors.push(message.text());
        return;
      }
      consoleErrors.push(locationUrl ? `${locationUrl}: ${message.text()}` : message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  await page.addInitScript((key) => {
    const resetMarker = `${key}.test-reset`;
    if (window.sessionStorage.getItem(resetMarker) !== "done") {
      window.localStorage.removeItem(key);
      window.sessionStorage.setItem(resetMarker, "done");
    }
  }, registryKey);

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });

  const analyzeItem = sidebar.getByRole("button", { name: "새 페이지 분석", exact: true });
  assert.equal(await currentItems().count(), 1);
  assert.equal(await analyzeItem.getAttribute("aria-current"), "page");

  const firstProject = sidebar.getByRole("button", {
    name: fixture.organization.name,
    exact: true
  });
  const projectTitle = fixture.organization.name;
  await firstProject.click();
  await page.waitForURL(/\/projects\/\d+$/);
  await page.waitForFunction(() => {
    const selected = document.querySelectorAll('aside [aria-current="page"]');
    return selected.length === 1 && selected[0]?.hasAttribute("title");
  });

  assert.equal(await analyzeItem.getAttribute("aria-current"), null);
  assert.equal(await currentItems().count(), 1);
  assert.equal(await currentItems().first().getAttribute("title"), projectTitle);

  const firstPageEntry = main.getByRole("button", {
    name: `${fixture.target.name} 상세 보기`,
    exact: true
  });
  await firstPageEntry.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/projects\/\d+\/pages\/\d+$/);
  await page.waitForFunction(() => {
    const selected = document.querySelectorAll('aside [aria-current="page"]');
    return selected.length === 1 && selected[0]?.matches('a[href*="/projects/"][href*="/pages/"]');
  });

  assert.equal(await currentItems().count(), 1);
  assert.equal(await firstProject.getAttribute("aria-current"), null);
  assert.match((await currentItems().first().getAttribute("href")) ?? "", /\/projects\/\d+\/pages\/\d+$/);

  const [, projectIdSegment, , pageIdSegment] = new URL(page.url()).pathname.split("/").filter(Boolean);
  const projectId = Number(projectIdSegment);
  const pageId = Number(pageIdSegment);

  await page.goto(`${baseUrl}/recent-pages/${pageId}`, { waitUntil: "networkidle" });
  assert.equal(
    await recentPageItems().count(),
    0,
    "an analyzed project page must not appear in recent pages when the quick-analysis registry is empty"
  );

  await page.evaluate(
    ({ key, projectId: selectedProjectId, pageId: selectedPageId }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          records: [
            {
              projectId: selectedProjectId,
              pageId: selectedPageId,
              timestamp: Date.now()
            }
          ]
        })
      );
    },
    { key: registryKey, projectId, pageId }
  );

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  const firstRecentPage = recentPageItems().first();
  await firstRecentPage.waitFor();
  assert.equal(await recentPageItems().count(), 1);

  assert.equal(await currentItems().count(), 1);
  assert.equal(await analyzeItem.getAttribute("aria-current"), "page");

  const recentPageAriaLabel = await firstRecentPage.getAttribute("aria-label");
  await firstRecentPage.click();
  await page.waitForURL(/\/recent-pages\/\d+$/);
  await page.waitForFunction(
    (ariaLabel) =>
      [...document.querySelectorAll("aside button")].some(
        (item) =>
          item.getAttribute("aria-label") === ariaLabel &&
          item.getAttribute("aria-current") === "page"
      ),
    recentPageAriaLabel
  );

  assert.equal(await analyzeItem.getAttribute("aria-current"), null);
  assert.equal(await currentItems().count(), 1);
  assert.equal(await firstRecentPage.getAttribute("aria-current"), "page");

  const accountTrigger = sidebar.locator('button[aria-haspopup="menu"]');
  await accountTrigger.click();
  const accountMenuItems = page.getByRole("menuitem");
  const accountMenuItemCount = await accountMenuItems.count();
  assert.equal(accountMenuItemCount, 2);
  assert.deepEqual(
    (await accountMenuItems.allTextContents()).map((label) => label.trim()),
    ["설정", "로그아웃"]
  );
  assert.equal(await page.getByRole("menuitem", { name: "프로필", exact: true }).count(), 0);
  // Let the component's menu-open focus frame settle before taking explicit
  // keyboard ownership. Otherwise that queued frame can race ArrowDown and
  // move focus back to the first item under a busy CI event loop.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  const firstAccountMenuItem = accountMenuItems.first();
  const secondAccountMenuItem = accountMenuItems.nth(1);
  await firstAccountMenuItem.focus();
  await page.keyboard.press("ArrowDown");
  const secondAccountMenuItemHandle = await secondAccountMenuItem.elementHandle();
  assert.ok(secondAccountMenuItemHandle);
  await page.waitForFunction(
    (element) => document.activeElement === element,
    secondAccountMenuItemHandle
  );
  assert.equal(
    await secondAccountMenuItem.evaluate((element) => document.activeElement === element),
    true
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-haspopup") === "menu"
  );
  const escapeFocusRestored = await accountTrigger.evaluate(
    (element) => document.activeElement === element
  );
  assert.equal(escapeFocusRestored, true);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  fixture.assertIsolated();

  console.log(
    JSON.stringify({
      status: "PASS",
      routes: ["/analyze", `/projects/${projectId}`, `/projects/${projectId}/pages/${pageId}`, `/recent-pages/${pageId}`],
      emptyRegistryRecentCount: 0,
      fixtureRecentCount: await recentPageItems().count(),
      ariaCurrentCount: await currentItems().count(),
      accountMenuItemCount,
      escapeFocusRestored,
      consoleErrorCount: consoleErrors.length,
      externalFontErrorCount: externalFontErrors.length,
      pageErrorCount: pageErrors.length
    })
  );
} finally {
  await browser.close();
}
