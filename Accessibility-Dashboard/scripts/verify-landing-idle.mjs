import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    window.scrubFrames = 0;
    const schedule = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => schedule(time => {
      if (callback.name === "raf") window.scrubFrames++;
      callback(time);
    });
  });
  await page.goto(resolveTestBaseUrl());
  await page.locator('[data-scroll-world-ready="true"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("video")].some(video => video.readyState >= 2));
  await page.waitForTimeout(700);
  const countIdleFrames = async () => {
    const before = await page.evaluate(() => window.scrubFrames);
    await page.waitForTimeout(600);
    return await page.evaluate(() => window.scrubFrames) - before;
  };
  const idleFrames = await countIdleFrames();
  console.log(JSON.stringify({ idleFrames, windowMs: 600 }));
  if (process.env.MEASURE_LANDING_BASELINE === "1") process.exitCode = 0;
  else {
    assert.equal(idleFrames, 0, "settled landing must stop scrub RAF work");
    for (const position of [500, 0]) {
      const before = await page.evaluate(() => window.scrubFrames);
      await page.evaluate(y => scrollTo(0, y), position);
      await page.waitForFunction(count => window.scrubFrames > count, before);
      await page.waitForFunction(() => {
        if (window.lastScrubCount !== window.scrubFrames) {
          window.lastScrubCount = window.scrubFrames;
          window.lastScrubChange = performance.now();
        }
        return performance.now() - window.lastScrubChange >= 600;
      }, undefined, { timeout: 10000 });
      assert.equal(await countIdleFrames(), 0, "scrolling must resume and settle again");
    }
  }
} finally { await browser.close(); }
