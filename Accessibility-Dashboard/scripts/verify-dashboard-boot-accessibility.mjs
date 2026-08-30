/**
 * Regression check: while the initial overview is unresolved, the visual boot
 * overlay must also block keyboard and assistive-technology access to the app.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const unexpectedRequests = [];
let markOverviewRequested;
const overviewRequested = new Promise((resolve) => {
  markOverviewRequested = resolve;
});
let releaseOverview;
const overviewGate = new Promise((resolve) => {
  releaseOverview = resolve;
});

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdpSession = await page.context().newCDPSession(page);
  const isSkipLinkExposed = async () => {
    const { nodes } = await cdpSession.send("Accessibility.getFullAXTree");
    return nodes.some(
      (node) =>
        node.ignored !== true &&
        node.role?.value === "link" &&
        node.name?.value === "본문으로 바로가기"
    );
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const requestLabel = `${request.method()} ${requestUrl.pathname}`;

    if (requestLabel === "GET /api/dashboard/overview") {
      markOverviewRequested();
      await overviewGate;
      await fulfillJson(route, createDashboardOverview());
      return;
    }

    unexpectedRequests.push(requestLabel);
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ success: false, data: null, message: requestLabel })
    });
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
  await overviewRequested;

  const appShell = page.locator("[data-dashboard-app-shell]");
  const bootOverlay = page.locator("[data-dashboard-boot-overlay]");
  await bootOverlay.waitFor();

  assert.equal(await appShell.getAttribute("inert"), "");
  assert.equal(await appShell.getAttribute("aria-busy"), "true");
  assert.equal(await bootOverlay.getAttribute("role"), "status");
  assert.equal(await bootOverlay.getAttribute("aria-live"), "polite");
  assert.equal(await bootOverlay.getAttribute("aria-atomic"), "true");
  assert.equal((await bootOverlay.innerText()).trim(), "분석 화면을 불러오는 중...");
  assert.equal(await page.locator(".dashboard-skip-link").count(), 1);
  assert.equal(
    await isSkipLinkExposed(),
    false,
    "inert dashboard content must be absent from the accessibility tree"
  );

  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.closest("[data-dashboard-app-shell]") !== null
      ),
      false,
      "keyboard focus must not enter the dashboard behind the boot overlay"
    );
  }

  releaseOverview();
  await bootOverlay.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const shell = document.querySelector("[data-dashboard-app-shell]");
    return shell?.hasAttribute("inert") === false && shell?.getAttribute("aria-busy") !== "true";
  });
  assert.equal(await isSkipLinkExposed(), true);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains("dashboard-skip-link")),
    true,
    "dashboard keyboard navigation must resume after bootstrap completes"
  );

  assert.deepEqual(unexpectedRequests, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      bootBackgroundWasInert: true,
      loadingStatusWasAnnounced: true,
      keyboardNavigationResumed: true
    })
  );
} finally {
  releaseOverview();
  await browser.close();
}
