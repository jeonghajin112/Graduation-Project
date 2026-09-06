/**
 * Regression check: once a target is created, failures in request creation or
 * request polling must resume from that stage instead of creating a duplicate
 * target (or a duplicate in-flight request).
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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
  assert.equal(await dialog.getByLabel("페이지 이름", { exact: true }).inputValue(), target.name);
  assert.equal(await dialog.getByLabel("페이지 주소", { exact: true }).isDisabled(), true,
    "the registered target must not be editable while retrying its analysis request");
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
  await requestRetryButton.evaluate(button => { button.click(); button.click(); });
  const busyButton = dialog.getByRole("button", { name: "요청 중…", exact: true });
  await busyButton.waitFor();
  assert.equal(await busyButton.isDisabled(), true, "the pending request must prevent duplicate submission");
  assert.equal(await dialog.getByLabel("페이지 이름", { exact: true }).inputValue(), target.name);
  assert.equal(await dialog.getByLabel("페이지 주소", { exact: true }).inputValue(), target.accessUrl);
  assert.equal(await dialog.getByLabel("페이지 주소", { exact: true }).isDisabled(), true);
  assert.equal(
    await dialog.getByRole("list").count(),
    0,
    "the add-page dialog must not render the removed analysis step list"
  );
  assert.equal(await dialog.getByText("분석 진행 중", { exact: true }).count(), 0);
  assert.equal(await dialog.locator("[data-site-create-footer]").count(), 1,
    "the input form and its actions must remain visible while submitting");
  await mkdir("artifacts/site-create-compact", { recursive: true });
  for (const [name, width, colorScheme] of [["desktop", 1280, "light"], ["dark", 1280, "dark"], ["mobile", 320, "light"]]) {
    await page.setViewportSize({ width, height: 568 });
    await page.emulateMedia({ colorScheme });
    const rect = await dialog.boundingBox();
    assert.ok(rect.height < 360 && rect.x >= 0 && rect.x + rect.width <= width,
      "the pending form must remain compact and fit the viewport");
    await dialog.screenshot({ path: `artifacts/site-create-compact/pending-${name}.png` });
  }
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
  await dialog.waitFor({ state: "hidden" });
  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 2);
  assert.equal(observed.terminalFailedStatusGets, 0, "registration must not wait for terminal status");
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null);

  // Migrate a retry checkpoint left by an older client, then recover an ambiguous POST.
  await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey, value: {
      version: 1, apiScope: "/api", projectId: organization.id, name: target.name,
      accessUrl: target.accessUrl, previousTargetIds: [inactiveTarget.id, lateInactiveTarget.id],
      startedAt: Date.now(), targetId: target.id, attemptId: "legacy-terminal-retry",
      phase: "request-ready", previousFailedRequestId: terminalPendingRequest.id
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await dialog.getByRole("button", { name: "분석 요청 다시 시도", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(observed.targetPosts, 1, "analysis recovery must reuse the original target");
  assert.equal(observed.requestPosts, 3, "lost response must reconcile without a fourth POST");
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), storageKey), null);
  assert.deepEqual(observed.targetPostBody, { name: target.name, accessUrl: target.accessUrl });
  assert.ok(observed.requestPostBodies.every(body => body.evaluationTargetId === target.id));
  assert.equal(new URL(page.url()).pathname, "/projects/" + organization.id);

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
  assert.equal(await dialog.getByLabel("페이지 주소", { exact: true }).inputValue(), target.accessUrl);
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
  await dialog.getByRole("alert").filter({ hasText: "이전 분석 요청이 시작되었는지 확인이 필요합니다" }).waitFor();
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
