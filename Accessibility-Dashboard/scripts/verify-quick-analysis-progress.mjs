// Background analysis contract: accepting another URL never depends on viewing a result.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const output = new URL("../artifacts/quick-analysis-progress/", import.meta.url);
await mkdir(output, { recursive: true });
const timestamp = "2026-09-06T00:00:00.000Z";
const organization = { id: 1, name: "연속 분석 검증", description: "", status: "ACTIVE", updatedAt: timestamp };
const requests = [];
const targets = [];
let overviewUnavailable = false;
let staleOverview = false;
let resultReads = 0;
let failingStatusId = null;
const browser = await chromium.launch({ headless: true });
const errors = [];
const requestJournal = [];
try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 950 } });
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 150 : ms, ...args);
  });
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    requestJournal.push({
      pathname,
      statuses: requests.map(({ id, status }) => ({ id, status })),
      overviewUnavailable,
      staleOverview,
      failingStatusId
    });
    if (pathname === "/api/dashboard/overview") {
      if (overviewUnavailable) return fulfillJson(route, null, { status: 503 });
      return fulfillJson(route, createDashboardOverview({
        organizations: [organization], evaluationTargets: staleOverview ? targets.slice(0, 1) : targets,
        evaluationRequests: staleOverview ? requests.slice(0, 1) : requests
      }));
    }
    if (pathname === "/api/requests/evaluate" && route.request().method() === "POST") {
      const id = 501 + requests.length;
      const url = route.request().postDataJSON().url;
      const targetId = 101 + targets.length;
      targets.push({ id: targetId, organizationId: 1, name: new URL(url).hostname, accessUrl: url,
        targetType: "WEB", status: "ACTIVE", createdAt: timestamp });
      const request = { id, evaluationTargetId: targetId, status: requests.length === 0 ? "IN_PROGRESS" : "PENDING", quickAnalysis: true,
        requestedAt: new Date(Date.parse(timestamp) + id * 1000).toISOString(), updatedAt: timestamp };
      requests.push(request);
      return fulfillJson(route, request);
    }
    const request = requests.find(item => pathname === "/api/requests/" + item.id);
    if (request) return fulfillJson(route, request.id === failingStatusId ? null : request,
      { status: request.id === failingStatusId ? 503 : 200 });
    if (pathname.includes("/results/") || pathname.startsWith("/api/targets/")) {
      resultReads++;
      return fulfillJson(route, null, { status: 503 });
    }
    return fulfillJson(route, []);
  });
  await page.goto(baseUrl + "/analyze", { waitUntil: "networkidle" });
  await page.getByRole("complementary").getByRole("button", { name: organization.name, exact: true }).click();
  await page.getByRole("button", { name: "새 페이지 분석", exact: true }).click();
  async function submit(url) {
    await page.locator("#quick-analyze-url").fill(url);
    await page.getByRole("button", { name: "분석 시작", exact: true }).click();
    await page.waitForFunction(() => {
      const input = document.querySelector("#quick-analyze-url");
      return input && !input.disabled && input.value === "";
    });
  }
  const job = id => page.locator('.sidebar-tree-projects [data-analysis-request-id="' + id + '"]');
  await submit("https://first.example/");
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="501"][data-analysis-status="IN_PROGRESS"]').waitFor();
  staleOverview = true;
  await submit("https://second.example/");
  assert.equal(await page.getByRole("region", { name: "분석 작업" }).count(), 0);
  assert.equal(requests.length, 2, "a running request must not hold the next URL");
  // A delayed overview may omit a new target; retain its accepted URL and job.
  assert.equal(await page.locator("#quick-analyze-url").inputValue(), "");
  assert.equal(new URL(page.url()).pathname, "/analyze");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("accessibility-dashboard.quick-analysis-attempt.v1")), null);

  staleOverview = false;
  overviewUnavailable = true;
  requests[0].status = "COMPLETED";
  requests[1].status = "IN_PROGRESS";
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="501"][data-analysis-status="COMPLETED"]').waitFor();

  assert.equal(new URL(page.url()).pathname, "/analyze", "completion must never navigate automatically");
  overviewUnavailable = false;
  await submit("https://third.example/");
  assert.equal(requests.length, 3, "a failed result refresh must not hold the next URL");
  await job(502).waitFor();
  assert.equal(await job(502).getAttribute("data-analysis-status"), "IN_PROGRESS");
  assert.equal(resultReads, 0, "acceptance must not load result payloads");
  overviewUnavailable = true;
  failingStatusId = 502;
  requests[2].status = "IN_PROGRESS";
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="503"][data-analysis-status="IN_PROGRESS"]').waitFor();
  assert.equal(await page.locator('#quick-analyze-url').isEnabled(), true,
    "one unavailable status endpoint must not block other jobs or the input");
  failingStatusId = null;
  overviewUnavailable = false;
  requests[1].status = "FAILED";
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="502"][data-analysis-status="FAILED"]').waitFor();
  requests[2].status = "IN_PROGRESS";
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="503"][data-analysis-status="IN_PROGRESS"]').waitFor();
  assert.equal(await page.getByRole("button", { name: /분석 완료 확인/ }).count(), 0,
    "completion must not add a separate acknowledgement button");
  const firstPageTab = page.getByRole("complementary").getByRole("link", {
    name: "first.example 페이지 열기 (연속 분석 검증 프로젝트)", exact: true
  });
  await firstPageTab.click();
  await page.waitForURL("**/projects/1/pages/101");
  assert.equal(await job(501).count(), 0, "opening the page tab must acknowledge its completed analysis");
  await page.getByRole("button", { name: "새 페이지 분석", exact: true }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("complementary").getByRole("button", { name: organization.name, exact: true }).click();
  assert.equal(await job(501).count(), 0, "acknowledgement must survive reload");
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="503"][data-analysis-status="IN_PROGRESS"]').waitFor();
  assert.equal(requests.length, 3, "reload must restore jobs without another POST");
  await page.waitForURL("**/projects/1");
  requests[2].status = "COMPLETED";
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="503"][data-analysis-status="COMPLETED"]').waitFor();
  assert.equal(new URL(page.url()).pathname, "/projects/1", "navigation must not cancel background tracking");
  await page.getByRole("button", { name: "새 페이지 분석", exact: true }).click();
  // A new scan of an acknowledged page must display a new status.
  const nextRequest = { ...requests[0], id: 504, status: "IN_PROGRESS", requestedAt: new Date(Date.parse(requests[2].requestedAt) + 1000).toISOString() };
  requests.push(nextRequest);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("complementary").getByRole("button", { name: organization.name, exact: true }).click();
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="504"][data-analysis-status="IN_PROGRESS"]').waitFor();
  nextRequest.status = "COMPLETED";
  await page.locator('.sidebar-tree-projects [data-analysis-request-id="504"][data-analysis-status="COMPLETED"]').waitFor();
  await firstPageTab.press("Enter");
  await page.waitForURL("**/projects/1/pages/101");
  assert.equal(await job(504).count(), 0, "keyboard activation must also acknowledge the new completion");
  await page.getByRole("button", { name: "새 페이지 분석", exact: true }).click();
  for (const [width, dark] of [[1560, false], [1024, false], [390, false], [1560, true]]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
    await page.screenshot({ path: fileURLToPath(new URL((dark ? "dark" : "width-" + width) + ".png", output)) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", submissions: requests.length, resultReads, recoveredAfterReload: true }));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  const snapshot = await page?.evaluate(() => ({
    url: location.pathname,
    visibility: document.visibilityState,
    statuses: [...document.querySelectorAll("[data-analysis-request-id]")].map(element => ({
      requestId: element.getAttribute("data-analysis-request-id"),
      status: element.getAttribute("data-analysis-status"),
      visible: element.getBoundingClientRect().height > 0
    })),
    acknowledgements: Object.keys(localStorage)
      .filter(key => key.startsWith("uni-access.analysis-acknowledged."))
      .map(key => ({ key, value: localStorage.getItem(key) }))
  })).catch(() => null);
  const diagnostics = { snapshot, errors, requestJournal: requestJournal.slice(-24) };
  await writeFile(new URL("failure.json", output), JSON.stringify(diagnostics, null, 2));
  console.error(JSON.stringify(diagnostics));
  throw error;
} finally {
  await browser.close();
}
