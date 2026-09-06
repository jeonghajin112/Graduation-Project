/**
 * Regression check: when organization creation succeeds but the following
 * directory refresh fails, closing/reopening the modal and retrying must issue
 * only a GET. The organization POST must never be repeated.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-08-10T10:00:00.000Z";
const project = {
  id: 77,
  name: "Refresh recovery project",
  type: "ETC",
  homepageUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

const firstRefreshMissedProject = createDeferred();
const observed = {
  organizationGets: 0,
  organizationPosts: 0,
  postBody: null,
  idempotencyKey: null,
  postMutationOrganizationGets: 0,
  successfulRecoveryGets: 0,
  unknownRequests: new Set()
};

let organizations = [];
let organizationCommitted = false;
let allowRecovery = false;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/dashboard/overview") {
      observed.organizationGets += 1;

      if (organizationCommitted && !allowRecovery) {
        observed.postMutationOrganizationGets += 1;
        await fulfillJson(route, createDashboardOverview());
        firstRefreshMissedProject.resolve();
        return;
      }

      if (organizationCommitted) {
        observed.successfulRecoveryGets += 1;
      }
      await fulfillJson(route, createDashboardOverview({ organizations }));
      return;
    }

    if (method === "POST" && pathname === "/api/organizations") {
      observed.organizationPosts += 1;
      observed.postBody = JSON.parse(request.postData() ?? "null");
      observed.idempotencyKey = request.headers()["idempotency-key"];
      organizations = [project];
      organizationCommitted = true;
      await fulfillJson(route, project, { status: 201 });
      return;
    }

    observed.unknownRequests.add(`${method} ${pathname}`);
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  const addProjectButton = page
    .locator("aside")
    .getByRole("button", { name: "프로젝트 추가", exact: true });
  await addProjectButton.waitFor();
  await addProjectButton.click();

  let dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
  await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(project.name);

  const postResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/organizations"
  );
  await dialog.getByRole("button", { name: "생성", exact: true }).click();
  const postResponse = await withTimeout(postResponsePromise, 5_000, "organization POST");
  await postResponse.finished();
  await withTimeout(firstRefreshMissedProject.promise, 5_000, "organization refresh without project");

  assert.equal(postResponse.status(), 201);
  await dialog.getByRole("alert").filter({ hasText: "프로젝트는 생성되었지만" }).waitFor();
  await dialog
    .getByRole("button", { name: "프로젝트 다시 시도", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, "/analyze");
  assert.equal(observed.organizationPosts, 1);
  assert.match(observed.idempotencyKey ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(await dialog.getByRole("button", { name: "생성", exact: true }).count(), 0);

  // Closing the modal is not a rollback. Reopening it must keep the saved ID
  // checkpoint so the user cannot accidentally submit the POST again.
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await addProjectButton.click();
  dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
  await dialog.getByRole("alert").filter({ hasText: "프로젝트는 생성되었지만" }).waitFor();
  assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).inputValue(), project.name);
  assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).isDisabled(), true);
  assert.equal(observed.organizationPosts, 1);
  assert.equal(await dialog.getByRole("button", { name: "생성", exact: true }).count(), 0);

  const organizationGetsBeforeRetry = observed.organizationGets;
  allowRecovery = true;
  const recoveryRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "GET" && new URL(request.url()).pathname === "/api/dashboard/overview"
  );
  await dialog
    .getByRole("button", { name: "프로젝트 다시 시도", exact: true })
    .click();
  await withTimeout(recoveryRequestPromise, 5_000, "organization recovery GET");

  await page.waitForURL(`**/projects/${project.id}`, { timeout: 10_000 });
  await page.getByRole("heading", { level: 1, name: project.name, exact: true }).waitFor();
  await page
    .locator("#dashboard-main-content .dashboard-project-content")
    .getByText("등록된 페이지가 없습니다.", { exact: true })
    .waitFor();

  assert.deepEqual(observed.postBody, {
    name: project.name,
    description: "",
    type: "ETC"
  });
  assert.equal(observed.organizationPosts, 1);
  assert.ok(observed.organizationGets > organizationGetsBeforeRetry);
  assert.ok(observed.postMutationOrganizationGets >= 1);
  assert.ok(observed.successfulRecoveryGets >= 1);
  assert.deepEqual([...observed.unknownRequests], []);

  await page.waitForTimeout(750);
  assert.equal(new URL(page.url()).pathname, `/projects/${project.id}`);
  assert.equal(
    await page
      .locator("aside")
      .getByRole("button", { name: project.name, exact: true })
      .getAttribute("aria-current"),
    "page"
  );

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        finalPath: new URL(page.url()).pathname,
        organizationGets: observed.organizationGets,
        organizationPosts: observed.organizationPosts,
        postMutationOrganizationGets: observed.postMutationOrganizationGets,
        successfulRecoveryGets: observed.successfulRecoveryGets
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
