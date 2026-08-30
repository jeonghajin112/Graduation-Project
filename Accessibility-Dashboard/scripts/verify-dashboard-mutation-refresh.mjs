/**
 * Regression checks for the dashboard overview load owner:
 *
 * - a mutation refresh is not blocked by a stalled background status poll;
 * - the detached poll cannot interfere with newer dashboard state;
 * - an owned timeout ends bootstrap with a retryable user-facing error;
 * - a component-unmount abort remains silent.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const DASHBOARD_OVERVIEW_TIMEOUT_MS = 15_000;
const ACCELERATED_DASHBOARD_OVERVIEW_TIMEOUT_MS = 250;
const DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE =
  "대시보드 응답 대기 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
const timestamp = "2026-08-10T10:00:00.000Z";
const baselineProject = {
  id: 1,
  name: "Active scan project",
  type: "ETC",
  homepageUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const baselineTarget = {
  id: 101,
  organizationId: baselineProject.id,
  name: "Pending scan page",
  targetType: "WEB",
  accessUrl: "https://example.com/pending",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const pendingRequest = {
  id: 501,
  evaluationTargetId: baselineTarget.id,
  targetName: baselineTarget.name,
  faviconUrl: null,
  status: "PENDING",
  requestNote: "Keep the background overview poll active",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};
const createdProject = {
  ...baselineProject,
  id: 77,
  name: "Polling-safe project"
};

const baselineOverview = createDashboardOverview({
  organizations: [baselineProject],
  evaluationTargets: [baselineTarget],
  evaluationRequests: [pendingRequest]
});

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function readOverviewProbe(page) {
  return page.evaluate(() => {
    const probe = window.__dashboardOverviewLoadProbe;
    return {
      aborts: probe.aborts,
      calls: probe.calls,
      scheduledTimeouts: probe.scheduledTimeouts ?? [],
      stalledCalls: probe.stalledCalls ?? 0
    };
  });
}

async function installBackgroundPollProbe(page, {
  stalledPath = "/api/dashboard/overview",
  staleData = baselineOverview
} = {}) {
  const stalledRequestStarted = createDeferred();
  await page.exposeFunction("markDashboardOverviewStalled", () => {
    stalledRequestStarted.resolve();
  });
  await page.addInitScript(({ stalledPath, staleResponse }) => {
    const nativeFetch = window.fetch.bind(window);
    const probe = {
      aborts: 0,
      calls: 0,
      releaseStale: null,
      stallNext: false,
      stalledCalls: 0
    };
    window.__dashboardOverviewLoadProbe = probe;
    window.fetch = (input, init) => {
      const rawUrl =
        typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(rawUrl, window.location.origin).pathname;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" || pathname !== stalledPath) {
        return nativeFetch(input, init);
      }

      probe.calls += 1;
      if (!probe.stallNext) {
        return nativeFetch(input, init);
      }

      probe.stallNext = false;
      probe.stalledCalls += 1;
      return new Promise((resolve) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            probe.aborts += 1;
          },
          { once: true }
        );
        probe.releaseStale = () => {
          resolve(
            new Response(JSON.stringify(staleResponse), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            })
          );
        };
        void window.markDashboardOverviewStalled();
      });
    };
  }, {
    stalledPath,
    staleResponse: { success: true, data: staleData, message: "" }
  });
  return { stalledRequestStarted: stalledRequestStarted.promise };
}

async function installBootstrapStallProbe(page) {
  const stalledRequestStarted = createDeferred();
  await page.exposeFunction("markDashboardOverviewStalled", () => {
    stalledRequestStarted.resolve();
  });
  await page.addInitScript(({ acceleratedTimeoutMs, overviewTimeoutMs }) => {
    const nativeFetch = window.fetch.bind(window);
    const nativeSetTimeout = window.setTimeout.bind(window);
    const probe = { aborts: 0, calls: 0, scheduledTimeouts: [], stalledCalls: 0 };
    window.__dashboardOverviewLoadProbe = probe;
    window.setTimeout = ((handler, timeout, ...args) => {
      if (timeout === overviewTimeoutMs) {
        probe.scheduledTimeouts.push(timeout);
        return nativeSetTimeout(handler, acceleratedTimeoutMs, ...args);
      }
      return nativeSetTimeout(handler, timeout, ...args);
    });
    window.fetch = (input, init) => {
      const rawUrl =
        typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(rawUrl, window.location.origin).pathname;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" || pathname !== "/api/dashboard/overview") {
        return nativeFetch(input, init);
      }

      probe.calls += 1;
      if (probe.calls > 2) {
        return nativeFetch(input, init);
      }

      probe.stalledCalls += 1;
      return new Promise((_, reject) => {
        const signal = init?.signal;
        const handleAbort = () => {
          probe.aborts += 1;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (signal?.aborted) {
          handleAbort();
          return;
        }
        signal?.addEventListener("abort", handleAbort, { once: true });
        if (probe.calls === 2) {
          void window.markDashboardOverviewStalled();
        }
      });
    };
  }, {
    acceleratedTimeoutMs: ACCELERATED_DASHBOARD_OVERVIEW_TIMEOUT_MS,
    overviewTimeoutMs: DASHBOARD_OVERVIEW_TIMEOUT_MS
  });
  return { stalledRequestStarted: stalledRequestStarted.promise };
}

async function runMutationReplacementScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const { stalledRequestStarted } = await installBackgroundPollProbe(page, {
    stalledPath: `/api/requests/${pendingRequest.id}`,
    staleData: pendingRequest
  });
  const observed = {
    organizationPosts: 0,
    overviewGets: 0,
    postMutationOverviewGets: 0,
    postBody: null,
    unknownRequests: new Set()
  };
  let organizationCommitted = false;

  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (method === "GET" && pathname === "/api/dashboard/overview") {
        observed.overviewGets += 1;
        if (organizationCommitted) {
          observed.postMutationOverviewGets += 1;
        }
        await fulfillJson(
          route,
          createDashboardOverview({
            organizations: organizationCommitted
              ? [baselineProject, createdProject]
              : [baselineProject],
            evaluationTargets: [baselineTarget],
            evaluationRequests: [pendingRequest]
          })
        );
        return;
      }
      if (method === "GET" && pathname === `/api/requests/${pendingRequest.id}`) {
        await fulfillJson(route, pendingRequest);
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        observed.postBody = JSON.parse(request.postData() ?? "null");
        organizationCommitted = true;
        await fulfillJson(route, createdProject, { status: 201 });
        return;
      }
      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page
      .getByRole("complementary")
      .getByRole("button", { name: baselineProject.name, exact: true })
      .waitFor();
    await page.evaluate(() => {
      window.__dashboardOverviewLoadProbe.stallNext = true;
    });
    await Promise.race([
      stalledRequestStarted,
      page.waitForTimeout(8_000).then(() => {
        throw new Error("background request-status poll did not start");
      })
    ]);

    const addProjectButton = page
      .getByRole("complementary")
      .getByRole("button", { name: "프로젝트 추가", exact: true });
    await addProjectButton.click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();

    await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 10_000 });
    await page.getByRole("heading", { level: 1, name: createdProject.name, exact: true }).waitFor();
    const replacementProbe = await readOverviewProbe(page);
    assert.equal(replacementProbe.stalledCalls, 1);
    assert.equal(replacementProbe.aborts, 1);
    assert.equal(observed.postMutationOverviewGets, 1);

    await page.evaluate(() => window.__dashboardOverviewLoadProbe.releaseStale());
    await page.waitForTimeout(250);
    assert.equal(new URL(page.url()).pathname, `/projects/${createdProject.id}`);
    assert.equal(
      await page
        .getByRole("complementary")
        .getByRole("button", { name: createdProject.name, exact: true })
        .getAttribute("aria-current"),
      "page",
      "a detached overview response must not replace mutation refresh data"
    );
    assert.equal(
      await page.getByText("분석 화면을 불러오는 중...", { exact: true }).count(),
      0,
      "a detached finally must not restore the loading overlay"
    );
    assert.deepEqual(observed.postBody, {
      name: createdProject.name,
      description: "",
      type: "ETC"
    });
    assert.equal(observed.organizationPosts, 1);
    assert.deepEqual([...observed.unknownRequests], []);
    return {
      finalPath: new URL(page.url()).pathname,
      overviewAborts: replacementProbe.aborts,
      overviewCalls: replacementProbe.calls,
      postMutationOverviewGets: observed.postMutationOverviewGets
    };
  } finally {
    await page.close();
  }
}

async function runRetrySupersededByMutationScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const { stalledRequestStarted } = await installBackgroundPollProbe(page);
  const observed = {
    organizationPosts: 0,
    pollFailures: 0,
    recoveryOverviewGets: 0,
    unknownRequests: new Set()
  };
  let organizationCommitted = false;
  let failNextOverview = false;

  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;

      if (method === "GET" && pathname === "/api/dashboard/overview") {
        if (failNextOverview) {
          failNextOverview = false;
          observed.pollFailures += 1;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              success: false,
              data: null,
              message: "Temporary overview failure"
            })
          });
          return;
        }

        if (organizationCommitted) {
          observed.recoveryOverviewGets += 1;
        }
        await fulfillJson(
          route,
          organizationCommitted
            ? createDashboardOverview({
                organizations: [baselineProject, createdProject],
                evaluationTargets: [baselineTarget],
                evaluationRequests: [pendingRequest]
              })
            : baselineOverview
        );
        return;
      }

      if (method === "GET" && pathname === `/api/requests/${pendingRequest.id}`) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            data: null,
            message: "Temporary request-status failure"
          })
        });
        return;
      }

      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        organizationCommitted = true;
        await fulfillJson(route, createdProject, { status: 201 });
        return;
      }

      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("complementary")
      .getByRole("button", { name: baselineProject.name, exact: true })
      .waitFor();
    failNextOverview = true;
    const retryAlert = page.getByRole("alert").filter({ hasText: "Temporary overview failure" });
    await retryAlert.waitFor({ timeout: 8_000 });
    await page.evaluate(() => {
      window.__dashboardOverviewLoadProbe.stallNext = true;
    });
    await retryAlert.getByRole("button", { name: "다시 시도", exact: true }).click();
    await stalledRequestStarted;

    const addProjectButton = page
      .getByRole("complementary")
      .getByRole("button", { name: "프로젝트 추가", exact: true });
    await addProjectButton.click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();

    await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 10_000 });
    await page.evaluate(() => window.__dashboardOverviewLoadProbe.releaseStale());
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      window.history.pushState({}, "", "/analyze");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.waitForURL("**/analyze");
    await page.locator("#quick-analyze-url").waitFor();

    assert.equal(
      await page.getByText("대시보드 데이터를 불러오는 중...", { exact: true }).count(),
      0,
      "a mutation that supersedes a retry must release the inherited loading owner"
    );
    assert.equal(
      await page
        .getByRole("complementary")
        .getByRole("button", { name: createdProject.name, exact: true })
        .count(),
      1
    );
    assert.equal(observed.organizationPosts, 1);
    assert.equal(observed.pollFailures, 1);
    assert.ok(observed.recoveryOverviewGets >= 1);
    assert.deepEqual([...observed.unknownRequests], []);
    return {
      finalPath: new URL(page.url()).pathname,
      organizationPosts: observed.organizationPosts,
      pollFailures: observed.pollFailures,
      recoveryOverviewGets: observed.recoveryOverviewGets
    };
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          scenario: "retry-superseded-by-mutation",
          url: page.url(),
          observed: {
            organizationPosts: observed.organizationPosts,
            pollFailures: observed.pollFailures,
            recoveryOverviewGets: observed.recoveryOverviewGets,
            unknownRequests: [...observed.unknownRequests]
          },
          probe: await readOverviewProbe(page),
          alerts: await page.getByRole("alert").allInnerTexts(),
          dialogs: await page.getByRole("dialog").allInnerTexts()
        },
        null,
        2
      )
    );
    throw error;
  } finally {
    await page.close();
  }
}

