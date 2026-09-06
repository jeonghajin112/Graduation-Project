/**
 * Regression checks for organization-create recovery across a full reload:
 * - an in-flight POST is persisted before fetch and restored without automatic replay;
 * - an explicit retry sends the same idempotency key and creates one resource;
 * - a known project ID is reconciled from a fresh directory without another POST.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const storageKey = "accessibility-dashboard.organization-create-attempt.v1";
const timestamp = "2026-08-11T10:00:00.000Z";

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
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function organization(id, name) {
  return {
    id,
    name,
    type: "ETC",
    homepageUrl: null,
    description: "",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function runScenario(browser, { commitBeforeReload, createdProject, navigation = "reload", testNewRequest = false }) {
  const postStarted = createDeferred();
  const releaseFirstResponse = createDeferred();
  const projectsByKey = new Map();
  const postKeys = [];
  const postBodies = [];
  const unknownRequests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "GET" && pathname === "/api/dashboard/overview") {
        await fulfillJson(route, createDashboardOverview({ organizations: [...projectsByKey.values()] }));
        return;
      }
      if (request.method() === "POST" && pathname === "/api/organizations") {
        const key = request.headers()["idempotency-key"];
        assert.match(key ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        postKeys.push(key);
        postBodies.push(request.postDataJSON());
        if (postKeys.length === 1) {
          if (commitBeforeReload) projectsByKey.set(key, createdProject);
          postStarted.resolve();
          await releaseFirstResponse.promise;
          await fulfillJson(route, createdProject, { status: 201 }).catch(() => {});
          return;
        }
        if (!projectsByKey.has(key)) {
          projectsByKey.set(key, { ...createdProject, id: createdProject.id + projectsByKey.size });
        }
        await fulfillJson(route, projectsByKey.get(key), { status: 201 });
        return;
      }
      unknownRequests.push(`${request.method()} ${pathname}`);
      await fulfillJson(route, null, { status: 500 });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    const addProjectButton = page.getByRole("complementary").getByRole("button", { name: "프로젝트 추가", exact: true });
    await addProjectButton.click();
    let dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(postStarted.promise, 5_000, "organization POST before navigation");
    const savedAttempt = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), storageKey);
    assert.equal(savedAttempt.version, 2);
    assert.equal(savedAttempt.organizationId, null);
    assert.equal(savedAttempt.attemptId, postKeys[0]);
    assert.equal(savedAttempt.apiScope, "/api");
    assert.equal(savedAttempt.name, createdProject.name);

    if (navigation === "reload") {
      await page.reload({ waitUntil: "networkidle" });
    } else {
      await page.evaluate(() => {
        history.pushState({}, "", "/");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.locator("#ua-hero-title").waitFor();
      await page.evaluate(() => {
        history.pushState({}, "", "/analyze");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await addProjectButton.waitFor();
    }
    releaseFirstResponse.resolve();
    await addProjectButton.click();
    dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByRole("alert").filter({ hasText: "프로젝트 생성 결과를 확인하지 못했습니다" }).waitFor();
    assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).inputValue(), createdProject.name);
    assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).isDisabled(), true);
    assert.equal(postKeys.length, 1, "restoring an unknown outcome must not automatically replay a POST");
    assert.deepEqual(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), storageKey), savedAttempt);

    await dialog.getByRole("button", { name: "프로젝트 다시 시도", exact: true }).click();
    await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 5_000 });
    assert.equal(postKeys.length, 2);
    assert.equal(postKeys[1], postKeys[0]);
    assert.deepEqual(postBodies[1], postBodies[0]);
    assert.equal(projectsByKey.size, 1);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);

    if (testNewRequest) {
      await addProjectButton.click();
      dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
      await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
      await dialog.getByRole("button", { name: "생성", exact: true }).click();
      await page.waitForURL(`**/projects/${createdProject.id + 1}`, { timeout: 5_000 });
      assert.equal(postKeys.length, 3);
      assert.notEqual(postKeys[2], postKeys[0], "a deliberate new project must receive a fresh key");
      assert.equal(projectsByKey.size, 2);
    }
    assert.deepEqual(unknownRequests, []);
    return { navigation, commitBeforeReload, posts: postKeys.length, resources: projectsByKey.size, testNewRequest };
  } finally {
    releaseFirstResponse.resolve();
    await page.close();
  }
}

async function runKnownIdRestoreScenario(browser) {
  const createdProject = organization(123, "Known project after reload");
  let organizationPosts = 0;
  let overviewGets = 0;
  const page = await browser.newPage();
  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      if (request.method() === "GET" && new URL(request.url()).pathname === "/api/dashboard/overview") {
        overviewGets += 1;
        await fulfillJson(route, createDashboardOverview({ organizations: [createdProject] }));
        return;
      }
      if (request.method() === "POST") organizationPosts += 1;
      await fulfillJson(route, null, { status: 500 });
    });
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page.evaluate(({ key, project }) => {
      sessionStorage.setItem(key, JSON.stringify({
        version: 2, attemptId: crypto.randomUUID(), apiScope: "/api", name: project.name,
        startedAt: Date.now(), organizationId: project.id
      }));
    }, { key: storageKey, project: createdProject });
    const getsBeforeReload = overviewGets;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction((key) => sessionStorage.getItem(key) === null, storageKey);
    assert.ok(overviewGets > getsBeforeReload);
    assert.equal(organizationPosts, 0);
    await page.getByRole("complementary").getByRole("button", { name: "프로젝트 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).inputValue(), "");
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await page.evaluate((key) => {
      sessionStorage.setItem(key, JSON.stringify({
        version: 2, attemptId: crypto.randomUUID(), apiScope: "/api", name: "Unconfirmed project",
        startedAt: Date.now(), organizationId: null
      }));
    }, storageKey);
    await page.reload({ waitUntil: "networkidle" });
    assert.notEqual(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    await page.locator(".dashboard-account-menu-trigger").click();
    await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
    await page.waitForURL(`${baseUrl}/`);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    assert.equal(organizationPosts, 0);
    return { organizationPosts, freshOverview: true, storageCleared: true, pendingClearedOnLogout: true };
  } finally {
    await page.close();
  }
}
async function runStorageFailureScenario(browser) {
  let organizationPosts = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.addInitScript((key) => {
      const nativeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(storageKey, value) {
        if (storageKey === key) {
          throw new DOMException("Storage quota exceeded.", "QuotaExceededError");
        }
        return nativeSetItem.call(this, storageKey, value);
      };
    }, storageKey);
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (method === "GET" && pathname === "/api/dashboard/overview") {
        await fulfillJson(route, createDashboardOverview());
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        organizationPosts += 1;
        await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    const input = dialog.getByLabel("프로젝트 이름", { exact: true });
    await input.fill("Storage blocked project");
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "브라우저에 이전 작업 상태를 저장하지 못해" })
      .waitFor();

    assert.equal(organizationPosts, 0);
    assert.equal(await input.isEnabled(), true);
    assert.equal(
      await dialog.getByRole("button", { name: "생성", exact: true }).isEnabled(),
      true
    );
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    return { organizationPosts, inputEnabled: await input.isEnabled() };
  } finally {
    await page.close();
  }
}

async function runStaleRecoveryDiscardScenario(browser) {
  let organizationPosts = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (method === "GET" && pathname === "/api/dashboard/overview") {
        await fulfillJson(route, createDashboardOverview());
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        organizationPosts += 1;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page.evaluate(
      ({ key, startedAt }) => {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            version: 2,
            attemptId: crypto.randomUUID(),
            apiScope: "/api",
            organizationId: null,
            name: "Stale recovery project",
            startedAt
          })
        );
      },
      { key: storageKey, startedAt: Date.now() - 25 * 60 * 60 * 1_000 }
    );
    await page.reload({ waitUntil: "networkidle" });
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    const discardButton = dialog.getByRole("button", {
      name: "이전 작업 정보 삭제",
      exact: true
    });
    await discardButton.waitFor();
    page.once("dialog", async (confirmation) => {
      await confirmation.accept();
    });
    await discardButton.click();

    await dialog.getByRole("button", { name: "생성", exact: true }).waitFor();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "프로젝트 이름"
    );
    assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).inputValue(), "");
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    assert.equal(organizationPosts, 0);
    return { organizationPosts, storageCleared: true };
  } finally {
    await page.close();
  }
}

async function runIncompatibleRecoveryDiscardScenario(browser) {
  let organizationPosts = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (method === "GET" && pathname === "/api/dashboard/overview") {
        await fulfillJson(route, createDashboardOverview());
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        organizationPosts += 1;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page.evaluate((key) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          attemptId: crypto.randomUUID(),
          apiScope: "/api",
          phase: "posting",
          name: "Legacy recovery project",
          previousOrganizationIds: [],
          startedAt: Date.now()
        })
      );
    }, storageKey);
    await page.reload({ waitUntil: "networkidle" });
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    const input = dialog.getByLabel("프로젝트 이름", { exact: true });
    assert.equal(await input.isDisabled(), true);
    await dialog
      .getByRole("alert")
      .filter({ hasText: "확인할 수 없는 이전 프로젝트 작업" })
      .waitFor();
    assert.equal(await dialog.getByRole("button", { name: "생성", exact: true }).count(), 0);
    const discardButton = dialog.getByRole("button", { name: "이전 작업 정보 삭제", exact: true });
    const acceptDiscard = async (confirmation) => {
      await confirmation.accept();
    };
    page.on("dialog", acceptDiscard);
    await discardButton.evaluate((button) => {
      button.click();
      button.click();
    });
    page.off("dialog", acceptDiscard);

    await dialog.getByRole("button", { name: "생성", exact: true }).waitFor();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "프로젝트 이름"
    );
    assert.equal(await input.isEnabled(), true);
    assert.equal(await dialog.getByRole("alert").count(), 0);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    assert.equal(organizationPosts, 0);
    return { organizationPosts, storageCleared: true };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const committed = await runScenario(browser, {
    commitBeforeReload: true,
    createdProject: organization(121, "Reload committed project")
  });
  const uncommitted = await runScenario(browser, {
    commitBeforeReload: false,
    createdProject: organization(122, "Reload uncommitted project"),
    testNewRequest: true
  });
  const storageFailure = await runStorageFailureScenario(browser);
  const sameDocumentRestore = await runScenario(browser, { commitBeforeReload: true, createdProject: organization(124, "Same document project"), navigation: "spa" });
  const knownIdRestore = await runKnownIdRestoreScenario(browser);
  const staleRecoveryDiscard = await runStaleRecoveryDiscardScenario(browser);
  const incompatibleRecoveryDiscard = await runIncompatibleRecoveryDiscardScenario(browser);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        committed,
        uncommitted,
        storageFailure,
        sameDocumentRestore,
        knownIdRestore,
        staleRecoveryDiscard,
        incompatibleRecoveryDiscard
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
