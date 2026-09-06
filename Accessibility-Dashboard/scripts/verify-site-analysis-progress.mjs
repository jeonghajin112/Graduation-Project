import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const output = new URL("../artifacts/site-analysis-progress/", import.meta.url);
await mkdir(output, { recursive: true });
const timestamp = new Date(Date.now() - 60_000).toISOString();
const organization = { id: 1, name: "분석 화면 검증", description: "", status: "ACTIVE", updatedAt: timestamp };
const targets = [101, 102, 103].map(id => ({ id, organizationId: 1, name: `검증 페이지 ${id}`,
  accessUrl: `https://example.com/${id}`, targetType: "WEB", status: "ACTIVE", createdAt: timestamp }));
const requests = [
  { id: 501, evaluationTargetId: 101, status: "PENDING", quickAnalysis: true, requestedAt: timestamp, updatedAt: timestamp },
  { id: 500, evaluationTargetId: 102, status: "COMPLETED", requestedAt: timestamp, updatedAt: timestamp },
  { id: 700, evaluationTargetId: 103, status: "FAILED", requestedAt: timestamp, updatedAt: timestamp }
];
const summaries = [{ requestId: 500, totalScore: 90, totalIssueCount: 0, requestedAt: timestamp }];
const resultReads = [];
let rescanPosts = 0;
let releaseRescan;
const rescanResponse = new Promise(resolve => { releaseRescan = resolve; });
let markRescanReceived;
const rescanReceived = new Promise(resolve => { markRescanReceived = resolve; });
const viewerOrigin = `http://${"c".repeat(40)}.localhost:9090`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 950 } });
  page.setDefaultTimeout(8000);
  // Measure final layout, not the entrance animation's temporary translation.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => interval(fn, ms === 5000 ? 150 : ms, ...args);
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === viewerOrigin) {
      const id = url.pathname.split("/").at(-1);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="ko"><meta charset="utf-8"><h1>완료된 검사 ${id}</h1><script>
        const documentToken = "doc_fixture_${id}";
        let port;
        addEventListener("message", event => {
          const message = event.data;
          if (event.source !== parent || message?.type !== "CONNECT" || !event.ports[0] || port) return;
          port = event.ports[0];
          const envelope = { source: "accessibility-page-live-report", protocolVersion: 1,
            bridgeSecret: message.bridgeSecret, challenge: message.challenge, documentToken };
          port.start();
          port.postMessage({ ...envelope, type: "ACK", sequence: 1 });
          let sequence = 1;
          for (const payload of [{ type: "DOCUMENT_LOADING" }, { type: "READY" }, { type: "DOCUMENT_HEALTH", status: "MEANINGFUL",
            consecutiveMeaningfulSamples: 1, visibleControlCount: 0, visibleElementCount: 1,
            visibleImageCount: 0, largestVisibleVisualArea: 0, visibleTextLength: 20 }]) {
            port.postMessage({ ...envelope, type: "EVENT", sequence: ++sequence,
              payload: { source: "accessibility-page-replay", documentToken, ...payload } });
          }
        });
        function announce() {
          if (port) return;
          parent.postMessage({ source: "accessibility-page-live-report", type: "AVAILABLE",
            protocolVersion: 1, sessionId: "session_${id}", documentToken }, "*");
          setTimeout(announce, 100);
        }
        announce();
      <\/script></html>` });
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/dashboard/overview") return fulfillJson(route, createDashboardOverview({
      organizations: [organization], evaluationTargets: targets, evaluationRequests: requests, resultSummaries: summaries
    }));
    const target = targets.find(target => url.pathname === `/api/targets/${target.id}`);
    if (target) return fulfillJson(route, target);
    if (url.pathname === "/api/requests") {
      if (route.request().method() === "GET") return fulfillJson(route, requests);
      assert.equal(route.request().method(), "POST");
      assert.equal(route.request().postDataJSON().evaluationTargetId, 101);
      rescanPosts += 1;
      if (rescanPosts === 1) return fulfillJson(route, {
        success: false, data: null, message: "분석 요청을 거절했습니다. 다시 시도해 주세요."
      }, { status: 400, envelope: false });
      if (rescanPosts === 2) {
        markRescanReceived();
        await rescanResponse;
      }
      const acceptedRequest = { id: 500 + rescanPosts, evaluationTargetId: 101, status: "PENDING",
        requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      requests.push(acceptedRequest);
      // A lost response must reconcile the accepted request, never send another POST.
      if (rescanPosts === 3) return route.abort("failed");
      return fulfillJson(route, acceptedRequest);
    }
    const request = requests.find(request => url.pathname === `/api/requests/${request.id}`);
    if (request) return fulfillJson(route, request);
    const result = url.pathname.match(/^\/api\/results\/requests\/(\d+)\/(.+)$/);
    if (result) {
      const id = Number(result[1]);
      resultReads.push(id);
      if (result[2] === "issues") return fulfillJson(route, []);
      if (result[2] === "capture-metadata") return fulfillJson(route, null);
      if (result[2] === "live-session") return fulfillJson(route, {
        sessionId: `session_${id}`, runtimeUrl: `${viewerOrigin}/render/${id}`, viewerOrigin,
        nonce: "n".repeat(32), bridgeSecret: "s".repeat(43), expiresAt: new Date(Date.now() + 120_000).toISOString()
      });
    }
    throw new Error(`Unexpected API request ${url.pathname}`);
  });
  const progress = page.locator(".site-analysis-progress");
  const iframe = page.locator("iframe.site-page-evidence-replay-frame");
  async function assertProgressOnly(phase) {
    await progress.locator(`[data-phase="${phase}"]`).waitFor();
    assert.equal(await page.getByRole("heading", { name: "페이지 정보", exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "최근 분석 추이", exact: true }).count(), 0);
    assert.equal(await iframe.count(), 0);
    assert.equal(await page.getByText("아직 표시할 동적 페이지가 없어요", { exact: true }).count(), 0);
  }
  await page.goto(baseUrl + "/recent-pages/101", { waitUntil: "domcontentloaded" });
  await assertProgressOnly("queued");
  assert.deepEqual(resultReads, [], "queued pages must not load result or viewer resources");
  requests[0].status = "IN_PROGRESS";
  await assertProgressOnly("running");
  const panelBox = await progress.boundingBox();
  const contentBox = await progress.locator(".quick-analysis-progress").boundingBox();
  assert.ok(Math.abs(contentBox.y + contentBox.height / 2 - (panelBox.y + panelBox.height / 2)) < 3,
    "analysis content must be vertically centered");
  for (const [name, width, dark] of [["desktop", 1560, false], ["dark", 1560, true], ["mobile", 390, false]]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await page.setViewportSize({ width: 1560, height: 950 });
  // Other pages remain usable while this one is running.
  await page.goto(baseUrl + "/projects/1/pages/102", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "페이지 정보", exact: true }).waitFor();
  assert.equal(await progress.count(), 0);
  await page.goto(baseUrl + "/recent-pages/101", { waitUntil: "domcontentloaded" });
  await assertProgressOnly("running");
  assert.equal(resultReads.includes(501), false);
  // The completed status arrives before its aggregate score; open that exact result.
  requests[0].status = "COMPLETED";
  await iframe.contentFrame().getByRole("heading", { name: "완료된 검사 501", exact: true }).waitFor().catch(async error => {
    console.log(JSON.stringify({ resultReads, frames: page.frames().map(frame => frame.url()), text: await page.locator("body").innerText() }));
    throw error;
  });
  assert.equal(await progress.count(), 0);
  await page.getByRole("heading", { name: "페이지 정보", exact: true }).waitFor();
  await page.locator('.site-page-evidence-preview[data-connection-state="ready"][data-loading-phase="complete"]').waitFor();
  summaries.push({ requestId: 501, totalScore: 80, totalIssueCount: 0, requestedAt: timestamp });
  const pageInformation = page.getByRole("region", { name: "페이지 정보", exact: true });
  const rescan = pageInformation.getByRole("button", { name: "재분석", exact: true });
  await rescan.waitFor();
  const previousDate = await pageInformation.locator(".site-page-information__metadata dd").innerText();
  for (const [name, width, dark] of [["desktop", 1560, false], ["dark", 1560, true], ["mobile", 390, false]]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
    await rescan.scrollIntoViewIfNeeded();
    const dateBox = await pageInformation.locator(".site-page-information__metadata").boundingBox();
    const buttonBox = await rescan.boundingBox();
    await pageInformation.screenshot({ path: fileURLToPath(new URL(`rescan-${name}.png`, output)) });
    assert.ok(buttonBox.x >= dateBox.x + dateBox.width &&
      Math.abs(buttonBox.y + buttonBox.height / 2 - dateBox.y - dateBox.height / 2) < 3,
      `the rescan button must sit beside the analysis date at ${name}: ${JSON.stringify({ dateBox, buttonBox })}`);
    const groupBox = await pageInformation.locator(".site-page-information__analysis-actions").boundingBox();
    assert.ok(buttonBox.x + buttonBox.width <= groupBox.x + groupBox.width && buttonBox.y >= groupBox.y &&
      buttonBox.y + buttonBox.height <= groupBox.y + groupBox.height,
      "the rescan button must be inside the date's rounded gray container");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await page.setViewportSize({ width: 1560, height: 950 });
  await rescan.focus();
  await page.keyboard.press("Enter");
  await pageInformation.getByRole("alert").waitFor();
  assert.equal(await rescan.isEnabled(), true, "a rejected request must allow retry");
  assert.equal(await iframe.count(), 1, "a rejected request must retain the completed result");
  assert.equal(await pageInformation.locator(".site-page-information__metadata dd").innerText(), previousDate);
  // Dispatch within one event loop tick to exercise the synchronous duplicate guard.
  await rescan.evaluate(button => { button.click(); button.click(); });
  await pageInformation.getByRole("button", { name: "요청 중…", exact: true }).waitFor();
  assert.equal(await pageInformation.getByRole("button", { name: "요청 중…", exact: true }).isDisabled(), true);
  await rescanReceived;
  assert.equal(rescanPosts, 2, "retry and double click must produce only one additional POST");
  assert.equal(await pageInformation.getByRole("alert").count(), 0);
  resultReads.length = 0;
  releaseRescan();
  await assertProgressOnly("queued");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("accessibility-dashboard.site-create-attempt.v1")), null);
  requests.at(-1).status = "IN_PROGRESS";
  await assertProgressOnly("running");
  assert.deepEqual(resultReads, [], "a rescan must hide and release the old result viewer");
  requests.at(-1).status = "COMPLETED";
  await iframe.contentFrame().getByRole("heading", { name: "완료된 검사 502", exact: true }).waitFor().catch(async error => {
    console.log(JSON.stringify({ requests, resultReads, text: await page.locator("body").innerText() }));
    throw error;
  });
  await page.locator('.site-page-evidence-preview[data-connection-state="ready"][data-loading-phase="complete"]').waitFor();
  assert.equal(resultReads.includes(501), false, "a stale overview must not reopen the older result");
  await rescan.click();
  await assertProgressOnly("queued");
  assert.equal(rescanPosts, 3, "a subsequent rescan with a lost response must reconcile without another POST");
  requests.at(-1).status = "COMPLETED";
  await iframe.contentFrame().getByRole("heading", { name: "완료된 검사 503", exact: true }).waitFor();
  await page.goto(baseUrl + "/projects/1/pages/103", { waitUntil: "domcontentloaded" });
  await assertProgressOnly("failed");
  await progress.getByRole("heading", { name: "분석을 완료하지 못했습니다", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", queuedAndRunningAreExclusive: true, completionOpensLatestResult: true,
    independentNavigation: true, rescanBesideDate: true, rescanDuplicateGuard: true, rejectionRetry: true, lostResponseRecovery: true }));
} finally {
  await browser.close();
}
