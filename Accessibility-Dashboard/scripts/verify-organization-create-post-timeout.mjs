/**
 * Regression checks for an organization POST that never settles:
 * - the real fetch is aborted after the client deadline;
 * - an ambiguous outcome retries with the original idempotency key;
 * - the server returns one resource whether the initial request committed or not.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-08-11T10:00:00.000Z";
const createTimeoutMs = 15_000;

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

async function runScenario(browser, { commitBeforeResponse, createdProject }) {
  const postStarted = createDeferred();
  const releaseFirstResponse = createDeferred();
  const projectsByKey = new Map();
  const postKeys = [];
  const postBodies = [];
  const unknownRequests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__organizationPostAborts = 0;
      window.fetch = (input, init) => {
        const rawUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        if (new URL(rawUrl, location.origin).pathname === "/api/organizations" && init?.method === "POST") {
          init.signal?.addEventListener("abort", () => { window.__organizationPostAborts += 1; }, { once: true });
        }
        return nativeFetch(input, init);
      };
    });
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
          if (commitBeforeResponse) projectsByKey.set(key, createdProject);
          postStarted.resolve();
          await releaseFirstResponse.promise;
          await fulfillJson(route, createdProject, { status: 201 }).catch(() => {});
          return;
        }
        if (!projectsByKey.has(key)) projectsByKey.set(key, createdProject);
        await fulfillJson(route, projectsByKey.get(key), { status: 201 });
        return;
      }
      unknownRequests.push(`${request.method()} ${pathname}`);
      await fulfillJson(route, null, { status: 500 });
    });

    await page.clock.install();
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page.getByRole("complementary").getByRole("button", { name: "프로젝트 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(postStarted.promise, 5_000, "organization POST start");
    await page.clock.runFor(createTimeoutMs + 1);
    await dialog.getByRole("alert").filter({ hasText: "프로젝트 생성 결과를 확인하지 못했습니다" }).waitFor();
    assert.equal(postKeys.length, 1);
    assert.equal(await page.evaluate(() => window.__organizationPostAborts), 1);
    assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "닫기", exact: true }).isEnabled(), true);

    await dialog.getByRole("button", { name: "프로젝트 다시 시도", exact: true }).click();
    await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 5_000 });
    await page.getByRole("heading", { level: 1, name: createdProject.name, exact: true }).waitFor();
    assert.equal(postKeys.length, 2);
    assert.equal(postKeys[1], postKeys[0], "an ambiguous POST must retry its original key");
    assert.deepEqual(postBodies[1], postBodies[0]);
    assert.equal(projectsByKey.size, 1, "retry must create exactly one server resource");
    assert.deepEqual(unknownRequests, []);
    return { posts: postKeys.length, resources: projectsByKey.size, aborts: 1, commitBeforeResponse };
  } finally {
    releaseFirstResponse.resolve();
    await page.close();
  }
}
async function runUnmountScenario(browser) {
  const postStarted = createDeferred();
  let organizationGets = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.exposeFunction("markUnmountPostStarted", () => {
      postStarted.resolve();
    });
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const probe = { aborts: 0, posts: 0 };
      window.__organizationPostUnmountProbe = probe;
      window.fetch = (input, init) => {
        const rawUrl =
          typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        const pathname = new URL(rawUrl, window.location.origin).pathname;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

        if (pathname === "/api/organizations" && method === "POST") {
          probe.posts += 1;
          void window.markUnmountPostStarted();
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
          });
        }

        return nativeFetch(input, init);
      };
    });
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard/overview") {
        organizationGets += 1;
        await fulfillJson(route, createDashboardOverview());
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.clock.install();
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill("Unmounted project");
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(postStarted.promise, 5_000, "unmount organization POST start");

    await page.evaluate(() => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.waitForURL(`${baseUrl}/`);
    await page.locator("#ua-hero-title").waitFor();
    let probe = await page.evaluate(() => ({ ...window.__organizationPostUnmountProbe }));
    assert.equal(probe.posts, 1);
    assert.equal(probe.aborts, 1);

    const organizationGetsAfterUnmount = organizationGets;
    await page.clock.runFor(createTimeoutMs * 2);
    await page.waitForTimeout(100);
    probe = await page.evaluate(() => ({ ...window.__organizationPostUnmountProbe }));
    assert.equal(probe.posts, 1);
    assert.equal(probe.aborts, 1);
    assert.equal(organizationGets, organizationGetsAfterUnmount);

    return {
      aborts: probe.aborts,
      organizationGetsAfterUnmount,
      posts: probe.posts
    };
  } finally {
    await page.close();
  }
}

async function runHttpErrorScenario(browser, { status, expectIdempotentRecovery }) {
  const postKeys = [];
  const postBodies = [];
  const projectsByKey = new Map();
  const createdProject = organization(114, `HTTP ${status} project`);
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
        assert.match(key ?? "", /^[0-9a-f-]{36}$/i);
        postKeys.push(key);
        postBodies.push(request.postDataJSON());
        if (postKeys.length === 1) {
          await fulfillJson(route, { message: `mock HTTP ${status}` }, { status });
        } else {
          if (!projectsByKey.has(key)) projectsByKey.set(key, createdProject);
          await fulfillJson(route, projectsByKey.get(key), { status: 201 });
        }
        return;
      }
      await fulfillJson(route, null, { status: 500 });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page.getByRole("complementary").getByRole("button", { name: "프로젝트 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    const input = dialog.getByLabel("프로젝트 이름", { exact: true });
    await input.fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();

    if (expectIdempotentRecovery) {
      await dialog.getByRole("alert").filter({ hasText: "프로젝트 생성 결과를 확인하지 못했습니다" }).waitFor();
      assert.equal(await input.isDisabled(), true);
      await dialog.getByRole("button", { name: "프로젝트 다시 시도", exact: true }).click();
    } else {
      await dialog.getByRole("alert").filter({ hasText: "프로젝트 생성 실패" }).waitFor();
      assert.equal(await input.isEnabled(), true);
      await dialog.getByRole("button", { name: "생성", exact: true }).click();
    }
    await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 5_000 });
    assert.equal(postKeys.length, 2);
    assert.equal(postKeys[0] === postKeys[1], expectIdempotentRecovery);
    assert.deepEqual(postBodies[0], postBodies[1]);
    assert.equal(projectsByKey.size, 1);
    return { status, posts: postKeys.length, reusedKey: expectIdempotentRecovery, resources: projectsByKey.size };
  } finally {
    await page.close();
  }
}
async function runRecoveryCasConflictScenario(browser) {
  const storageKey = "accessibility-dashboard.organization-create-attempt.v1";
  const createdProject = organization(113, "Conflicting recovery project");
  const observed = { organizationPosts: 0, unknownRequests: new Set() };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.addInitScript(({ key }) => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const rawUrl =
          typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        const pathname = new URL(rawUrl, window.location.origin).pathname;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const response = await nativeFetch(input, init);

        if (pathname === "/api/organizations" && method === "POST") {
          const rawValue = window.sessionStorage.getItem(key);
          if (rawValue !== null) {
            const attempt = JSON.parse(rawValue);
            window.sessionStorage.setItem(
              key,
              JSON.stringify({ ...attempt, attemptId: crypto.randomUUID(), organizationId: null })
            );
          }
        }
        return response;
      };
    }, { key: storageKey });

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      if (method === "GET" && pathname === "/api/dashboard/overview") {
        await fulfillJson(route, createDashboardOverview());
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        await fulfillJson(route, createdProject, { status: 201 });
        return;
      }
      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    const addProjectButton = page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true });
    await addProjectButton.click();
    let dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    const input = dialog.getByLabel("프로젝트 이름", { exact: true });
    await input.fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();

    const conflictAlert = dialog
      .getByRole("alert")
      .filter({ hasText: "복구 상태가 다른 화면에서 변경되었습니다" });
    await conflictAlert.waitFor();
    assert.equal(observed.organizationPosts, 1);
    assert.equal(await input.isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "생성", exact: true }).count(), 0);
    assert.equal(
      await dialog.getByRole("button", { name: "이전 작업 정보 삭제", exact: true }).count(),
      0
    );

    const storedAttempt = await page.evaluate((key) => {
      const rawValue = window.sessionStorage.getItem(key);
      return rawValue === null ? null : JSON.parse(rawValue);
    }, storageKey);
    assert.equal(storedAttempt?.version, 2);
    assert.equal(storedAttempt?.organizationId, null);

    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await addProjectButton.click();
    dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog
      .getByRole("alert")
      .filter({ hasText: "복구 상태가 다른 화면에서 변경되었습니다" })
      .waitFor();
    assert.equal(observed.organizationPosts, 1);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      blockedWithoutDiscard: true,
      organizationPosts: observed.organizationPosts,
      storedVersion: storedAttempt.version
    };
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const noCommit = await runScenario(browser, {
    commitBeforeResponse: false,
    createdProject: organization(111, "Timed out project")
  });
  const committed = await runScenario(browser, {
    commitBeforeResponse: true,
    createdProject: organization(112, "Eventually visible project")
  });
  const unmount = await runUnmountScenario(browser);
  const definitive422 = await runHttpErrorScenario(browser, {
    status: 422,
    expectIdempotentRecovery: false
  });
  const ambiguous503 = await runHttpErrorScenario(browser, {
    status: 503,
    expectIdempotentRecovery: true
  });
  const ambiguous499 = await runHttpErrorScenario(browser, {
    status: 499,
    expectIdempotentRecovery: true
  });
  const recoveryCasConflict = await runRecoveryCasConflictScenario(browser);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        noCommit,
        committed,
        unmount,
        definitive422,
        ambiguous503,
        ambiguous499,
        recoveryCasConflict
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