async function runTimeoutRetryScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const { stalledRequestStarted } = await installBootstrapStallProbe(page);
  const startedAt = performance.now();
  let recoveryOverviewGets = 0;

  try {
    await page.route("**/api/dashboard/overview", async (route) => {
      recoveryOverviewGets += 1;
      await fulfillJson(route, baselineOverview);
    });
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
    await stalledRequestStarted;
    const timeoutAlert = page.getByRole("alert").filter({
      hasText: DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE
    });
    await timeoutAlert.waitFor({ timeout: 5_000 });
    const elapsedMs = performance.now() - startedAt;
    const timeoutProbe = await readOverviewProbe(page);
    assert.ok(elapsedMs >= ACCELERATED_DASHBOARD_OVERVIEW_TIMEOUT_MS - 100);
    assert.ok(
      timeoutProbe.scheduledTimeouts.includes(DASHBOARD_OVERVIEW_TIMEOUT_MS),
      "the dashboard load must register the production 15-second deadline"
    );
    assert.equal(
      await page.getByText("분석 화면을 불러오는 중...", { exact: true }).count(),
      0,
      "the boot overlay must end when the overview deadline expires"
    );
    const retryButton = timeoutAlert.getByRole("button", { name: "다시 시도", exact: true });
    await retryButton.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("complementary")
      .getByRole("button", { name: baselineProject.name, exact: true })
      .waitFor();
    await timeoutAlert.waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.id === "dashboard-main-content"
    );
    const probe = await readOverviewProbe(page);
    assert.equal(probe.calls, 3);
    assert.equal(probe.aborts, 2);
    assert.equal(recoveryOverviewGets, 1);
    return {
      elapsedMs: Math.round(elapsedMs),
      focusAfterRetry: await page.evaluate(() => document.activeElement?.id),
      recoveryOverviewGets,
      ...probe
    };
  } finally {
    await page.close();
  }
}

async function runUnmountScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const { stalledRequestStarted } = await installBootstrapStallProbe(page);
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  try {
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
    await stalledRequestStarted;
    await page.evaluate(() => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.locator("[data-dashboard-app-shell]").waitFor({ state: "detached" });
    await page.locator(".ua-hero__headline").waitFor();
    const probe = await readOverviewProbe(page);
    assert.equal(probe.calls, 2);
    assert.equal(probe.aborts, 2);
    assert.equal(
      await page.getByText(DASHBOARD_OVERVIEW_TIMEOUT_MESSAGE, { exact: true }).count(),
      0,
      "an unmount abort must not surface as an overview timeout"
    );
    assert.deepEqual(consoleErrors, []);
    return probe;
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const replacement = await runMutationReplacementScenario(browser);
  const retrySupersededByMutation = await runRetrySupersededByMutationScenario(browser);
  const timeoutRetry = await runTimeoutRetryScenario(browser);
  const unmount = await runUnmountScenario(browser);
  console.log(
    JSON.stringify(
      { result: "PASS", replacement, retrySupersededByMutation, timeoutRetry, unmount },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
