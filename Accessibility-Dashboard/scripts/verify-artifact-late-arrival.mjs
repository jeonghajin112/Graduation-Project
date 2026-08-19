/**
 * Regression check for the gap between a completed analysis and its replay
 * artifact becoming available.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-artifact-late-arrival.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const capturedAt = "2026-08-12T05:00:00.000Z";
const expectedRetryDelays = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000];

const [hookSource, evidenceCardSource, mainSource] = await Promise.all([
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
  readFile(path.join(dashboardDirectory, "src/main.tsx"), "utf8")
]);

const retryDeclaration = hookSource.match(
  /const ARTIFACT_RETRY_DELAYS_MS\s*=\s*\[([\s\S]*?)\]\s*as const;/
);
assert.ok(retryDeclaration, "artifact retry schedule must be an explicit bounded tuple");
const retryDelays = [...retryDeclaration[1].matchAll(/\d[\d_]*/g)].map((match) =>
  Number(match[0].replaceAll("_", ""))
);
assert.deepEqual(retryDelays, expectedRetryDelays, "artifact retry schedule changed unexpectedly");
assert.equal(retryDelays.length, 8, "artifact lookup must make at most eight attempts");
assert.equal(
  retryDelays.reduce((total, delay) => total + delay, 0),
  90_000,
  "artifact retry budget must cover the 60-second upload timeout"
);
assert.match(
  hookSource,
  /await wait\(delayMs, controller\.signal\);[\s\S]*?await fetchEvaluationArtifact\(requestId, controller\.signal\)/,
  "every attempt, including attempt one, must pass through an abortable wait"
);
assert.match(
  hookSource,
  /attemptIndex === ARTIFACT_RETRY_DELAYS_MS\.length - 1[\s\S]*?loadState: "empty"/,
  "only an exhausted null response chain may become empty"
);
assert.match(
  hookSource,
  /activeControllerRef\.current\?\.abort\(\);[\s\S]*?loadState: "loading"[\s\S]*?setRetryRevision/,
  "manual retry must abort the previous generation and synchronously restart loading"
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
      pathSteps: [{ context: "DOCUMENT", selector }],
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
    if (mode === "missing" || (mode === "late" && artifactCalls.filter((item) => item.requestId === requestId).length <= 2)) {
      call.status = 404;
      await route.fulfill({ status: 404, contentType: "application/json", body: "null" });
      return;
    }
    call.status = 200;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(requestId === 501 ? artifactA : artifactB)
    });
  } finally {
    activeArtifactFetches -= 1;
  }
}

async function installFixture(page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payloadFor(pathname))
    });
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
  assert.deepEqual(pageErrors, []);
  assert.deepEqual([...unknownPaths], []);

  console.log(JSON.stringify({
    result: "PASS",
    retrySchedule: retryDelays,
    lateArrivalStatuses: callsA.map((call) => call.status),
    dashboardFetchesDuringRecovery: dashboardFetchesDuringLateArrival,
    staleArtifactPaints: staleSamples.length,
    immediateErrorCalls: errorCalls.length,
    maximumConcurrentArtifactFetches
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
