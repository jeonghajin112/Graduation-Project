import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const outDir = process.env.OUT_DIR ?? "artifacts/landing-media-quality";
mkdirSync(outDir, { recursive: true });
const cases = [
  { width: 1920, height: 1080, resolution: 3840 },
  { width: 1280, height: 900, resolution: 3840 },
  { width: 2560, height: 1440, resolution: 3840 },
  { width: 1920, height: 1080, dpr: 2, resolution: 3840 },
  { width: 1920, height: 1500, resolution: 3840 },
  { width: 3840, height: 2160, resolution: 3840 },
  { width: 390, height: 844, static: true },
  { width: 1440, height: 900, static: true, reduce: true },
  { width: 1440, height: 900, static: true, saveData: true }
];
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const scenario of cases) {
    console.log(`Opening: ${scenario.width}x${scenario.height}@${scenario.dpr ?? 1} ${scenario.static ? "static" : scenario.resolution}`);
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      deviceScaleFactor: scenario.dpr ?? 1,
      reducedMotion: scenario.reduce ? "reduce" : "no-preference"
    });
    try {
      if (scenario.saveData) await context.addInitScript(() => {
        Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
      });
      const page = await context.newPage();
      const requests = [];
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (new URL(request.url()).pathname.endsWith(".mp4")) requests.push(request.url());
      });
      await page.route("**/api/**", route => route.abort());
      await page.goto(baseUrl);
      await page.locator('[data-scroll-world-ready="true"]').waitFor();
      if (scenario.static) {
        await page.locator('.sw-scene__still').first().evaluate(image => image.decode());
        await page.waitForTimeout(200);
        assert.equal(await page.locator("video").count(), 0);
        assert.deepEqual(requests, [], "Static mode must not download a video");
        results.push({ ...scenario, requests });
      } else {
        await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
        const expectedPath = "/landing/scroll-world/vid/opening.mp4";
        assert.deepEqual(requests.map(url => new URL(url).pathname), [expectedPath], "Initially load only the suitable opening variant");
        let previousTime = -1;
        for (const position of [0.2, 0.4]) {
          await page.evaluate(p => window.scrollTo(0, innerHeight * p), position);
          await page.waitForFunction(previous => {
            const video = document.querySelector("video");
            return video && !video.seeking && video.readyState >= 2 && video.currentTime > previous + 0.05;
          }, previousTime, { timeout: 15_000 }).catch(async error => {
            console.error(await page.evaluate(() => ({ scrollY, height: innerHeight,
              videos: [...document.querySelectorAll("video")].map(v => ({ time: v.currentTime, seeking: v.seeking, ready: v.readyState })) })));
            throw error;
          });
          previousTime = await page.locator(".sw-scene").first().locator("video").evaluate(video => video.currentTime);
        }
        const media = await page.locator(".sw-scene").first().locator("video").evaluate(video => ({
          width: video.videoWidth, height: video.videoHeight, duration: video.duration
        }));
        assert.deepEqual([media.width, media.height], [scenario.resolution, scenario.resolution * 9 / 16]);
        assert.ok(media.duration > 8 && media.duration < 9);
        assert.deepEqual(requests.map(url => new URL(url).pathname).filter(path => path.includes("/opening")),
          [expectedPath], "Scrolling must not download another opening variant");
        const bytes = await page.evaluate(path => performance.getEntriesByType("resource")
          .find(entry => new URL(entry.name).pathname === path)?.encodedBodySize, expectedPath);
        const budget = 8 * 1024 * 1024;
        assert.ok(bytes > 0 && bytes <= budget, `Opening exceeded its transfer budget: ${bytes}/${budget}`);
        assert.ok(requests[0].includes("?v="), "Opening media changes must bypass the previous cached version");
        if (scenario.width === 1920 && scenario.height === 1080 && !scenario.dpr) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForFunction(() => document.querySelector("video").currentTime < 0.1);
          await page.screenshot({ path: `${outDir}/opening-desktop.png` });
        }
        results.push({ ...scenario, media, bytes, requests });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 2));
  console.log(`Landing opening quality: ${results.length} viewport/density/static-mode checks passed.`);
} finally { await browser.close(); }
