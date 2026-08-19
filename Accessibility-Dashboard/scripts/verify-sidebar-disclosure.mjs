import assert from "node:assert/strict";
import path from "node:path";

import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5174";
const registryKey = "uni-access.quick-analysis-results.v2";
const artifactsDir = path.resolve("artifacts");
const browser = await chromium.launch({ headless: true });
const observations = [];

async function verifyViewport({ height, name, width }) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }

    const locationUrl = message.location().url;
    if (locationUrl.startsWith("https://cdn.jsdelivr.net/gh/orioncactus/pretendard/")) {
      return;
    }
    consoleErrors.push(locationUrl ? `${locationUrl}: ${message.text()}` : message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.addInitScript(
    ({ quickRegistryKey }) => {
      const resetMarker = `${quickRegistryKey}.disclosure-reset`;
      if (window.sessionStorage.getItem(resetMarker) === "done") {
        return;
      }
      window.localStorage.removeItem(quickRegistryKey);
      window.localStorage.setItem("bridge-theme", "light");
      window.sessionStorage.setItem(resetMarker, "done");
    },
    { quickRegistryKey: registryKey }
  );

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });

  const sidebar = page.locator("aside");
  const currentItems = () => sidebar.locator('[aria-current="page"]');
  const analyzeItem = sidebar.getByRole("button", { name: "새 페이지 분석", exact: true });
  const projectParents = sidebar.locator('button[aria-controls^="sidebar-project-pages-"]');
  const firstProject = projectParents.first();

  assert.equal(await sidebar.locator('[role="tree"]').count(), 0);
  assert.equal(await currentItems().count(), 1);
  assert.equal(await analyzeItem.getAttribute("aria-current"), "page");
  assert.equal(await firstProject.count(), 1, `${name}: project fixture is required`);
  assert.equal(await firstProject.getAttribute("aria-expanded"), "false");

  const lightMetrics = await firstProject.evaluate((element) => {
    const nameElement = element.querySelector("span.flex-1.truncate");
    const countElement = element.querySelector("span.text-xs");
    return {
      countColor: countElement ? getComputedStyle(countElement).color : null,
      height: element.getBoundingClientRect().height,
      nameColor: nameElement ? getComputedStyle(nameElement).color : null
    };
  });
  assert.equal(lightMetrics.height, 44);
  assert.equal(lightMetrics.nameColor, "rgb(29, 29, 31)");
  assert.equal(lightMetrics.countColor, "rgb(110, 110, 115)");

  await firstProject.click();
  await page.waitForURL(/\/projects\/\d+$/);
  await page.waitForFunction(() => {
    const parent = document.querySelector('aside button[aria-controls^="sidebar-project-pages-"]');
    return parent?.getAttribute("aria-expanded") === "true" && parent.getAttribute("aria-current") === "page";
  });
  assert.equal(await currentItems().count(), 1);
  assert.equal(await firstProject.getAttribute("aria-current"), "page");

  const childListId = await firstProject.getAttribute("aria-controls");
  assert.ok(childListId);
  const childList = sidebar.locator(`#${childListId}`);
  assert.equal(await childList.evaluate((element) => element.tagName), "UL");
  assert.equal(await childList.locator(":scope > li").count() > 0, true, `${name}: page fixture is required`);
  assert.equal(await firstProject.locator("svg.lucide-folder-open").count(), 1);

  await firstProject.focus();
  await page.keyboard.press("Enter");
  assert.equal(await firstProject.getAttribute("aria-expanded"), "false");
  await firstProject.focus();
  await page.keyboard.press("Space");
  assert.equal(await firstProject.getAttribute("aria-expanded"), "true");

  const firstChild = childList.locator('a[href*="/pages/"]').first();
  assert.equal(await firstChild.getAttribute("aria-current"), null);
  assert.equal(await firstChild.evaluate((element) => element.getBoundingClientRect().height), 44);
  const childHref = await firstChild.getAttribute("href");
  assert.ok(childHref);
  const [, projectIdSegment, , pageIdSegment] = new URL(childHref, baseUrl).pathname.split("/").filter(Boolean);
  const projectId = Number(projectIdSegment);
  const pageId = Number(pageIdSegment);

  await firstChild.click();
  await page.waitForURL(/\/projects\/\d+\/pages\/\d+$/);
  await page.waitForFunction(() => {
    const selected = document.querySelectorAll('aside [aria-current="page"]');
    return selected.length === 1 && selected[0]?.matches('a[href*="/projects/"][href*="/pages/"]');
  });
  assert.equal(await currentItems().count(), 1);
  assert.equal(await firstProject.getAttribute("aria-current"), null);
  assert.equal(await firstProject.getAttribute("aria-expanded"), "true");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const parent = document.querySelector('aside button[aria-controls^="sidebar-project-pages-"]');
    const selected = document.querySelectorAll('aside [aria-current="page"]');
    return (
      parent?.getAttribute("aria-expanded") === "true" &&
      selected.length === 1 &&
      selected[0]?.matches('a[href*="/projects/"][href*="/pages/"]')
    );
  });
  const expandedScreenshotPath = path.join(artifactsDir, `sidebar-disclosure-${name}-expanded.png`);
  await page.screenshot({ path: expandedScreenshotPath, fullPage: true });

  const menuTrigger = sidebar.locator('button[aria-label$="관리 메뉴"]').first();
  const countRect = await firstProject.locator("span.text-xs").boundingBox();
  const menuRect = await menuTrigger.boundingBox();
  assert.ok(countRect && menuRect);
  assert.equal(countRect.x + countRect.width <= menuRect.x, true);
  await menuTrigger.click();
  const projectMenu = page.getByRole("dialog", { name: /관리$/ }).first();
  await projectMenu.waitFor();
  await page.keyboard.press("Escape");
  await projectMenu.waitFor({ state: "hidden" });
  assert.equal(await menuTrigger.evaluate((element) => document.activeElement === element), true);

  await page.evaluate(
    ({ key, selectedPageId, selectedProjectId }) => {
      window.localStorage.setItem(
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
    { key: registryKey, selectedPageId: pageId, selectedProjectId: projectId }
  );

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  const recentItems = sidebar.locator('button[aria-label*="페이지 열기"]');
  assert.equal(await recentItems.count(), 1);
  assert.equal(await currentItems().count(), 1);
  assert.equal(await analyzeItem.getAttribute("aria-current"), "page");

  await recentItems.first().click();
  await page.waitForURL(/\/recent-pages\/\d+$/);
  await page.waitForFunction(() => {
    const selected = document.querySelectorAll('aside [aria-current="page"]');
    return selected.length === 1 && selected[0]?.matches('button[aria-label*="페이지 열기"]');
  });
  assert.equal(await currentItems().count(), 1);
  assert.equal(await recentItems.first().getAttribute("aria-current"), "page");
  assert.equal(await sidebar.locator('a[href*="/projects/"][href*="/pages/"][aria-current="page"]').count(), 0);

  await page.evaluate(() => window.localStorage.setItem("bridge-theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".bridge-dashboard.theme-dark").waitFor();

  const darkMetrics = await firstProject.evaluate((element) => {
    const nameElement = element.querySelector("span.flex-1.truncate");
    const countElement = element.querySelector("span.text-xs");
    return {
      countColor: countElement ? getComputedStyle(countElement).color : null,
      nameColor: nameElement ? getComputedStyle(nameElement).color : null
    };
  });
  assert.equal(darkMetrics.nameColor, "rgb(255, 255, 255)");
  assert.equal(darkMetrics.countColor, "rgb(161, 161, 166)");
  assert.equal(await currentItems().count(), 1);

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sidebar: (() => {
      const element = document.querySelector("aside");
      return element ? element.scrollWidth - element.clientWidth : -1;
    })()
  }));
  assert.deepEqual(overflow, { body: 0, document: 0, sidebar: 0 });

  const screenshotPath = path.join(artifactsDir, `sidebar-disclosure-${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);

  observations.push({
    activeCount: await currentItems().count(),
    ariaCurrentCount: await sidebar.locator('[aria-current="page"]').count(),
    darkMetrics,
    expandedScreenshotPath,
    lightMetrics,
    name,
    overflow,
    route: new URL(page.url()).pathname,
    screenshotPath,
    viewport: { height, width }
  });

  await context.close();
}

try {
  await verifyViewport({ height: 800, name: "desktop", width: 1280 });
  await verifyViewport({ height: 844, name: "mobile-390", width: 390 });
  console.log(JSON.stringify({ observations, status: "PASS" }));
} finally {
  await browser.close();
}
