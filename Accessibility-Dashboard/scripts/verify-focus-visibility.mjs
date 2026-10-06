import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { installDashboardApiFixture, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { createTestLiveReportSession, createTestLiveReportViewerHtml } from "./fixtures/live-report-viewer-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const output = "artifacts/focus-visibility";
await mkdir(output, { recursive: true });

async function assertVisibleFocus(control, label) {
  const facts = await control.evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const outset = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const clippedBy = [];
    let opacity = 1;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const css = getComputedStyle(ancestor);
      opacity *= Number(css.opacity);
      if (ancestor === element) continue;
      // The root's scroll box is the viewport, not its own border box.
      const root = ancestor === document.documentElement;
      const bounds = root ? new DOMRect(0, 0, ancestor.clientWidth, ancestor.clientHeight) : ancestor.getBoundingClientRect();
      const paint = /paint|strict|content/.test(css.contain);
      const clipX = paint || /^(hidden|clip|auto|scroll)$/.test(css.overflowX);
      const clipY = paint || /^(hidden|clip|auto|scroll)$/.test(css.overflowY);
      const left = bounds.left + (root ? 0 : ancestor.clientLeft);
      const top = bounds.top + (root ? 0 : ancestor.clientTop);
      if ((clipX && (rect.left - outset < left - 1 || rect.right + outset > left + ancestor.clientWidth + 1))
        || (clipY && (rect.top - outset < top - 1 || rect.bottom + outset > top + ancestor.clientHeight + 1))) {
        clippedBy.push(ancestor.className);
      }
    }
    return {
      focused: document.activeElement === element && element.matches(":focus-visible"),
      outline: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor,
      opacity, clip: style.clip, clipPath: style.clipPath, clippedBy,
      size: [rect.width, rect.height]
    };
  });
  assert.equal(facts.focused, true, `${label}: must have keyboard focus`);
  assert.ok(facts.width >= 2 && facts.outline !== "none", `${label}: a visible outline is required`);
  assert.notEqual(facts.color, "rgba(0, 0, 0, 0)", `${label}: outline must not be transparent`);
  assert.equal(facts.opacity, 1, `${label}: focused control must not be transparent`);
  assert.equal(facts.clip, "auto", `${label}: focused control must not be visually hidden`);
  assert.equal(facts.clipPath, "none", `${label}: focused control must not be clipped`);
  assert.ok(facts.size.every(size => size >= 6), `${label}: control must have visible dimensions`);
  assert.deepEqual(facts.clippedBy, [], `${label}: the full focus outline must fit its clipping ancestors`);
}

async function tabTo(page, control, label) {
  await control.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await assertVisibleFocus(control, label);
}

async function installFocusFixture(page) {
  const fixture = await installDashboardApiFixture(page);
  fixture.request.quickAnalysis = true;
  const session = createTestLiveReportSession(501, "focus_visibility");
  const issues = Array.from({ length: 18 }, (_, index) => ({
    id: 9000 + index, requestId: 501, module: "rule_based", severity: "SERIOUS",
    title: `포커스 검사 ${index + 1}`, description: "문제 설명", recommendation: null,
    selector: `#missing-${index}`, wcagCode: "5.4.3", createdAt: "2026-09-01T00:00:00Z",
    locator: { kind: "DOM_PATH", pathSteps: [{ context: "MAIN_DOCUMENT", selector: `#missing-${index}`, frameUrl: null }],
      x: null, y: null, width: null, height: null, coordinateSpace: null, visible: true, htmlSnippet: "<p>Missing issue</p>" }
  }));
  const viewer = createTestLiveReportViewerHtml({ session }).replace(
    'if (message.type === "REQUEST_DOCUMENT_STATE") {',
    `if (message.type === "INIT_ISSUES") {
      message.issues.forEach(issue => send({type:"LOCATOR_STATUS",issueId:issue.id,status:"UNAVAILABLE",reason:"SELECTOR_NOT_FOUND"}));
    }
    if (message.type === "REQUEST_DOCUMENT_STATE") {`
  );
  // Override only these declared scenarios; all other API calls still go through
  // the shared fixture's isolation boundary, including unexpected mutations.
  await page.route("**/api/**", route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/results/requests/501/issues") return fulfillJson(route, issues);
    if (request.method() === "POST" && pathname === "/api/results/requests/501/live-session") return fulfillJson(route, session);
    if (request.method() === "GET" && request.url() === session.runtimeUrl) {
      return route.fulfill({ status: 200, contentType: "text/html", body: viewer });
    }
    return route.fallback();
  });
  return fixture;
}

const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem("bridge-theme", theme), theme);
      const fixture = await installFocusFixture(page);
      const name = `${viewport.width}-${theme}`;
      await page.goto(`${baseUrl}/projects/1`);
      await page.locator(".dashboard-project-card").waitFor();
      // The disclosure state lives on the separate chevron toggle.
      const projectToggle = page.locator(".sidebar-tree-toggle").first();
      if (await projectToggle.getAttribute("aria-expanded") === "false") await projectToggle.click();
      for (const selector of [".reference-sidebar-primary-row", ".sidebar-tree-parent-row", ".sidebar-tree-children .sidebar-nav-link", ".sidebar-tree-recent-list .sidebar-nav-link"]) {
        await tabTo(page, page.locator(selector).first(), `${name} sidebar ${selector}`);
      }
      await page.locator(".dashboard-sidebar").screenshot({ path: `${output}/${name}-sidebar.png` });
      const card = page.getByRole("button", { name: "CI Fixture Page 상세 보기", exact: true });
      await tabTo(page, card, `${name} page card`);
      await page.locator(".dashboard-project-card").screenshot({ path: `${output}/${name}-card.png` });
      await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
      const scroll = page.getByRole("region", { name: "페이지 추가 내용", exact: true });
      await tabTo(page, scroll, `${name} modal scroll region`);
      await page.getByRole("dialog").screenshot({ path: `${output}/${name}-modal.png` });
      await page.keyboard.press("Escape");

      await page.goto(`${baseUrl}/projects/1/pages/101`);
      const panel = page.getByRole("region", { name: "화면에 표시되지 않은 문제", exact: true });
      const toggle = panel.locator(".site-unavailable-locator-panel__group-toggle").first();
      const line = panel.locator(".site-unavailable-locator-panel__line").first();
      await line.waitFor({ timeout: 10_000 }).catch(async error => {
        console.error(JSON.stringify({ body: (await page.locator('body').innerText()).slice(0, 2000), errors,
          requests: fixture.journal, frames: page.frames().map(frame => frame.url()) }));
        throw error;
      });
      // Group headers and finding lines are ordinary buttons in tab order.
      await tabTo(page, toggle, `${name} issue group`);
      await page.keyboard.press("Tab");
      await assertVisibleFocus(line, `${name} issue line`);
      await panel.screenshot({ path: `${output}/${name}-issue-groups.png` });
      await toggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false", "Enter on a group header must close the group");
      await page.keyboard.press("Enter");
      assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Enter again must reopen the group");
      assert.deepEqual(errors, [], `${name}: no page errors`);
      fixture.assertIsolated();
      await context.close();
      console.log(`${name}: sidebar, page card, modal and issue groups PASS`);
    }
  }
} finally { await browser.close(); }
