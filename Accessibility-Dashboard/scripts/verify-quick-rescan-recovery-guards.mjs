/**
 * Regression coverage for the still-supported Quick Analyze mutation and
 * recovery guards.
 *
 * Usage:
 *   npm run test:recovery
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-08-11T00:00:00.000Z";
const quickRecoveryStorageKey = "accessibility-dashboard.quick-analysis-attempt.v1";

const organization = {
  id: 1,
  name: "Recovery guard project",
  type: "ETC",
  homepageUrl: "",
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const target = {
  id: 101,
  organizationId: 1,
  name: "Recovery guard page",
  targetType: "WEB",
  accessUrl: "https://example.com/",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const pendingRequest = {
  id: 501,
  evaluationTargetId: target.id,
  targetName: target.name,
  status: "PENDING",
  requestNote: "Recovery guard",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};

const completedRequest = { ...pendingRequest, status: "COMPLETED" };
const failedRequest = { ...pendingRequest, status: "FAILED" };
const summary = {
  requestId: completedRequest.id,
  targetName: target.name,
  status: "COMPLETED",
  totalScore: 90,
  totalIssueCount: 0,
  criticalIssueCount: 0,
  requestedAt: timestamp
};
const score = {
  id: 1,
  evaluationRequestId: completedRequest.id,
  totalScore: 90,
  ruleScore: 90,
  aiScore: 90,
  cvScore: 90,
  createdAt: timestamp,
  updatedAt: timestamp
};

async function fulfillJson(route, body, status = 200) {
  const successful = status >= 200 && status < 300;
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      success: successful,
      data: successful ? body : null,
      message:
        successful || typeof body?.message !== "string" ? null : body.message
    })
  });
}

function dashboardPayload(
  pathname,
  { committed = false, completed = false, directoryVisible = committed, targets = [target] } = {}
) {
  if (pathname === "/api/dashboard/overview") {
    return createDashboardOverview({
      organizations: directoryVisible ? [organization] : [],
      evaluationTargets: directoryVisible ? targets : [],
      evaluationRequests: committed ? [completed ? completedRequest : pendingRequest] : [],
      resultSummaries: committed && completed ? [summary] : [],
      scoreResults: committed && completed ? [score] : [],
      latestIssueCounts:
        committed && completed
          ? [
              {
                evaluationTargetId: target.id,
                requestId: completedRequest.id,
                totalIssueCount: 0,
                criticalIssueCount: 0,
                highIssueCount: 0,
                mediumIssueCount: 0,
                lowIssueCount: 0,
                groups: []
              }
            ]
          : []
    });
  }
  if (pathname === "/api/organizations") return directoryVisible ? [organization] : [];
  if (pathname === "/api/organizations/1/evaluation-targets") return targets;
  if (pathname === "/api/requests") {
    return committed ? [completed ? completedRequest : pendingRequest] : [];
  }
  if (pathname === "/api/results/requests/501/summary") return summary;
  if (pathname === "/api/results/requests/501/issues") return [];
  if (pathname === "/api/scores/requests/501") return score;
  return [];
}

async function clickQuickSubmit(page, count = 1) {
  await page.locator("#quick-analyze-url").evaluate((input, clickCount) => {
    const button = input.parentElement?.parentElement?.querySelector("button");
    for (let index = 0; index < clickCount; index += 1) {
      button?.click();
    }
  }, count);
}

async function waitForQuickStatusCheck(page) {
  // Four bounded GET-only reconciliation attempts intentionally follow an
  // ambiguous POST timeout. Leave CI headroom for those real-time waits when
  // this fixture runs alongside the other Chromium regression suites.
  await page
    .getByRole("button", { name: "상태 다시 확인", exact: true })
    .waitFor({ timeout: 15_000 });
}

async function assertQuickStatusCheckPresentation(page) {
  await page
    .getByRole("heading", { name: "분석 상태를 다시 확인해 주세요", exact: true })
    .waitFor();
  await page.getByText("상태 확인 필요", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("분석 실패", { exact: true }).count(),
    0,
    "a retryable GET failure must not be presented as a terminal analysis failure"
  );
}

async function waitForObservedCondition(predicate, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function verifyQuickAmbiguousCommitAndMutex(browser) {
  let posts = 0;
  let committed = false;
  let completed = false;
  const page = await browser.newPage();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      committed = true;
      await fulfillJson(route, { message: "response lost after commit" }, 503);
      return;
    }
    if (pathname === "/api/requests/501") {
      completed = true;
      await fulfillJson(route, completedRequest);
      return;
    }
    if (pathname === "/api/targets/101") {
      await fulfillJson(route, target);
      return;
    }
    await fulfillJson(route, dashboardPayload(pathname, { committed, completed }));
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").fill("https://example.com");
  await clickQuickSubmit(page, 2);
  await page.waitForURL("**/recent-pages/101");
  assert.equal(posts, 1, "same-task Quick Analyze submit must send one POST");
  await page.close();
  return { posts, finalPath: "/recent-pages/101" };
}

