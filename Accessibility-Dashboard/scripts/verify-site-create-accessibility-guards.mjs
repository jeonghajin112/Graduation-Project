import assert from "node:assert/strict";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const storageKey = "accessibility-dashboard.site-create-attempt.v1";
const timestamp = "2026-08-24T10:00:00.000Z";
const organization = {
  id: 1,
  name: "Mobile guard project",
  type: "ETC",
  homepageUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const overview = createDashboardOverview({ organizations: [organization] });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
const page = await context.newPage();
let targetPosts = 0;
const unknownRequests = [];

try {
  await page.addInitScript((key) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function guardedSetItem(storageKey, value) {
      if (storageKey === key) {
        throw new DOMException("Storage is blocked", "QuotaExceededError");
      }
      return originalSetItem.call(this, storageKey, value);
    };
  }, storageKey);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    if (method === "GET" && pathname === "/api/dashboard/overview") {
      await fulfillJson(route, overview);
      return;
    }
    if (
      method === "GET" &&
      pathname === `/api/organizations/${organization.id}/evaluation-targets`
    ) {
      await fulfillJson(route, []);
      return;
    }
    if (
      method === "POST" &&
      pathname === `/api/organizations/${organization.id}/evaluation-targets`
    ) {
      targetPosts += 1;
      await fulfillJson(route, null, { status: 500 });
      return;
    }
    unknownRequests.push(`${method} ${pathname}`);
    await fulfillJson(route, null, { status: 500 });
  });

  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { level: 1, name: organization.name, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
  await dialog.getByLabel("페이지 이름", { exact: true }).fill("Storage guarded page");
  await dialog.getByLabel("페이지 주소", { exact: true }).fill("https://example.com/storage-guard");

  await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "이전 작업 상태를 저장하지 못해 요청을 시작하지 않았습니다" })
    .waitFor();

  const metrics = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      clientHeight: element.clientHeight,
      overflowY: style.overflowY,
      top: rect.top
    };
  });
  assert.ok(metrics.clientHeight <= 520, `dialog height ${metrics.clientHeight} exceeds mobile max`);
  assert.ok(metrics.top >= 0 && metrics.bottom <= 568, "dialog must stay inside the mobile viewport");
  assert.equal(metrics.overflowY, "auto");
  assert.equal(targetPosts, 0, "a storage failure must prevent the mutation POST");
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
  assert.deepEqual(unknownRequests, []);

  console.log(JSON.stringify({ result: "PASS", metrics, targetPosts }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
