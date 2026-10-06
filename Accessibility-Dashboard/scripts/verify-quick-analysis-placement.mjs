import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-09-06T02:00:00.000Z";
const organizations = [
  { id: 1, name: "접근성 분석", description: "AI-module imported evaluation results", status: "ACTIVE", updatedAt: timestamp, systemManaged: false },
  { id: 99, name: "AI Module Imported", description: "AI-module imported evaluation results", status: "ACTIVE", updatedAt: timestamp, systemManaged: true }
];
const targets = [{ id: 101, organizationId: 1, name: "프로젝트 페이지", accessUrl: "https://project.example/", targetType: "WEB", status: "ACTIVE", createdAt: timestamp }];
const requests = [{ id: 501, evaluationTargetId: 101, status: "COMPLETED", quickAnalysis: false, requestedAt: timestamp, updatedAt: timestamp }];
let submissions = 0;
let projectWrites = 0;
let omitLatestFromNextOverview = false;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 150 : ms, ...args);
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/dashboard/overview") {
      const omitLatest = omitLatestFromNextOverview;
      omitLatestFromNextOverview = false;
      return fulfillJson(route, createDashboardOverview({ organizations,
        evaluationTargets: omitLatest ? targets.slice(0, -1) : targets,
        evaluationRequests: omitLatest ? requests.slice(0, -1) : requests }));
    }
    if (path.startsWith("/api/organizations") && route.request().method() !== "GET") projectWrites++;
    if (path === "/api/requests/evaluate" && route.request().method() === "POST") {
      submissions++;
      const url = route.request().postDataJSON().url;
      const target = { id: 201 + submissions, organizationId: 99, name: new URL(url).hostname, accessUrl: url, targetType: "WEB", status: "ACTIVE", createdAt: timestamp };
      targets.push(target);
      const request = { id: 601 + submissions, evaluationTargetId: target.id, status: "PENDING", quickAnalysis: true,
        requestedAt: new Date(Date.parse(timestamp) + submissions * 1000).toISOString(), updatedAt: timestamp };
      requests.push(request);
      omitLatestFromNextOverview = true;
      return fulfillJson(route, request);
    }
    const request = requests.find(request => path === `/api/requests/${request.id}`);
    if (request) return fulfillJson(route, request);
    return fulfillJson(route, []);
  });
  await page.goto(baseUrl + "/analyze", { waitUntil: "networkidle" });
  const projects = page.locator(".sidebar-tree-projects");
  const recent = page.locator(".sidebar-tree-recent");
  const job = id => recent.locator(`[data-analysis-request-id="${id}"]`);
  await projects.getByRole("button", { name: "접근성 분석", exact: true }).waitFor();
  assert.equal(await projects.getByText("AI Module Imported", { exact: true }).count(), 0);
  assert.equal(await recent.getByText("프로젝트 페이지", { exact: true }).count(), 0, "project-only requests must not become quick history");
  for (const host of ["first.quick.example", "second.quick.example"]) {
    await page.locator("#quick-analyze-url").fill(`https://${host}/`);
    await page.getByRole("button", { name: "분석 시작", exact: true }).click();
    await recent.getByRole("button", { name: `${host} 페이지 열기 (최근 분석)`, exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector("#quick-analyze-url")?.value === "");
  }
  assert.equal(await job(602).getAttribute("data-analysis-status"), "PENDING");
  assert.equal(await projects.getByText("first.quick.example", { exact: true }).count(), 0);
  // No browser registry exists: pending receipts must survive a full reload.
  assert.equal(await page.evaluate(() => localStorage.getItem("uni-access.quick-analysis-results.v2")), null);
  await page.reload({ waitUntil: "domcontentloaded" });
  await job(602).waitFor();
  await job(603).waitFor();
  assert.equal(submissions, 2);
  requests[1].status = "IN_PROGRESS";
  await job(602).and(recent.locator('[data-analysis-status="IN_PROGRESS"]')).waitFor();
  requests[1].status = "COMPLETED";
  requests[2].status = "FAILED";
  await job(602).and(recent.locator('[data-analysis-status="COMPLETED"]')).waitFor();
  await job(603).and(recent.locator('[data-analysis-status="FAILED"]')).waitFor();
  await recent.getByRole("button", { name: "first.quick.example 페이지 열기 (최근 분석)", exact: true }).click();
  await page.waitForURL("**/recent-pages/202");
  assert.equal(await job(602).count(), 0, "opening a recent page acknowledges its completed analysis");
  await page.reload({ waitUntil: "domcontentloaded" });
  await recent.getByRole("button", { name: "first.quick.example 페이지 열기 (최근 분석)", exact: true }).waitFor();
  assert.equal(await job(602).count(), 0);
  assert.equal(await projects.getByText("AI Module Imported", { exact: true }).count(), 0);
  assert.equal(projectWrites, 0);
  await page.goto(baseUrl + "/projects/99/pages/202", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/recent-pages/202");
  await page.goto(baseUrl + "/projects/99", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/analyze");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", submissions, projectWrites, pendingHistorySurvivesReload: true }));
} finally {
  await browser.close();
}
