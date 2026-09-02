/**
 * Regression check: once a target is created, failures in request creation or
 * request polling must resume from that stage instead of creating a duplicate
 * target (or a duplicate in-flight request).
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const storageKey = "accessibility-dashboard.site-create-attempt.v1";
const timestamp = "2026-08-10T10:00:00.000Z";

const organization = {
  id: 1,
  name: "Partial success project",
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
  name: "Retry-safe page",
  targetType: "WEB",
  accessUrl: "https://example.com/retry-safe",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const inactiveTarget = {
  ...target,
  id: 100,
  status: "INACTIVE"
};

const lateInactiveTarget = {
  ...target,
  id: 102,
  status: "INACTIVE"
};

const pendingRequest = {
  id: 501,
  evaluationTargetId: target.id,
  targetName: target.name,
  status: "PENDING",
  requestNote: "retry regression",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};

const terminalPendingRequest = {
  ...pendingRequest,
  id: 500,
  requestNote: "terminal failure regression"
};

const terminalFailedRequest = {
  ...terminalPendingRequest,
  status: "FAILED",
  updatedAt: "2026-08-10T10:00:01.000Z"
};

const completedRequest = {
  ...pendingRequest,
  status: "COMPLETED",
  updatedAt: "2026-08-10T10:00:05.000Z"
};

const summary = {
  requestId: completedRequest.id,
  targetName: target.name,
  status: "COMPLETED",
  totalScore: 91,
  totalIssueCount: 0,
  criticalIssueCount: 0,
  requestedAt: completedRequest.requestedAt
};

const score = {
  id: 9001,
  evaluationRequestId: completedRequest.id,
  totalScore: 91,
  ruleScore: 90,
  aiScore: 92,
  cvScore: 91,
  createdAt: completedRequest.createdAt,
  updatedAt: completedRequest.updatedAt
};

const observed = {
  events: [],
  targetGets: 0,
  targetStatusGets: 0,
  targetPosts: 0,
  requestPosts: 0,
  terminalFailedStatusGets: 0,
  requestStatusGets: 0,
  targetPostBody: null,
  requestPostBodies: [],
  unknownRequests: new Set()
};

let targets = [inactiveTarget];
let requests = [];
let targetLookupStatus = "ACTIVE";
let releaseSecondRequestResponse = () => {};
const secondRequestResponseGate = new Promise((resolve) => {
  releaseSecondRequestResponse = resolve;
});

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/dashboard/overview") {
      const hasCompletedRequest = requests.some((candidate) => candidate.status === "COMPLETED");
      const overview = createDashboardOverview({
        organizations: [organization],
        evaluationTargets: targets.filter((candidate) => candidate.status === "ACTIVE"),
        evaluationRequests: requests,
        resultSummaries: hasCompletedRequest ? [summary] : [],
        scoreResults: hasCompletedRequest ? [score] : [],
        latestIssueCounts: hasCompletedRequest
          ? [{
              evaluationTargetId: target.id,
              requestId: completedRequest.id,
              totalIssueCount: 0,
              criticalIssueCount: 0,
              highIssueCount: 0,
              mediumIssueCount: 0,
              lowIssueCount: 0,
              groups: []
            }]
          : []
      });
      await fulfillJson(
        route,
        (observed.targetPosts === 1 && observed.requestPosts === 0) ||
          (observed.requestPosts === 3 && observed.requestStatusGets === 0)
          ? { ...overview, organizations: "unrelated malformed overview" }
          : overview
      );
      return;
    }

    if (method === "GET" && pathname === "/api/organizations") {
      await fulfillJson(route, [organization]);
      return;
    }

    if (method === "GET" && pathname === `/api/organizations/${organization.id}/evaluation-targets`) {
      observed.targetGets += 1;
      observed.events.push({ method, pathname, targetIds: targets.map((candidate) => candidate.id) });
      await fulfillJson(route, targets);
      return;
    }

    if (method === "GET" && pathname === "/api/requests") {
      await fulfillJson(route, requests);
      return;
    }

    if (method === "GET" && pathname === `/api/targets/${target.id}`) {
      observed.targetStatusGets += 1;
      await fulfillJson(route, { ...target, status: targetLookupStatus });
      return;
    }

    if (
      method === "POST" &&
      pathname === `/api/organizations/${organization.id}/evaluation-targets`
    ) {
      observed.targetPosts += 1;
      observed.events.push({ method, pathname });
      observed.targetPostBody = JSON.parse(request.postData() ?? "null");
      targets = [inactiveTarget, lateInactiveTarget, target];
      // The target was committed, but the otherwise valid response points to
      // an ID that existed before the POST. The client must reconcile the list
      // instead of attaching analysis to that pre-existing target.
      await fulfillJson(
        route,
        { ...target, id: inactiveTarget.id },
        { status: 201 }
      );
      return;
    }

    if (method === "POST" && pathname === "/api/requests") {
      observed.requestPosts += 1;
      observed.requestPostBodies.push(JSON.parse(request.postData() ?? "null"));

      if (observed.requestPosts === 1) {
        await route.fulfill({
          // A definite rejection permits a deliberate new request. Ambiguous
          // 5xx/timeouts are covered by verify-site-create-guards and must
          // remain GET-only instead.
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ message: "analysis request rejected" })
        });
        return;
      }

      if (observed.requestPosts === 2) {
        requests = [terminalFailedRequest];
        await secondRequestResponseGate;
        await fulfillJson(route, terminalPendingRequest);
        return;
      }

      requests = [terminalFailedRequest, pendingRequest];
      await route.fulfill({
        // The request committed but its response was lost. Recovery must use
        // the targeted request list even while overview is malformed.
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "request response lost after commit" })
      });
      return;
    }

    if (method === "GET" && pathname === `/api/requests/${terminalPendingRequest.id}`) {
      observed.terminalFailedStatusGets += 1;
      await fulfillJson(route, terminalFailedRequest);
      return;
    }

    if (method === "GET" && pathname === `/api/requests/${pendingRequest.id}`) {
      observed.requestStatusGets += 1;

      if (observed.requestStatusGets === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "status temporarily unavailable" })
        });
        return;
      }

      requests = [terminalFailedRequest, completedRequest];
      await fulfillJson(route, completedRequest);
      return;
    }

    if (method === "GET" && pathname === `/api/results/requests/${completedRequest.id}/summary`) {
      await fulfillJson(route, summary);
      return;
    }

    if (method === "GET" && pathname === `/api/results/requests/${completedRequest.id}/issues`) {
      await fulfillJson(route, []);
      return;
    }

    if (method === "GET" && pathname === `/api/scores/requests/${completedRequest.id}`) {
      await fulfillJson(route, score);
      return;
    }

    const requestLabel = `${method} ${pathname}`;
    observed.unknownRequests.add(requestLabel);
    await fulfillJson(
      route,
      { requestLabel },
      { status: 500 }
    );
  });

  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
  await dialog.getByLabel("페이지 이름", { exact: true }).evaluate((input) => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    valueSetter?.call(input, "가".repeat(101));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dialog.getByLabel("페이지 주소", { exact: true }).fill(target.accessUrl);
  await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "페이지 이름은 100자 이하" })
    .waitFor();
  assert.equal(observed.targetPosts, 0, "oversized names must be rejected before POST");

  await dialog.getByLabel("페이지 이름", { exact: true }).fill(target.name);
  await dialog.getByLabel("페이지 주소", { exact: true }).fill("javascript:alert(document.domain)");
  await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "올바른 페이지 주소를 입력해주세요" })
    .waitFor();
  assert.equal(observed.targetPosts, 0, "unsafe URL schemes must be rejected before POST");

  await dialog.getByLabel("페이지 주소", { exact: true }).fill(target.accessUrl);
  await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();

  await dialog.getByText(/페이지 등록 완료 · 분석 시작 전/).waitFor();
  await dialog.getByText("분석을 시작할 수 있습니다", { exact: true }).waitFor();
  const requestRetryButton = dialog.getByRole("button", {
    name: "분석 시작",
    exact: true
  });
  await requestRetryButton.waitFor();

  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 1);
  const targetPostEventIndex = observed.events.findIndex((event) => event.method === "POST");
  assert.ok(targetPostEventIndex > 0, "target creation must read the targeted baseline before POST");
  assert.deepEqual(
    observed.events[targetPostEventIndex - 1],
    {
      method: "GET",
      pathname: `/api/organizations/${organization.id}/evaluation-targets`,
      targetIds: [inactiveTarget.id]
    },
    "the pre-POST baseline must include existing inactive targets omitted from overview"
  );

  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await dialog.waitFor();
  await requestRetryButton.waitFor();

  // Closing and reopening the modal must preserve the partial-success
  // checkpoint instead of returning to target creation.
  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 1);

  targetLookupStatus = "INACTIVE";
  await requestRetryButton.click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "등록된 페이지가 현재 목록과 일치하지 않아" })
    .waitFor();
  assert.equal(
    observed.requestPosts,
    1,
    "an inactive recovered target must be rejected before another analysis POST"
  );

  targetLookupStatus = "ACTIVE";
  await page.setViewportSize({ width: 580, height: 560 });
  await requestRetryButton.click();
  await dialog.getByText("분석 진행 중", { exact: true }).waitFor();
  assert.equal(
    await dialog.locator("[data-site-create-footer]").count(),
    0,
    "active analysis must not render the modal footer"
  );
  assert.equal(
    await dialog.getByText("분석 중에는 창을 닫을 수 없습니다.", { exact: true }).count(),
    0,
    "active analysis must not render the close restriction copy"
  );
  assert.equal(
    await dialog.getByRole("button", { name: "자동 닫힘", exact: true }).count(),
    0,
    "active analysis must not render an auto-close button"
  );
  releaseSecondRequestResponse();
  const terminalFailureAlert = dialog
    .getByRole("alert")
    .filter({ hasText: "페이지 검사를 완료하지 못했습니다" });
  await terminalFailureAlert.waitFor();
  await dialog.getByText("분석을 완료하지 못했습니다", { exact: true }).waitFor();
  assert.match(await terminalFailureAlert.innerText(), /페이지 등록 완료 · 분석 실패/);
  assert.equal(
    await dialog
      .getByText(
        "페이지 검사를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요. 같은 문제가 계속되면 관리자에게 문의해 주세요.",
        { exact: false }
      )
      .count(),
    1,
    "terminal failure details must be rendered in only one announcement region"
  );

  const terminalFailureText = await terminalFailureAlert.innerText();
  assert.match(
    terminalFailureText,
    /잠시 후 다시 시도해 주세요\. 같은 문제가 계속되면 관리자에게 문의해 주세요\./
  );
  assert.doesNotMatch(
    terminalFailureText,
    /자동 접속|차단|리다이렉트|FAILED|HTTP|\/(?:api|requests|targets)\//,
    "terminal analysis failures must not expose speculative causes or implementation details"
  );

  const failureLayout = await dialog.evaluate((element) => {
    const scrollRegion = element.querySelector("[data-site-create-scroll-region]");
    const footer = element.querySelector("[data-site-create-footer]");
    const title = element.querySelector("#site-create-title");
    if (
      !(scrollRegion instanceof HTMLElement) ||
      !(footer instanceof HTMLElement) ||
      !(title instanceof HTMLElement)
    ) {
      throw new Error("site-create modal regions are missing");
    }
    const dialogRect = element.getBoundingClientRect();
    const footerRectBefore = footer.getBoundingClientRect();
    const titleRectBefore = title.getBoundingClientRect();
    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    const footerRectAfter = footer.getBoundingClientRect();
    const titleRectAfter = title.getBoundingClientRect();
    return {
      dialogBottom: dialogRect.bottom,
      dialogOverflowY: getComputedStyle(element).overflowY,
      dialogTop: dialogRect.top,
      footerBottom: footerRectAfter.bottom,
      footerTopDelta: footerRectAfter.top - footerRectBefore.top,
      scrollClientHeight: scrollRegion.clientHeight,
      scrollHeight: scrollRegion.scrollHeight,
      scrollOverflowY: getComputedStyle(scrollRegion).overflowY,
      titleTopDelta: titleRectAfter.top - titleRectBefore.top
    };
  });
  assert.equal(failureLayout.dialogOverflowY, "hidden");
  assert.equal(failureLayout.scrollOverflowY, "auto");
  assert.ok(
    failureLayout.scrollHeight > failureLayout.scrollClientHeight,
    "the compact failure state must scroll only its content region"
  );
  assert.ok(failureLayout.dialogTop >= 0 && failureLayout.dialogBottom <= 560);
  assert.ok(failureLayout.footerBottom <= failureLayout.dialogBottom + 1);
  assert.ok(Math.abs(failureLayout.footerTopDelta) < 1, "footer must stay fixed while content scrolls");
  assert.ok(Math.abs(failureLayout.titleTopDelta) < 1, "title must stay fixed while content scrolls");

  const scrollRegion = dialog.locator("[data-site-create-scroll-region]");
  await scrollRegion.evaluate((element) => {
    element.scrollTop = 0;
  });
  await scrollRegion.focus();
  await page.keyboard.press("PageDown");
  await page.waitForFunction(
    () => (document.querySelector("[data-site-create-scroll-region]")?.scrollTop ?? 0) > 0
  );

  await page.setViewportSize({ width: 320, height: 568 });
  const narrowFailureLayout = await dialog.evaluate((element) => {
    const footer = element.querySelector("[data-site-create-footer]");
    if (!(footer instanceof HTMLElement)) {
      throw new Error("site-create modal footer is missing");
    }
    const dialogRect = element.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const buttonRects = Array.from(footer.querySelectorAll("button")).map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return {
      buttonRects,
      dialogBottom: dialogRect.bottom,
      dialogLeft: dialogRect.left,
      dialogRight: dialogRect.right,
      dialogTop: dialogRect.top,
      footerBottom: footerRect.bottom,
      footerLeft: footerRect.left,
      footerRight: footerRect.right,
      footerScrollWidth: footer.scrollWidth,
      footerWidth: footer.clientWidth
    };
  });
  assert.ok(narrowFailureLayout.dialogTop >= 0 && narrowFailureLayout.dialogBottom <= 568);
  assert.ok(narrowFailureLayout.footerBottom <= narrowFailureLayout.dialogBottom + 1);
  assert.ok(
    narrowFailureLayout.footerScrollWidth <= narrowFailureLayout.footerWidth,
    "the compact footer must not overflow horizontally"
  );
  for (const buttonRect of narrowFailureLayout.buttonRects) {
    assert.ok(buttonRect.left >= narrowFailureLayout.footerLeft - 1);
    assert.ok(buttonRect.right <= narrowFailureLayout.footerRight + 1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  const failedRecovery = await page.evaluate((key) => {
    const rawValue = window.sessionStorage.getItem(key);
    return rawValue === null ? null : JSON.parse(rawValue);
  }, storageKey);
  assert.ok(failedRecovery, "a terminal failure must leave a retry checkpoint");
  assert.equal(failedRecovery.phase, "request-ready");
  assert.equal(failedRecovery.targetId, target.id);
  assert.equal(failedRecovery.previousFailedRequestId, terminalPendingRequest.id);
  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 2);
  assert.equal(observed.targetStatusGets, 3);
  assert.equal(observed.terminalFailedStatusGets, 1);
  assert.equal(observed.requestStatusGets, 0);

  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await dialog.waitFor();
  const terminalRetryButton = dialog.getByRole("button", {
    name: "분석 요청 다시 시도",
    exact: true
  });
  await terminalRetryButton.waitFor();
  await page.waitForTimeout(250);
  assert.equal(
    observed.requestPosts,
    2,
    "restoring a terminal-failure checkpoint must not automatically create another request"
  );

  await page.setViewportSize({ width: 320, height: 568 });
  const retryScrollRegion = dialog.locator("[data-site-create-scroll-region]");
  const retryScrollMaximum = await retryScrollRegion.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollHeight - element.clientHeight;
  });
  assert.ok(retryScrollMaximum > 0, "the compact retry state must provide scrollable content");
  await terminalRetryButton.click();
  const pollRetryButton = dialog.getByRole("button", {
    name: "상태 확인 다시 시도",
    exact: true
  });
  await pollRetryButton.waitFor();

  const statusCheckAlert = dialog
    .getByRole("alert")
    .filter({ hasText: "페이지 등록 완료 · 상태 확인 필요" });
  await statusCheckAlert.waitFor();
  const statusAlertVisibility = await statusCheckAlert.evaluate((alert) => {
    const scrollRegion = alert.closest("[data-site-create-scroll-region]");
    if (!(scrollRegion instanceof HTMLElement)) {
      throw new Error("status alert is outside the site-create scroll region");
    }
    const alertRect = alert.getBoundingClientRect();
    const scrollRect = scrollRegion.getBoundingClientRect();
    return {
      alertBottom: alertRect.bottom,
      alertTop: alertRect.top,
      scrollBottom: scrollRect.bottom,
      scrollTop: scrollRect.top,
      scrollPosition: scrollRegion.scrollTop
    };
  });
  assert.equal(statusAlertVisibility.scrollPosition, 0, "new errors must reset content to the top");
  assert.ok(statusAlertVisibility.alertTop >= statusAlertVisibility.scrollTop - 1);
  assert.ok(statusAlertVisibility.alertBottom <= statusAlertVisibility.scrollBottom + 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByText("분석 상태를 다시 확인해 주세요", { exact: true }).waitFor();
  assert.doesNotMatch(
    await statusCheckAlert.innerText(),
    /분석 실패|분석을 완료하지 못했습니다/,
    "a temporary status lookup failure must not be presented as a terminal analysis failure"
  );
  assert.equal(
    await dialog
      .getByText("서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.", {
        exact: false
      })
      .count(),
    1,
    "status lookup error details must be rendered in only one announcement region"
  );

  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 3);
  assert.equal(observed.targetStatusGets, 4);
  assert.equal(observed.terminalFailedStatusGets, 1);
  assert.equal(observed.requestStatusGets, 1);

  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await dialog.waitFor();
  await statusCheckAlert.waitFor();
  await dialog.getByText("분석 상태를 다시 확인해 주세요", { exact: true }).waitFor();
  assert.equal(observed.requestPosts, 3);
  assert.equal(
    observed.requestStatusGets,
    1,
    "restoring an in-progress request must wait for an explicit status-check retry"
  );

  await pollRetryButton.click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 3);
  assert.equal(observed.requestStatusGets, 2);
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
  assert.deepEqual(observed.targetPostBody, {
    name: target.name,
    accessUrl: target.accessUrl
  });
  assert.ok(
    observed.requestPostBodies.every((body) => body?.evaluationTargetId === target.id),
    "every analysis request must reuse the created target"
  );
  const createdTargetDetailButton = page.getByRole("button", {
    name: `${target.name} 상세 보기`,
    exact: true
  });
  await createdTargetDetailButton.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await createdTargetDetailButton.count(), 1);
  assert.equal(new URL(page.url()).pathname, `/projects/${organization.id}`);

  const recoveryBase = {
    version: 1,
    apiScope: "/api",
    projectId: organization.id,
    name: target.name,
    accessUrl: target.accessUrl,
    previousTargetIds: [inactiveTarget.id, lateInactiveTarget.id],
    startedAt: Date.now(),
    targetId: target.id
  };
  await page.evaluate(
    ({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)),
    {
      key: storageKey,
      value: {
        ...recoveryBase,
        attemptId: "request-ready-not-started",
        phase: "request-ready",
        previousFailedRequestId: null
      }
    }
  );
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await dialog.waitFor();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "페이지 등록 완료 · 분석 시작 전" })
    .waitFor();
  await dialog.getByText("분석을 시작할 수 있습니다", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "분석 시작", exact: true }).waitFor();
  assert.equal(await dialog.getByText("분석 실패", { exact: false }).count(), 0);
  assert.equal(observed.requestPosts, 3, "request-ready recovery must not auto-submit analysis");
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  await page.evaluate(
    ({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)),
    {
      key: storageKey,
      value: {
        ...recoveryBase,
        attemptId: "stale-request-ready",
        phase: "request-ready",
        previousFailedRequestId: null,
        startedAt: Date.now() - 24 * 60 * 60 * 1_000 - 1
      }
    }
  );
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "이전 작업 정보 삭제", exact: true }).waitFor();
  const staleFooterLayout = await dialog.locator("[data-site-create-footer]").evaluate((footer) => {
    const footerRect = footer.getBoundingClientRect();
    const buttons = Array.from(footer.querySelectorAll("button")).map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return {
      buttons,
      buttonCount: buttons.length,
      footerLeft: footerRect.left,
      footerRight: footerRect.right,
      scrollWidth: footer.scrollWidth,
      width: footer.clientWidth
    };
  });
  assert.equal(staleFooterLayout.buttonCount, 3, "stale recovery must expose all three actions");
  assert.ok(
    staleFooterLayout.scrollWidth <= staleFooterLayout.width,
    "the three-action compact footer must not overflow"
  );
  for (const buttonRect of staleFooterLayout.buttons) {
    assert.ok(buttonRect.left >= staleFooterLayout.footerLeft - 1);
    assert.ok(buttonRect.right <= staleFooterLayout.footerRight + 1);
  }
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.evaluate(
    ({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)),
    {
      key: storageKey,
      value: {
        ...recoveryBase,
        attemptId: "request-post-outcome-unknown",
        phase: "request-reconciling",
        knownRequestIds: [terminalPendingRequest.id, pendingRequest.id],
        previousFailedRequestId: null
      }
    }
  );
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await dialog.waitFor();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "페이지 등록 완료 · 상태 확인 필요" })
    .waitFor();
  await dialog.getByText("분석 상태를 다시 확인해 주세요", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "분석 시작 여부 확인", exact: true }).waitFor();
  assert.equal(await dialog.getByText("분석 실패", { exact: false }).count(), 0);
  assert.equal(
    observed.requestPosts,
    3,
    "request-reconciling recovery must remain GET-only until explicit confirmation"
  );
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.evaluate((key) => sessionStorage.removeItem(key), storageKey);
  assert.deepEqual([...observed.unknownRequests], []);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        targetGets: observed.targetGets,
        targetStatusGets: observed.targetStatusGets,
        targetPosts: observed.targetPosts,
        requestPosts: observed.requestPosts,
        terminalFailedStatusGets: observed.terminalFailedStatusGets,
        requestStatusGets: observed.requestStatusGets,
        finalPath: new URL(page.url()).pathname
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
