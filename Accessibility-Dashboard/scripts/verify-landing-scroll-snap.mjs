import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const browser = await chromium.launch();
const baseUrl = resolveTestBaseUrl();
const cases = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
  { width: 390, height: 844, mobile: true },
  { width: 320, height: 700, mobile: true }
];
const at = (page, y) => page.waitForFunction(target => Math.abs(scrollY - target) < 2, y);
async function position(page, y) {
  await page.evaluate(top => window.scrollTo({ top, behavior: "instant" }), y);
  await at(page, y);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function checkUnchanged(page, y) {
  // Exceed the idle delay and animation duration to detect unwanted corrections.
  await page.waitForTimeout(600);
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - y) < 2, `unexpected snap from ${y}`);
}

try {
  for (const viewport of cases) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: Boolean(viewport.mobile), hasTouch: Boolean(viewport.mobile),
      reducedMotion: "reduce"
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => route.abort());
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator('[data-scroll-world-ready="true"]').waitFor();
    const unit = Math.min(viewport.height, 1080);
    const input = unit * 2.25;
    const measurements = await page.evaluate(() => ({
      film: document.querySelector('.sw-track').getBoundingClientRect().height - innerHeight,
      findings: document.querySelector('.ua-findings__track').getBoundingClientRect().height - innerHeight
    }));
    assert.ok(Math.abs(measurements.film - 7.5 * unit) < 1, "film scroll distance must be capped independently of screen size");
    assert.ok(Math.abs(measurements.findings - 4.2 * unit) < 1, "findings scroll distance must be capped");

    await position(page, input - 180);
    await checkUnchanged(page, input - 180);
    await page.mouse.wheel(0, 80);
    await at(page, input);
    await page.locator('#sw-section-input[aria-hidden="false"]').waitFor();
    await page.mouse.wheel(0, 70);
    await at(page, input + 70);
    await checkUnchanged(page, input + 70); // Leaving an anchor must not pull the user back.
    await position(page, input + 180);
    await page.mouse.wheel(0, -80);
    await at(page, input);
    await position(page, input - 120);
    await page.keyboard.press("ArrowDown");
    await at(page, input);

    const findings = await page.locator('[data-landing-snap="findings-2"]').evaluate(el => scrollY + el.getBoundingClientRect().top);
    await position(page, findings - 180);
    await page.mouse.wheel(0, 80);
    await at(page, findings);
    await page.waitForFunction(() => document.querySelector('.ua-findings__steps li.is-active .ua-findings__number')?.textContent === '01');

    if (viewport.mobile) {
      await position(page, input - 180);
      const session = await context.newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 500 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150, y: 420 }] });
      await page.waitForTimeout(100);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await at(page, input);
      await session.detach();
    }

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await position(page, input - 300);
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(target => scrollY > target - 215 && scrollY < target - 5, input);
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(target => scrollY < target - 400, input);
    const interrupted = await page.evaluate(() => scrollY);
    await checkUnchanged(page, interrupted);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await position(page, input - 180);
    await page.mouse.wheel(0, 80);
    await page.locator('.sw-topcta').click();
    await page.waitForURL('**/analyze');
    await checkUnchanged(page, 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}x${viewport.height}: wheel, keyboard, reverse, interruption, cleanup${viewport.mobile ? ', touch' : ''}`);
    await context.close();
  }
} finally {
  await browser.close();
}
