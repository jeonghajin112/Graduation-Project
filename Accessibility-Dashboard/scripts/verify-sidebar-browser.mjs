import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl("SIDEBAR_TEST_BASE_URL");
const projectId = Number(process.env.SIDEBAR_TEST_PROJECT_ID ?? "1");
const pageId = Number(process.env.SIDEBAR_TEST_PAGE_ID ?? "33");
const projectName = process.env.SIDEBAR_TEST_PROJECT_NAME ?? "AI Module Imported";
const pageName = process.env.SIDEBAR_TEST_PAGE_NAME ?? "example.com";
const otherProjectId = Number(process.env.SIDEBAR_TEST_OTHER_PROJECT_ID ?? "33");
const otherProjectName =
  process.env.SIDEBAR_TEST_OTHER_PROJECT_NAME ?? "CODEx-E2E-Recent-Selection-20260728";
const registryKey = "uni-access.quick-analysis-results.v2";
const artifactDirectory = resolve("artifacts", "sidebar-selection");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
const externalFontErrors = [];
const pageErrors = [];
const steps = [];

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
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => {
  pageErrors.push(error.message);
});

await page.addInitScript(
  ({ key, fixture }) => {
    window.localStorage.setItem(key, JSON.stringify(fixture));
  },
  {
    key: registryKey,
    fixture: {
      version: 2,
      records: [
        { projectId, pageId, timestamp: Date.now() },
        { projectId: otherProjectId, pageId, timestamp: Date.now() + 1000 },
        { projectId, pageId: 999999, timestamp: Date.now() + 2000 },
        { projectId, pageId: -1, timestamp: Date.now() + 3000 }
      ]
    }
  }
);

async function waitForDashboard() {
  await page.locator("aside").waitFor();
  await page.locator("main").waitFor();
  await page.getByRole("button", { name: projectName, exact: true }).waitFor();
}

async function waitForResultBody() {
  await page.getByText("접근성 점수 추이", { exact: true }).waitFor();
}

async function waitForRouteBody() {
  const pathname = new URL(page.url()).pathname;
  if (pathname.startsWith("/recent-pages/") || /\/projects\/\d+\/pages\/\d+/.test(pathname)) {
    await waitForResultBody();
    return;
  }

  if (/^\/projects\/\d+$/.test(pathname)) {
    await page.getByRole("button", { name: "페이지 추가", exact: true }).waitFor();
  }
}

async function collectStep(name) {
  await waitForDashboard();
  await waitForRouteBody();
  const sidebar = page.locator("aside");
  const activeClassCount = await sidebar.locator(".sidebar-nav-link-active").count();
  const ariaCurrentCount = await sidebar.locator('[aria-current="page"]').count();
  const mainText = (await page.locator("main").innerText()).replace(/\s+/g, " ").trim();
  const result = {
    name,
    url: page.url(),
    activeClassCount,
    ariaCurrentCount,
    mainExcerpt: mainText.slice(0, 90)
  };
  steps.push(result);
  assert.equal(activeClassCount, 1, `${name}: active class count`);
  assert.equal(ariaCurrentCount, 1, `${name}: aria-current count`);
  return mainText;
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

try {
  await mkdir(artifactDirectory, { recursive: true });

  await page.goto(`${baseUrl}/projects/${projectId}/pages/${pageId}`);
  await waitForResultBody();
  const projectPageBody = await collectStep("project-page-body");
  assert.match(projectPageBody, new RegExp(pageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await page.goto(`${baseUrl}/recent-pages/${pageId}`);
  await waitForResultBody();
  const recentPageBody = await collectStep("recent-page-body");
  assert.equal(recentPageBody, projectPageBody, "project/recent result body must match");

  const recentButtons = page.locator('aside button[aria-label*="페이지 열기"]');
  assert.equal(await recentButtons.count(), 1, "only the quick fixture may appear in recent pages");
  assert.match(await recentButtons.first().getAttribute("aria-label"), new RegExp(`^${pageName}`));
  assert.equal(await page.locator("aside").getByText("www.naver.com", { exact: true }).count(), 0);

  await page.goto(`${baseUrl}/analyze`);
  await waitForDashboard();
  await page.getByRole("button", { name: projectName, exact: true }).click();
  await page.waitForURL(`**/projects/${projectId}`);
  await collectStep("project");

  await page.getByRole("button", { name: new RegExp(`^${pageName} 페이지 열기`) }).click();
  await page.waitForURL(`**/recent-pages/${pageId}`);
  await collectStep("recent");

  await page.getByRole("button", { name: otherProjectName, exact: true }).click();
  await page.waitForURL(`**/projects/${otherProjectId}`);
  await collectStep("other-project");

  await page.goBack();
  await page.waitForURL(`**/recent-pages/${pageId}`);
  await collectStep("back");

  await page.goForward();
  await page.waitForURL(`**/projects/${otherProjectId}`);
  await collectStep("forward");

  await page.reload();
  await collectStep("reload");

  await page.goto(`${baseUrl}/recent-pages/${pageId}`);
  const projectButton = page.getByRole("button", { name: projectName, exact: true });
  await projectButton.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const projectFocus = await projectButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth
    };
  });
  assert.equal(projectFocus.focusVisible, true);
  assert.notEqual(projectFocus.outlineStyle, "none");
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/projects/${projectId}`);

  const recentButton = page.getByRole("button", {
    name: new RegExp(`^${pageName} 페이지 열기`)
  });
  await recentButton.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const recentFocus = await recentButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth
    };
  });
  assert.equal(recentFocus.focusVisible, true);
  assert.notEqual(recentFocus.outlineStyle, "none");
  await page.keyboard.press("Space");
  await page.waitForURL(`**/recent-pages/${pageId}`);
  await collectStep("keyboard-space-recent");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: resolve(artifactDirectory, "desktop-1440.png"),
    fullPage: true
  });
  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  assert.ok(desktopOverflow <= 0, `desktop horizontal overflow: ${desktopOverflow}`);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({
    path: resolve(artifactDirectory, "narrow-320.png"),
    fullPage: true
  });
  const narrowOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  assert.ok(narrowOverflow <= 0, `narrow horizontal overflow: ${narrowOverflow}`);

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        steps,
        resultBodyHash: hashText(projectPageBody),
        recentLabels: await recentButtons.allTextContents(),
        keyboard: { projectFocus, recentFocus },
        overflow: { desktop: desktopOverflow, narrow: narrowOverflow },
        consoleErrorCount: consoleErrors.length,
        externalFontErrorCount: externalFontErrors.length,
        pageErrorCount: pageErrors.length,
        screenshots: [
          resolve(artifactDirectory, "desktop-1440.png"),
          resolve(artifactDirectory, "narrow-320.png")
        ]
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
