import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installDashboardApiFixture } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const browser = await chromium.launch({ headless: true });
const viewports = [
  { width: 1920, height: 1080 }, { width: 1600, height: 900 },
  { width: 1366, height: 768 }, { width: 1280, height: 720 },
  { width: 768, height: 1024 }, { width: 639, height: 844 },
  { width: 390, height: 844 }, { width: 320, height: 568 }
];

async function resize(page, viewport) {
  await page.setViewportSize(viewport);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertNoHorizontalOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
}

try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ colorScheme: theme });
    const page = await context.newPage();
    const fixture = await installDashboardApiFixture(page);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page.locator("#quick-analyze-url").waitFor();
    for (const viewport of viewports) {
      await resize(page, viewport);
      const input = await page.locator("#quick-analyze-url").boundingBox();
      const button = await page.getByRole("button", { name: "분석 시작", exact: true }).boundingBox();
      assert.ok(input.height >= 40, `${theme} ${viewport.width}: URL input must remain usable`);
      assert.ok(button.height >= 44, `${theme} ${viewport.width}: submit target must remain usable`);
      assert.ok(Math.abs(input.height + 2 - button.height) < 2, "input and button must retain matching heights");
      if (viewport.width < 640) {
        assert.ok(button.y >= input.y + input.height, "mobile controls must stack without overlap");
        assert.ok(button.y + button.height <= viewport.height, "the initial mobile form must fit below the fixture menu");
      }
      await assertNoHorizontalOverflow(page, `analysis ${viewport.width}`);
    }

    await page.goto(`${baseUrl}/projects/${fixture.organization.id}`, { waitUntil: "networkidle" });
    for (const viewport of viewports.filter(viewport => viewport.width < 768)) {
      await resize(page, viewport);
      const title = await page.getByRole("heading", { name: fixture.organization.name, level: 1 }).boundingBox();
      const action = await page.getByRole("button", { name: "페이지 추가", exact: true }).boundingBox();
      const card = await page.locator(".dashboard-project-card").first().boundingBox();
      assert.ok(action.y >= title.y + title.height, "mobile page action must follow the project heading");
      assert.ok(action.y + action.height <= card.y, "mobile page action must precede the page cards");
      await assertNoHorizontalOverflow(page, `project ${viewport.width}`);
    }

    await page.goto(`${baseUrl}/projects/${fixture.organization.id}/pages/${fixture.target.id}`, { waitUntil: "networkidle" });
    await page.locator(".site-page-information").waitFor();
    for (const viewport of viewports) {
      await resize(page, viewport);
      const title = await page.getByRole("heading", { name: "페이지 정보", exact: true }).boundingBox();
      const actions = await page.locator(".site-page-information__analysis-actions").boundingBox();
      assert.ok(title.y < actions.y + actions.height && actions.y < title.y + title.height,
        `${theme} ${viewport.width}: date and rescan must stay in the heading row`);
      assert.ok(title.x + title.width <= actions.x, "heading and actions must not overlap");
      await assertNoHorizontalOverflow(page, `detail ${viewport.width}`);
    }

    await resize(page, { width: 568, height: 320 });
    await page.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: "설정", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "설정", exact: true });
    await dialog.waitFor();
    const bounds = await dialog.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => {
      const modal = document.querySelector('[role="dialog"]');
      const close = [...modal.querySelectorAll("button")].find(button => button.textContent.trim() === "닫기");
      const m = modal.getBoundingClientRect(), b = close.getBoundingClientRect();
      return b.top >= m.top && b.bottom <= m.bottom;
    });
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    fixture.assertIsolated();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ result: "PASS", themes: 2, viewports: viewports.length, shortSettingsHeight: 320 }));
} finally {
  await browser.close();
}
