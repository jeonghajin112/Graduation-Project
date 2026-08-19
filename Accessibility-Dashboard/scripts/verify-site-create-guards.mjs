/**
 * Browser regressions for page creation:
 * - same-task submit re-entry sends one target POST;
 * - an ambiguous target POST is bounded by an AbortSignal and retries GET-only;
 * - a committed-but-lost response is reconciled from fresh dashboard GETs;
 * - the progress/error dialog remains scrollable and operable at 320x568.
 *
 * Usage: BASE_URL=http://127.0.0.1:4173 node scripts/verify-site-create-guards.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const timestamp = "2026-08-11T10:00:00.000Z";

const organization = {
  id: 1,
  name: "Target guard project",
  type: "ETC",
  homepageUrl: "https://example.com",
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const target = {
  id: 101,
  organizationId: organization.id,
  name: "Guarded target",
  targetType: "WEB",
  accessUrl: "https://example.com/guarded",
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
  requestNote: "site guard",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};
const failedRequest = {
  ...pendingRequest,
  status: "FAILED",
  updatedAt: "2026-08-11T10:00:05.000Z"
};
const replacementRequest = {
  ...pendingRequest,
  id: 502,
  updatedAt: "2026-08-11T10:00:06.000Z"
};

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForCounter(read, expected, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (read() < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(read() >= expected, `${label}: expected at least ${expected}, received ${read()}`);
}

async function installDashboardRoutes(page, state, observed, handlers = {}) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/organizations") {
      observed.organizationGets += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([organization])
      });
      return;
    }

    if (method === "GET" && pathname === `/api/organizations/${organization.id}/evaluation-targets`) {
      observed.targetGets += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.targets)
      });
      return;
    }

    if (method === "GET" && pathname === "/api/requests") {
      observed.requestGets += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.requests ?? [])
      });
      return;
    }

    if (method === "GET" && /^\/api\/requests\/\d+$/.test(pathname) && handlers.requestStatusGet) {
      await handlers.requestStatusGet(route, request);
      return;
    }

    if (
      method === "POST" &&
      pathname === `/api/organizations/${organization.id}/evaluation-targets` &&
      handlers.targetPost
    ) {
      await handlers.targetPost(route, request);
      return;
    }

    if (method === "POST" && pathname === "/api/requests") {
      observed.requestPosts += 1;
      if (handlers.requestPost) {
        await handlers.requestPost(route, request);
      } else {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "analysis queue unavailable" })
        });
      }
      return;
    }

    if (handlers.otherRequest && (await handlers.otherRequest(route, request, method, pathname))) {
      return;
    }

    observed.unknownRequests.add(`${method} ${pathname}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

async function openFilledDialog(page) {
  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
  await dialog.getByLabel("페이지 이름", { exact: true }).fill(target.name);
  await dialog.getByLabel("페이지 주소", { exact: true }).fill(target.accessUrl);
  return dialog;
}

async function runSameTaskAndMobileScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  const state = { targets: [] };
  const targetPostStarted = createDeferred();
  const releaseTargetPost = createDeferred();
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    targetPosts: 0,
    requestPosts: 0,
    unknownRequests: new Set()
  };

  try {
    await installDashboardRoutes(page, state, observed, {
      targetPost: async (route) => {
        observed.targetPosts += 1;
        targetPostStarted.resolve();
        await releaseTargetPost.promise;
        state.targets = [target];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(target)
        });
      }
    });

    const dialog = await openFilledDialog(page);
    const submit = dialog.getByRole("button", { name: "분석 시작", exact: true });
    await submit.evaluate((button) => {
      button.click();
      button.click();
    });
    await targetPostStarted.promise;
    await page.waitForTimeout(50);
    assert.equal(observed.targetPosts, 1, "same-task clicks must send one target POST");
    assert.equal(
      await dialog.getByRole("button", { name: "자동 닫힘", exact: true }).isDisabled(),
      true
    );

    releaseTargetPost.resolve();
    const retry = dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true });
    await retry.waitFor({ timeout: 10_000 });
    assert.equal(observed.targetPosts, 1);
    assert.equal(observed.requestPosts, 1);

    const metrics = await dialog.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        overflowY: style.overflowY
      };
    });
    assert.ok(metrics.clientHeight <= 520, `dialog height ${metrics.clientHeight} exceeds mobile max`);
    assert.ok(metrics.scrollHeight > metrics.clientHeight, "progress/error content should be scrollable");
    assert.equal(metrics.overflowY, "auto");

    await retry.scrollIntoViewIfNeeded();
    await retry.focus();
    const retryBox = await retry.boundingBox();
    assert.ok(retryBox, "retry button must have a mobile bounding box");
    assert.ok(retryBox.y >= 0 && retryBox.y + retryBox.height <= 568, "retry button must be reachable in viewport");
    assert.equal(await retry.evaluate((button) => document.activeElement === button), true);
    assert.ok((await dialog.evaluate((element) => element.scrollTop)) > metrics.scrollTop);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: observed.targetPosts,
      requestPosts: observed.requestPosts,
      dialogClientHeight: metrics.clientHeight,
      dialogScrollHeight: metrics.scrollHeight
    };
  } finally {
    releaseTargetPost.resolve();
    await context.close();
  }
}

async function installCompressedTargetTimeout(page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    const realSetTimeout = window.setTimeout.bind(window);
    const stats = { posts: 0, aborts: 0, missingSignals: 0, compressedTimeouts: 0 };
    window.__targetGuardStats = stats;

    window.setTimeout = ((callback, delay, ...args) => {
      if (delay === 15_000 && stats.compressedTimeouts === 0) {
        stats.compressedTimeouts += 1;
        return realSetTimeout(callback, 75, ...args);
      }
      return realSetTimeout(callback, delay, ...args);
    });

    window.fetch = ((input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(rawUrl, window.location.href).pathname;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST" && /^\/api\/organizations\/\d+\/evaluation-targets$/.test(pathname)) {
        stats.posts += 1;
        const signal = init?.signal;
        if (!signal) {
          stats.missingSignals += 1;
          return new Promise(() => {});
        }
        return new Promise((_, reject) => {
          const rejectAbort = () => {
            stats.aborts += 1;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return realFetch(input, init);
    });
  });
}

async function runTimeoutNoCommitScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const state = { targets: [] };
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    requestPosts: 0,
    unknownRequests: new Set()
  };

  try {
    await installCompressedTargetTimeout(page);
    await installDashboardRoutes(page, state, observed);
    const dialog = await openFilledDialog(page);
    const initialTargetGets = observed.targetGets;
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await dialog.getByText(/중복 생성을 막기 위해/).waitFor({ timeout: 10_000 });
    await waitForCounter(() => observed.targetGets, initialTargetGets + 4, "initial target reconciliation");

    const firstStats = await page.evaluate(() => window.__targetGuardStats);
    assert.deepEqual(
      { posts: firstStats.posts, aborts: firstStats.aborts, missingSignals: firstStats.missingSignals },
      { posts: 1, aborts: 1, missingSignals: 0 }
    );

    const retryStartGets = observed.targetGets;
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await waitForCounter(() => observed.targetGets, retryStartGets + 4, "GET-only target retry");
    const retryStats = await page.evaluate(() => window.__targetGuardStats);
    assert.equal(retryStats.posts, 1, "unresolved retry must not send another target POST");
    assert.equal(observed.requestPosts, 0);
    assert.equal(new URL(page.url()).pathname, `/projects/${organization.id}`);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: retryStats.posts,
      targetPostAborts: retryStats.aborts,
      reconcileGets: observed.targetGets - initialTargetGets
    };
  } finally {
    await context.close();
  }
}

async function runCommittedAmbiguousScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const state = { targets: [] };
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    targetPosts: 0,
    requestPosts: 0,
    unknownRequests: new Set()
  };

  try {
    await installDashboardRoutes(page, state, observed, {
      targetPost: async (route) => {
        observed.targetPosts += 1;
        state.targets = [target];
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "response lost after commit" })
        });
      }
    });
    const dialog = await openFilledDialog(page);
    const targetGetsBeforeSubmit = observed.targetGets;
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    const retry = dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true });
    await retry.waitFor({ timeout: 10_000 });

    assert.equal(observed.targetPosts, 1);
    assert.equal(observed.requestPosts, 1);
    assert.ok(observed.targetGets > targetGetsBeforeSubmit, "ambiguous POST must reconcile with a dashboard GET");
    assert.equal(
      await page.getByRole("button", { name: `${target.name} 상세 보기`, exact: true }).count(),
      1
    );
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: observed.targetPosts,
      requestPosts: observed.requestPosts,
      reconcileGets: observed.targetGets - targetGetsBeforeSubmit
    };
  } finally {
    await context.close();
  }
}

async function runTransientSnapshotRetentionScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const existingTarget = {
    ...target,
    id: 90,
    name: "Protected result page",
    accessUrl: "https://example.com/protected"
  };
  const completedRequest = {
    ...pendingRequest,
    id: 490,
    evaluationTargetId: existingTarget.id,
    targetName: existingTarget.name,
    status: "COMPLETED"
  };
  const summary = {
    requestId: completedRequest.id,
    targetName: existingTarget.name,
    status: "COMPLETED",
    totalScore: 84,
    totalIssueCount: 1,
    criticalIssueCount: 0,
    requestedAt: timestamp
  };
  const retainedIssue = {
    id: 7001,
    requestId: completedRequest.id,
    module: "rule_based",
    severity: "SERIOUS",
    title: "타깃 복구 중 유지되어야 하는 접근성 이슈",
    description: "불완전한 응답이 기존 결과를 지우면 안 됩니다.",
    recommendation: "마지막 정상 결과를 유지하세요.",
    selector: "main img",
    wcagCode: "5.1.1",
    createdAt: timestamp
  };
  const retainedScore = {
    id: 8001,
    evaluationRequestId: completedRequest.id,
    totalScore: 84,
    ruleScore: 82,
    aiScore: 85,
    cvScore: 85,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const emptyOrganizationObserved = createDeferred();
  const missingTargetObserved = createDeferred();
  const missingRequestObserved = createDeferred();
  const releaseFreshTarget = createDeferred();
  let mode = "baseline";
  let emptyOrganizationsReturned = false;
  let emptyRequestsReturned = false;
  let targetPosts = 0;

  const markEmptyRound = () => {
    if (emptyOrganizationsReturned && emptyRequestsReturned) {
      mode = "missing-target";
      emptyOrganizationObserved.resolve();
    }
  };

  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;

      if (method === "GET" && pathname === "/api/organizations") {
        if (mode === "empty-org") {
          emptyOrganizationsReturned = true;
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          markEmptyRound();
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([organization]) });
        return;
      }
      if (method === "GET" && pathname === `/api/organizations/${organization.id}/evaluation-targets`) {
        if (mode === "missing-target") {
          await missingRequestObserved.promise;
          mode = "fresh-block";
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          missingTargetObserved.resolve();
          return;
        }
        if (mode === "fresh-block") {
          await releaseFreshTarget.promise;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mode === "baseline" ? [existingTarget] : [existingTarget, target])
        });
        return;
      }
      if (method === "GET" && pathname === "/api/requests") {
        if (mode === "empty-org" || mode === "missing-target") {
          if (mode === "empty-org") {
            emptyRequestsReturned = true;
          } else {
            missingRequestObserved.resolve();
          }
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          markEmptyRound();
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([completedRequest]) });
        return;
      }
      if (method === "GET" && pathname === `/api/results/requests/${completedRequest.id}/summary`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) });
        return;
      }
      if (method === "GET" && pathname === `/api/results/requests/${completedRequest.id}/issues`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([retainedIssue]) });
        return;
      }
      if (method === "GET" && pathname === `/api/scores/requests/${completedRequest.id}`) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(retainedScore) });
        return;
      }
      if (method === "POST" && pathname === `/api/organizations/${organization.id}/evaluation-targets`) {
        targetPosts += 1;
        mode = "empty-org";
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "committed target response lost" })
        });
        return;
      }
      if (method === "POST" && pathname === "/api/requests") {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ message: "stop after target reconciliation" })
        });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
    const scoreCard = page.getByRole("button", { name: `${existingTarget.name} 상세 보기`, exact: true });
    await scoreCard.waitFor();
    assert.match((await scoreCard.locator("xpath=..").textContent())?.replace(/\s+/g, "") ?? "", /84점/);

    await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
    await dialog.getByLabel("페이지 이름", { exact: true }).fill(target.name);
    await dialog.getByLabel("페이지 주소", { exact: true }).fill(target.accessUrl);
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await emptyOrganizationObserved.promise;

    await page.evaluate((path) => {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/projects/${organization.id}/pages/${existingTarget.id}`);
    await page.getByRole("heading", { level: 1, name: existingTarget.name, exact: true }).waitFor();
    const latestScore = page.locator(".site-summary-stat-item").filter({ hasText: "최신 점수" });
    assert.match((await latestScore.textContent())?.replace(/\s+/g, "") ?? "", /최신점수84점/);
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();

    await missingTargetObserved.promise;
    assert.equal(new URL(page.url()).pathname, `/projects/${organization.id}/pages/${existingTarget.id}`);
    assert.match((await latestScore.textContent())?.replace(/\s+/g, "") ?? "", /최신점수84점/);
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();

    releaseFreshTarget.resolve();
    await dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(targetPosts, 1);
    return {
      targetPosts,
      finalPath: new URL(page.url()).pathname,
      retainedScore: 84,
      retainedIssues: 1
    };
  } finally {
    releaseFreshTarget.resolve();
    await context.close();
  }
}

async function installRequestPostTimeout(page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    const realSetTimeout = window.setTimeout.bind(window);
    const stats = { posts: 0, aborts: 0, missingSignals: 0, deadlineCalls: 0 };
    window.__requestPostTimeoutStats = stats;

    window.setTimeout = ((callback, delay, ...args) => {
      if (delay === 15_000) {
        stats.deadlineCalls += 1;
        if (stats.deadlineCalls === 3) {
          return realSetTimeout(callback, 75, ...args);
        }
      }
      return realSetTimeout(callback, delay, ...args);
    });

    window.fetch = ((input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(rawUrl, window.location.href).pathname;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST" && pathname === "/api/requests") {
        stats.posts += 1;
        const signal = init?.signal;
        if (!signal) {
          stats.missingSignals += 1;
          return new Promise(() => {});
        }
        return new Promise((_, reject) => {
          const rejectAbort = () => {
            stats.aborts += 1;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return realFetch(input, init);
    });
  });
}

async function runRequestTimeoutNoCommitScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const state = { targets: [], requests: [] };
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    targetPosts: 0,
    requestPosts: 0,
    unknownRequests: new Set()
  };

  try {
    await installRequestPostTimeout(page);
    await installDashboardRoutes(page, state, observed, {
      targetPost: async (route) => {
        observed.targetPosts += 1;
        state.targets = [target];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(target) });
      }
    });
    const dialog = await openFilledDialog(page);
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    const retry = dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true });
    await retry.waitFor({ timeout: 10_000 });
    await dialog
      .getByText(
        "분석 요청 결과를 확인하지 못했습니다. 중복 분석을 막기 위해 요청을 다시 보내지 않고 요청 목록만 다시 확인합니다.",
        { exact: true }
      )
      .waitFor();

    const firstStats = await page.evaluate(() => window.__requestPostTimeoutStats);
    assert.deepEqual(
      { posts: firstStats.posts, aborts: firstStats.aborts, missingSignals: firstStats.missingSignals },
      { posts: 1, aborts: 1, missingSignals: 0 }
    );
    const requestGetsBeforeRetry = observed.requestGets;
    await retry.click();
    await waitForCounter(() => observed.requestGets, requestGetsBeforeRetry + 3, "GET-only request retry");
    const retryStats = await page.evaluate(() => window.__requestPostTimeoutStats);
    assert.equal(retryStats.posts, 1, "ambiguous request retry must remain GET-only");
    assert.equal(observed.targetPosts, 1);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: observed.targetPosts,
      requestPosts: retryStats.posts,
      requestPostAborts: retryStats.aborts,
      requestGets: observed.requestGets
    };
  } finally {
    await context.close();
  }
}

async function installStatusGetTimeout(page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    const stats = { statusGets: 0, aborts: 0, missingSignals: 0 };
    window.__statusGetTimeoutStats = stats;

    window.fetch = ((input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(rawUrl, window.location.href).pathname;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "GET" && /^\/api\/requests\/\d+$/.test(pathname) && stats.statusGets === 0) {
        stats.statusGets += 1;
        const signal = init?.signal;
        if (!signal) {
          stats.missingSignals += 1;
          return new Promise(() => {});
        }
        return new Promise((_, reject) => {
          const rejectAbort = () => {
            stats.aborts += 1;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal.aborted) {
            rejectAbort();
            return;
          }
          signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return realFetch(input, init);
    });
  });
}

async function runStatusTimeoutAndFailedReplacementScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const state = { targets: [], requests: [] };
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    targetPosts: 0,
    requestPosts: 0,
    statusGets: 0,
    unknownRequests: new Set()
  };

  try {
    await installStatusGetTimeout(page);
    await installDashboardRoutes(page, state, observed, {
      targetPost: async (route) => {
        observed.targetPosts += 1;
        state.targets = [target];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(target) });
      },
      requestPost: async (route) => {
        const nextRequest = observed.requestPosts === 1 ? pendingRequest : replacementRequest;
        state.requests = [nextRequest, ...(observed.requestPosts === 1 ? [] : [failedRequest])];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(nextRequest) });
      },
      requestStatusGet: async (route, request) => {
        observed.statusGets += 1;
        const requestId = Number(new URL(request.url()).pathname.split("/").at(-1));
        if (requestId === pendingRequest.id) {
          state.requests = [failedRequest];
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(failedRequest) });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(replacementRequest) });
      }
    });

    const dialog = await openFilledDialog(page);
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    const pollRetry = dialog.getByRole("button", { name: "상태 확인 다시 시도", exact: true });
    await pollRetry.waitFor({ timeout: 20_000 });
    const timeoutStats = await page.evaluate(() => window.__statusGetTimeoutStats);
    assert.deepEqual(
      { statusGets: timeoutStats.statusGets, aborts: timeoutStats.aborts, missingSignals: timeoutStats.missingSignals },
      { statusGets: 1, aborts: 1, missingSignals: 0 }
    );
    assert.equal(observed.requestPosts, 1);

    await pollRetry.click();
    const requestRetry = dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true });
    await requestRetry.waitFor({ timeout: 5_000 });
    assert.equal(observed.requestPosts, 1, "FAILED status check must not itself create a request");
    await requestRetry.click();
    await waitForCounter(() => observed.requestPosts, 2, "FAILED request replacement");
    assert.equal(observed.targetPosts, 1);
    assert.equal(observed.requestPosts, 2, "one explicit FAILED retry must create one replacement POST");
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: observed.targetPosts,
      requestPosts: observed.requestPosts,
      statusGetAborts: timeoutStats.aborts,
      statusGetsAfterRetry: observed.statusGets
    };
  } finally {
    await context.close();
  }
}

async function openRestoredDialog(page) {
  await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
  await dialog.waitFor();
  return dialog;
}

async function waitForInputValue(locator, expected, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while ((await locator.inputValue()) !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await locator.inputValue(), expected, label);
}

async function navigateSameDocument(page, pathname) {
  await page.evaluate((nextPathname) => {
    window.history.pushState({}, "", nextPathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, pathname);
  await page.waitForURL((url) => url.pathname === pathname);
}

async function runTargetReloadRecoveryScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const state = { targets: [], requests: [] };
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    targetPosts: 0,
    requestPosts: 0,
    unknownRequests: new Set()
  };

  try {
    await installDashboardRoutes(page, state, observed, {
      targetPost: async (route) => {
        observed.targetPosts += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "committed response is not visible yet" })
        });
      },
      requestPost: async (route) => {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ message: "stop after target reload recovery" })
        });
      }
    });

    let dialog = await openFilledDialog(page);
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await dialog.getByText(/중복 생성을 막기 위해 생성 요청을 다시 보내지 않고/).waitFor({ timeout: 10_000 });
    assert.equal(observed.targetPosts, 1);
    const storedBeforeReload = await page.evaluate(() => {
      const raw = sessionStorage.getItem("accessibility-dashboard.site-create-attempt.v1");
      return { raw, parsed: raw ? JSON.parse(raw) : null };
    });
    assert.equal(storedBeforeReload.parsed?.phase, "target-reconciling");
    assert.equal(storedBeforeReload.parsed?.apiScope, "/api");
    assert.ok(
      typeof storedBeforeReload.parsed?.attemptId === "string" &&
        storedBeforeReload.parsed.attemptId.length > 0
    );

    await dialog.getByLabel("페이지 이름", { exact: true }).fill("Different unresolved intent");
    await dialog.getByLabel("페이지 주소", { exact: true }).fill("https://example.com/different");
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await dialog.getByText(/완료 여부를 확인하지 못한 다른 페이지 작업/).waitFor();
    assert.equal(observed.targetPosts, 1, "a conflicting intent must not send a new target POST");
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("accessibility-dashboard.site-create-attempt.v1")
      ),
      storedBeforeReload.raw,
      "a conflicting intent must preserve the exact original recovery record"
    );

    state.targets = [target];
    await page.reload({ waitUntil: "networkidle" });
    dialog = await openRestoredDialog(page);
    await waitForInputValue(
      dialog.getByLabel("페이지 이름", { exact: true }),
      target.name,
      "target name must restore after reload"
    );
    await waitForInputValue(
      dialog.getByLabel("페이지 주소", { exact: true }),
      target.accessUrl,
      "target URL must restore after reload"
    );
    const targetGetsBeforeRetry = observed.targetGets;
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true }).waitFor({ timeout: 10_000 });
    assert.ok(observed.targetGets > targetGetsBeforeRetry, "reload recovery must use a fresh target GET");
    assert.equal(observed.targetPosts, 1, "target reload recovery must not repeat the target POST");
    assert.equal(observed.requestPosts, 1);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: observed.targetPosts,
      requestPosts: observed.requestPosts,
      freshTargetGets: observed.targetGets - targetGetsBeforeRetry,
      restoredPhase: storedBeforeReload.parsed.phase,
      conflictingIntentPosts: observed.targetPosts
    };
  } finally {
    await context.close();
  }
}

async function runRequestReloadAndSpaRecoveryScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const secondCandidate = {
    ...pendingRequest,
    id: 503,
    requestedAt: "2026-08-11T10:00:07.000Z",
    createdAt: "2026-08-11T10:00:07.000Z",
    updatedAt: "2026-08-11T10:00:07.000Z"
  };
  const state = { targets: [], requests: [] };
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    targetPosts: 0,
    requestPosts: 0,
    statusGets: 0,
    unknownRequests: new Set()
  };

  try {
    await installDashboardRoutes(page, state, observed, {
      targetPost: async (route) => {
        observed.targetPosts += 1;
        state.targets = [target];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(target) });
      },
      requestPost: async (route) => {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "request response lost" })
        });
      },
      requestStatusGet: async (route) => {
        observed.statusGets += 1;
        state.requests = [failedRequest];
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(failedRequest) });
      }
    });

    let dialog = await openFilledDialog(page);
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    let retry = dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true });
    await retry.waitFor({ timeout: 10_000 });
    assert.equal(observed.targetPosts, 1);
    assert.equal(observed.requestPosts, 1);

    // Simulate browser/host SPA navigation while the modal subtree is still
    // mounted; pointer navigation is intentionally trapped by the modal.
    await navigateSameDocument(page, "/analyze");
    await dialog.waitFor({ state: "hidden" });
    await navigateSameDocument(page, `/projects/${organization.id}`);
    dialog = await openRestoredDialog(page);
    retry = dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true });
    await retry.waitFor();
    const requestGetsBeforeSpaRetry = observed.requestGets;
    await retry.click();
    await waitForCounter(() => observed.requestGets, requestGetsBeforeSpaRetry + 3, "SPA GET-only request retry");
    assert.equal(observed.targetPosts, 1, "SPA remount must not repeat the target POST");
    assert.equal(observed.requestPosts, 1, "SPA remount must not repeat an ambiguous request POST");

    await page.reload({ waitUntil: "networkidle" });
    state.requests = [pendingRequest, secondCandidate];
    dialog = await openRestoredDialog(page);
    retry = dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true });
    const requestGetsBeforeMultiple = observed.requestGets;
    await retry.click();
    await waitForCounter(() => observed.requestGets, requestGetsBeforeMultiple + 1, "multiple-candidate request reconciliation");
    await dialog
      .getByText(/중복 분석을 막기 위해 요청을 다시 보내지 않고/)
      .first()
      .waitFor({ timeout: 10_000 });
    assert.equal(observed.requestPosts, 1, "multiple candidates must fail closed without a POST");
    assert.equal(observed.statusGets, 0, "multiple candidates must not be adopted for polling");

    state.requests = [pendingRequest];
    await retry.click();
    await dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(observed.statusGets, 1, "one unique candidate should resume status polling");
    assert.equal(observed.targetPosts, 1);
    assert.equal(observed.requestPosts, 1, "reload recovery must remain GET-only");
    const storedAfterFailed = await page.evaluate(() => {
      const raw = sessionStorage.getItem("accessibility-dashboard.site-create-attempt.v1");
      return raw ? JSON.parse(raw) : null;
    });
    assert.equal(storedAfterFailed?.phase, "request-ready");
    assert.equal(storedAfterFailed?.previousFailedRequestId, pendingRequest.id);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: observed.targetPosts,
      requestPosts: observed.requestPosts,
      requestGets: observed.requestGets,
      statusGets: observed.statusGets,
      finalPhase: storedAfterFailed.phase
    };
  } finally {
    await context.close();
  }
}

async function runStorageRecoveryGuardsScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const state = { targets: [], requests: [] };
  const observed = {
    organizationGets: 0,
    targetGets: 0,
    requestGets: 0,
    targetPosts: 0,
    requestPosts: 0,
    unknownRequests: new Set()
  };
  const storageKey = "accessibility-dashboard.site-create-attempt.v1";

  try {
    await installDashboardRoutes(page, state, observed, {
      targetPost: async (route) => {
        observed.targetPosts += 1;
        state.targets = [target];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(target) });
      },
      requestPost: async (route) => {
        state.requests = [pendingRequest];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(pendingRequest) });
      },
      requestStatusGet: async (route) => {
        const completed = { ...pendingRequest, status: "COMPLETED" };
        state.requests = [completed];
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(completed) });
      },
      otherRequest: async (route, _request, method, pathname) => {
        if (method === "GET" && pathname === `/api/results/requests/${pendingRequest.id}/summary`) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              requestId: pendingRequest.id,
              targetName: target.name,
              status: "COMPLETED",
              totalScore: 91,
              totalIssueCount: 0,
              criticalIssueCount: 0,
              requestedAt: timestamp
            })
          });
          return true;
        }
        if (method === "GET" && pathname === `/api/results/requests/${pendingRequest.id}/issues`) {
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          return true;
        }
        if (method === "GET" && pathname === `/api/scores/requests/${pendingRequest.id}`) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: 9001,
              evaluationRequestId: pendingRequest.id,
              totalScore: 91,
              ruleScore: 90,
              aiScore: 92,
              cvScore: 91,
              createdAt: timestamp,
              updatedAt: timestamp
            })
          });
          return true;
        }
        return false;
      }
    });
    await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();

    const mismatchedScopeRaw = await page.evaluate(({ key, item, now }) => {
      const raw = JSON.stringify({
        version: 1,
        attemptId: "scope-mismatch-attempt",
        apiScope: "/different-api",
        projectId: 1,
        name: item.name,
        accessUrl: item.accessUrl,
        previousTargetIds: [],
        startedAt: now,
        phase: "target-reconciling"
      });
      sessionStorage.setItem(key, raw);
      return raw;
    }, { key: storageKey, item: target, now: Date.now() });
    await page.reload({ waitUntil: "networkidle" });
    let dialog = await openRestoredDialog(page);
    await dialog.getByText(/다른 서버 또는 손상된 페이지 생성 복구 정보/).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "분석 시작", exact: true }).isDisabled(), true);
    assert.equal(observed.targetPosts, 0, "API-scope mismatch must fail closed before POST");

    const discard = dialog.getByRole("button", { name: "복구 정보 삭제", exact: true });
    await Promise.all([
      page.waitForEvent("dialog").then((confirmation) => confirmation.dismiss()),
      discard.click()
    ]);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), mismatchedScopeRaw);
    await Promise.all([
      page.waitForEvent("dialog").then((confirmation) => confirmation.accept()),
      discard.click()
    ]);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);

    await page.evaluate((key) => {
      const originalSetItem = Storage.prototype.setItem;
      window.__restoreSiteStorageSetItem = () => {
        Storage.prototype.setItem = originalSetItem;
      };
      Storage.prototype.setItem = function guardedSetItem(storageKey, value) {
        if (storageKey === key) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        return originalSetItem.call(this, storageKey, value);
      };
    }, storageKey);
    await dialog.getByLabel("페이지 이름", { exact: true }).fill(target.name);
    await dialog.getByLabel("페이지 주소", { exact: true }).fill(target.accessUrl);
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await dialog.getByText(/안전한 복구 정보를 저장하지 못해 요청을 시작하지 않았습니다/).waitFor();
    assert.equal(observed.targetPosts, 0, "quota failure must occur before target POST");
    await page.evaluate(() => window.__restoreSiteStorageSetItem?.());
    await dialog.getByRole("button", { name: "취소", exact: true }).click();

    const staleRaw = await page.evaluate(({ key, item, now }) => {
      const raw = JSON.stringify({
        version: 1,
        attemptId: "stale-target-attempt",
        apiScope: "/api",
        projectId: 1,
        name: item.name,
        accessUrl: item.accessUrl,
        previousTargetIds: [],
        startedAt: now - 25 * 60 * 60 * 1000,
        phase: "target-reconciling"
      });
      sessionStorage.setItem(key, raw);
      return raw;
    }, { key: storageKey, item: target, now: Date.now() });
    dialog = await openRestoredDialog(page);
    await dialog.getByText(/24시간이 지난 복구 정보/).waitFor();
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await dialog.getByText(/중복 생성을 막기 위해 생성 요청을 다시 보내지 않고/).waitFor();
    assert.equal(observed.targetPosts, 0, "stale recovery retry must remain GET-only");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), staleRaw);
    await Promise.all([
      page.waitForEvent("dialog").then((confirmation) => confirmation.accept()),
      dialog.getByRole("button", { name: "복구 정보 삭제", exact: true }).click()
    ]);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);

    await dialog.getByLabel("페이지 이름", { exact: true }).fill(target.name);
    await dialog.getByLabel("페이지 주소", { exact: true }).fill(target.accessUrl);
    await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    assert.equal(
      await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
      null,
      "a completed Site workflow must clear its durable recovery record"
    );
    assert.equal(observed.targetPosts, 1);
    assert.equal(observed.requestPosts, 1);

    await page.evaluate((key) => sessionStorage.setItem(key, "malformed-site-recovery"), storageKey);
    await page.getByRole("button", { name: "ADMIN", exact: true }).click();
    await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      targetPosts: observed.targetPosts,
      scopeMismatchPostCount: 0,
      quotaPostCount: 0,
      staleRetryPostCount: 0,
      completionCleared: true,
      logoutCleared: true
    };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  if (process.env.SITE_STORAGE_ONLY === "1") {
    const storageRecovery = await runStorageRecoveryGuardsScenario(browser);
    console.log(JSON.stringify({ result: "PASS", storageRecovery }, null, 2));
    process.exitCode = 0;
  } else if (process.env.SITE_RECOVERY_ONLY === "1") {
    const targetReload = await runTargetReloadRecoveryScenario(browser);
    const requestReload = await runRequestReloadAndSpaRecoveryScenario(browser);
    const storageRecovery = await runStorageRecoveryGuardsScenario(browser);
    console.log(
      JSON.stringify({ result: "PASS", targetReload, requestReload, storageRecovery }, null, 2)
    );
    process.exitCode = 0;
  } else {
  const mobile = await runSameTaskAndMobileScenario(browser);
  const timeout = await runTimeoutNoCommitScenario(browser);
  const committed = await runCommittedAmbiguousScenario(browser);
  const retention = await runTransientSnapshotRetentionScenario(browser);
  const requestTimeout = await runRequestTimeoutNoCommitScenario(browser);
  const statusTimeout = await runStatusTimeoutAndFailedReplacementScenario(browser);
  const targetReload = await runTargetReloadRecoveryScenario(browser);
  const requestReload = await runRequestReloadAndSpaRecoveryScenario(browser);
  const storageRecovery = await runStorageRecoveryGuardsScenario(browser);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        mobile,
        timeout,
        committed,
        retention,
        requestTimeout,
        statusTimeout,
        targetReload,
        requestReload,
        storageRecovery
      },
      null,
      2
    )
  );
  }
} finally {
  await browser.close();
}
