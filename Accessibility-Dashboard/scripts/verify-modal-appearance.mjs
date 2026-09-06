import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installDashboardApiFixture } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const outDir = await fs.mkdtemp(path.resolve("artifacts/modal-appearance-"));
const browser = await chromium.launch({ headless: true });
const results = [];

async function measure(dialog) {
  await dialog.waitFor();
  return dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const sample = (node) => {
      const css = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return { background: css.backgroundColor, color: css.color, radius: css.borderRadius, height: box.height };
    };
    return {
      surface: { background: style.backgroundColor, color: style.color, border: style.borderColor, radius: style.borderRadius, shadow: style.boxShadow },
      inputs: [...element.querySelectorAll('input:not([type="radio"])')].map(sample),
      buttons: [...element.querySelectorAll("button")].map(sample),
      fits: rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth,
    };
  });
}

async function verifyTheme(theme, viewport) {
  const context = await browser.newContext({ colorScheme: theme, viewport });
  const page = await context.newPage();
  const fixture = await installDashboardApiFixture(page);
  await page.goto(`${baseUrl}/projects/${fixture.organization.id}`, { waitUntil: "networkidle" });
  const samples = {};
  async function capture(name, accessibleName, closeName) {
    const dialog = page.getByRole("dialog", { name: accessibleName, exact: true });
    samples[name] = await measure(dialog);
    assert.ok(samples[name].fits, `${theme} ${viewport.width}: ${name} must fit the viewport`);
    const expectedHeights = name === "settings" ? [36, 28]
      : samples[name].buttons.map(() => 28);
    assert.deepEqual(samples[name].buttons.map(button => button.height), expectedHeights,
      `${name}: retain the existing compact button sizes`);
    await dialog.screenshot({ path: path.join(outDir, `${theme}-${viewport.width}-${name}.png`) });
    await dialog.getByRole("button", { name: closeName, exact: true }).click();
  }
  await page.getByRole("button", { name: "프로젝트 추가", exact: true }).click();
  await capture("project-create", "프로젝트 추가", "취소");
  const project = page.getByRole("complementary").getByRole("button", { name: fixture.organization.name, exact: true });
  await project.click({ button: "right" });
  await page.getByRole("menuitem", { name: "수정", exact: true }).click();
  await capture("project-edit", "프로젝트 수정", "취소");
  await project.click({ button: "right" });
  await page.getByRole("menuitem", { name: "삭제", exact: true }).click();
  await capture("project-delete", "프로젝트 제거", "아니요");
  await page.getByRole("button", { name: "페이지 추가", exact: true }).click();
  await capture("page-create", "페이지 추가", "취소");
  await page.getByRole("button", { name: `${fixture.target.name} 제거`, exact: true }).click();
  await capture("page-delete", "페이지 제거", "취소");
  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "설정", exact: true }).click();
  await capture("settings", "설정", "닫기");
  const baseline = samples["project-create"];
  for (const [name, sample] of Object.entries(samples)) {
    assert.deepEqual(sample.surface, baseline.surface, `${name} must share the same modal surface in ${theme}`);
    for (const input of sample.inputs) {
      assert.deepEqual(input, baseline.inputs[0], `${name} inputs must match project creation`);
    }
  }
  assert.notEqual(baseline.surface.background, theme === "dark" ? "rgb(255, 255, 255)" : "rgb(28, 28, 30)");
  fixture.assertIsolated();
  results.push({ theme, viewport, samples });
  await context.close();
}

async function verifyFallbacks(theme) {
  const context = await browser.newContext({ colorScheme: theme });
  const page = await context.newPage();
  const fixture = await installDashboardApiFixture(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/src/components/dashboard/modals/account-settings-modal.tsx*", async route => {
    await gate;
    await route.abort("failed");
  });
  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "설정", exact: true }).click();
  const loading = page.getByRole("status").filter({ hasText: "창을 불러오는 중..." });
  const loadingSample = await measure(loading);
  release();
  const error = page.getByRole("alertdialog", { name: "창을 표시할 수 없습니다" });
  const errorSample = await measure(error);
  const baseline = results.find(result => result.theme === theme).samples["project-create"].surface;
  assert.deepEqual(loadingSample.surface, baseline, "loading modal must inherit the theme");
  assert.deepEqual(errorSample.surface, baseline, "error modal must inherit the theme");
  assert.deepEqual(errorSample.buttons.map(button => button.height), [28, 28], "error actions must use compact modal buttons");
  assert.equal(await error.getByRole("button", { name: "새로고침", exact: true }).count(), 1);
  await error.screenshot({ path: path.join(outDir, `${theme}-error.png`) });
  await error.getByRole("button", { name: "닫기", exact: true }).click();
  fixture.assertIsolated();
  await context.close();
}

try {
  for (const theme of ["dark", "light"]) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 568 }]) {
      await verifyTheme(theme, viewport);
    }
    await verifyFallbacks(theme);
  }
  await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ result: "PASS", themes: 2, modalViews: 28, outDir }));
} finally {
  await browser.close();
}
