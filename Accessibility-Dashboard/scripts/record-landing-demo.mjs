import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const videoDirectory = resolve("artifacts", "landing-demo");

await mkdir(videoDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  reducedMotion: "no-preference",
  recordVideo: {
    dir: videoDirectory,
    size: { width: 1920, height: 1080 }
  }
});
const page = await context.newPage();

async function addDemoCursor() {
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes uni-demo-click {
        from { opacity: 0.9; transform: translate(-50%, -50%) scale(0.25); }
        to { opacity: 0; transform: translate(-50%, -50%) scale(2.2); }
      }
      #uni-demo-cursor {
        position: fixed;
        z-index: 2147483647;
        width: 18px;
        height: 18px;
        border: 2px solid #ffffff;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.5);
        pointer-events: none;
        transform: translate(-50%, -50%);
        transition: left 560ms cubic-bezier(0.22, 1, 0.36, 1), top 560ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      .uni-demo-pulse {
        position: fixed;
        z-index: 2147483646;
        width: 18px;
        height: 18px;
        border: 1px solid rgba(255, 255, 255, 0.92);
        border-radius: 999px;
        pointer-events: none;
        animation: uni-demo-click 560ms ease-out forwards;
      }
    `;
    document.head.append(style);

    const cursor = document.createElement("div");
    cursor.id = "uni-demo-cursor";
    cursor.style.left = "44vw";
    cursor.style.top = "70vh";
    document.body.append(cursor);
  });
}

async function moveTo(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Could not locate demo target.");

  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    const cursor = document.querySelector("#uni-demo-cursor");
    if (cursor instanceof HTMLElement) {
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    }
  }, point);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(700);
  return point;
}

async function showClick(point) {
  await page.evaluate(({ x, y }) => {
    const pulse = document.createElement("div");
    pulse.className = "uni-demo-pulse";
    pulse.style.left = `${x}px`;
    pulse.style.top = `${y}px`;
    document.body.append(pulse);
    window.setTimeout(() => pulse.remove(), 600);
  }, point);
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
  await addDemoCursor();

  const analyzeCta = page.locator(".ora-hero__copy").getByRole("button", { name: "새 페이지 분석", exact: true });
  const point = await moveTo(analyzeCta);
  await showClick(point);
  await Promise.all([
    page.waitForURL("**/analyze"),
    analyzeCta.click()
  ]);
  await page.waitForTimeout(1800);
} finally {
  await context.close();
  await browser.close();
}

console.log(`Landing demo recorded in ${videoDirectory}`);
