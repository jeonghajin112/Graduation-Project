import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";
const baseUrl = resolveTestBaseUrl();
const timestamp = new Date().toISOString();
const organization = { id: 1, name: "계약 검증", description: "", status: "ACTIVE", updatedAt: timestamp };
const target = { id: 101, organizationId: 1, name: "접수 페이지", targetType: "WEB", accessUrl: "https://protocol.example/", status: "ACTIVE", createdAt: timestamp };
const request = (id, status = "PENDING") => ({ id, evaluationTargetId: 101, status, requestedAt: timestamp, updatedAt: timestamp, quickAnalysis: true });
const overview = evaluationRequests => ({ ...createDashboardOverview({ organizations: [organization], evaluationTargets: [target], evaluationRequests }), analysisProtocolVersion: 1 });
const browser = await chromium.launch({ headless: true });
try {
  for (const lostBeforeAcceptance of [false, true]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const history = Array.from({ length: 10001 }, (_, index) => ({ ...request(index + 1, "COMPLETED"), quickAnalysis: false }));
    const keys = [];
    let created = null;
    let overviewReads = 0;
    let preSubmitReads = 0;
    let batches = 0;
    let individualReads = 0;
    let extraJobs = [];
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/dashboard/overview") {
        overviewReads++;
        return fulfillJson(route, overview([...history, ...(created ? [created] : []), ...extraJobs]));
      }
      if (url.pathname === "/api/requests/evaluate") {
        keys.push(route.request().headers()["idempotency-key"]);
        assert.match(keys.at(-1), /^[0-9a-f-]{36}$/);
        if (keys.length === 1) {
          assert.equal(overviewReads, preSubmitReads, "submission must not prefetch 10,001 historical IDs");
          if (!lostBeforeAcceptance) created = request(10002);
          return route.abort("failed");
        }
        assert.equal(keys.at(-1), keys[0], "retry must preserve the original operation key");
        created ??= request(10002);
        return fulfillJson(route, created);
      }
      if (url.pathname.startsWith("/api/requests/attempts/")) {
        assert.equal(url.pathname.split("/").at(-1), keys[0]);
        return fulfillJson(route, created);
      }
      if (url.pathname === "/api/requests/statuses") {
        batches++;
        const ids = url.searchParams.get("ids").split(",").map(Number);
        assert.ok(ids.length <= 100);
        return fulfillJson(route, ids.map(id => ({ id, outcome: "FOUND", request: request(id) })));
      }
      if (/\/api\/requests\/\d+$/.test(url.pathname)) individualReads++;
      throw new Error(`Unexpected API request ${url.pathname}`);
    });
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: organization.name, exact: true }).waitFor({ timeout: 20000 });
    await page.clock.install();
    await page.locator("#quick-analyze-url").fill(target.accessUrl);
    preSubmitReads = overviewReads;
    await page.getByRole("button", { name: "분석 시작", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#quick-analyze-url")?.value === "");
    assert.equal(keys.length, lostBeforeAcceptance ? 2 : 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("accessibility-dashboard.quick-analysis-attempt.v1")), null);
    // Reload twenty active jobs, then observe one transport for the whole set.
    extraJobs = Array.from({ length: 19 }, (_, i) => request(11000 + i));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: organization.name, exact: true }).waitFor({ timeout: 20000 });
    batches = 0;
    await page.clock.runFor(5000);
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && batches === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(batches, 1, "20 active jobs should use one batch request per tick");
    assert.equal(individualReads, 0);
    await page.close();
    console.log(`PASS 10,001 historical requests, keyed recovery (lost before acceptance: ${lostBeforeAcceptance}), 20-job batching`);
  }

  for (const lostBeforeAcceptance of [false, true]) {
    const rescanPage = await browser.newPage();
    const keys = [];
    let accepted = null;
    let activeReads = 0;
    await rescanPage.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/dashboard/overview") return fulfillJson(route, overview(accepted ? [accepted] : []));
      if (url.pathname === "/api/targets/101") return fulfillJson(route, { ...target, updatedAt: timestamp });
      if (url.pathname === "/api/requests/active") {
        activeReads++;
        assert.equal(url.searchParams.get("targetId"), "101");
        return fulfillJson(route, []);
      }
      if (url.pathname === "/api/requests" && route.request().method() === "POST") {
        keys.push(route.request().headers()["idempotency-key"]);
        assert.match(keys.at(-1), /^[0-9a-f-]{36}$/);
        if (keys.length === 1) {
          if (!lostBeforeAcceptance) accepted = { ...request(601), quickAnalysis: false };
          return route.abort("failed");
        }
        assert.equal(keys.at(-1), keys[0]);
        accepted ??= { ...request(601), quickAnalysis: false };
        return fulfillJson(route, accepted);
      }
      if (url.pathname.startsWith("/api/requests/attempts/")) {
        assert.equal(url.pathname.split("/").at(-1), keys[0]);
        return fulfillJson(route, accepted);
      }
      if (url.pathname === "/api/requests/statuses") return fulfillJson(route, [{ id: 601, outcome: "FOUND", request: accepted }]);
      throw new Error(`Unexpected rescan API ${route.request().method()} ${url.pathname}`);
    });
    await rescanPage.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
    await rescanPage.getByRole("button", { name: "재분석", exact: true }).click();
    await rescanPage.getByRole("heading", { name: "분석 순서를 기다리고 있습니다", exact: true }).waitFor();
    assert.equal(activeReads, 1);
    assert.equal(keys.length, lostBeforeAcceptance ? 2 : 1);
    assert.equal(await rescanPage.evaluate(() => sessionStorage.getItem("accessibility-dashboard.site-create-attempt.v1")), null);
    await rescanPage.close();
    console.log(`PASS keyed page rescan recovery (lost before acceptance: ${lostBeforeAcceptance})`);
  }

  {
    const stalledPage = await browser.newPage();
    let posts = 0;
    let key;
    let stalled = true;
    let releaseProbe;
    let notifyProbe;
    const probeStarted = new Promise(resolve => { notifyProbe = resolve; });
    await stalledPage.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/dashboard/overview") return fulfillJson(route, overview([]));
      if (url.pathname === "/api/requests/evaluate") {
        posts++;
        key = route.request().headers()["idempotency-key"];
        return route.abort("failed");
      }
      if (url.pathname.startsWith("/api/requests/attempts/")) {
        assert.equal(url.pathname.split("/").at(-1), key);
        if (stalled) { notifyProbe(); return new Promise(resolve => { releaseProbe = resolve; }); }
        return fulfillJson(route, request(701));
      }
      if (url.pathname === "/api/requests/statuses") return fulfillJson(route, [{ id: 701, outcome: "FOUND", request: request(701) }]);
      throw new Error(url.pathname);
    });
    await stalledPage.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await stalledPage.clock.install();
    await stalledPage.locator("#quick-analyze-url").fill(target.accessUrl);
    await stalledPage.getByRole("button", { name: "분석 시작", exact: true }).click();
    await probeStarted;
    await stalledPage.clock.runFor(15001);
    await stalledPage.getByRole("alert").filter({ hasText: "접수 결과를 확인하는 데 시간이 오래" }).waitFor();
    const saved = await stalledPage.evaluate(() => JSON.parse(sessionStorage.getItem("accessibility-dashboard.quick-analysis-attempt.v1")));
    assert.equal(saved.attemptId, key);
    assert.equal(saved.serverKey, true);
    stalled = false;
    releaseProbe();
    await stalledPage.getByRole("button", { name: "상태 다시 확인", exact: true }).click();
    await stalledPage.waitForFunction(() => document.querySelector("#quick-analyze-url")?.value === "");
    assert.equal(posts, 1, "timed-out lookup retry must recover the receipt without a second job");
    await stalledPage.close();
    console.log("PASS stalled receipt lookup times out, preserves the key, and recovers on retry");
  }

  const page = await browser.newPage();
  let missing = true;
  let batches = 0;
  let posts = 0;
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/dashboard/overview") return fulfillJson(route, missing
      ? { ...createDashboardOverview(), analysisProtocolVersion: 1 } : overview([request(501)]));
    if (url.pathname === "/api/requests/evaluate") { posts++; return fulfillJson(route, request(501)); }
    if (url.pathname === "/api/requests/statuses") {
      batches++;
      return fulfillJson(route, [{ id: 501, outcome: missing ? "NOT_FOUND" : "FOUND", request: missing ? null : request(501) }]);
    }
    throw new Error(url.pathname);
  });
  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.clock.install();
  await page.locator("#quick-analyze-url").fill(target.accessUrl);
  await page.getByRole("button", { name: "분석 시작", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#quick-analyze-url")?.value === "");
  for (const elapsed of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const before = batches;
    await page.clock.runFor(elapsed);
    for (let i = 0; i < 50 && batches === before; i++) await new Promise(resolve => setTimeout(resolve, 20));
  }
  const retry = page.getByRole("button", { name: "분석 상태 다시 확인", exact: true });
  await retry.waitFor();
  const pausedAt = batches;
  await page.clock.runFor(120000);
  assert.equal(batches, pausedAt, "unconfirmed request must stop automatic polling after sustained misses");
  assert.equal(posts, 1);
  missing = false;
  await retry.click();
  await retry.waitFor({ state: "detached" });
  assert.equal(posts, 1, "manual status recovery must not resubmit analysis");
  await page.close();
  console.log("PASS never-listed request pauses, preserves uncertainty and recovers manually");
} finally { await browser.close(); }
