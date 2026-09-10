/** A failed rescan must not reserve the shared page-creation recovery slot. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { installApiRouteFixture } from "./fixtures/api-route-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const storageKey = "accessibility-dashboard.site-create-attempt.v1";
const timestamp = "2026-09-09T00:00:00.000Z";
const organization = { id: 1, name: "Rescan isolation project", type: "ETC", homepageUrl: null,
  description: "", status: "ACTIVE", createdAt: timestamp, updatedAt: timestamp };
const targets = [101, 102].map(id => ({ id, organizationId: 1, name: `Rescan page ${id}`,
  targetType: "WEB", accessUrl: `https://example.com/rescan-${id}`, faviconUrl: null,
  description: "", status: "ACTIVE", createdAt: timestamp, updatedAt: timestamp }));
const requestFor = targetId => ({ id: targetId + 1000, evaluationTargetId: targetId,
  status: "PENDING", requestedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
const recoveryFor = (targetId = 101, overrides = {}) => ({
  version: 1, attemptId: `rescan-${targetId}`, apiScope: "/api", projectId: 1,
  name: `Rescan page ${targetId}`, accessUrl: `https://example.com/rescan-${targetId}`,
  previousTargetIds: [101, 102], startedAt: Date.now(), phase: "request-ready",
  targetId, previousFailedRequestId: null, ...overrides
});

async function createScenario(browser, mode, seededRecovery) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  if (seededRecovery) await page.addInitScript(({ key, value }) => {
    sessionStorage.setItem(key, JSON.stringify(value));
  }, { key: storageKey, value: seededRecovery });
  const requests = [];
  const posts = [];
  let releaseResponse;
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  let notifyPending;
  const responsePending = new Promise(resolve => { notifyPending = resolve; });
  const fixture = await installApiRouteFixture(page, [
    { method: "GET", pathname: "/api/dashboard/overview", handle: route => fulfillJson(route,
      createDashboardOverview({ organizations: [organization], evaluationTargets: targets, evaluationRequests: requests })) },
    ...targets.map(target => ({ method: "GET", pathname: `/api/targets/${target.id}`, handle: route =>
      fulfillJson(route, target, { status: mode === "target-get-503" && target.id === 101 ? 503 : 200 }) })),
    { method: "GET", pathname: "/api/requests", handle: async route => {
      if (mode === "cancel-preflight") { notifyPending(); await responseGate; }
      return fulfillJson(route, requests, { status: mode === "list-get-503" && posts.length === 0 ? 503 : 200 });
    } },
    { method: "POST", pathname: "/api/requests", handle: async route => {
      const targetId = route.request().postDataJSON().evaluationTargetId;
      posts.push(targetId);
      if (targetId === 101 && mode === "new-owner-during-rejection") {
        notifyPending(); await responseGate;
        return fulfillJson(route, null, { status: 422 });
      }
      if (targetId === 101 && mode === "post-422") return fulfillJson(route, null, { status: 422 });
      const request = requestFor(targetId);
      requests.push(request);
      return fulfillJson(route, request, { status: mode === "lost-post-response" ? 503 : 201 });
    } },
    ...targets.map(target => ({ method: "GET", pathname: `/api/requests/${target.id + 1000}`,
      handle: route => fulfillJson(route, requestFor(target.id)) }))
  ]);
  const open = async id => {
    await page.goto(`${baseUrl}/projects/1/pages/${id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "재분석", exact: true }).waitFor();
  };
  return { page, fixture, posts, open, responsePending, releaseResponse,
    close: async () => { releaseResponse(); await page.close(); fixture.assertIsolated(); } };
}

async function verifyFailureIsolation(browser, mode) {
  const scenario = await createScenario(browser, mode);
  const { page, posts, open } = scenario;
  try {
    await open(101);
    await page.getByRole("button", { name: "재분석", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: mode === "post-422" ? "입력한 내용을 확인" : "서비스에 일시적인 문제" }).waitFor();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null,
      "a failed preflight or definitive rejection must leave no standalone reservation");
    assert.deepEqual(posts, mode === "post-422" ? [101] : []);
    // Navigating reloads the app in the same session: the safe failure must not
    // reappear as a blocked recovery after a route change or reload.
    await open(102);
    if (mode === "list-get-503") {
      await page.route("**/api/requests", route => route.request().method() === "GET"
        ? fulfillJson(route, []) : route.fallback());
    }
    await page.getByRole("button", { name: "재분석", exact: true }).click();
    await page.getByRole("heading", { name: "분석 순서를 기다리고 있습니다", exact: true }).waitFor();
    assert.deepEqual(posts, mode === "post-422" ? [101, 102] : [102]);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null);
    console.log(`PASS rescan isolation: ${mode}`);
  } finally { await scenario.close(); }
}

