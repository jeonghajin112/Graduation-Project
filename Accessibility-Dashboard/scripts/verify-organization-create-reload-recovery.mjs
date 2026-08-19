/**
 * Regression checks for organization-create recovery across a full reload:
 * - an in-flight POST is persisted before fetch and never repeated after reload;
 * - a committed project is reconciled silently from the fresh directory;
 * - an uncommitted outcome restores a disabled, GET-only recovery form.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-organization-create-reload-recovery.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
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

async function runScenario(browser, { commitBeforeReload, createdProject }) {
  const postStarted = createDeferred();
  let retryOrganizationGet = createDeferred();
  const observed = {
    organizationGets: 0,
    organizationPosts: 0,
    retryArmed: false,
    serverCommitted: false,
    unknownRequests: new Set()
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let recoveryPath = "/analyze";
  let storageClearedOnLogout = false;

  try {
    await page.exposeFunction("markReloadOrganizationPostStarted", () => {
      observed.organizationPosts += 1;
      observed.serverCommitted = commitBeforeReload;
      postStarted.resolve();
    });
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const rawUrl =
          typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        const pathname = new URL(rawUrl, window.location.origin).pathname;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

        if (pathname === "/api/organizations" && method === "POST") {
          void window.markReloadOrganizationPostStarted();
          return new Promise((_, reject) => {
            const signal = init?.signal;
            const handleAbort = () => {
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
          body: JSON.stringify(observed.serverCommitted ? [createdProject] : [])
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

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    let dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(postStarted.promise, 5_000, "organization POST before reload");

    const storedBeforeReload = await page.evaluate((key) => {
      const rawValue = sessionStorage.getItem(key);
      return rawValue === null ? null : JSON.parse(rawValue);
    }, storageKey);
    assert.equal(storedBeforeReload?.phase, "posting");
    assert.equal(storedBeforeReload?.apiScope, "/api");
    assert.equal(storedBeforeReload?.name, createdProject.name);
    assert.equal(observed.organizationPosts, 1);

    await page.reload({ waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/analyze");

    const addProjectButton = page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true });
    if (commitBeforeReload) {
      await page
        .locator("aside")
        .getByRole("button", { name: createdProject.name, exact: true })
        .waitFor();
      await page.waitForFunction((key) => sessionStorage.getItem(key) === null, storageKey);
      await addProjectButton.click();
      dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
      assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).inputValue(), "");
      await dialog.getByRole("button", { name: "생성", exact: true }).waitFor();
      assert.equal(
        await dialog
          .getByRole("button", { name: "프로젝트 불러오기 다시 시도", exact: true })
          .count(),
        0
      );
    } else {
      const storedAfterReload = await page.evaluate((key) => {
        const rawValue = sessionStorage.getItem(key);
        return rawValue === null ? null : JSON.parse(rawValue);
      }, storageKey);
      assert.equal(storedAfterReload?.phase, "reconciling");
      assert.equal(storedAfterReload?.organizationId, null);

      await addProjectButton.click();
      dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
      const input = dialog.getByLabel("프로젝트 이름", { exact: true });
      assert.equal(await input.inputValue(), createdProject.name);
      assert.equal(await input.isDisabled(), true);
      await dialog
        .getByRole("alert")
        .filter({ hasText: "프로젝트 생성 결과를 확인하지 못했습니다" })
        .waitFor();
      const retryButton = dialog.getByRole("button", {
        name: "프로젝트 불러오기 다시 시도",
        exact: true
      });
      const getsBeforeRetry = observed.organizationGets;
      observed.retryArmed = true;
      retryOrganizationGet = createDeferred();
      await retryButton.click();
      await withTimeout(retryOrganizationGet.promise, 5_000, "reload GET-only retry");
      assert.ok(observed.organizationGets > getsBeforeRetry);
      assert.equal(observed.organizationPosts, 1);
      assert.equal(await retryButton.isEnabled(), true);

      recoveryPath = new URL(page.url()).pathname;
      assert.notEqual(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
      await dialog.getByRole("button", { name: "닫기", exact: true }).click();
      await page.locator(".dashboard-account-menu-trigger").click();
      await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
      await page.waitForURL(`${baseUrl}/`);
      storageClearedOnLogout =
        (await page.evaluate((key) => sessionStorage.getItem(key), storageKey)) === null;
      assert.equal(storageClearedOnLogout, true);
    }

    assert.equal(observed.organizationPosts, 1);
    assert.deepEqual([...observed.unknownRequests], []);
    return {
      finalPath: new URL(page.url()).pathname,
      recoveryPath,
      organizationGets: observed.organizationGets,
      organizationPosts: observed.organizationPosts,
      storageCleared: (await page.evaluate((key) => sessionStorage.getItem(key), storageKey)) === null,
      storageClearedOnLogout
    };
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
      if (method === "GET" && pathname === "/api/requests") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (method === "GET" && pathname === "/api/organizations") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
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
      .filter({ hasText: "브라우저에 안전한 복구 정보를 저장하지 못해" })
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

async function runSameDocumentRestoreScenario(browser) {
  const postStarted = createDeferred();
  const restoredDirectoryGet = createDeferred();
  let organizationGets = 0;
  let organizationPosts = 0;
  let restoreArmed = false;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.exposeFunction("markSameDocumentPostStarted", () => {
      organizationPosts += 1;
      postStarted.resolve();
    });
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const rawUrl =
          typeof input === "string" || input instanceof URL ? input.toString() : input.url;
        const pathname = new URL(rawUrl, window.location.origin).pathname;
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (pathname === "/api/organizations" && method === "POST") {
          void window.markSameDocumentPostStarted();
          return new Promise((_, reject) => {
            const signal = init?.signal;
            const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
            if (signal?.aborted) {
              abort();
            } else {
              signal?.addEventListener("abort", abort, { once: true });
            }
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
        organizationGets += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        if (restoreArmed) {
          restoredDirectoryGet.resolve();
        }
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
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill("Same document project");
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(postStarted.promise, 5_000, "same-document organization POST");

    await page.evaluate(() => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.locator("#ua-hero-title").waitFor();
    const getsBeforeRestore = organizationGets;
    restoreArmed = true;
    await page.evaluate(() => {
      window.history.pushState({}, "", "/analyze");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await withTimeout(restoredDirectoryGet.promise, 2_000, "same-document forced directory GET");

    assert.ok(organizationGets > getsBeforeRestore);
    assert.equal(organizationPosts, 1);
    assert.notEqual(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
    return { organizationGets, organizationPosts, forcedImmediately: true };
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
      if (method === "GET" && (pathname === "/api/requests" || pathname === "/api/organizations")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
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
            version: 1,
            attemptId: crypto.randomUUID(),
            apiScope: "/api",
            phase: "reconciling",
            organizationId: null,
            name: "Stale recovery project",
            previousOrganizationIds: [],
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
      name: "복구 정보 삭제",
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
      if (method === "GET" && (pathname === "/api/requests" || pathname === "/api/organizations")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
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
    await dialog.getByRole("alert").filter({ hasText: "이전 버전" }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "생성", exact: true }).count(), 0);
    const discardButton = dialog.getByRole("button", { name: "복구 정보 삭제", exact: true });
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
    createdProject: organization(122, "Reload uncommitted project")
  });
  const storageFailure = await runStorageFailureScenario(browser);
  const sameDocumentRestore = await runSameDocumentRestoreScenario(browser);
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
