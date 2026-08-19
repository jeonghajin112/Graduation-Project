/**
 * Regression check: a CRUD refresh queued behind an in-flight dashboard poll
 * must fetch fresh directory data before navigating to the created project.
 *
 * The delayed organization response models a poll that started before the
 * mutation. Releasing it after the POST exercises both the UI refresh queue
 * and the directory-cache generation guard.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-dashboard-mutation-refresh.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const timestamp = "2026-08-10T10:00:00.000Z";
const project = {
  id: 77,
  name: "Polling-safe project",
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

const pollStarted = createDeferred();
const releaseStalePoll = createDeferred();
const stalePollSettled = createDeferred();
const observed = {
  blockNextOrganizationGet: false,
  organizationGets: 0,
  freshOrganizationGets: 0,
  postBody: null,
  unknownRequests: new Set()
};

let organizations = [];
let stalePollReleased = false;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === "GET" && pathname === "/api/requests") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (method === "GET" && pathname === "/api/organizations") {
      observed.organizationGets += 1;

      if (observed.blockNextOrganizationGet) {
        observed.blockNextOrganizationGet = false;
        const stalePayload = JSON.stringify(organizations);
        pollStarted.resolve();

        try {
          await releaseStalePoll.promise;
          stalePollReleased = true;
          await route.fulfill({ status: 200, contentType: "application/json", body: stalePayload });
        } finally {
          stalePollSettled.resolve();
        }
        return;
      }

      if (organizations.length > 0) {
        observed.freshOrganizationGets += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(organizations)
      });
      return;
    }

    if (method === "GET" && pathname === `/api/organizations/${project.id}/evaluation-targets`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (method === "POST" && pathname === "/api/organizations") {
      observed.postBody = JSON.parse(request.postData() ?? "null");
      organizations = [project];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(project)
      });
      return;
    }

    observed.unknownRequests.add(`${method} ${pathname}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  const addProjectButton = page
    .locator("aside")
    .getByRole("button", { name: "프로젝트 추가", exact: true });
  await addProjectButton.waitFor();

  // Expire the 15-second directory cache without changing the real 5-second
  // interval. The next poll must therefore issue the GET that we delay below.
  await page.evaluate(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 20_000;
  });
  observed.blockNextOrganizationGet = true;

  await addProjectButton.click();
  const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
  await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(project.name);

  await withTimeout(pollStarted.promise, 8_000, "dashboard poll");

  const postResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/organizations"
  );
  await dialog.getByRole("button", { name: "생성", exact: true }).click();
  const postResponse = await withTimeout(postResponsePromise, 5_000, "organization POST");
  await postResponse.finished();
  assert.equal(postResponse.status(), 201);

  // Let the fetch continuation invalidate the cache and enter the queued
  // refresh before the older directory response is allowed to complete.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );

  releaseStalePoll.resolve();
  await withTimeout(stalePollSettled.promise, 5_000, "stale poll response");

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
  assert.equal(stalePollReleased, true);
  assert.ok(
    observed.freshOrganizationGets >= 1,
    "expected a fresh organization GET after the mutation"
  );
  assert.deepEqual([...observed.unknownRequests], []);

  // A transient success is not enough: the stale dashboard state used to
  // redirect this route back to /analyze on the following React effect.
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
        freshOrganizationGets: observed.freshOrganizationGets,
        stalePollReleased
      },
      null,
      2
    )
  );
} finally {
  releaseStalePoll.resolve();
  await browser.close();
}
