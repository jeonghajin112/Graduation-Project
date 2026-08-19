/**
 * Regression checks for frontend-only organization creation guards:
 * - same-tick submit re-entry cannot duplicate the POST;
 * - transiently missing organizations, targets, or requests preserve the last
 *   complete dashboard snapshot while automatic recovery bypasses the cache;
 * - overlapping organization, target, and request recovery leases do not
 *   overwrite or end one another;
 * - bounded recovery releases genuinely deleted routes without letting stale
 *   route effects overwrite a newly reconciled project navigation;
 * - dashboard-owned requests are aborted when the dashboard unmounts.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify-organization-create-frontend-guards.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const timestamp = "2026-08-10T10:00:00.000Z";

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

async function runSubmitMutexScenario(browser) {
  const createdProject = organization(71, "Single submit project");
  const releasePost = createDeferred();
  const firstPostStarted = createDeferred();
  const observed = {
    activePosts: 0,
    maxConcurrentPosts: 0,
    organizationPosts: 0,
    unknownRequests: new Set()
  };
  let organizations = [];
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
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(organizations)
        });
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/organizations/${createdProject.id}/evaluation-targets`
      ) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        observed.activePosts += 1;
        observed.maxConcurrentPosts = Math.max(
          observed.maxConcurrentPosts,
          observed.activePosts
        );
        firstPostStarted.resolve();
        await releasePost.promise;
        organizations = [createdProject];
        observed.activePosts -= 1;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(createdProject)
        });
        return;
      }

      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    const createButton = dialog.getByRole("button", { name: "생성", exact: true });
    const createButtonHandle = await createButton.elementHandle();
    assert.ok(createButtonHandle);

    await createButtonHandle.evaluate((button) => {
      button.click();
      button.click();
    });
    await withTimeout(firstPostStarted.promise, 5_000, "first organization POST");
    await page.waitForTimeout(150);

    assert.equal(observed.organizationPosts, 1);
    assert.equal(observed.maxConcurrentPosts, 1);
    assert.equal(await createButtonHandle.evaluate((button) => button.disabled), true);

    releasePost.resolve();
    await page.waitForURL(`**/projects/${createdProject.id}`, { timeout: 10_000 });
    assert.equal(observed.organizationPosts, 1);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      organizationPosts: observed.organizationPosts,
      maxConcurrentPosts: observed.maxConcurrentPosts,
      finalPath: new URL(page.url()).pathname
    };
  } finally {
    releasePost.resolve();
    await page.close();
  }
}

async function runTransientEmptyScenario(browser) {
  const existingProject = organization(1, "Existing project");
  const createdProject = organization(2, "Recovered project");
  const existingTarget = {
    id: 101,
    organizationId: existingProject.id,
    name: "Existing result page",
    targetType: "WEB",
    accessUrl: "https://example.com/existing",
    faviconUrl: null,
    description: "",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const completedRequest = {
    id: 501,
    evaluationTargetId: existingTarget.id,
    targetName: existingTarget.name,
    status: "COMPLETED",
    requestNote: "protected result snapshot",
    requestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const resultSummary = {
    requestId: completedRequest.id,
    targetName: existingTarget.name,
    status: "COMPLETED",
    totalScore: 84,
    totalIssueCount: 1,
    criticalIssueCount: 0,
    requestedAt: timestamp
  };
  const retainedIssue = {
    id: 7001,
    requestId: completedRequest.id,
    module: "rule_based",
    severity: "SERIOUS",
    title: "복구 중에도 유지되어야 하는 접근성 이슈",
    description: "불완전한 디렉터리 응답이 결과를 지우면 안 됩니다.",
    recommendation: "마지막 정상 결과를 유지하세요.",
    selector: "main img",
    wcagCode: "5.1.1",
    createdAt: timestamp
  };
  const retainedScore = {
    id: 8001,
    evaluationRequestId: completedRequest.id,
    totalScore: 84,
    ruleScore: 82,
    aiScore: 85,
    cvScore: 85,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const firstEmptyRefresh = createDeferred();
  const missingTargetRefresh = createDeferred();
  const baselineCompleteRefresh = createDeferred();
  const emptyRequestsRefresh = createDeferred();
  const terminalRollbackRefresh = createDeferred();
  const invalidTimestampRefresh = createDeferred();
  const observed = {
    invalidTimestampGets: 0,
    terminalRollbackGets: 0,
    emptyOrganizationGets: 0,
    emptyRequestGets: 0,
    freshOrganizationGets: 0,
    missingTargetGets: 0,
    organizationPosts: 0,
    returnedTransientEmpty: false,
    unknownRequests: new Set()
  };
  let committed = false;
  let recoveryPhase = "empty-organizations";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;

      if (method === "GET" && pathname === "/api/requests") {
        if (committed && recoveryPhase === "empty-requests") {
          observed.emptyRequestGets += 1;
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          emptyRequestsRefresh.resolve();
          return;
        }
        if (committed && recoveryPhase === "terminal-rollback") {
          observed.terminalRollbackGets += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([{ ...completedRequest, status: "FAILED" }])
          });
          terminalRollbackRefresh.resolve();
          return;
        }
        if (committed && recoveryPhase === "invalid-request-timestamp") {
          observed.invalidTimestampGets += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([{ ...completedRequest, updatedAt: "invalid-timestamp" }])
          });
          invalidTimestampRefresh.resolve();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([completedRequest])
        });
        return;
      }
      if (method === "GET" && pathname === "/api/organizations") {
        if (committed && recoveryPhase === "empty-organizations") {
          observed.emptyOrganizationGets += 1;
          if (!observed.returnedTransientEmpty) {
            observed.returnedTransientEmpty = true;
          }
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          firstEmptyRefresh.resolve();
          return;
        }

        if (committed && recoveryPhase === "fresh") {
          observed.freshOrganizationGets += 1;
        }
        if (committed && recoveryPhase === "baseline-complete") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([existingProject])
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(committed ? [existingProject, createdProject] : [existingProject])
        });
        return;
      }
      if (method === "GET" && pathname === "/api/organizations/1/evaluation-targets") {
        if (committed && recoveryPhase === "missing-target") {
          observed.missingTargetGets += 1;
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          missingTargetRefresh.resolve();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([existingTarget])
        });
        if (committed && recoveryPhase === "baseline-complete") {
          baselineCompleteRefresh.resolve();
        }
        return;
      }
      if (method === "GET" && pathname === "/api/organizations/2/evaluation-targets") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/results/requests/${completedRequest.id}/summary`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(resultSummary)
        });
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/results/requests/${completedRequest.id}/issues`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([retainedIssue])
        });
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/scores/requests/${completedRequest.id}`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(retainedScore)
        });
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        committed = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(createdProject)
        });
        return;
      }

      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(
      `${baseUrl}/projects/${existingProject.id}/pages/${existingTarget.id}`,
      { waitUntil: "networkidle" }
    );
    await page
      .getByRole("heading", { level: 1, name: existingTarget.name, exact: true })
      .waitFor();
    const latestScore = page.locator(".site-summary-stat-item").filter({ hasText: "최신 점수" });
    const evaluationCount = page
      .locator(".site-summary-stat-item")
      .filter({ hasText: "평가 횟수" });
    assert.match(
      (await latestScore.textContent())?.replace(/\s+/g, "") ?? "",
      /최신점수84점/,
      JSON.stringify({
        emptyOrganizationGets: observed.emptyOrganizationGets,
        missingTargetGets: observed.missingTargetGets,
        emptyRequestGets: observed.emptyRequestGets
      })
    );
    assert.match(
      (await evaluationCount.textContent())?.replace(/\s+/g, "") ?? "",
      /평가횟수1건/
    );
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();
    const addProjectButton = page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true });
    await addProjectButton.click();
    let dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(firstEmptyRefresh.promise, 5_000, "transient empty refresh");
    await dialog.getByRole("alert").filter({ hasText: "프로젝트는 생성되었지만" }).waitFor();

    // The transient empty response must preserve the entire last consistent
    // snapshot: current site route, score, evaluation count, and issues.
    assert.equal(
      new URL(page.url()).pathname,
      `/projects/${existingProject.id}/pages/${existingTarget.id}`
    );
    await page
      .getByRole("heading", { level: 1, name: existingTarget.name, exact: true })
      .waitFor();
    assert.match((await latestScore.textContent())?.replace(/\s+/g, "") ?? "", /최신점수84점/);
    assert.match(
      (await evaluationCount.textContent())?.replace(/\s+/g, "") ?? "",
      /평가횟수1건/
    );
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();

    // Closing is not a rollback. The protected recovery scope remains active,
    // so the next five-second poll bypasses the cached empty directory.
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    recoveryPhase = "missing-target";
    await withTimeout(missingTargetRefresh.promise, 8_000, "transient missing target refresh");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );

    assert.equal(
      new URL(page.url()).pathname,
      `/projects/${existingProject.id}/pages/${existingTarget.id}`
    );
    assert.match(
      (await latestScore.textContent())?.replace(/\s+/g, "") ?? "",
      /최신점수84점/,
      JSON.stringify({
        emptyOrganizationGets: observed.emptyOrganizationGets,
        missingTargetGets: observed.missingTargetGets,
        emptyRequestGets: observed.emptyRequestGets
      })
    );
    assert.match(
      (await evaluationCount.textContent())?.replace(/\s+/g, "") ?? "",
      /평가횟수1건/
    );
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();
    assert.equal(
      await page
        .locator("aside")
        .getByRole("button", { name: createdProject.name, exact: true })
        .count(),
      0
    );

    // Adopt a complete baseline-only checkpoint before exercising request-only
    // regressions. It resets the consecutive-incomplete lease without finding
    // the newly created project, so recovery remains active.
    recoveryPhase = "baseline-complete";
    await withTimeout(baselineCompleteRefresh.promise, 8_000, "complete baseline refresh");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    assert.equal(
      new URL(page.url()).pathname,
      `/projects/${existingProject.id}/pages/${existingTarget.id}`
    );
    assert.match((await latestScore.textContent())?.replace(/\s+/g, "") ?? "", /최신점수84점/);
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();
    assert.equal(
      await page
        .locator("aside")
        .getByRole("button", { name: createdProject.name, exact: true })
        .count(),
      0
    );

    // A complete organization/target directory is still an incomplete
    // dashboard snapshot when the request endpoint transiently returns 200 [].
    // Preserve its score, issue list, and route under the same bounded lease.
    recoveryPhase = "empty-requests";
    await withTimeout(emptyRequestsRefresh.promise, 8_000, "transient empty requests refresh");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    assert.equal(
      new URL(page.url()).pathname,
      `/projects/${existingProject.id}/pages/${existingTarget.id}`
    );
    assert.match(
      (await latestScore.textContent())?.replace(/\s+/g, "") ?? "",
      /최신점수84점/,
      JSON.stringify({
        emptyOrganizationGets: observed.emptyOrganizationGets,
        missingTargetGets: observed.missingTargetGets,
        emptyRequestGets: observed.emptyRequestGets
      })
    );
    assert.match(
      (await evaluationCount.textContent())?.replace(/\s+/g, "") ?? "",
      /평가횟수1건/
    );
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();

    // COMPLETED and FAILED are distinct terminal states. Accepting this
    // rollback as complete would remove the completed request's score/issues.
    recoveryPhase = "terminal-rollback";
    await withTimeout(terminalRollbackRefresh.promise, 8_000, "terminal request rollback refresh");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    assert.equal(
      new URL(page.url()).pathname,
      `/projects/${existingProject.id}/pages/${existingTarget.id}`
    );
    assert.match(
      (await latestScore.textContent())?.replace(/\s+/g, "") ?? "",
      /최신점수84점/,
      JSON.stringify(observed, (_key, value) => (value instanceof Set ? [...value] : value))
    );
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();

    // A valid baseline timestamp followed by an unparsable timestamp is also
    // indeterminate, not proof that the request is at least as recent.
    recoveryPhase = "invalid-request-timestamp";
    await withTimeout(invalidTimestampRefresh.promise, 8_000, "invalid request timestamp refresh");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    assert.equal(
      new URL(page.url()).pathname,
      `/projects/${existingProject.id}/pages/${existingTarget.id}`
    );
    assert.match((await latestScore.textContent())?.replace(/\s+/g, "") ?? "", /최신점수84점/);
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();

    recoveryPhase = "fresh";
    await page
      .locator("aside")
      .getByRole("button", { name: createdProject.name, exact: true })
      .waitFor({ timeout: 8_000 });

    assert.equal(
      new URL(page.url()).pathname,
      `/projects/${existingProject.id}/pages/${existingTarget.id}`
    );
    assert.match((await latestScore.textContent())?.replace(/\s+/g, "") ?? "", /최신점수84점/);
    assert.match(
      (await evaluationCount.textContent())?.replace(/\s+/g, "") ?? "",
      /평가횟수1건/
    );
    await page.getByText(retainedIssue.title, { exact: true }).waitFor();
    assert.equal(observed.organizationPosts, 1);
    assert.equal(observed.returnedTransientEmpty, true);
    assert.ok(observed.emptyRequestGets >= 1);
    assert.ok(observed.terminalRollbackGets >= 1);
    assert.ok(observed.invalidTimestampGets >= 1);
    assert.ok(observed.missingTargetGets >= 1);

    // Auto reconciliation while closed clears the checkpoint without routing.
    await page.waitForTimeout(100);
    await addProjectButton.click();
    dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    assert.equal(await dialog.getByLabel("프로젝트 이름", { exact: true }).inputValue(), "");
    await dialog.getByRole("button", { name: "생성", exact: true }).waitFor();
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      organizationPosts: observed.organizationPosts,
      emptyOrganizationGets: observed.emptyOrganizationGets,
      emptyRequestGets: observed.emptyRequestGets,
      terminalRollbackGets: observed.terminalRollbackGets,
      invalidTimestampGets: observed.invalidTimestampGets,
      freshOrganizationGets: observed.freshOrganizationGets,
      missingTargetGets: observed.missingTargetGets,
      finalPath: new URL(page.url()).pathname
    };
  } finally {
    await page.close();
  }
}