async function verifyQuickCheckpointResume(browser) {
  let posts = 0;
  let statusGets = 0;
  let targetGets = 0;
  let committed = false;
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      committed = true;
      await fulfillJson(route, pendingRequest);
      return;
    }
    if (pathname === "/api/requests/501") {
      statusGets += 1;
      if (statusGets === 1) {
        await fulfillJson(route, { message: "temporary status failure" }, 503);
      } else {
        await fulfillJson(route, completedRequest);
      }
      return;
    }
    if (pathname === "/api/targets/101") {
      targetGets += 1;
      if (targetGets === 1) {
        await fulfillJson(route, { message: "temporary target failure" }, 503);
      } else {
        await fulfillJson(route, target);
      }
      return;
    }
    await fulfillJson(
      route,
      dashboardPayload(pathname, { committed, completed: committed })
    );
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").fill("https://example.com");
  await clickQuickSubmit(page);
  await waitForQuickStatusCheck(page);
  await assertQuickStatusCheckPresentation(page);
  await page.getByRole("button", { name: "상태 다시 확인", exact: true }).click();
  await waitForQuickStatusCheck(page);
  await assertQuickStatusCheckPresentation(page);
  await page.getByRole("button", { name: "상태 다시 확인", exact: true }).click();
  await page.waitForURL("**/recent-pages/101");

  assert.equal(posts, 1, "status/target GET retries must not repeat the evaluate POST");
  assert.equal(statusGets, 2);
  assert.equal(targetGets, 2);
  await page.close();
  return { posts, statusGets, targetGets };
}

async function verifyQuickTerminalFailure(browser) {
  let posts = 0;
  let statusGets = 0;
  let committed = false;
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      committed = true;
      await fulfillJson(route, pendingRequest);
      return;
    }
    if (pathname === "/api/requests/501") {
      statusGets += 1;
      await fulfillJson(route, failedRequest);
      return;
    }
    await fulfillJson(route, dashboardPayload(pathname, { committed }));
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").fill("https://example.com");
  await clickQuickSubmit(page);
  await page
    .getByRole("heading", { name: "분석을 완료하지 못했습니다", exact: true })
    .waitFor();
  await page.getByText("분석 실패", { exact: true }).waitFor();
  await page.getByRole("button", { name: "다시 시도", exact: true }).waitFor();
  assert.equal(
    await page.getByText("상태 확인 필요", { exact: true }).count(),
    0,
    "a terminal FAILED response must remain a terminal analysis failure"
  );
  assert.equal(posts, 1);
  assert.equal(statusGets, 1);
  assert.equal(
    await page.evaluate((key) => sessionStorage.getItem(key), quickRecoveryStorageKey),
    null,
    "a terminal FAILED request must clear its in-flight checkpoint"
  );
  await page.close();
  return { posts, statusGets };
}

