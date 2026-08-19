/**
 * Regression checks for an organization POST that never settles:
 * - the real fetch is aborted after the client deadline;
 * - an ambiguous outcome becomes GET-only recovery and never repeats the POST;
 * - an eventually visible server commit is reconciled without duplication.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-organization-create-post-timeout.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
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
  let retryOrganizationGet = createDeferred();
  const observed = {
    organizationGets: 0,
    retryArmed: false,
    unknownRequests: new Set()
  };
  let revealCreatedProject = false;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.exposeFunction("markOrganizationPostStarted", () => {
      postStarted.resolve();
    });
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      const probe = { aborts: 0, posts: 0 };
      window.__organizationPostTimeoutProbe = probe;
      window.fetch = (input, init) => {
        const rawUrl =
          typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        const pathname = new URL(rawUrl, window.location.origin).pathname;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

        if (pathname === "/api/organizations" && method === "POST") {
          probe.posts += 1;
          void window.markOrganizationPostStarted();
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
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;

      if (method === "GET" && pathname === "/api/requests") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (method === "GET" && pathname === "/api/organizations") {
        observed.organizationGets += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            commitBeforeResponse && revealCreatedProject ? [createdProject] : []
          )
        });
        if (observed.retryArmed) {
          retryOrganizationGet.resolve();
        }
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/organizations/${createdProject.id}/evaluation-targets`
      ) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }

      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.clock.install();
    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(postStarted.promise, 5_000, "organization POST start");

    await page.clock.runFor(createTimeoutMs + 1);
    const alert = dialog
      .getByRole("alert")
      .filter({ hasText: "프로젝트 생성 결과를 확인하지 못했습니다" });
    await alert.waitFor({ timeout: 5_000 });

    let probe = await page.evaluate(() => ({ ...window.__organizationPostTimeoutProbe }));
    assert.equal(probe.posts, 1);
    assert.equal(probe.aborts, 1);
    assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole("button", { name: "닫기", exact: true }).isEnabled(), true);
    const retryButton = dialog.getByRole("button", {
      name: "프로젝트 불러오기 다시 시도",
      exact: true
    });
    assert.equal(await retryButton.isEnabled(), true);

    const organizationGetsBeforeRetry = observed.organizationGets;
    revealCreatedProject = commitBeforeResponse;
    observed.retryArmed = true;
    retryOrganizationGet = createDeferred();
    await retryButton.click();
    await withTimeout(retryOrganizationGet.promise, 5_000, "GET-only recovery retry");

    if (commitBeforeResponse) {
      await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 5_000 });
      await page
        .getByRole("heading", { level: 1, name: createdProject.name, exact: true })
        .waitFor();
      await dialog.waitFor({ state: "hidden" });
    } else {
      await alert.waitFor();
      assert.equal(new URL(page.url()).pathname, "/analyze");
      assert.equal(await retryButton.isEnabled(), true);
    }

    probe = await page.evaluate(() => ({ ...window.__organizationPostTimeoutProbe }));
    assert.equal(probe.posts, 1);
    assert.equal(probe.aborts, 1);
    assert.ok(observed.organizationGets > organizationGetsBeforeRetry);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      aborts: probe.aborts,
      finalPath: new URL(page.url()).pathname,
      organizationGets: observed.organizationGets,
      posts: probe.posts
    };
  } finally {
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
      if (pathname === "/api/requests") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (pathname === "/api/organizations") {
        organizationGets += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
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
    await page.waitForTimeout(100);
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

async function runHttpErrorScenario(browser, { status, expectGetOnlyRecovery }) {
  const observed = { organizationGets: 0, organizationPosts: 0 };
  const retryOrganizationGet = createDeferred();
  let retryArmed = false;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
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
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        if (retryArmed) {
          retryOrganizationGet.resolve();
        }
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ message: `mock HTTP ${status}` })
        });
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
    await input.fill(`HTTP ${status} project`);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();

    if (expectGetOnlyRecovery) {
      await dialog
        .getByRole("alert")
        .filter({ hasText: "프로젝트 생성 결과를 확인하지 못했습니다" })
        .waitFor();
      const getsBeforeRetry = observed.organizationGets;
      retryArmed = true;
      await dialog
        .getByRole("button", { name: "프로젝트 불러오기 다시 시도", exact: true })
        .click();
      await withTimeout(retryOrganizationGet.promise, 5_000, `HTTP ${status} GET retry`);
      assert.ok(observed.organizationGets > getsBeforeRetry);
      assert.equal(await input.isDisabled(), true);
    } else {
      await dialog
        .getByRole("alert")
        .filter({ hasText: "프로젝트 생성 실패" })
        .waitFor();
      await dialog.getByRole("button", { name: "생성", exact: true }).waitFor();
      assert.equal(await input.isEnabled(), true);
    }

    assert.equal(observed.organizationPosts, 1);
    return {
      organizationGets: observed.organizationGets,
      organizationPosts: observed.organizationPosts,
      status
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
    expectGetOnlyRecovery: false
  });
  const ambiguous503 = await runHttpErrorScenario(browser, {
    status: 503,
    expectGetOnlyRecovery: true
  });
  const ambiguous499 = await runHttpErrorScenario(browser, {
    status: 499,
    expectGetOnlyRecovery: true
  });

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        noCommit,
        committed,
        unmount,
        definitive422,
        ambiguous503,
        ambiguous499
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