async function verifyLegacyAndCreationRecovery(browser, createdTarget) {
  const seed = recoveryFor(101, { previousTargetIds: createdTarget ? [102] : [101, 102] });
  const scenario = await createScenario(browser, "success", seed);
  const { page, open, posts } = scenario;
  try {
    await open(102);
    const before = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
    await page.getByRole("button", { name: "재분석", exact: true }).click();
    if (createdTarget) {
      await page.getByRole("alert").filter({ hasText: "다른 페이지 작업" }).waitFor();
      assert.deepEqual(posts, [], "an unfinished page creation must not be discarded");
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), before);
    } else {
      await page.getByRole("heading", { name: "분석 순서를 기다리고 있습니다", exact: true }).waitFor();
      assert.deepEqual(posts, [102], "an old standalone request-ready record must not block B");
    }
    console.log(`PASS rescan recovery: ${createdTarget ? "preserve page creation" : "release legacy preparation"}`);
  } finally { await scenario.close(); }
}

async function verifyLostResponse(browser) {
  const scenario = await createScenario(browser, "lost-post-response");
  const { page, open, posts, fixture } = scenario;
  try {
    await open(101);
    await page.getByRole("button", { name: "재분석", exact: true }).evaluate(button => { button.click(); button.click(); });
    await page.getByRole("heading", { name: "분석 순서를 기다리고 있습니다", exact: true }).waitFor();
    assert.deepEqual(posts, [101], "response loss and double click must never duplicate POST");
    assert.equal(fixture.countRequests({ method: "GET", pathname: "/api/requests" }), 2);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null);
    console.log("PASS rescan recovery: lost response reconciles by GET");
  } finally { await scenario.close(); }
}

async function verifyOwnershipAndCancel(browser, mode) {
  const scenario = await createScenario(browser, mode);
  const { page, open, posts, responsePending, releaseResponse } = scenario;
  try {
    await open(101);
    await page.getByRole("button", { name: "재분석", exact: true }).click();
    await responsePending;
    if (mode === "cancel-preflight") {
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null,
        "a preflight must not reserve durable recovery before any POST");
      await page.locator("aside").getByRole("button", { name: "새 페이지 분석", exact: true }).click();
      await page.locator("#quick-analyze-url").waitFor();
      releaseResponse();
      assert.deepEqual(posts, []);
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null);
    } else {
      const original = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), storageKey);
      assert.equal(original.phase, "request-reconciling", "the checkpoint must exist before POST");
      const newer = JSON.stringify(recoveryFor(102, { attemptId: "newer-owner", phase: "request-reconciling", knownRequestIds: [] }));
      await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key: storageKey, value: newer });
      releaseResponse();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), newer,
        "an older rejection must not erase another attempt's recovery");
      assert.deepEqual(posts, [101]);
    }
    console.log(`PASS rescan recovery: ${mode}`);
  } finally { await scenario.close(); }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const mode of ["target-get-503", "list-get-503", "post-422"]) await verifyFailureIsolation(browser, mode);
  await verifyLegacyAndCreationRecovery(browser, false);
  await verifyLegacyAndCreationRecovery(browser, true);
  await verifyLostResponse(browser);
  await verifyOwnershipAndCancel(browser, "cancel-preflight");
  await verifyOwnershipAndCancel(browser, "new-owner-during-rejection");
} finally { await browser.close(); }
