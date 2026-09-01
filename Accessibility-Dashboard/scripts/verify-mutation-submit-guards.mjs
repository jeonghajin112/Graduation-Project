/**
 * Same-task re-entry regressions for sidebar project save/delete and project
 * page delete. Each mutation is held in flight while the DOM button is clicked
 * twice synchronously; exactly one PATCH may reach the API.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-08-11T10:00:00.000Z";

let organization = {
  id: 1,
  name: "Mutation guard project",
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
  name: "Mutation guard page",
  targetType: "WEB",
  accessUrl: "https://example.com/mutation-guard",
  faviconUrl: null,
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

const pageDeleteStarted = createDeferred();
const releasePageDelete = createDeferred();
const projectSaveStarted = createDeferred();
const releaseProjectSave = createDeferred();
const projectDeleteStarted = createDeferred();
const releaseProjectDelete = createDeferred();
const observed = {
  pageDeletePatches: 0,
  projectSavePatches: 0,
  projectDeletePatches: 0,
  unknownRequests: new Set()
};
let organizationActive = true;
let targets = [target];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/dashboard/overview") {
      await fulfillJson(route, createDashboardOverview({
        organizations: organizationActive ? [organization] : [],
        evaluationTargets: organizationActive ? targets : []
      }));
      return;
    }

    if (method === "GET" && pathname === "/api/organizations") {
      await fulfillJson(route, organizationActive ? [organization] : []);
      return;
    }

    if (method === "GET" && pathname === `/api/organizations/${organization.id}/evaluation-targets`) {
      await fulfillJson(route, targets);
      return;
    }

    if (method === "GET" && pathname === "/api/requests") {
      await fulfillJson(route, []);
      return;
    }

    if (method === "PATCH" && pathname === `/api/targets/${target.id}/delete`) {
      observed.pageDeletePatches += 1;
      pageDeleteStarted.resolve();
      await releasePageDelete.promise;
      if (observed.pageDeletePatches === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: {}, message: null })
        });
        return;
      }
      targets = [];
      await fulfillJson(route, null);
      return;
    }

    if (method === "PATCH" && pathname === `/api/organizations/${organization.id}`) {
      observed.projectSavePatches += 1;
      projectSaveStarted.resolve();
      await releaseProjectSave.promise;
      const body = JSON.parse(request.postData() ?? "{}");
      organization = { ...organization, name: body.name, description: body.description, updatedAt: timestamp };
      await fulfillJson(route, organization);
      return;
    }

    if (method === "PATCH" && pathname === `/api/organizations/${organization.id}/deactivate`) {
      observed.projectDeletePatches += 1;
      projectDeleteStarted.resolve();
      await releaseProjectDelete.promise;
      if (observed.projectDeletePatches === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            data: null,
            message: "프로젝트 제거가 거부되었습니다."
          })
        });
        return;
      }
      organizationActive = false;
      await fulfillJson(route, null);
      return;
    }

    observed.unknownRequests.add(`${method} ${pathname}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto(`${baseUrl}/projects/${organization.id}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();

  await page.getByRole("button", { name: `${target.name} 제거`, exact: true }).click();
  const pageDeleteDialog = page.getByRole("dialog", { name: "페이지 제거", exact: true });
  const pageDeleteButton = pageDeleteDialog.getByRole("button", { name: "제거", exact: true });
  await pageDeleteButton.evaluate((button) => {
    button.click();
    button.click();
  });
  await pageDeleteStarted.promise;
  await page.waitForTimeout(50);
  assert.equal(observed.pageDeletePatches, 1, "page delete must issue one PATCH");
  releasePageDelete.resolve();
  const pageDeleteAlert = pageDeleteDialog
    .getByRole("alert")
    .filter({ hasText: "페이지를 제거하지 못했습니다. 잠시 후 다시 시도해 주세요." });
  await pageDeleteAlert.waitFor();
  assert.doesNotMatch(
    await pageDeleteAlert.innerText(),
    /data|success|null|HTTP|PATCH|\/(?:api|targets)\//i,
    "void response contract details must not be exposed to the user"
  );
  assert.equal(await pageDeleteDialog.isVisible(), true);
  await pageDeleteButton.click();
  await pageDeleteDialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(observed.pageDeletePatches, 2, "void contract failure retry must issue one new PATCH");

  const sidebar = page.locator("aside");
  await sidebar.getByRole("button", { name: organization.name, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "수정", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "프로젝트 수정", exact: true });
  const updatedName = "Mutation guard renamed";
  await editDialog.getByLabel("프로젝트 이름", { exact: true }).fill(updatedName);
  const saveButton = editDialog.getByRole("button", { name: "저장", exact: true });
  await saveButton.evaluate((button) => {
    button.click();
    button.click();
  });
  await projectSaveStarted.promise;
  await page.waitForTimeout(50);
  assert.equal(observed.projectSavePatches, 1, "project save must issue one PATCH");
  releaseProjectSave.resolve();
  await editDialog.waitFor({ state: "hidden", timeout: 10_000 });
  await page.getByRole("heading", { level: 1, name: updatedName, exact: true }).waitFor();

  await sidebar.getByRole("button", { name: updatedName, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  const projectDeleteDialog = page.getByRole("dialog", { name: "프로젝트 제거", exact: true });
  const projectDeleteButton = projectDeleteDialog.getByRole("button", { name: "네", exact: true });
  await projectDeleteButton.evaluate((button) => {
    button.click();
    button.click();
  });
  await projectDeleteStarted.promise;
  await page.waitForTimeout(50);
  assert.equal(observed.projectDeletePatches, 1, "project delete must issue one PATCH");
  releaseProjectDelete.resolve();
  const projectDeleteAlert = projectDeleteDialog
    .getByRole("alert")
    .filter({ hasText: "프로젝트를 제거하지 못했습니다. 잠시 후 다시 시도해 주세요." });
  await projectDeleteAlert.waitFor();
  assert.doesNotMatch(
    await projectDeleteAlert.innerText(),
    /거부되었습니다|success|data|null|HTTP|PATCH|\/(?:api|organizations)\//i,
    "server payload and request details must not be exposed to the user"
  );
  assert.equal(new URL(page.url()).pathname, `/projects/${organization.id}`);
  await projectDeleteButton.click();
  await projectDeleteDialog.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForURL("**/analyze", { timeout: 10_000 });
  assert.equal(
    observed.projectDeletePatches,
    2,
    "success:false retry must issue one new PATCH"
  );

  assert.deepEqual([...observed.unknownRequests], []);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        pageDeletePatches: observed.pageDeletePatches,
        projectSavePatches: observed.projectSavePatches,
        projectDeletePatches: observed.projectDeletePatches,
        finalPath: new URL(page.url()).pathname
      },
      null,
      2
    )
  );
} finally {
  releasePageDelete.resolve();
  releaseProjectSave.resolve();
  releaseProjectDelete.resolve();
  await browser.close();
}
