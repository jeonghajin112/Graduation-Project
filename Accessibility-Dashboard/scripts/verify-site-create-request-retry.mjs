/**
 * Regression check: once a target is created, failures in request creation or
 * request polling must resume from that stage instead of creating a duplicate
 * target (or a duplicate in-flight request).
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-site-create-request-retry.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
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
  targetPosts: 0,
  requestPosts: 0,
  requestStatusGets: 0,
  targetPostBody: null,
  requestPostBodies: [],
  unknownRequests: new Set()
};

let targets = [];
let requests = [];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/organizations") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([organization])
      });
      return;
    }

    if (method === "GET" && pathname === `/api/organizations/${organization.id}/evaluation-targets`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(targets)
      });
      return;
    }

    if (method === "GET" && pathname === "/api/requests") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(requests)
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === `/api/organizations/${organization.id}/evaluation-targets`
    ) {
      observed.targetPosts += 1;
      observed.targetPostBody = JSON.parse(request.postData() ?? "null");
      targets = [target];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(target)
      });
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

      requests = [pendingRequest];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(pendingRequest)
      });
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

      requests = [completedRequest];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(completedRequest)
      });
      return;
    }

    if (method === "GET" && pathname === `/api/results/requests/${completedRequest.id}/summary`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) });
      return;
    }

    if (method === "GET" && pathname === `/api/results/requests/${completedRequest.id}/issues`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (method === "GET" && pathname === `/api/scores/requests/${completedRequest.id}`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(score) });
      return;
    }

    observed.unknownRequests.add(`${method} ${pathname}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
  await dialog.getByLabel("페이지 이름", { exact: true }).fill(target.name);
  await dialog.getByLabel("페이지 주소", { exact: true }).fill(target.accessUrl);
  await dialog.getByRole("button", { name: "분석 시작", exact: true }).click();

  await dialog.getByText(/페이지 등록 완료 · 분석 실패/).waitFor();
  const requestRetryButton = dialog.getByRole("button", {
    name: "분석 요청 다시 시도",
    exact: true
  });
  await requestRetryButton.waitFor();

  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 1);
  assert.equal(
    await page.getByRole("button", { name: `${target.name} 상세 보기`, exact: true }).count(),
    1
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

  await requestRetryButton.click();
  const pollRetryButton = dialog.getByRole("button", {
    name: "상태 확인 다시 시도",
    exact: true
  });
  await pollRetryButton.waitFor();

  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 2);
  assert.equal(observed.requestStatusGets, 1);

  await pollRetryButton.click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  assert.equal(observed.targetPosts, 1);
  assert.equal(observed.requestPosts, 2);
  assert.equal(observed.requestStatusGets, 2);
  assert.deepEqual(observed.targetPostBody, {
    name: target.name,
    accessUrl: target.accessUrl
  });
  assert.ok(
    observed.requestPostBodies.every((body) => body?.evaluationTargetId === target.id),
    "every analysis request must reuse the created target"
  );
  assert.equal(
    await page.getByRole("button", { name: `${target.name} 상세 보기`, exact: true }).count(),
    1
  );
  assert.equal(new URL(page.url()).pathname, `/projects/${organization.id}`);
  assert.deepEqual([...observed.unknownRequests], []);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        targetPosts: observed.targetPosts,
        requestPosts: observed.requestPosts,
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