async function verifyQuickStatusGetTimeout(browser) {
  let posts = 0;
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.__quickStatusTimeoutProbe = { gets: 0, aborted: 0 };
    window.fetch = (input, init) => {
      const inputRequest = input instanceof Request ? input : null;
      const method = String(init?.method ?? inputRequest?.method ?? "GET").toUpperCase();
      const rawUrl = inputRequest?.url ?? String(input);
      const pathname = new URL(rawUrl, window.location.href).pathname;
      if (method !== "GET" || pathname !== "/api/requests/501") {
        return nativeFetch(input, init);
      }

      window.__quickStatusTimeoutProbe.gets += 1;
      const signal = init?.signal ?? inputRequest?.signal;
      return new Promise((resolve, reject) => {
        const rejectAsAborted = () => {
          window.__quickStatusTimeoutProbe.aborted += 1;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal?.aborted) {
          rejectAsAborted();
          return;
        }
        signal?.addEventListener("abort", rejectAsAborted, { once: true });
      });
    };
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      await fulfillJson(route, pendingRequest);
      return;
    }
    await fulfillJson(route, dashboardPayload(pathname));
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.clock.install();
  await page.locator("#quick-analyze-url").fill("https://example.com");
  await clickQuickSubmit(page);
  await waitForObservedCondition(
    async () => (await page.evaluate(() => window.__quickStatusTimeoutProbe.gets)) === 1,
    "Quick Analyze status GET was not observed"
  );
  await page.clock.runFor(15_000);
  await waitForObservedCondition(
    async () => (await page.evaluate(() => window.__quickStatusTimeoutProbe.aborted)) === 1,
    "Quick Analyze did not abort its status GET at the finite deadline"
  );
  await waitForQuickStatusCheck(page);
  await assertQuickStatusCheckPresentation(page);
  assert.equal(posts, 1, "a status GET timeout must not repeat the evaluate POST");
  await page.close();
  return { posts, statusGets: 1 };
}

async function verifyQuickNonFinalPollingTimeout(browser) {
  let posts = 0;
  let statusGets = 0;
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      await fulfillJson(route, pendingRequest);
      return;
    }
    if (pathname === "/api/requests/501") {
      statusGets += 1;
      await fulfillJson(route, pendingRequest);
      return;
    }
    await fulfillJson(route, dashboardPayload(pathname));
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.clock.install();
  await page.locator("#quick-analyze-url").fill("https://example.com");
  await clickQuickSubmit(page);
  await waitForObservedCondition(
    async () => statusGets === 1,
    "Quick Analyze did not begin status polling"
  );
  for (let attempt = 1; attempt < 52; attempt += 1) {
    const delayMs = attempt <= 10 ? 1_500 : attempt <= 30 ? 3_000 : 5_000;
    await page.clock.runFor(delayMs);
    await waitForObservedCondition(
      async () => statusGets === attempt + 1,
      `Quick Analyze did not perform polling attempt ${attempt + 1}`
    );
  }
  await waitForQuickStatusCheck(page);
  await assertQuickStatusCheckPresentation(page);
  assert.equal(posts, 1, "poll exhaustion must not repeat the evaluate POST");
  assert.equal(statusGets, 52);
  await page.close();
  return { posts, statusGets };
}

