/**
 * Regression check for the gap between a completed analysis and its replay
 * artifact becoming available.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const baseUrl = resolveTestBaseUrl();
const capturedAt = new Date(Date.now() + 60_000).toISOString();
const artifactUploadTimeoutMs = 60_000;
const expectedRetryOffsets = [0, 1_000, 3_000, 7_000, 15_000, 30_000, 60_000, 90_000];
const expectedRetryDelays = expectedRetryOffsets.map((offset, index) =>
  index === 0 ? 0 : offset - expectedRetryOffsets[index - 1]
);
const artifactRequestTimeoutMs = 10_000;
const artifactReconcilingUiDelayMs = 3_000;

const [hookSource, evidenceCardSource, backendApiSource, mainSource] = await Promise.all([
  readFile(
    path.join(
      dashboardDirectory,
      "src/components/dashboard/panels/site-dashboard/use-evaluation-artifact.ts"
    ),
    "utf8"
  ),
  readFile(
    path.join(
      dashboardDirectory,
      "src/components/dashboard/panels/site-dashboard/rendered-page-evidence-card.tsx"
    ),
    "utf8"
  ),
  readFile(path.join(dashboardDirectory, "src/services/backend-api.ts"), "utf8"),
  readFile(path.join(dashboardDirectory, "src/main.tsx"), "utf8")
]);

const retryDeclaration = hookSource.match(
  /const ARTIFACT_RETRY_OFFSETS_MS\s*=\s*\[([\s\S]*?)\]\s*as const;/
);
assert.ok(retryDeclaration, "artifact retry offsets must be an explicit bounded tuple");
const retryOffsets = [...retryDeclaration[1].matchAll(/\d[\d_]*/g)].map((match) =>
  Number(match[0].replaceAll("_", ""))
);
assert.deepEqual(
  retryOffsets,
  expectedRetryOffsets,
  "artifact retry attempts must retain the bounded 90-second upload reconciliation window"
);
assert.ok(
  retryOffsets.at(-1) > artifactUploadTimeoutMs,
  "the final artifact lookup must occur after the uploader's 60-second transport timeout"
);
assert.match(
  hookSource,
  /elapsedSinceCompletion[\s\S]*?ARTIFACT_RETRY_OFFSETS_MS\.filter[\s\S]*?attemptOffsets = \[0, \.\.\.remainingOffsets\]/,
  "old requests must get one immediate lookup instead of a fresh 90-second retry window"
);
assert.match(
  hookSource,
  /const ARTIFACT_REQUEST_TIMEOUT_MS\s*=\s*10_000;[\s\S]*?const ARTIFACT_RECONCILIATION_DEADLINE_MS\s*=\s*105_000;[\s\S]*?const ARTIFACT_RECONCILING_UI_DELAY_MS\s*=\s*3_000;/,
  "artifact metadata attempts, the full chain, and the honest pending UI need explicit deadlines"
);
assert.match(
  hookSource,
  /fetchArtifactWithDeadline[\s\S]*?controller\.abort\(ARTIFACT_REQUEST_TIMEOUT_MESSAGE\)[\s\S]*?fetchEvaluationArtifact\(requestId, controller\.signal\)/,
  "each artifact metadata GET must be actively aborted at its own deadline"
);
assert.match(
  hookSource,
  /attemptIndex === retryDelays\.length - 1[\s\S]*?loadState: "empty"/,
  "only an exhausted null response chain may become empty"
);
assert.match(
  hookSource,
  /activeControllerRef\.current\?\.abort\(\);[\s\S]*?loadState: "loading"[\s\S]*?setRetryRevision/,
  "manual retry must abort the previous generation and synchronously restart loading"
);
assert.match(
  hookSource,
  /const ARTIFACT_READY_CACHE_TTL_MS\s*=\s*60_000;[\s\S]*?const ARTIFACT_EMPTY_CACHE_TTL_MS\s*=\s*5_000;[\s\S]*?const ARTIFACT_CACHE_MAX_ENTRIES\s*=\s*50;/,
  "ready and empty artifact states must use explicit, bounded TTL cache limits"
);
assert.match(
  hookSource,
  /ageMs < 0 \|\| ageMs >= ttlMs[\s\S]*?artifactCache\.size > ARTIFACT_CACHE_MAX_ENTRIES/,
  "artifact cache must reject clock rollback and evict entries above its bound"
);
assert.match(
  hookSource,
  /sharedArtifactRequests[\s\S]*?consumers[\s\S]*?window\.setTimeout\([\s\S]*?sharedRequest\.controller\.abort\(\)[\s\S]*?, 0\)/,
  "StrictMode cleanup must defer the shared artifact abort by one task"
);
assert.match(
  backendApiSource,
  /fetchEvaluationArtifact[\s\S]*?cache: "no-store"[\s\S]*?optionalStatuses: \[404\]/,
  "artifact availability lookups must bypass browser and intermediary caches"
);
assert.match(
  hookSource,
  /state\.requestId === requestId[\s\S]*?requestId === null[\s\S]*?IDLE_STATE[\s\S]*?loadState: "loading"/,
  "rendered artifact state must be synchronously owned by the current request id"
);
assert.match(mainSource, /<React\.StrictMode>/, "the regression fixture must exercise React StrictMode");
assert.match(
  evidenceCardSource,
  /loadState === "empty"[\s\S]*?className="site-page-evidence-retry"[\s\S]*?onClick=\{onRetry\}[\s\S]*?다시 확인/,
  "terminal empty must offer a manual artifact lookup restart"
);
assert.match(
  evidenceCardSource,
  /loadState === "reconciling"[\s\S]*?재현 페이지를 준비 중입니다[\s\S]*?백그라운드에서 확인/,
  "a long upload reconciliation must stop presenting as an indefinite initial spinner"
);

