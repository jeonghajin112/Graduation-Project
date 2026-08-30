import assert from "node:assert/strict";
import { chromium } from "playwright";

import { installDashboardApiFixture } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const browser = await chromium.launch({ headless: true });

async function verifyAppLoadingAndChunkFailure() {
  const context = await browser.newContext();
  const page = await context.newPage();
  let releaseModule;
  const moduleGate = new Promise((resolve) => {
    releaseModule = resolve;
  });
  let markModuleRequested;
  const moduleRequested = new Promise((resolve) => {
    markModuleRequested = resolve;
  });

  await page.route("**/src/components/dashboard/dashboard-app-route.tsx*", async (route) => {
    markModuleRequested();
    await moduleGate;
    await route.abort("failed");
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
  await moduleRequested;
  const loadingStatus = page.locator('[role="status"]').filter({
    hasText: "분석 화면을 불러오는 중..."
  });
  await loadingStatus.waitFor();
  assert.equal(await loadingStatus.getAttribute("aria-live"), "polite");
  assert.equal(await loadingStatus.getAttribute("aria-atomic"), "true");
  assert.equal(await loadingStatus.getAttribute("aria-busy"), "true");

  releaseModule();
  const errorAlert = page.getByRole("alert");
  await errorAlert.waitFor();
  assert.match(await errorAlert.innerText(), /앱 화면을 표시할 수 없습니다/);
  assert.equal(
    await errorAlert.getByRole("button", { name: "페이지 새로고침" }).count(),
    1
  );
  await context.close();
}

async function verifyRoutePanelLoading() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const fixture = await installDashboardApiFixture(page);
  let releasePanel;
  const panelGate = new Promise((resolve) => {
    releasePanel = resolve;
  });
  let markPanelRequested;
  const panelRequested = new Promise((resolve) => {
    markPanelRequested = resolve;
  });

  await page.route("**/src/components/dashboard/panels/quick-analyze-panel.tsx*", async (route) => {
    markPanelRequested();
    await panelGate;
    await route.continue();
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
  await panelRequested;
  const loadingStatus = page.locator('[role="status"]').filter({
    hasText: "화면을 불러오는 중..."
  });
  await loadingStatus.waitFor();
  assert.equal(await loadingStatus.getAttribute("aria-live"), "polite");
  assert.equal(await loadingStatus.getAttribute("aria-busy"), "true");

  releasePanel();
  await page.getByRole("button", { name: "분석 시작" }).waitFor();
  fixture.assertIsolated();
  await context.close();
}

async function verifyModalLoadingOwnership() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const fixture = await installDashboardApiFixture(page);
  let releaseModal;
  const modalGate = new Promise((resolve) => {
    releaseModal = resolve;
  });
  let markModalRequested;
  const modalRequested = new Promise((resolve) => {
    markModalRequested = resolve;
  });

  await page.route("**/src/components/dashboard/modals/account-settings-modal.tsx*", async (route) => {
    markModalRequested();
    await modalGate;
    await route.continue();
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  const accountTrigger = page.locator('button[aria-haspopup="menu"]');
  await accountTrigger.click();
  await page.getByRole("menuitem", { name: "설정" }).click();
  await modalRequested;

  const appShell = page.locator("[data-dashboard-app-shell]");
  const loadingStatus = page.locator('[role="status"]').filter({
    hasText: "창을 불러오는 중..."
  });
  await loadingStatus.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "status");
  assert.equal(await loadingStatus.getAttribute("aria-live"), "polite");
  assert.equal(await loadingStatus.getAttribute("aria-busy"), "true");
  assert.equal(await appShell.getAttribute("inert"), "");
  await page.keyboard.press("Tab");
  assert.equal(
    await loadingStatus.evaluate((element) => document.activeElement === element),
    true,
    "keyboard focus must remain owned by the lazy modal loading layer"
  );

  releaseModal();
  const dialog = page.getByRole("dialog", { name: "설정" });
  await dialog.waitFor();
  await page.waitForFunction(() => {
    const shell = document.querySelector("[data-dashboard-app-shell]");
    const openDialog = document.querySelector('[role="dialog"]');
    return (
      shell?.hasAttribute("inert") === false &&
      openDialog instanceof HTMLElement &&
      openDialog.contains(document.activeElement)
    );
  });

  await dialog.getByRole("button", { name: "닫기" }).click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-haspopup") === "menu"
  );
  fixture.assertIsolated();
  await context.close();
}

async function verifyTitlesHeadingAndThemeCleanup() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const fixture = await installDashboardApiFixture(page);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function getItem(key) {
      if (key === "bridge-theme") {
        throw new DOMException("Theme storage unavailable", "SecurityError");
      }
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === "bridge-theme") {
        throw new DOMException("Theme storage unavailable", "SecurityError");
      }
      return originalSetItem.call(this, key, value);
    };
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  assert.equal(await page.title(), "새 페이지 분석 | UNI ACCESS");
  assert.equal(
    await page.getByRole("heading", { level: 1, name: "새 페이지 분석" }).count(),
    1
  );

  const accountTrigger = page.locator('button[aria-haspopup="menu"]');
  await accountTrigger.click();
  await page.getByRole("menuitem", { name: "설정" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "설정" });
  await settingsDialog.getByText("다크", { exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await settingsDialog.getByRole("button", { name: "닫기" }).click();

  await page
    .getByRole("complementary")
    .getByRole("button", { name: fixture.organization.name, exact: true })
    .click();
  await page.waitForURL(`**/projects/${fixture.organization.id}`);
  await page.waitForFunction(
    (expectedTitle) => document.title === expectedTitle,
    `${fixture.organization.name} 프로젝트 | UNI ACCESS`
  );
  assert.equal(await page.title(), `${fixture.organization.name} 프로젝트 | UNI ACCESS`);

  await page
    .getByRole("main")
    .getByRole("button", { name: `${fixture.target.name} 상세 보기`, exact: true })
    .click({ position: { x: 12, y: 12 } });
  await page.waitForURL(`**/projects/${fixture.organization.id}/pages/${fixture.target.id}`);
  await page.waitForFunction(
    (expectedTitle) => document.title === expectedTitle,
    `${fixture.target.name} 접근성 분석 | UNI ACCESS`
  );
  const siteHeading = page.getByRole("heading", { level: 1, name: fixture.target.name });
  await siteHeading.waitFor();
  assert.equal(await page.title(), `${fixture.target.name} 접근성 분석 | UNI ACCESS`);

  await accountTrigger.click();
  await page.getByRole("menuitem", { name: "로그아웃" }).click();
  await page.waitForURL(`${baseUrl}/`);
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  assert.equal(await page.title(), "UNI ACCESS | 웹 접근성 결과를 명확하게");
  assert.deepEqual(pageErrors, []);
  fixture.assertIsolated();
  await context.close();
}

try {
  await verifyAppLoadingAndChunkFailure();
  await verifyRoutePanelLoading();
  await verifyModalLoadingOwnership();
  await verifyTitlesHeadingAndThemeCleanup();
  console.log(
    JSON.stringify({
      result: "PASS",
      appChunkRecoveryVisible: true,
      routeLoadingAnnounced: true,
      modalLoadingOwnedFocus: true,
      storageFailureTolerated: true,
      dashboardDarkClassCleanedUp: true,
      routeTitlesVerified: 4,
      siteDetailHasLevelOneHeading: true
    })
  );
} finally {
  await browser.close();
}
