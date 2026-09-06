/**
 * A site-analysis checkpoint must survive a terminal/transient status error,
 * while its in-memory directory protection lease must end with the modal
 * operation. Otherwise a later authoritative deletion is hidden for several
 * dashboard refreshes behind the stale pre-analysis snapshot.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const recoveryStorageKey = "accessibility-dashboard.site-create-attempt.v1";
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

function activeOverview() {
  return createDashboardOverview({
    organizations: [organization],
    evaluationTargets: [target]
  });
}

async function verifyLeaseRelease(browser, statusOutcome) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const observed = {
    incompleteOverviewGets: 0,
    overviewGets: 0,
    requestListGets: 0,
    requestPosts: 0,
    requestStatusGets: 0,
    targetDeletePatches: 0,
    unknownRequests: []
  };
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
    const pathname = new URL(request.url()).pathname;

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
    if (method === "GET" && pathname === "/api/requests") {
      observed.requestListGets += 1;
      await fulfillJson(route, requestCommitted ? [pendingRequest] : []);
      return;
    }
    if (method === "GET" && pathname === `/api/targets/${target.id}`) {
      await fulfillJson(route, target);
      return;
    }
    if (method === "POST" && pathname === "/api/requests") {
      observed.requestPosts += 1;
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
    if (method === "GET" && pathname === `/api/requests/${pendingRequest.id}`) {
      observed.requestStatusGets += 1;
      if (statusOutcome === "FAILED") {
        await fulfillJson(route, failedRequest);
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
    assert.equal(
      observed.requestListGets,
      statusOutcome === "FAILED" ? 1 : 2,
      "an ambiguous POST must reconcile by GET without sending another request"
    );
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
    backgroundStatusGets: 0,
    incompleteOverviewGets: 0,
    overviewGets: 0,
    requestListGets: 0,
    requestPosts: 0,
    requestStatusGets: 0,
    unknownRequests: []
  };
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
    const pathname = new URL(request.url()).pathname;

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
    if (method === "GET" && pathname === "/api/requests") {
      observed.requestListGets += 1;
      if (observed.requestListGets > 1) {
        resolveReconcileStarted();
        await reconcileGate;
      }
      await fulfillJson(
        route,
        requestCommitted ? [backgroundRequest, pendingRequest] : [backgroundRequest]
      );
      return;
    }
    if (method === "GET" && pathname === `/api/targets/${target.id}`) {
      await fulfillJson(route, target);
      return;
    }
    if (method === "POST" && pathname === "/api/requests") {
      observed.requestPosts += 1;
      requestCommitted = true;
      await fulfillJson(
        route,
        { message: "request response lost after commit" },
        { status: 503 }
      );
      return;
    }
    if (method === "GET" && pathname === `/api/requests/${backgroundRequest.id}`) {
      observed.backgroundStatusGets += 1;
      await fulfillJson(route, { message: "refresh overview" }, { status: 503 });
      return;
    }
    if (method === "GET" && pathname === `/api/requests/${pendingRequest.id}`) {
      observed.requestStatusGets += 1;
      await fulfillJson(
        route,
        { message: "temporary request status failure" },
        { status: 503 }
      );
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
      }, recoveryStorageKey);
      assert.equal(
        unresolvedCheckpoint?.phase,
        "request-reconciling",
        "unmount cleanup must preserve the ambiguous POST checkpoint"
      );

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
      assert.equal(observed.requestPosts, 1);
      assert.equal(observed.requestListGets, 2);
      assert.equal(observed.requestStatusGets, 0);
      assert.equal(observed.backgroundStatusGets, 2);
      assert.equal(observed.incompleteOverviewGets, 2);
      assert.notEqual(
        await page.evaluate((key) => sessionStorage.getItem(key), recoveryStorageKey),
        null,
        "unmount cleanup must keep the persisted duplicate-POST checkpoint"
      );
      assert.deepEqual(observed.unknownRequests, []);
      return observed;
    }

    releaseReconcileRequest();
    await siteDialog.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), recoveryStorageKey), null);

    // Receipt handoff releases the lease; the next snapshot may accept deletion.
    await page.waitForURL("**/analyze", { timeout: 10_000 });

    assert.equal(observed.requestPosts, 1);
    assert.equal(observed.requestListGets, 2);
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
