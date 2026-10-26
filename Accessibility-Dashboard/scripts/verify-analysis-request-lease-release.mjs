/**
 * A site-analysis checkpoint must survive a terminal/transient status error,
 * while its in-memory directory protection lease must end with the modal
 * operation. Otherwise a later authoritative deletion is hidden for several
 * dashboard refreshes behind the stale pre-analysis snapshot.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import {
  activeRequestsForTarget,
  createAnalysisAttempts,
  idempotencyKey,
  readAttemptKey,
  readStatusIds,
  statusEntries
} from "./fixtures/analysis-protocol-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const recoveryStorageKey = "accessibility-dashboard.site-create-attempt.v1";
// The seeded record is a legacy standalone rescan preparation (its target is in
// previousTargetIds). The request flow releases it and continues in the
// per-page rescan slot, so the shared page-creation slot stays free.
const rescanStorageKey = "accessibility-dashboard.target-rescan-attempts.v1:711";
const timestamp = "2026-08-29T10:00:00.000Z";
const organization = {
  id: 71,
  name: "Lease release project",
  type: "ETC",
  homepageUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const target = {
  id: 711,
  organizationId: organization.id,
  name: "Lease release page",
  targetType: "WEB",
  accessUrl: "https://example.com/lease-release",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const backgroundTarget = {
  ...target,
  id: 713,
  name: "Background polling page",
  accessUrl: "https://example.com/background-polling"
};
const pendingRequest = {
  id: 712,
  evaluationTargetId: target.id,
  targetName: target.name,
  faviconUrl: null,
  status: "PENDING",
  requestNote: "lease release regression",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};
const backgroundRequest = {
  ...pendingRequest,
  id: 714,
  evaluationTargetId: backgroundTarget.id,
  targetName: backgroundTarget.name,
  requestNote: "background refresh trigger"
};
const failedRequest = {
  ...pendingRequest,
  status: "FAILED",
  updatedAt: "2026-08-29T10:00:01.000Z"
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function activeOverview() {
  return createDashboardOverview({
    organizations: [organization],
    evaluationTargets: [target]
  });
}

async function verifyLeaseRelease(browser, statusOutcome) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const observed = {
    activeRequestGets: 0,
    attemptLookupGets: 0,
    incompleteOverviewGets: 0,
    overviewGets: 0,
    requestPosts: 0,
    requestStatusGets: 0,
    targetDeletePatches: 0,
    postKeys: [],
    attemptLookupKeys: [],
    unknownRequests: []
  };
  const attempts = createAnalysisAttempts();
  let baselineDeleted = false;
  let requestCommitted = false;

  await page.addInitScript(
    ({ key, project, pageTarget }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          attemptId: crypto.randomUUID(),
          apiScope: "/api",
          projectId: project.id,
          name: pageTarget.name,
          accessUrl: pageTarget.accessUrl,
          previousTargetIds: [pageTarget.id],
          startedAt: Date.now(),
          phase: "request-ready",
          targetId: pageTarget.id,
          previousFailedRequestId: null
        })
      );
    },
    { key: recoveryStorageKey, project: organization, pageTarget: target }
  );

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/dashboard/overview") {
      observed.overviewGets += 1;
      if (baselineDeleted) {
        observed.incompleteOverviewGets += 1;
      }
      await fulfillJson(route, baselineDeleted ? createDashboardOverview() : activeOverview());
      return;
    }
    if (method === "GET" && pathname === "/api/organizations") {
      await fulfillJson(route, baselineDeleted ? [] : [organization]);
      return;
    }
    if (
      method === "GET" &&
      pathname === `/api/organizations/${organization.id}/evaluation-targets`
    ) {
      await fulfillJson(route, baselineDeleted ? [] : [target]);
      return;
    }
    if (method === "GET" && pathname === "/api/requests/active") {
      observed.activeRequestGets += 1;
      await fulfillJson(
        route,
        activeRequestsForTarget(requestCommitted ? [pendingRequest] : [], url)
      );
      return;
    }
    const attemptKey = method === "GET" ? readAttemptKey(pathname) : null;
    if (attemptKey !== null) {
      observed.attemptLookupGets += 1;
      observed.attemptLookupKeys.push(attemptKey);
      await fulfillJson(route, attempts.find(attemptKey));
      return;
    }
    if (method === "GET" && pathname === `/api/targets/${target.id}`) {
      await fulfillJson(route, target);
      return;
    }
    if (method === "POST" && pathname === "/api/requests") {
      observed.requestPosts += 1;
      const key = idempotencyKey(route);
      observed.postKeys.push(key);
      // The server answers a repeated key with the request it created first.
      attempts.remember(key, attempts.find(key) ?? pendingRequest);
      requestCommitted = true;
      if (statusOutcome === "FAILED") {
        await fulfillJson(route, pendingRequest, { status: 201 });
      } else {
        await fulfillJson(
          route,
          { message: "request response lost after commit" },
          { status: 503 }
        );
      }
      return;
    }
    if (method === "GET" && pathname === "/api/requests/statuses") {
      if (readStatusIds(url).includes(pendingRequest.id)) {
        observed.requestStatusGets += 1;
      }
      if (statusOutcome === "FAILED") {
        await fulfillJson(
          route,
          statusEntries(readStatusIds(url), (id) =>
            id === pendingRequest.id && requestCommitted ? failedRequest : null)
        );
      } else {
        await fulfillJson(
          route,
          { message: "temporary request status failure" },
          { status: 503 }
        );
      }
      return;
    }
    if (method === "PATCH" && pathname === `/api/targets/${target.id}/delete`) {
      observed.targetDeletePatches += 1;
      baselineDeleted = true;
      await fulfillJson(route, null);
      return;
    }

    observed.unknownRequests.push(`${method} ${pathname}`);
    await fulfillJson(route, null, { status: 500 });
  });

  try {
    await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
    await page
      .getByRole("heading", { level: 1, name: organization.name, exact: true })
      .waitFor();
    await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
    const siteDialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
    await siteDialog.getByRole("button", { name: "분석 시작", exact: true }).click();

    await siteDialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryStorageKey), null,
      "confirmed receipts must release the form checkpoint before background status reads");

    await page.getByRole("button", { name: `${target.name} 제거`, exact: true }).click();
    const deleteDialog = page.getByRole("dialog", { name: "페이지 제거", exact: true });
    await deleteDialog.getByRole("button", { name: "제거", exact: true }).click();
    await page.waitForURL("**/analyze", { timeout: 10_000 });

    assert.equal(observed.requestPosts, 1, "status recovery must not duplicate the POST");
    assert.match(observed.postKeys[0] ?? "", uuidPattern, "the rescan POST must carry an Idempotency-Key");
    assert.equal(
      observed.activeRequestGets,
      1,
      "the rescan preflight must read only this page's active requests, once"
    );
    assert.deepEqual(
      observed.attemptLookupKeys,
      statusOutcome === "FAILED" ? [] : [observed.postKeys[0]],
      "an ambiguous POST must reconcile by GET (its own key) without sending another request"
    );
    assert.deepEqual(attempts.keys(), [observed.postKeys[0]], "the server must hold exactly one request");
    assert.equal(observed.requestStatusGets, 0, "handoff does not await status");
    assert.equal(observed.targetDeletePatches, 1);
    assert.equal(
      observed.incompleteOverviewGets,
      1,
      "the first incomplete authoritative overview must be accepted after lease release"
    );
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryStorageKey), null);
    assert.deepEqual(observed.unknownRequests, []);
    return observed;
  } finally {
    await page.close();
  }
}

