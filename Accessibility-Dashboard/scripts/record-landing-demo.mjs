/**
 * Record the running service and its real analysis flow. No API interception,
 * sample data, replacement viewer, or animation timeline changes are used.
 *
 * Set BASE_URL to the running frontend and LANDING_TARGET_ID to an existing page.
 * npm run record:landing -- --stills-only    (review PNGs before encoding)
 * npm run record:landing -- --publish        (replace all four scenes together)
 * Requires ffmpeg. Each new run, including --stills-only, starts ONE REAL analysis.
 * --resume-results with LANDING_RECORDING_DIR reuses recorded input/progress and
 * opens the service's existing completed result without starting another scan.
 * --resume-analysis reuses recorded input and its still-active request ID.
 * LANDING_MARKER_ID optionally selects a real issue marker for the report scene.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const runFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.env.BASE_URL, "Set BASE_URL to the real running frontend.");
const baseUrl = resolveTestBaseUrl();
const targetId = Number(process.env.LANDING_TARGET_ID);
assert.ok(Number.isSafeInteger(targetId) && targetId > 0, "Set LANDING_TARGET_ID to an existing real page ID.");
const overviewResponse = await fetch(baseUrl + "/api/dashboard/overview");
assert.ok(overviewResponse.ok, "The real dashboard API must be available.");
const overviewEnvelope = await overviewResponse.json();
assert.equal(overviewEnvelope.success, true);
const project = overviewEnvelope.data.organizations.find(item => item.evaluationTargets.some(target => target.id === targetId));
const target = project?.evaluationTargets.find(item => item.id === targetId);
assert.ok(target, "The requested real page is missing from the dashboard.");
const reportPath = "/projects/" + project.id + "/pages/" + target.id;
const overviewPath = "/projects/" + project.id;
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--stills-only", "--publish", "--resume-results", "--resume-analysis"].includes(arg)) throw new Error("Unknown option: " + arg);
}
const stillsOnly = args.has("--stills-only");
const resumeResults = args.has("--resume-results");
const resumeAnalysis = args.has("--resume-analysis");
assert.ok(!(resumeResults && resumeAnalysis), "Choose one recording resume point.");
assert.ok(!(stillsOnly && args.has("--publish")), "Publishing requires posters and videos together.");
const recordingsRoot = join(root, "artifacts/landing-recordings");
const output = resumeResults || resumeAnalysis
  ? resolve(process.env.LANDING_RECORDING_DIR || "")
  : join(recordingsRoot, new Date().toISOString().replace(/[:.]/g, "-"));
assert.ok(output.startsWith(recordingsRoot + "/") || output.startsWith(recordingsRoot + "\\"),
  "Resumed recordings must stay inside artifacts/landing-recordings.");
const mediaOutput = join(output, "media");
const FPS = 12;
const FRAME_COUNT = 48;
const variants = [
  { suffix: "", width: 3840, height: 2160, crf: 18 },
  { suffix: "-1440", width: 2560, height: 1440, crf: 19 },
  { suffix: "-1080", width: 1920, height: 1080, crf: 20 }
];
await mkdir(join(mediaOutput, "vid"), { recursive: true });

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

async function encodeScene(scene, frameDirectory, posterPath) {
  await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", posterPath,
    "-frames:v", "1", "-c:v", "libwebp", "-quality", "90", join(mediaOutput, scene + ".webp")], { windowsHide: true });
  for (const variant of variants) {
    await runFile("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS),
      "-i", join(frameDirectory, "%04d.png"),
      "-vf", "scale=" + variant.width + ":" + variant.height + ":flags=lanczos,fps=30",
      "-c:v", "libx264", "-preset", "fast", "-crf", String(variant.crf), "-threads", "2",
      "-pix_fmt", "yuv420p", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0",
      "-bf", "0", "-an", "-movflags", "+faststart", join(mediaOutput, "vid", scene + variant.suffix + ".mp4")
    ], { windowsHide: true });
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
  colorScheme: "light", reducedMotion: "no-preference", locale: "ko-KR", timezoneId: "Asia/Seoul",
  serviceWorkers: "block"
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));
const previousCapture = resumeResults || resumeAnalysis ? JSON.parse(await readFile(join(output, "capture-manifest.json"), "utf8")) : null;
let analysisRequestId = previousCapture?.analysisRequestId ?? null;
if (previousCapture) {
  assert.equal(previousCapture.sampleData, false, "Only real recordings may be resumed.");
  assert.equal(previousCapture.targetId, target.id);
  for (const scene of resumeResults ? ["input", "analyze"] : ["input"]) {
    assert.ok(previousCapture.scenes.some(item => item.scene === scene && item.verified));
    await access(join(mediaOutput, scene + ".webp"));
    for (const variant of variants) await access(join(mediaOutput, "vid", scene + variant.suffix + ".mp4"));
  }
}
const scenes = previousCapture?.scenes.filter(item => (resumeResults ? ["input", "analyze"] : ["input"]).includes(item.scene)) ?? [];
async function saveManifest() {
  await writeFile(join(output, "capture-manifest.json"), JSON.stringify({
    capturedAt: new Date().toISOString(), sampleData: false,
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, framesPerSecond: FPS,
    source: "Real running service, real analysis request and live upstream page",
    targetId: target.id, projectId: project.id, targetUrl: target.accessUrl,
    analysisRequestId,
    resultSource: resumeResults ? "Previously completed real analysis stored in the service" : "New real analysis",
    scenes, variants: stillsOnly ? [] : variants
  }, null, 2));
}

async function verifyScene(scene) {
  if (scene === "input") {
    assert.equal(await page.getByRole("textbox", { name: "페이지 주소", exact: true }).inputValue(), target.accessUrl);
    assert.equal(await page.getByRole("button", { name: "분석 시작", exact: true }).isEnabled(), true);
  } else if (scene === "analyze") {
    assert.equal(new URL(page.url()).pathname, "/recent-pages/" + target.id,
      "The recording must show the current page-based analysis flow.");
    assert.equal(await page.locator('.quick-analysis-progress[data-phase="running"]').count(), 1);
    assert.match(await page.locator('.quick-analysis-step[aria-current="step"]').innerText(), /접근성 검사/);
  } else if (scene === "report") {
    assert.equal(await page.locator('.site-page-evidence-preview[aria-busy="false"][data-connection-state="ready"]').count(), 1);
    const viewer = page.frameLocator('iframe[data-report-mode="live"]');
    assert.ok(await viewer.locator(".ap-live-marker:visible").count() >= 1);
    assert.equal(await viewer.locator(".ap-live-popover:visible").count(), 1);
    assert.equal(await page.getByRole("dialog", { name: "문제 위치 정보", exact: true }).isVisible(), false,
      "The landing recording must stay on the live marker explanation.");
    assert.equal(await page.getByRole("complementary", { name: "최근 분석 추이", exact: true }).isVisible(), true);
    const pageInformation = page.getByRole("region", { name: "페이지 정보", exact: true });
    assert.equal(await pageInformation.getByRole("button", { name: "재분석", exact: true }).isEnabled(), true);
  } else {
    assert.ok(await page.locator(".dashboard-project-card").count() >= 1, "Overview must contain loaded page cards.");
    assert.ok(await page.locator('.dashboard-project-card [aria-label^="점수 "]:not([aria-label="점수 없음"])').count() >= 1);
  }
  assert.equal(await page.getByRole("alert").count(), 0, scene + ": unexpected error UI");
  assert.deepEqual(pageErrors, [], scene + ": browser error");
}

async function captureScene(scene, renderFrame, posterFrame = 30) {
  console.log("Capturing " + scene + " from the current application…");
  const frameDirectory = join(output, scene);
  await mkdir(frameDirectory, { recursive: true });
  const posterPath = join(output, scene + ".png");
  const indices = stillsOnly ? [posterFrame] : Array.from({ length: FRAME_COUNT }, (_, i) => i);
  for (const frame of indices) {
    await renderFrame(frame);
    await settle(page);
    if (frame === posterFrame) await verifyScene(scene);
    const framePath = join(frameDirectory, String(frame).padStart(4, "0") + ".png");
    await page.screenshot({ path: framePath, type: "png" });
    if (frame === posterFrame) await copyFile(framePath, posterPath);
  }
  if (!stillsOnly) {
    console.log("Encoding " + scene + ": 4K, 1440p, 1080p and WebP…");
    await encodeScene(scene, frameDirectory, posterPath);
  }
  scenes.push({ scene, posterPath, frames: indices.length, source: page.url(), verified: true });
  await saveManifest();
}

try {
  if (!resumeResults) {
  await page.goto(baseUrl + "/analyze", { waitUntil: "networkidle" });
  if (!resumeAnalysis) {
  const urlInput = page.getByRole("textbox", { name: "페이지 주소", exact: true });
  await urlInput.waitFor();
  await settle(page);
  await captureScene("input", async frame => {
    const typedLength = Math.ceil(Math.max(0, Math.min(1, frame / 24)) * target.accessUrl.length);
    await urlInput.fill(target.accessUrl.slice(0, typedLength));
    if (frame >= 24) await urlInput.blur();
  });

  await urlInput.fill(target.accessUrl);
  const acceptedResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/requests/evaluate" && response.request().method() === "POST");
  await page.getByRole("button", { name: "분석 시작", exact: true }).click();
  const response = await acceptedResponse;
  assert.ok(response.ok(), "The real analysis request must be accepted.");
  const receipt = await response.json();
  assert.equal(receipt.success, true);
  assert.equal(receipt.data.evaluationTargetId, target.id);
  analysisRequestId = receipt.data.id;
  await saveManifest();
  console.log("Real analysis accepted: request " + analysisRequestId);
  } else {
    assert.ok(Number.isSafeInteger(analysisRequestId) && analysisRequestId > 0,
      "The previous recording must identify the real analysis request to resume.");
    const resumedResponse = await context.request.get(baseUrl + "/api/requests/" + analysisRequestId);
    assert.ok(resumedResponse.ok());
    const resumedReceipt = await resumedResponse.json();
    assert.equal(resumedReceipt.data.evaluationTargetId, target.id);
    assert.ok(["PENDING", "IN_PROGRESS"].includes(resumedReceipt.data.status),
      "The real analysis must still be active to record its progress.");
    console.log("Resuming real analysis recording: request " + analysisRequestId);
  }
  // Accepted requests leave the URL form ready for the next page. Open the
  // real sidebar entry just as a user does to view this page's live status.
  await page.locator(".sidebar-tree-recent-list").getByRole("button", {
    name: target.name + " 페이지 열기 (" + project.name + " 프로젝트)", exact: true
  }).click();
  await page.locator('.quick-analysis-progress[data-phase="running"]').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".quick-analysis-progress")).opacity === "1");
  await captureScene("analyze", async () => {}, 24);

  console.log("Waiting for the real analysis to finish…");
  await page.waitForFunction(resultPath => {
    const phase = document.querySelector(".quick-analysis-progress")?.getAttribute("data-phase");
    // The sidebar can open this page while its request is still running.
    // The URL alone does not mean the analysis has completed.
    return (location.pathname === resultPath && !!document.querySelector(".site-page-information")) ||
      phase === "failed" || phase === "paused";
  }, "/recent-pages/" + target.id, { timeout: 900_000 });
  assert.equal(new URL(page.url()).pathname, "/recent-pages/" + target.id,
    "The real analysis did not complete. Inspect capture-error.png; do not publish a simulated result.");
  const completedResponse = await context.request.get(baseUrl + "/api/requests/" + analysisRequestId);
  assert.ok(completedResponse.ok());
  const completedReceipt = await completedResponse.json();
  assert.equal(completedReceipt.data.status, "COMPLETED",
    "Only the newly completed real analysis may be used for a fresh recording.");
  }
  await page.goto(baseUrl + reportPath, { waitUntil: "domcontentloaded" });
  await page.locator('.site-page-evidence-preview[aria-busy="false"][data-connection-state="ready"]').waitFor({ timeout: 60_000 });
  const viewer = page.frameLocator('iframe[data-report-mode="live"]');
  const markerId = process.env.LANDING_MARKER_ID;
  assert.ok(!markerId || /^\d+$/.test(markerId), "LANDING_MARKER_ID must be a real numeric issue ID.");
  const marker = markerId
    ? viewer.locator('.ap-live-marker[data-issue-id="' + markerId + '"]')
    : viewer.locator(".ap-live-marker:visible").first();
  await marker.waitFor();
  await settle(page);
  let markerOpened = false;
  await captureScene("report", async frame => {
    if (frame >= 12) {
      // The real viewer positions markers in a zero-size overflow layer. Move
      // the real pointer to its rendered box instead of scrolling that layer.
      if (!markerOpened) {
        const box = await marker.boundingBox();
        assert.ok(box && box.width > 0 && box.height > 0, "A visible marker is required for the report recording.");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        markerOpened = true;
      }
      await viewer.locator(".ap-live-popover:visible").waitFor();
    } else {
      await page.mouse.move(1, 1);
    }
  });

  await page.goto(baseUrl + overviewPath, { waitUntil: "networkidle" });
  await page.locator(".dashboard-project-card").first().waitFor();
  await settle(page);
  await captureScene("overview", async () => { await page.mouse.move(1, 1); });

  assert.deepEqual(pageErrors, []);
  await saveManifest();
  if (args.has("--publish")) {
    const destination = join(root, "public/landing/scroll-world");
    for (const { scene } of scenes) {
      await copyFile(join(mediaOutput, scene + ".webp"), join(destination, scene + ".webp"));
      for (const { suffix } of variants) {
        await copyFile(join(mediaOutput, "vid", scene + suffix + ".mp4"), join(destination, "vid", scene + suffix + ".mp4"));
      }
    }
    console.log("Updated all four landing UI posters and twelve videos.");
  }
  console.log("Verified capture: " + output);
} catch (error) {
  await page.screenshot({ path: join(output, "capture-error.png") }).catch(() => undefined);
  await writeFile(join(output, "capture-error.txt"), String(error) + "\n" + await page.locator("body").innerText()).catch(() => undefined);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