const organization = {
  id: 1,
  name: "Artifact retry fixture",
  type: "ETC",
  homepageUrl: "https://example.com/",
  description: "",
  status: "ACTIVE",
  createdAt: capturedAt,
  updatedAt: capturedAt
};

function makeTarget(id, name) {
  return {
    id,
    organizationId: organization.id,
    name,
    targetType: "WEB",
    accessUrl: `https://example.com/${id}`,
    faviconUrl: null,
    description: "",
    status: "ACTIVE",
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
}

function makeRequest(id, evaluationTargetId, targetName) {
  return {
    id,
    evaluationTargetId,
    targetName,
    status: "COMPLETED",
    requestNote: "late artifact regression",
    requestedAt: capturedAt,
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
}

function makeSummary(requestId, targetName) {
  return {
    requestId,
    targetName,
    status: "COMPLETED",
    totalScore: 91,
    totalIssueCount: 1,
    criticalIssueCount: 1,
    requestedAt: capturedAt
  };
}

function makeScore(id, evaluationRequestId) {
  return {
    id,
    evaluationRequestId,
    totalScore: 91,
    ruleScore: 91,
    aiScore: 91,
    cvScore: 91,
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
}

function makeIssue(id, requestId, selector) {
  return {
    id,
    requestId,
    module: "rule_based",
    severity: "CRITICAL",
    title: `Fixture issue ${id}`,
    description: "The replay marker must appear without refreshing dashboard data.",
    recommendation: "Add an accessible name.",
    selector,
    locator: {
      kind: "DOM_PATH",
      pathSteps: [{ context: "DOCUMENT", selector, frameUrl: null }],
      x: null,
      y: null,
      width: null,
      height: null,
      coordinateSpace: null,
      visible: true,
      htmlSnippet: `<button id="${selector.slice(1)}">Fixture</button>`
    },
    wcagCode: "5.1.1",
    createdAt: capturedAt
  };
}

function makeArtifact(id, requestId) {
  return {
    id,
    requestId,
    requestedUrl: `https://example.com/${requestId}`,
    finalUrl: `https://example.com/${requestId}`,
    capturedAt,
    viewportWidthCssPx: 1280,
    viewportHeightCssPx: 720,
    deviceScaleFactor: 1,
    pageWidthCssPx: 1280,
    pageHeightCssPx: 900,
    captureMode: "DOM_REPLAY",
    contentUrl: `/results/artifacts/${id}/content`,
    contentType: "text/html",
    sizeBytes: 4096,
    sha256: String(id).padStart(64, "a").slice(-64),
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
}

const targetA = makeTarget(101, "Request A target");
const targetB = makeTarget(102, "Request B target");
const requestA = makeRequest(501, targetA.id, targetA.name);
const requestB = makeRequest(502, targetB.id, targetB.name);
const issueA = makeIssue(9001, requestA.id, "#fixture-a");
const issueB = makeIssue(9002, requestB.id, "#fixture-b");
const artifactA = makeArtifact(77, requestA.id);
const artifactB = makeArtifact(78, requestB.id);
const overview = createDashboardOverview({
  organizations: [organization],
  evaluationTargets: [targetA, targetB],
  evaluationRequests: [requestA, requestB],
  resultSummaries: [makeSummary(requestA.id, targetA.name), makeSummary(requestB.id, targetB.name)],
  scoreResults: [makeScore(1, requestA.id), makeScore(2, requestB.id)],
  latestIssueCounts: [
    {
      evaluationTargetId: targetA.id,
      requestId: requestA.id,
      totalIssueCount: 1,
      criticalIssueCount: 1,
      highIssueCount: 0,
      mediumIssueCount: 0,
      lowIssueCount: 0,
      groups: [{ issueCode: "5.1.1", issueTitle: issueA.title, severity: "CRITICAL", count: 1 }]
    },
    {
      evaluationTargetId: targetB.id,
      requestId: requestB.id,
      totalIssueCount: 1,
      criticalIssueCount: 1,
      highIssueCount: 0,
      mediumIssueCount: 0,
      lowIssueCount: 0,
      groups: [{ issueCode: "5.1.1", issueTitle: issueB.title, severity: "CRITICAL", count: 1 }]
    }
  ]
});

function replayHtml(artifactId) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      body { margin: 0; min-height: 800px; font-family: sans-serif; }
      main { padding: 32px; }
      .replay-marker { width: 36px; height: 36px; border: 0; border-radius: 50%; background: #c33; color: white; }
    </style>
  </head>
  <body>
    <main><button id="fixture-${artifactId === 77 ? "a" : "b"}">Fixture target</button><div id="markers"></div></main>
    <script>
      (() => {
        const token = "artifact_${artifactId}_" + Math.random().toString(36).slice(2);
        const send = (type) => parent.postMessage({
          source: "accessibility-page-replay",
          type,
          documentToken: token
        }, "*");
        addEventListener("message", (event) => {
          const message = event.data;
          if (event.source !== parent || !message || message.source !== "accessibility-dashboard") return;
          if (message.type === "REQUEST_DOCUMENT_STATE") {
            send("DOCUMENT_LOADING");
            send("READY");
          }
          if (message.type === "INIT_ISSUES" && Array.isArray(message.issues)) {
            const host = document.querySelector("#markers");
            host.replaceChildren(...message.issues.map((issue) => {
              const marker = document.createElement("button");
              marker.className = "replay-marker";
              marker.dataset.issueId = String(issue.id);
              marker.textContent = String(issue.id);
              return marker;
            }));
          }
        });
        send("DOCUMENT_LOADING");
        setTimeout(() => send("READY"), 0);
      })();
    <\/script>
  </body>
</html>`;
}

let artifactModeA = "late";
let artifactModeB = "missing";
let artifactLateMissesRemainingA = 2;
let artifactLateMissesRemainingB = 0;
const artifactCalls = [];
let dashboardRequestFetchCount = 0;
let activeArtifactFetches = 0;
let maximumConcurrentArtifactFetches = 0;
const unknownPaths = new Set();

function payloadFor(pathname) {
  if (pathname === "/api/requests") {
    dashboardRequestFetchCount += 1;
    return [requestA, requestB];
  }
  if (pathname === "/api/organizations") return [organization];
  if (pathname === "/api/organizations/1/evaluation-targets") return [targetA, targetB];
  if (pathname === "/api/results/requests/501/summary") return makeSummary(501, targetA.name);
  if (pathname === "/api/results/requests/502/summary") return makeSummary(502, targetB.name);
  if (pathname === "/api/results/requests/501/issues") return [issueA];
  if (pathname === "/api/results/requests/502/issues") return [issueB];
  if (pathname === "/api/scores/requests/501") return makeScore(1, 501);
  if (pathname === "/api/scores/requests/502") return makeScore(2, 502);
  if (pathname === "/api/targets/101") return targetA;
  if (pathname === "/api/targets/102") return targetB;
  unknownPaths.add(pathname);
  return [];
}

async function fulfillArtifact(route, requestId) {
  activeArtifactFetches += 1;
  maximumConcurrentArtifactFetches = Math.max(maximumConcurrentArtifactFetches, activeArtifactFetches);
  const call = { requestId, startedAt: Date.now(), status: null };
  artifactCalls.push(call);
  try {
    const mode = requestId === 501 ? artifactModeA : artifactModeB;
    if (mode === "error") {
      call.status = 500;
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"fixture error"}' });
      return;
    }
    if (mode === "stall") {
      call.status = "stalled";
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        await fulfillJson(route, requestId === 501 ? artifactA : artifactB);
        call.status = 200;
      } catch {
        call.status = "aborted";
      }
      return;
    }
    let shouldReturnMissing = mode === "missing";
    if (mode === "late" && requestId === 501 && artifactLateMissesRemainingA > 0) {
      artifactLateMissesRemainingA -= 1;
      shouldReturnMissing = true;
    }
    if (mode === "late" && requestId === 502 && artifactLateMissesRemainingB > 0) {
      artifactLateMissesRemainingB -= 1;
      shouldReturnMissing = true;
    }
    if (shouldReturnMissing) {
      call.status = 404;
      await route.fulfill({ status: 404, contentType: "application/json", body: "null" });
      return;
    }
    call.status = 200;
    await fulfillJson(route, requestId === 501 ? artifactA : artifactB);
  } finally {
    activeArtifactFetches -= 1;
  }
}

async function installFixture(page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && pathname === "/api/dashboard/overview") {
      dashboardRequestFetchCount += 1;
      await fulfillJson(route, overview);
      return;
    }
    const artifactMatch = pathname.match(/^\/api\/results\/requests\/(501|502)\/artifact$/);
    if (artifactMatch) {
      await fulfillArtifact(route, Number(artifactMatch[1]));
      return;
    }
    const contentMatch = pathname.match(/^\/api\/results\/artifacts\/(77|78)\/content$/);
    if (contentMatch) {
      const artifactId = Number(contentMatch[1]);
      await route.fulfill({ status: 200, contentType: "text/html", body: replayHtml(artifactId) });
      return;
    }
    await fulfillJson(route, payloadFor(pathname));
  });
}

async function waitForArtifactCalls(requestId, count, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (artifactCalls.filter((call) => call.requestId === requestId).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for artifact ${requestId} call ${count}`);
}

async function installAcceleratedArtifactRetryTimers(page) {
  await page.evaluate((retryDelays) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const remainingDelays = retryDelays.slice(1);
    const consumedDelays = [];
    window.__artifactRetryTimerState = { consumedDelays, remainingDelays };
    window.__restoreArtifactRetryTimers = () => {
      window.setTimeout = nativeSetTimeout;
      delete window.__restoreArtifactRetryTimers;
    };
    window.setTimeout = ((handler, timeout, ...args) => {
      const nextRetryDelay = remainingDelays[0];
      const isArtifactRetryTimer =
        timeout === nextRetryDelay &&
        document.querySelector(".site-page-evidence-loading") !== null &&
        document.querySelector("iframe.site-page-evidence-replay-frame") === null;
      if (isArtifactRetryTimer) {
        consumedDelays.push(remainingDelays.shift());
      }
      return nativeSetTimeout(handler, isArtifactRetryTimer ? 5 : timeout, ...args);
    });
  }, expectedRetryDelays);
}

async function restoreAcceleratedArtifactRetryTimers(page) {
  return page.evaluate(() => {
    const state = window.__artifactRetryTimerState;
    window.__restoreArtifactRetryTimers?.();
    delete window.__artifactRetryTimerState;
    return state;
  });
}

async function installAcceleratedArtifactDeadlineTimers(page) {
  await page.evaluate(({ requestTimeoutMs, reconcilingUiDelayMs }) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.__restoreArtifactDeadlineTimers = () => {
      window.setTimeout = nativeSetTimeout;
      delete window.__restoreArtifactDeadlineTimers;
    };
    window.setTimeout = ((handler, timeout, ...args) => {
      const acceleratedTimeout =
        timeout === reconcilingUiDelayMs
          ? 25
          : timeout === requestTimeoutMs
            ? 200
            : timeout;
      return nativeSetTimeout(handler, acceleratedTimeout, ...args);
    });
  }, {
    requestTimeoutMs: artifactRequestTimeoutMs,
    reconcilingUiDelayMs: artifactReconcilingUiDelayMs
  });
}

async function restoreAcceleratedArtifactDeadlineTimers(page) {
  await page.evaluate(() => window.__restoreArtifactDeadlineTimers?.());
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await installFixture(page);
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });

  const evidence = page.locator("article.site-page-evidence-card");
  await evidence.waitFor({ state: "visible" });
  await waitForArtifactCalls(501, 1);
  const dashboardFetchesAtFirstArtifact = dashboardRequestFetchCount;
  await evidence
    .locator("iframe.site-page-evidence-replay-frame")
    .contentFrame()
    .locator('[data-issue-id="9001"]')
    .waitFor({ state: "visible", timeout: 8_000 });

  const callsA = artifactCalls.filter((call) => call.requestId === 501);
  const dashboardFetchesDuringLateArrival =
    dashboardRequestFetchCount - dashboardFetchesAtFirstArtifact;
  assert.deepEqual(callsA.map((call) => call.status), [404, 404, 200]);
  assert.equal(new Set(callsA.map((call) => call.requestId)).size, 1, "retry must retain request id 501");
  assert.equal(
    dashboardFetchesDuringLateArrival,
    0,
    "artifact recovery must not require a dashboard poll"
  );
  assert.equal(new URL(page.url()).pathname, "/projects/1/pages/101");
  assert.equal(await evidence.locator(".site-page-evidence-empty").count(), 0);
  assert.equal(await evidence.locator('[role="alert"]').count(), 0);

  await page.evaluate(() => {
    const samples = [];
    const sample = () => {
      const frame = document.querySelector("iframe.site-page-evidence-replay-frame");
      samples.push({
        pathname: location.pathname,
        src: frame?.getAttribute("src") ?? null,
        title: frame?.getAttribute("title") ?? null
      });
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    window.__artifactOwnershipSamples = samples;
    window.__artifactOwnershipObserver = observer;
    sample();
    history.pushState({}, "", "/projects/1/pages/102");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForArtifactCalls(502, 1);
  await evidence.locator(".site-page-evidence-loading").waitFor({ state: "visible" });
  await page.waitForTimeout(75);
  const ownershipSamples = await page.evaluate(() => {
    window.__artifactOwnershipObserver?.disconnect();
    return window.__artifactOwnershipSamples;
  });
  const staleSamples = ownershipSamples.filter(
    (sample) => sample.pathname.endsWith("/102") && sample.src?.endsWith("/artifacts/77/content")
  );
  assert.deepEqual(staleSamples, [], "request B must never paint request A's iframe");
  assert.equal(await evidence.locator("iframe").count(), 0, "request B must hide A while B is pending");

  const callsABeforeCacheReturn = artifactCalls.filter((call) => call.requestId === 501).length;
  await page.evaluate(() => {
    history.pushState({}, "", "/projects/1/pages/101");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await evidence
    .locator("iframe.site-page-evidence-replay-frame")
    .contentFrame()
    .locator('[data-issue-id="9001"]')
    .waitFor({ state: "visible", timeout: 8_000 });
  assert.equal(
    artifactCalls.filter((call) => call.requestId === 501).length,
    callsABeforeCacheReturn,
    "a fresh ready cache entry must avoid another artifact metadata lookup"
  );

  const callsBBeforeReturn = artifactCalls.filter((call) => call.requestId === 502).length;
  await page.evaluate(() => {
    history.pushState({}, "", "/projects/1/pages/102");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitForArtifactCalls(502, callsBBeforeReturn + 1);
  await evidence.locator(".site-page-evidence-loading").waitFor({ state: "visible" });

  artifactModeB = "error";
  const callsBeforeErrorReload = artifactCalls.filter((call) => call.requestId === 502).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedEvidence = page.locator("article.site-page-evidence-card");
  await reloadedEvidence.waitFor({ state: "visible" });
  await reloadedEvidence.getByRole("alert").waitFor({ state: "visible" });
  await page.waitForTimeout(1_100);
  const errorCalls = artifactCalls.filter((call) => call.requestId === 502).slice(callsBeforeErrorReload);
  assert.deepEqual(errorCalls.map((call) => call.status), [500], "HTTP 500 must fail immediately without retry");
  assert.equal(await reloadedEvidence.locator("iframe").count(), 0);
  assert.equal(maximumConcurrentArtifactFetches, 1, "StrictMode must not overlap artifact fetches");

  artifactModeB = "stall";
  await installAcceleratedArtifactDeadlineTimers(page);
  await reloadedEvidence.getByRole("button", { name: "다시 시도", exact: true }).click();
  await reloadedEvidence
    .getByText("재현 페이지를 준비 중입니다", { exact: true })
    .waitFor({ state: "visible" });
  await reloadedEvidence
    .getByRole("alert")
    .filter({ hasText: "페이지 재현 화면 응답 대기 시간이 초과되었습니다" })
    .waitFor({ state: "visible" });
  await restoreAcceleratedArtifactDeadlineTimers(page);
  await page.waitForTimeout(300);
  assert.equal(
    maximumConcurrentArtifactFetches,
    1,
    "a timed-out metadata lookup must abort before another request can start"
  );

  // Exhaust the production retry tuple on an accelerated clock. Only delays
  // scheduled while no replay iframe exists are reduced, so the replay
  // handshake timeout itself keeps its production behavior.
  artifactModeB = "missing";
  await installAcceleratedArtifactRetryTimers(page);
  const callsBeforeEmptyRetry = artifactCalls.filter((call) => call.requestId === 502).length;
  await reloadedEvidence.getByRole("button", { name: "다시 시도", exact: true }).click();
  await waitForArtifactCalls(502, callsBeforeEmptyRetry + expectedRetryDelays.length);
  await reloadedEvidence.getByText("이 스캔에는 재현 페이지가 없어요", { exact: true }).waitFor();
  const emptyRetryCalls = artifactCalls
    .filter((call) => call.requestId === 502)
    .slice(callsBeforeEmptyRetry);
  assert.equal(emptyRetryCalls.length, expectedRetryDelays.length);
  assert.ok(emptyRetryCalls.every((call) => call.status === 404));
  const missingRetryTimerState = await restoreAcceleratedArtifactRetryTimers(page);
  assert.deepEqual(missingRetryTimerState.remainingDelays, []);
  assert.deepEqual(missingRetryTimerState.consumedDelays, expectedRetryDelays.slice(1));

  await page.evaluate(() => {
    history.pushState({}, "", "/projects/1/pages/101");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await reloadedEvidence
    .locator("iframe.site-page-evidence-replay-frame")
    .contentFrame()
    .locator('[data-issue-id="9001"]')
    .waitFor({ state: "visible", timeout: 8_000 });
  const callsBeforeEmptyCacheReturn = artifactCalls.filter((call) => call.requestId === 502).length;
  await page.evaluate(() => {
    history.pushState({}, "", "/projects/1/pages/102");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await reloadedEvidence.getByText("이 스캔에는 재현 페이지가 없어요", { exact: true }).waitFor();
  assert.equal(
    artifactCalls.filter((call) => call.requestId === 502).length,
    callsBeforeEmptyCacheReturn,
    "a fresh empty cache entry must avoid restarting the bounded lookup chain"
  );

  artifactModeB = "error";
  await reloadedEvidence.getByRole("button", { name: "다시 확인", exact: true }).click();
  await reloadedEvidence.getByRole("alert").waitFor({ state: "visible" });
  assert.equal(
    artifactCalls.filter((call) => call.requestId === 502).length,
    callsBeforeEmptyCacheReturn + 1,
    "manual retry must invalidate a fresh empty cache entry"
  );

  // Result ingestion can become visible before the separately uploaded HTML.
  // Accelerate the production delays while preserving every attempt boundary,
  // then prove that an artifact arriving after the 60-second timeout window is
  // still recovered by the final 90-second probe.
  artifactModeB = "late";
  artifactLateMissesRemainingB = expectedRetryDelays.length - 1;
  await installAcceleratedArtifactRetryTimers(page);
  const callsBeforeUploadWindowRecovery = artifactCalls.filter(
    (call) => call.requestId === 502
  ).length;
  await reloadedEvidence.getByRole("button", { name: "다시 시도", exact: true }).click();
  await waitForArtifactCalls(
    502,
    callsBeforeUploadWindowRecovery + expectedRetryDelays.length
  );
  await reloadedEvidence
    .locator("iframe.site-page-evidence-replay-frame")
    .contentFrame()
    .locator('[data-issue-id="9002"]')
    .waitFor({ state: "visible", timeout: 8_000 });
  const uploadWindowRecoveryCalls = artifactCalls
    .filter((call) => call.requestId === 502)
    .slice(callsBeforeUploadWindowRecovery);
  assert.deepEqual(
    uploadWindowRecoveryCalls.map((call) => call.status),
    [...Array(expectedRetryDelays.length - 1).fill(404), 200],
    "the final 90-second probe must recover an artifact that misses the 60-second boundary"
  );
  assert.equal(await reloadedEvidence.locator(".site-page-evidence-empty").count(), 0);
  const uploadWindowTimerState = await restoreAcceleratedArtifactRetryTimers(page);
  assert.deepEqual(uploadWindowTimerState.remainingDelays, []);
  assert.deepEqual(uploadWindowTimerState.consumedDelays, expectedRetryDelays.slice(1));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual([...unknownPaths], []);

  console.log(JSON.stringify({
    result: "PASS",
    retryOffsets,
    lateArrivalStatuses: callsA.map((call) => call.status),
    dashboardFetchesDuringRecovery: dashboardFetchesDuringLateArrival,
    readyCacheAvoidedLookups: true,
    emptyCacheAvoidedLookups: true,
    emptyCacheManualRetryInvalidated: true,
    uploadWindowLateArrivalStatuses: uploadWindowRecoveryCalls.map((call) => call.status),
    staleArtifactPaints: staleSamples.length,
    immediateErrorCalls: errorCalls.length,
    stalledRequestTimedOut: true,
    maximumConcurrentArtifactFetches
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
