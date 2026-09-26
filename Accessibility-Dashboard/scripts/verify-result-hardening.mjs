import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-09-24T00:00:00Z";
const organization = { id: 1, name: "결과 검증", description: "", status: "ACTIVE", updatedAt: timestamp };
const target = { id: 101, organizationId: 1, name: "결과 페이지", targetType: "WEB", accessUrl: "https://example.com", status: "ACTIVE", createdAt: timestamp };
const completed = { id: 501, evaluationTargetId: 101, status: "COMPLETED", requestedAt: timestamp, updatedAt: "2026-09-26T00:00:00Z" };
const failed = { id: 502, evaluationTargetId: 101, status: "FAILED", requestedAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z" };
const browser = await chromium.launch({ headless: true });
try {
  for (const count of [0, 1, 5000, 5001, 10001]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const issues = Array.from({ length: count }, (_, index) => ({
      id: 9001 + index, requestId: 501, module: "rule_based", severity: "SERIOUS", title: `저장된 문제 ${index + 1}`, createdAt: timestamp,
      description: `전체 설명 ${index + 1}`, recommendation: "요소에 접근 가능한 이름을 제공하세요.", selector: "#button",
      wcagCode: "5.1.1", locator: { kind: "DOM_PATH", pathSteps: [{ context: "DOCUMENT", selector: "#button", frameUrl: null }],
        htmlSnippet: '<button><script>window.untrusted = true</script></button>' }
    }));
    await page.route("**/api/**", route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/dashboard/overview") return fulfillJson(route, createDashboardOverview({
        organizations: [organization], evaluationTargets: [target], evaluationRequests: [completed, failed],
        // No summary: a measured zero score must not imply zero issues.
        scoreResults: [{ id: 1, evaluationRequestId: 501, totalScore: 0, ruleScore: 0, aiScore: 0, cvScore: null }]
      }));
      if (pathname === "/api/targets/101") return fulfillJson(route, target);
      if (pathname.endsWith("/issues")) return fulfillJson(route, issues);
      if (pathname.endsWith("/capture-metadata")) return fulfillJson(route, null);
      if (pathname.endsWith("/live-session")) return fulfillJson(route, null, { status: 503 });
      throw new Error(`Unexpected API request: ${pathname}`);
    });
    await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
    const open = page.getByRole("button", { name: `전체 문제 ${count.toLocaleString("ko-KR")}개`, exact: true });
    await open.waitFor({ timeout: 10000 }).catch(async error => { console.log(await page.locator("body").innerText()); throw error; });
    await page.getByText(/최신 재분석에 실패했습니다/).waitFor();
    await page.getByText(/현재 페이지에 연결하지 못했습니다. 저장된 분석 결과를 표시합니다/).waitFor();
    const trend = page.locator(".site-page-evidence-trend-panel");
    assert.match(await trend.innerText(), /미확인/);
    assert.equal(await trend.locator('[data-slot="chart"]').count(), 1, "real zero is a measured score");
    await open.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `전체 문제 ${count.toLocaleString("ko-KR")}개`, exact: true });
    await dialog.waitFor();
    const list = dialog.getByRole("list", { name: "전체 문제 목록" });
    if (count === 0) {
      await dialog.getByText("저장된 문제가 없습니다.", { exact: true }).waitFor();
    } else {
      assert.equal(await list.getByRole("listitem").count(), Math.min(count, 25));
      if (count > 25) await dialog.getByRole("button", { name: "마지막", exact: true }).click();
      await list.getByRole("button", { name: new RegExp(`저장된 문제 ${count} 문제 상세$`) }).click();
      await dialog.getByText(`전체 설명 ${count}`, { exact: false }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1, "details must not create a nested modal");
      assert.equal(await page.evaluate(() => window.untrusted), undefined, "stored HTML stays text");
      assert.equal(await dialog.getByRole("region", { name: "선택한 문제 상세" }).evaluate(el => el === document.activeElement), true);
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await open.evaluate(el => el === document.activeElement), true, "restore focus to the opener");
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS saved results independent of live session: ${count} issues`);
  }
  for (const records of [0, 1, 7]) {
    const page = await browser.newPage();
    await page.route("**/api/**", route => {
      const pathname = new URL(route.request().url()).pathname;
      const requests = Array.from({ length: records }, (_, i) => ({ ...completed, id: 501 + i }));
      if (pathname === "/api/dashboard/overview") return fulfillJson(route, createDashboardOverview({
        organizations: [organization], evaluationTargets: [target], evaluationRequests: requests,
        resultSummaries: requests.map(request => ({ requestId: request.id, totalScore: 87, totalIssueCount: 0, requestedAt: timestamp }))
      }));
      if (pathname === "/api/targets/101") return fulfillJson(route, target);
      if (pathname.endsWith("/issues")) return fulfillJson(route, []);
      if (pathname.endsWith("/live-session")) return fulfillJson(route, null, { status: 503 });
      if (pathname.endsWith("/capture-metadata")) return fulfillJson(route, null);
      throw new Error(pathname);
    });
    await page.goto(`${baseUrl}/projects/1/pages/101`);
    const trend = page.locator(".site-page-evidence-trend-panel");
    await trend.waitFor();
    assert.equal(await trend.locator('[data-slot="chart"]').count(), records > 0 ? 1 : 0);
    if (records === 0) await trend.getByRole("status").waitFor();
    else assert.match(await trend.locator(".sr-only").innerText(), new RegExp(`최근 ${records}회 분석 기준`));
    await page.close();
    console.log(`PASS trend: ${records} records`);
  }
} finally {
  await browser.close();
}