async function verifyQuickPostTimeout(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.__quickTimeoutProbe = {
      posts: 0,
      startedAt: null,
      abortedAt: null
    };
    window.fetch = (input, init) => {
      const inputRequest = input instanceof Request ? input : null;
      const method = String(init?.method ?? inputRequest?.method ?? "GET").toUpperCase();
      const rawUrl = inputRequest?.url ?? String(input);
      const pathname = new URL(rawUrl, window.location.href).pathname;
      if (method !== "POST" || pathname !== "/api/requests/evaluate") {
        return nativeFetch(input, init);
      }

      const probe = window.__quickTimeoutProbe;
      probe.posts += 1;
      probe.startedAt = Date.now();
      const signal = init?.signal ?? inputRequest?.signal;
      return new Promise((resolve, reject) => {
        const rejectAsAborted = () => {
          probe.abortedAt = Date.now();
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal?.aborted) {
          rejectAsAborted();
          return;
        }
        signal?.addEventListener("abort", rejectAsAborted, { once: true });
      });
    };
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await fulfillJson(
      route,
      dashboardPayload(pathname, { committed: false, directoryVisible: false })
    );
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.clock.install();
  await page.locator("#quick-analyze-url").fill("https://timeout.example");
  await clickQuickSubmit(page);
  await waitForObservedCondition(
    async () => (await page.evaluate(() => window.__quickTimeoutProbe.posts)) === 1,
    "Quick Analyze POST was not observed"
  );

  await page.clock.runFor(15_000);
  await waitForObservedCondition(
    async () => (await page.evaluate(() => window.__quickTimeoutProbe.abortedAt)) !== null,
    "Quick Analyze did not abort its POST at the finite deadline"
  );
  const probe = await page.evaluate(() => window.__quickTimeoutProbe);
  assert.equal(probe.posts, 1);
  const observedAbortDelay = probe.abortedAt - probe.startedAt;
  assert.ok(
    observedAbortDelay >= 14_990 && observedAbortDelay <= 15_050,
    `Quick Analyze POST AbortSignal must fire at its 15-second deadline, observed ${observedAbortDelay}ms`
  );

  // Let the bounded GET-only reconciliation use real time. This avoids coupling
  // the assertion to Playwright route delivery/microtask ordering under a fake clock.
  await page.clock.resume();
  await waitForQuickStatusCheck(page);
  await assertQuickStatusCheckPresentation(page);
  await page.close();
  return { posts: probe.posts, abortedAfterVirtualMs: observedAbortDelay };
}

async function verifyQuickRecoveryAfterReload(browser) {
  let posts = 0;
  let allowRecovery = false;
  let postSeenResolve;
  const postSeen = new Promise((resolve) => {
    postSeenResolve = resolve;
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      await fulfillJson(route, { message: "response lost after commit" }, 503);
      postSeenResolve();
      return;
    }
    if (pathname === "/api/requests/501") {
      await fulfillJson(route, completedRequest);
      return;
    }
    if (pathname === "/api/targets/101") {
      await fulfillJson(route, target);
      return;
    }
    await fulfillJson(
      route,
      dashboardPayload(pathname, {
        committed: allowRecovery,
        completed: allowRecovery,
        directoryVisible: allowRecovery
      })
    );
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").fill("https://example.com");
  await clickQuickSubmit(page);
  await postSeen;
  assert.equal(posts, 1);
  assert.notEqual(
    await page.evaluate((key) => sessionStorage.getItem(key), quickRecoveryStorageKey),
    null,
    "Quick Analyze must persist its checkpoint before POST"
  );

  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("#quick-analyze-url").inputValue(), "https://example.com");
  allowRecovery = true;
  await clickQuickSubmit(page);
  await page.waitForURL("**/recent-pages/101");
  assert.equal(posts, 1, "Quick Analyze reload recovery must remain GET-only");
  assert.equal(
    await page.evaluate((key) => sessionStorage.getItem(key), quickRecoveryStorageKey),
    null,
    "Quick Analyze must CAS-clear a completed recovery"
  );
  await page.close();
  return { posts, finalPath: "/recent-pages/101" };
}

