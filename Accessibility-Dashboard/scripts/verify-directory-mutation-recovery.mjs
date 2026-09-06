/** Stalled project edit/delete and page delete must recover without duplicate PATCHes. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-09-07T00:00:00.000Z";
const unknownMessage = "요청 처리 결과를 확인하지 못했습니다.";
const statusMessage = "현재 처리 상태를 확인하지 못했습니다.";

async function verify(browser, kind, mode) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  let organization = { id: 1, name: "Recovery project", type: "ETC", homepageUrl: null,
    description: "", status: "ACTIVE", createdAt: timestamp, updatedAt: timestamp };
  const target = { id: 101, organizationId: 1, name: "Recovery page", targetType: "WEB",
    accessUrl: "https://example.com/recovery", faviconUrl: null, description: "", status: "ACTIVE",
    createdAt: timestamp, updatedAt: timestamp };
  let targets = [target];
  let organizationActive = true;
  let patches = 0;
  const events = [];
  const pendingRoutes = [];
  const unknown = [];
  const apply = () => {
    if (kind === "edit") organization = { ...organization, name: "Recovered name" };
    if (kind === "project-delete") organizationActive = false;
    if (kind === "page-delete") targets = [];
  };
  const patchPath = kind === "edit" ? "/api/organizations/1"
    : kind === "project-delete" ? "/api/organizations/1/deactivate" : "/api/targets/101/delete";
  try {
    await page.route("**/api/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "GET" && pathname === "/api/dashboard/overview") {
        events.push("GET");
        if (mode === "lookup-stalled" && patches > 0) { pendingRoutes.push(route); return; }
        return fulfillJson(route, createDashboardOverview({
          organizations: organizationActive ? [organization] : [],
          evaluationTargets: organizationActive ? targets : []
        }));
      }
      if (request.method() === "PATCH" && pathname === patchPath) {
        patches++;
        events.push("PATCH");
        if (mode === "already-committed") apply();
        // The server may have committed, but the response never reaches the browser.
        pendingRoutes.push(route);
        return;
      }
      unknown.push(`${request.method()} ${pathname}`);
      await route.fulfill({ status: 500, body: "Unexpected fixture request" });
    });
    await page.goto(`${baseUrl}/projects/1`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1, name: organization.name, exact: true }).waitFor();
    // Accelerate only the existing request deadlines after bootstrap. Production
    // values and abort behavior are checked independently by the unit tests.
    await page.evaluate(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => original(callback,
        delay === 15_000 ? 600 : delay === 5_000 ? 300 : delay, ...args);
    });

    const open = async () => {
      if (kind === "page-delete") {
        await page.getByRole("button", { name: `${target.name} 제거`, exact: true }).click();
      } else {
        await page.locator("aside").getByRole("button", { name: "Recovery project", exact: true }).click({ button: "right" });
        await page.getByRole("menuitem", { name: kind === "edit" ? "수정" : "삭제", exact: true }).click();
      }
      const dialog = page.getByRole("dialog", { name: kind === "edit" ? "프로젝트 수정"
        : kind === "project-delete" ? "프로젝트 제거" : "페이지 제거", exact: true });
      if (kind === "edit") await dialog.getByLabel("프로젝트 이름", { exact: true }).fill("Recovered name");
      return dialog;
    };
    const submit = dialog => dialog.getByRole("button", {
      name: kind === "edit" ? "저장" : kind === "project-delete" ? "네" : "제거", exact: true
    });

    let dialog = await open();
    await submit(dialog).click();
    if (mode === "already-committed") {
      await dialog.waitFor({ state: "hidden" });
    } else {
      await dialog.getByRole("alert").filter({ hasText: unknownMessage }).waitFor();
      assert.equal(await submit(dialog).isEnabled(), true, "timed-out mutation must unlock submission");
      assert.equal(await dialog.getByRole("button", { name: kind === "project-delete" ? "아니요" : "취소", exact: true }).isEnabled(), true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.notEqual(await page.evaluate(() => document.body.style.overflow), "hidden", "closing must restore page scrolling");
      assert.equal(patches, 1, "recovery must not automatically send a second PATCH");

      if (mode === "late-commit") apply();
      const beforeRetry = events.length;
      dialog = await open();
      await submit(dialog).click();
      if (mode === "lookup-stalled") {
        await dialog.getByRole("alert").filter({ hasText: statusMessage }).waitFor();
        await page.keyboard.press("Escape");
      }
      await dialog.waitFor({ state: "hidden" });
      assert.equal(events[beforeRetry], "GET", "retry must check server state first");
    }
    assert.equal(patches, 1, "confirmed or unreadable outcomes must not repeat PATCH");
    assert.deepEqual(unknown, []);
    if (mode !== "lookup-stalled") {
      if (kind === "edit") await page.getByRole("heading", { level: 1, name: "Recovered name", exact: true }).waitFor();
      if (kind === "project-delete") await page.waitForURL("**/analyze");
      if (kind === "page-delete") assert.equal(await page.getByRole("button", { name: `${target.name} 제거`, exact: true }).count(), 0);
    }
    console.log(`PASS ${kind}: ${mode}`);
  } finally {
    for (const route of pendingRoutes) await route.abort().catch(() => {});
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const kind of ["edit", "project-delete", "page-delete"]) {
    for (const mode of ["already-committed", "late-commit"]) await verify(browser, kind, mode);
  }
  await verify(browser, "page-delete", "lookup-stalled");
} finally {
  await browser.close();
}