async function runNestedRecoveryLeaseScenario(browser) {
  const existingProject = organization(61, "Nested recovery project");
  const unresolvedProject = organization(62, "Unresolved nested project");
  const createdTarget = {
    id: 611,
    organizationId: existingProject.id,
    name: "Nested recovery page",
    targetType: "WEB",
    accessUrl: "https://example.com/nested-recovery",
    faviconUrl: null,
    description: "",
    status: "ACTIVE",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const pendingRequest = {
    id: 612,
    evaluationTargetId: createdTarget.id,
    targetName: createdTarget.name,
    status: "PENDING",
    requestNote: "nested recovery lease regression",
    requestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const completedRequest = {
    ...pendingRequest,
    status: "COMPLETED",
    updatedAt: "2026-08-10T10:00:05.000Z"
  };
  const resultSummary = {
    requestId: completedRequest.id,
    targetName: createdTarget.name,
    status: "COMPLETED",
    totalScore: 92,
    totalIssueCount: 0,
    criticalIssueCount: 0,
    requestedAt: completedRequest.requestedAt
  };
  const score = {
    id: 613,
    evaluationRequestId: completedRequest.id,
    totalScore: 92,
    ruleScore: 91,
    aiScore: 93,
    cvScore: 92,
    createdAt: completedRequest.createdAt,
    updatedAt: completedRequest.updatedAt
  };
  const organizationReconcileRefresh = createDeferred();
  const protectedEmptyRefresh = createDeferred();
  const observed = {
    organizationPosts: 0,
    targetPosts: 0,
    requestPosts: 0,
    requestStatusGets: 0,
    protectedEmptyGets: 0,
    unknownRequests: new Set()
  };
  let targets = [];
  let requests = [];
  let returnEmptyOrganizations = false;
  let didResolveOrganizationReconcile = false;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // Keep the five-second poll from racing the deliberately sequenced nested
    // mutations. The final incomplete refresh is triggered by the recovery UI.
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (handler, timeout = 0, ...args) =>
        nativeSetInterval(handler, timeout === 5_000 ? 60_000 : timeout, ...args);
    });

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;

      if (method === "GET" && pathname === "/api/organizations") {
        if (returnEmptyOrganizations) {
          observed.protectedEmptyGets += 1;
          await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
          protectedEmptyRefresh.resolve();
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([existingProject])
        });
        if (observed.organizationPosts > 0 && !didResolveOrganizationReconcile) {
          didResolveOrganizationReconcile = true;
          organizationReconcileRefresh.resolve();
        }
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/organizations/${existingProject.id}/evaluation-targets`
      ) {
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
      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(unresolvedProject)
        });
        return;
      }
      if (
        method === "POST" &&
        pathname === `/api/organizations/${existingProject.id}/evaluation-targets`
      ) {
        observed.targetPosts += 1;
        targets = [createdTarget];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(createdTarget)
        });
        return;
      }
      if (method === "POST" && pathname === "/api/requests") {
        observed.requestPosts += 1;
        requests = [pendingRequest];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(pendingRequest)
        });
        return;
      }
      if (method === "GET" && pathname === `/api/requests/${completedRequest.id}`) {
        observed.requestStatusGets += 1;
        requests = [completedRequest];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(completedRequest)
        });
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/results/requests/${completedRequest.id}/summary`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(resultSummary)
        });
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/results/requests/${completedRequest.id}/issues`
      ) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (
        method === "GET" &&
        pathname === `/api/scores/requests/${completedRequest.id}`
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(score)
        });
        return;
      }

      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/projects/${existingProject.id}`, { waitUntil: "networkidle" });
    await page
      .getByRole("heading", { level: 1, name: existingProject.name, exact: true })
      .waitFor();

    const addProjectButton = page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true });
    await addProjectButton.click();
    let projectDialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await projectDialog
      .getByLabel("프로젝트 이름", { exact: true })
      .fill(unresolvedProject.name);
    await projectDialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(
      organizationReconcileRefresh.promise,
      5_000,
      "organization recovery baseline refresh"
    );
    await projectDialog
      .getByRole("alert")
      .filter({ hasText: "프로젝트는 생성되었지만" })
      .waitFor();
    await projectDialog.getByRole("button", { name: "닫기", exact: true }).click();
    await projectDialog.waitFor({ state: "hidden" });

    // The unresolved organization lease remains active while target creation
    // and request creation briefly acquire and later release their own leases.
    await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
    const siteDialog = page.getByRole("dialog", { name: "페이지 추가", exact: true });
    await siteDialog.getByLabel("페이지 이름", { exact: true }).fill(createdTarget.name);
    await siteDialog.getByLabel("페이지 주소", { exact: true }).fill(createdTarget.accessUrl);
    await siteDialog.getByRole("button", { name: "분석 시작", exact: true }).click();
    await siteDialog.waitFor({ state: "hidden", timeout: 10_000 });

    assert.equal(observed.organizationPosts, 1);
    assert.equal(observed.targetPosts, 1);
    assert.equal(observed.requestPosts, 1);
    assert.equal(observed.requestStatusGets, 1);
    assert.equal(new URL(page.url()).pathname, `/projects/${existingProject.id}`);
    await page
      .getByRole("button", { name: `${createdTarget.name} 상세 보기`, exact: true })
      .waitFor();

    // Ending the target/request leases must not end the older unresolved
    // organization lease. Its next incomplete snapshot must still be hidden.
    returnEmptyOrganizations = true;
    await addProjectButton.click();
    projectDialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await projectDialog
      .getByRole("button", { name: "프로젝트 불러오기 다시 시도", exact: true })
      .click();
    await withTimeout(protectedEmptyRefresh.promise, 5_000, "nested protected empty refresh");
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );

    assert.equal(new URL(page.url()).pathname, `/projects/${existingProject.id}`);
    await page
      .getByRole("heading", { level: 1, name: existingProject.name, exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: `${createdTarget.name} 상세 보기`, exact: true })
        .count(),
      1
    );
    assert.equal(observed.protectedEmptyGets, 1);
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      organizationPosts: observed.organizationPosts,
      targetPosts: observed.targetPosts,
      requestPosts: observed.requestPosts,
      protectedEmptyGets: observed.protectedEmptyGets,
      finalPath: new URL(page.url()).pathname
    };
  } finally {
    await page.close();
  }
}