async function verifyLeaseHeldDuringReconciliation(browser, releaseMode) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const observed = {
    activeRequestGets: 0,
    attemptLookupGets: 0,
    backgroundStatusGets: 0,
    incompleteOverviewGets: 0,
    overviewGets: 0,
    requestPosts: 0,
    requestStatusGets: 0,
    postKeys: [],
    attemptLookupKeys: [],
    unknownRequests: []
  };
  const attempts = createAnalysisAttempts();
  let authoritativeBaselineDeleted = false;
  let requestCommitted = false;
  let resolveFirstIncompleteOverview;
  let resolveSecondIncompleteOverview;
  let resolveReconcileStarted;
  let releaseReconcileRequest;
  const firstIncompleteOverview = new Promise((resolve) => {
    resolveFirstIncompleteOverview = resolve;
  });
  const secondIncompleteOverview = new Promise((resolve) => {
    resolveSecondIncompleteOverview = resolve;
  });
  const reconcileStarted = new Promise((resolve) => {
    resolveReconcileStarted = resolve;
  });
  const reconcileGate = new Promise((resolve) => {
    releaseReconcileRequest = resolve;
  });

  await page.addInitScript(
    ({ key, project, pageTarget }) => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (handler, timeout = 0, ...args) =>
        nativeSetInterval(handler, timeout === 5_000 ? 60_000 : timeout, ...args);
      sessionStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          attemptId: crypto.randomUUID(),
          apiScope: "/api",
          projectId: project.id,
          name: pageTarget.name,
          accessUrl: pageTarget.accessUrl,
          previousTargetIds: [pageTarget.id],
          startedAt: Date.now(),
          phase: "request-ready",
          targetId: pageTarget.id,
          previousFailedRequestId: null
        })
      );
    },
    { key: recoveryStorageKey, project: organization, pageTarget: target }
  );

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/dashboard/overview") {
      observed.overviewGets += 1;
      if (authoritativeBaselineDeleted) {
        observed.incompleteOverviewGets += 1;
        if (observed.incompleteOverviewGets === 1) {
          resolveFirstIncompleteOverview();
        } else if (observed.incompleteOverviewGets === 2) {
          resolveSecondIncompleteOverview();
        }
      }
      await fulfillJson(
        route,
        authoritativeBaselineDeleted
          ? createDashboardOverview()
          : createDashboardOverview({
              organizations: [organization],
              evaluationTargets: [target, backgroundTarget],
              evaluationRequests: [backgroundRequest]
            })
      );
      return;
    }
    if (method === "GET" && pathname === "/api/organizations") {
      await fulfillJson(route, authoritativeBaselineDeleted ? [] : [organization]);
      return;
    }
    if (
      method === "GET" &&
      pathname === `/api/organizations/${organization.id}/evaluation-targets`
    ) {
      await fulfillJson(
        route,
        authoritativeBaselineDeleted ? [] : [target, backgroundTarget]
      );
      return;
    }
    if (method === "GET" && pathname === "/api/requests/active") {
      observed.activeRequestGets += 1;
      await fulfillJson(
        route,
        activeRequestsForTarget(
          requestCommitted ? [backgroundRequest, pendingRequest] : [backgroundRequest],
          url
        )
      );
      return;
    }
    const attemptKey = method === "GET" ? readAttemptKey(pathname) : null;
    if (attemptKey !== null) {
      // Every receipt lookup after the lost POST waits for the gate, so the
      // reconciliation stays unresolved while the test inspects the lease.
      observed.attemptLookupGets += 1;
      observed.attemptLookupKeys.push(attemptKey);
      resolveReconcileStarted();
      await reconcileGate;
      await fulfillJson(route, attempts.find(attemptKey));
      return;
    }
    if (method === "GET" && pathname === `/api/targets/${target.id}`) {
      await fulfillJson(route, target);
      return;
    }
    if (method === "POST" && pathname === "/api/requests") {
      observed.requestPosts += 1;
      const key = idempotencyKey(route);
      observed.postKeys.push(key);
      attempts.remember(key, attempts.find(key) ?? pendingRequest);
      requestCommitted = true;
      await fulfillJson(
        route,
        { message: "request response lost after commit" },
        { status: 503 }
      );
      return;
    }
    if (method === "GET" && pathname === "/api/requests/statuses") {
      const ids = readStatusIds(url);
      if (ids.includes(backgroundRequest.id)) {
        observed.backgroundStatusGets += 1;
      }
      if (ids.includes(pendingRequest.id)) {
        observed.requestStatusGets += 1;
      }
      // A failed status read makes the shell refresh the overview.
      await fulfillJson(route, { message: "refresh overview" }, { status: 503 });
      return;
    }

    observed.unknownRequests.push(`${method} ${pathname}`);
    await fulfillJson(route, null, { status: 500 });
  });

  try {
    await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
    await page
      .getByRole("heading", { level: 1, name: organization.name, exact: true })
      .waitFor();
    await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
    const siteDialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
    await siteDialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await reconcileStarted;

    authoritativeBaselineDeleted = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await firstIncompleteOverview;
    assert.equal(
      observed.incompleteOverviewGets,
      1,
      "reconciliation must trigger one controlled incomplete overview"
    );
    assert.equal(
      await page.getByRole("button", { name: `${target.name} 제거`, exact: true }).count(),
      1,
      "the lease must protect the baseline while POST reconciliation is unresolved"
    );
    assert.equal(new URL(page.url()).pathname, `/projects/${organization.id}`);

    if (releaseMode === "unmount") {
      await page.evaluate(() => {
        window.history.pushState({}, "", "/analyze");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.waitForURL("**/analyze", { timeout: 10_000 });
      await siteDialog.waitFor({ state: "hidden" });
      const unresolvedCheckpoint = await page.evaluate((key) => {
        const rawValue = sessionStorage.getItem(key);
        return rawValue === null ? null : JSON.parse(rawValue);
      }, rescanStorageKey);
      assert.equal(
        unresolvedCheckpoint?.phase,
        "request-reconciling",
        "unmount cleanup must preserve the ambiguous POST checkpoint until it is settled"
      );
      assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryStorageKey), null,
        "a rescan must not hold the shared page-creation slot");

      releaseReconcileRequest();
      await page.waitForTimeout(50);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await secondIncompleteOverview;
      const removedProjectButton = page.getByRole("button", {
        name: organization.name,
        exact: true
      });
      await removedProjectButton.waitFor({ state: "detached", timeout: 10_000 });
      assert.equal(
        await removedProjectButton.count(),
        0,
        "unmount abort must release the lease before the next authoritative refresh"
      );
      // The abandoned rescan is settled in the background with GETs only.
      await page.waitForFunction(
        (key) => sessionStorage.getItem(key) === null,
        rescanStorageKey,
        { timeout: 10_000 }
      );
      assert.equal(observed.requestPosts, 1, "background settlement must never resend the POST");
      assert.equal(observed.activeRequestGets, 1, "only the original click runs the active-request preflight");
      assert.deepEqual(
        observed.attemptLookupKeys,
        [observed.postKeys[0], observed.postKeys[0]],
        "the abandoned POST is settled by one extra receipt GET for its own key"
      );
      assert.deepEqual(attempts.keys(), [observed.postKeys[0]], "the server must hold exactly one request");
      assert.equal(observed.requestStatusGets, 0);
      // The next authoritative overview may come from the settled rescan's own
      // refresh rather than from a second (backed-off) background status poll.
      assert.ok(observed.backgroundStatusGets >= 1, JSON.stringify(observed));
      assert.ok(observed.incompleteOverviewGets >= 2);
      assert.deepEqual(observed.unknownRequests, []);
      return observed;
    }

    releaseReconcileRequest();
    await siteDialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryStorageKey), null);

    // Receipt handoff releases the lease; the next snapshot may accept deletion.
    await page.waitForURL("**/analyze", { timeout: 10_000 });

    assert.equal(observed.requestPosts, 1);
    assert.match(observed.postKeys[0] ?? "", uuidPattern, "the rescan POST must carry an Idempotency-Key");
    assert.equal(observed.activeRequestGets, 1);
    assert.deepEqual(observed.attemptLookupKeys, [observed.postKeys[0]]);
    assert.deepEqual(attempts.keys(), [observed.postKeys[0]], "the server must hold exactly one request");
    assert.equal(observed.requestStatusGets, 0, "receipt handoff does not await status");
    assert.equal(observed.backgroundStatusGets, 1);
    assert.equal(observed.incompleteOverviewGets, 2);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryStorageKey), null);
    assert.deepEqual(observed.unknownRequests, []);
    return observed;
  } finally {
    releaseReconcileRequest();
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const failed = await verifyLeaseRelease(browser, "FAILED");
  const temporarilyUnavailable = await verifyLeaseRelease(browser, "STATUS_503");
  const reconciliationLifecycle = await verifyLeaseHeldDuringReconciliation(
    browser,
    "operation"
  );
  const unmountLifecycle = await verifyLeaseHeldDuringReconciliation(browser, "unmount");
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        failed,
        temporarilyUnavailable,
        reconciliationLifecycle,
        unmountLifecycle
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