async function verifyQuickRecoveryAfterSpaUnmount(browser) {
  let posts = 0;
  let allowRecovery = false;
  let postSeenResolve;
  const postSeen = new Promise((resolve) => {
    postSeenResolve = resolve;
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      await fulfillJson(route, { message: "response lost after commit" }, 503);
      postSeenResolve();
      return;
    }
    if (pathname === "/api/requests/501") {
      await fulfillJson(route, completedRequest);
      return;
    }
    if (pathname === "/api/targets/101") {
      await fulfillJson(route, target);
      return;
    }
    await fulfillJson(
      route,
      dashboardPayload(pathname, {
        committed: allowRecovery,
        completed: allowRecovery,
        directoryVisible: true,
        targets: allowRecovery ? [target] : []
      })
    );
  });

  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__quickRecoveryDocumentMarker = crypto.randomUUID();
  });
  const documentMarker = await page.evaluate(() => window.__quickRecoveryDocumentMarker);
  await page.locator("button.sidebar-nav-link").first().click();
  await page.locator("#quick-analyze-url").waitFor();
  await page.locator("#quick-analyze-url").fill("https://example.com");
  await clickQuickSubmit(page);
  await postSeen;

  await page.goBack();
  await page.locator("#quick-analyze-url").waitFor({ state: "detached" });
  allowRecovery = true;
  await page.locator("button.sidebar-nav-link").first().click();
  await page.locator("#quick-analyze-url").waitFor();
  assert.equal(await page.evaluate(() => window.__quickRecoveryDocumentMarker), documentMarker);
  assert.equal(await page.locator("#quick-analyze-url").inputValue(), "https://example.com");
  await clickQuickSubmit(page);
  await page.waitForURL("**/recent-pages/101");
  assert.equal(posts, 1, "Quick Analyze SPA remount recovery must remain GET-only");
  await page.close();
  return { posts, sameDocument: true };
}

async function verifyQuickDifferentUrlFailsClosed(browser) {
  let posts = 0;
  let postSeenResolve;
  const postSeen = new Promise((resolve) => {
    postSeenResolve = resolve;
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
      await fulfillJson(route, { message: "response lost after commit" }, 503);
      postSeenResolve();
      return;
    }
    await fulfillJson(
      route,
      dashboardPayload(pathname, { committed: false, directoryVisible: false })
    );
  });

  const recoveryUrl = "https://recovery-a.example";
  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").fill(recoveryUrl);
  await clickQuickSubmit(page);
  await postSeen;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").fill("https://different-b.example");
  await clickQuickSubmit(page);
  const retryButton = page.locator('section[aria-live="polite"] button');
  await retryButton.waitFor();

  const storedRecovery = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)),
    quickRecoveryStorageKey
  );
  assert.equal(posts, 1, "a different URL must not discard an ambiguous Quick POST");
  assert.equal(storedRecovery.url, recoveryUrl);
  await retryButton.click();
  await page.locator("#quick-analyze-url").waitFor();
  assert.equal(await page.locator("#quick-analyze-url").inputValue(), recoveryUrl);
  await page.close();
  return { posts, storedUrl: storedRecovery.url };
}

async function verifyMalformedQuickRecoveryFailsClosed(browser) {
  const page = await browser.newPage();
  let posts = 0;
  await page.addInitScript((key) => {
    sessionStorage.setItem(key, "malformed-recovery-record");
  }, quickRecoveryStorageKey);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/requests/evaluate") {
      posts += 1;
    }
    await fulfillJson(
      route,
      dashboardPayload(pathname, { committed: false, directoryVisible: false })
    );
  });
  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").fill("https://blocked.example");
  await clickQuickSubmit(page);
  await page.locator("#quick-analyze-url-error").waitFor();
  assert.equal(posts, 0, "malformed Quick recovery must fail closed before POST");
  await page.close();
  return { posts };
}

const browser = await chromium.launch({ headless: true });
try {
  const result = {
    quickAmbiguousMutex: await verifyQuickAmbiguousCommitAndMutex(browser),
    quickCheckpointResume: await verifyQuickCheckpointResume(browser),
    quickTerminalFailure: await verifyQuickTerminalFailure(browser),
    quickStatusTimeout: await verifyQuickStatusGetTimeout(browser),
    quickNonFinalTimeout: await verifyQuickNonFinalPollingTimeout(browser),
    quickTimeout: await verifyQuickPostTimeout(browser),
    quickReloadRecovery: await verifyQuickRecoveryAfterReload(browser),
    quickSpaRecovery: await verifyQuickRecoveryAfterSpaUnmount(browser),
    quickDifferentUrl: await verifyQuickDifferentUrlFailsClosed(browser),
    malformedRecovery: await verifyMalformedQuickRecoveryFailsClosed(browser)
  };
  console.log(JSON.stringify({ result: "PASS", ...result }, null, 2));
} finally {
  await browser.close();
}