async function runBoundedRecoveryCase(
  browser,
  { existingProject, createdProject, revealCreatedAtRelease }
) {
  const incompleteRefreshes = Array.from({ length: 4 }, () => createDeferred());
  const observed = {
    incompleteGets: 0,
    organizationPosts: 0,
    unknownRequests: new Set()
  };
  let committed = false;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // Keep the product's background poll out of this threshold test. Each
    // incomplete snapshot below is triggered by one explicit, forced refresh.
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (handler, timeout = 0, ...args) =>
        nativeSetInterval(handler, timeout === 5_000 ? 60_000 : timeout, ...args);
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
        if (!committed) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([existingProject])
          });
          return;
        }

        const refreshIndex = observed.incompleteGets;
        observed.incompleteGets += 1;
        const organizations =
          revealCreatedAtRelease && observed.incompleteGets >= 4 ? [createdProject] : [];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(organizations)
        });
        incompleteRefreshes[refreshIndex]?.resolve();
        return;
      }
      if (
        method === "GET" &&
        (pathname === `/api/organizations/${existingProject.id}/evaluation-targets` ||
          pathname === `/api/organizations/${createdProject.id}/evaluation-targets`)
      ) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (method === "POST" && pathname === "/api/organizations") {
        observed.organizationPosts += 1;
        committed = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(createdProject)
        });
        return;
      }

      observed.unknownRequests.add(`${method} ${pathname}`);
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/projects/${existingProject.id}`, { waitUntil: "networkidle" });
    await page
      .getByRole("heading", { level: 1, name: existingProject.name, exact: true })
      .waitFor();
    await page
      .locator("aside")
      .getByRole("button", { name: "프로젝트 추가", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
    await dialog.getByLabel("프로젝트 이름", { exact: true }).fill(createdProject.name);
    await dialog.getByRole("button", { name: "생성", exact: true }).click();
    await withTimeout(incompleteRefreshes[0].promise, 5_000, "first bounded refresh");
    await dialog.getByRole("alert").filter({ hasText: "프로젝트는 생성되었지만" }).waitFor();

    for (let refreshIndex = 1; refreshIndex < incompleteRefreshes.length; refreshIndex += 1) {
      await dialog
        .getByRole("button", { name: "프로젝트 불러오기 다시 시도", exact: true })
        .click();
      await withTimeout(
        incompleteRefreshes[refreshIndex].promise,
        5_000,
        `bounded refresh ${refreshIndex + 1}`
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );

      if (refreshIndex < incompleteRefreshes.length - 1) {
        assert.equal(new URL(page.url()).pathname, `/projects/${existingProject.id}`);
      }
    }

    const expectedPath = revealCreatedAtRelease
      ? `/projects/${createdProject.id}`
      : "/analyze";
    await page.waitForURL(`${baseUrl}${expectedPath}`, { timeout: 5_000 });
    if (revealCreatedAtRelease) {
      await page
        .getByRole("heading", { level: 1, name: createdProject.name, exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator("aside")
          .getByRole("button", { name: createdProject.name, exact: true })
          .getAttribute("aria-current"),
        "page"
      );
    } else {
      await page
        .getByRole("heading", { level: 2, name: "확인할 페이지 주소를 입력하세요", exact: true })
        .waitFor();
    }

    await page.waitForTimeout(750);
    assert.equal(new URL(page.url()).pathname, expectedPath);
    assert.equal(observed.organizationPosts, 1);
    assert.equal(observed.incompleteGets, 4);
    assert.equal(
      await page
        .locator("aside")
        .getByRole("button", { name: existingProject.name, exact: true })
        .count(),
      0
    );
    assert.deepEqual([...observed.unknownRequests], []);

    return {
      finalPath: new URL(page.url()).pathname,
      incompleteGets: observed.incompleteGets,
      organizationPosts: observed.organizationPosts
    };
  } finally {
    await page.close();
  }
}

async function runBoundedRecoveryScenario(browser) {
  return {
    createdObserved: await runBoundedRecoveryCase(browser, {
      existingProject: organization(81, "Replaced project"),
      createdProject: organization(82, "Reconciled project"),
      revealCreatedAtRelease: true
    }),
    createdUnobserved: await runBoundedRecoveryCase(browser, {
      existingProject: organization(91, "Deleted project"),
      createdProject: organization(92, "Unobserved project"),
      revealCreatedAtRelease: false
    })
  };
}

async function runUnmountAbortScenario(browser) {
  const existingProject = organization(1, "Abort cleanup project");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      const nativeSetInterval = window.setInterval.bind(window);
      const probe = { aborts: 0, hangNext: false, starts: 0 };
      window.__dashboardFetchProbe = probe;
      window.setInterval = (handler, timeout = 0, ...args) => {
        if (timeout === 5_000 && typeof handler === "function") {
          window.__runDashboardPoll = () => handler(...args);
          return nativeSetInterval(() => {}, 60_000);
        }
        return nativeSetInterval(handler, timeout, ...args);
      };
      window.fetch = (input, init) => {
        const rawUrl = typeof input === "string" ? input : input.url;
        const pathname = new URL(rawUrl, window.location.origin).pathname;
        if (probe.hangNext && pathname === "/api/organizations") {
          probe.hangNext = false;
          probe.starts += 1;
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
        return realFetch(input, init);
      };
    });

    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/requests") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      if (pathname === "/api/organizations") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([existingProject])
        });
        return;
      }
      if (pathname === "/api/organizations/1/evaluation-targets") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });

    await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      window.__dashboardFetchProbe.hangNext = true;
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + 20_000;
      window.__runDashboardPoll();
    });
    await page.waitForFunction(() => window.__dashboardFetchProbe.starts === 1, null, {
      timeout: 10_000
    });

    await page.locator(".dashboard-account-menu-trigger").click();
    await page.getByRole("menuitem", { name: "로그아웃", exact: true }).click();
    await page.waitForURL(`${baseUrl}/`);
    await page.waitForFunction(() => window.__dashboardFetchProbe.aborts === 1, null, {
      timeout: 1_500
    });

    const probe = await page.evaluate(() => ({ ...window.__dashboardFetchProbe }));
    assert.equal(probe.starts, 1);
    assert.equal(probe.aborts, 1);
    return probe;
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  const submitMutex = await runSubmitMutexScenario(browser);
  const transientEmpty = await runTransientEmptyScenario(browser);
  const nestedRecoveryLease = await runNestedRecoveryLeaseScenario(browser);
  const boundedRecovery = await runBoundedRecoveryScenario(browser);
  const unmountAbort = await runUnmountAbortScenario(browser);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        submitMutex,
        transientEmpty,
        nestedRecoveryLease,
        boundedRecovery,
        unmountAbort
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
