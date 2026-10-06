/**
 * Record the running service and its real analysis flow. No API interception,
 * sample data, replacement viewer, or animation timeline changes are used.
 *
 * Set BASE_URL to the running frontend and LANDING_TARGET_ID to an existing page.
 * npm run record:landing -- --stills-only    (review PNGs before encoding)
 * npm run record:landing -- --publish        (replace all four scenes together)
 * npm run record:landing -- --report-only --with-findings --publish
 * Successful video runs remove sequence PNGs; --keep-frames retains them.
 * Stills-only and failed runs always retain their frames.
 * Requires ffmpeg. New full runs, including --stills-only, start ONE REAL analysis.
 * --resume-results with LANDING_RECORDING_DIR reuses recorded input/progress and
 * opens the service's existing completed result without starting another scan.
 * --resume-analysis reuses recorded input and its still-active request ID.
 * --report-only records the existing live page without starting another scan.
 * The report scene includes the current header, rendered page and summary rail.
 * --with-findings also captures a real issue popover; set LANDING_ISSUE_ID to
 * an issue on the selected page. Inspect the capture before publishing it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";
import { cleanupRecordingFrames } from "./artifact-retention.mjs";
import { readReportFrameState, waitForReportFrame, assertSameReportFrame } from "./fixtures/landing-report-readiness.mjs";

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
  if (!["--stills-only", "--publish", "--resume-results", "--resume-analysis", "--report-only", "--with-findings", "--keep-frames"].includes(arg)) throw new Error("Unknown option: " + arg);
}
const stillsOnly = args.has("--stills-only");
const resumeResults = args.has("--resume-results");
const resumeAnalysis = args.has("--resume-analysis");
const reportOnly = args.has("--report-only");
const withFindings = args.has("--with-findings");
const findingsIssueId = Number(process.env.LANDING_ISSUE_ID);
assert.ok(!withFindings || reportOnly, "Use --report-only with --with-findings to preserve the selected issue ID.");
if (withFindings) assert.ok(Number.isSafeInteger(findingsIssueId) && findingsIssueId > 0,
  "Set LANDING_ISSUE_ID to an existing issue on the recorded page.");
assert.ok(!(resumeResults && resumeAnalysis), "Choose one recording resume point.");
assert.ok(!(reportOnly && (resumeResults || resumeAnalysis)), "Report-only recording does not resume a full recording.");
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
    "-vf", "scale=3840:2160:force_original_aspect_ratio=decrease", "-frames:v", "1", "-c:v", "libwebp", "-quality", "90",
    join(mediaOutput, scene + ".webp")], { windowsHide: true });
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
// Capture the ordinary desktop layout at higher pixel density. Enlarging the
// CSS viewport to obtain 4K pixels activates a different, disproportionately
// small summary rail when the recording is displayed on the landing page.
const capturePixelRatio = 3;
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 }, deviceScaleFactor: capturePixelRatio,
  colorScheme: "light", reducedMotion: "no-preference", locale: "ko-KR", timezoneId: "Asia/Seoul",
  serviceWorkers: "block"
});
const page = await context.newPage();
const pageErrors = [];
const upstreamWarnings = [];
page.on("pageerror", error => {
  // Hongik's URL named jquery-2.2.4.min.js currently serves jQuery 3.7.1,
  // which its own Bootstrap 3 rejects. Preserve this verified upstream error
  // in the manifest; all app/bridge and other script errors still fail capture.
  const knownUpstreamMismatch = new URL(target.accessUrl).hostname === "www.hongik.ac.kr"
    && error.message === "Bootstrap's JavaScript requires jQuery version 1.9.1 or higher, but lower than version 3"
    && /bootstrap\.min\.js/.test(error.stack || "");
  if (knownUpstreamMismatch) upstreamWarnings.push(error.message);
  else pageErrors.push(error.message);
});
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
let findingsCapture = null;
async function saveManifest() {
  await writeFile(join(output, "capture-manifest.json"), JSON.stringify({
    capturedAt: new Date().toISOString(), sampleData: false,
    viewport: page.viewportSize(), deviceScaleFactor: capturePixelRatio, framesPerSecond: FPS,
    source: "Real running service, real analysis request and live upstream page",
    targetId: target.id, projectId: project.id, targetUrl: target.accessUrl,
    analysisRequestId,
    resultSource: resumeResults || reportOnly ? "Previously completed real analysis stored in the service" : "New real analysis",
    scenes, findings: findingsCapture, upstreamWarnings, variants: stillsOnly ? [] : variants
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
    assert.equal(page.viewportSize().width, 1920, "Record the normal desktop layout, not an ultrawide layout.");
    assert.equal(await page.locator('.site-page-evidence-preview[aria-busy="false"][data-connection-state="ready"]').count(), 1);
    const viewer = page.frameLocator('iframe[data-report-mode="live"]');
    assert.ok(await viewer.locator("body").innerText(), "The live upstream page must contain real content.");
    assert.equal(await viewer.locator(".ap-live-popover:visible").count(), 0);
    assert.equal(await page.getByRole("dialog", { name: "문제 상세", exact: true }).isVisible(), false,
      "The page-view recording must not open issue details.");
    assert.equal(await page.getByRole("complementary", { name: "최근 분석 추이", exact: true }).isVisible(), true);
    const pageChrome = page.locator(".site-page-evidence-chrome");
    const chromeSurface = await pageChrome.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, blur: style.backdropFilter };
    });
    assert.equal(chromeSurface.blur, "none", "The landing recording must use the opaque report header.");
    assert.match(chromeSurface.background, /^rgb\(/, "The recorded header must not show the source page through it.");
    assert.equal(await pageChrome.getByRole("button", { name: "재분석", exact: true }).isEnabled(), true);
    assert.equal(await pageChrome.locator("h2").innerText(),
      await viewer.locator("html").evaluate(() => document.title.trim()));
    assert.equal(await pageChrome.getByRole("link").getAttribute("href"), target.accessUrl);
    assert.equal(await pageChrome.locator(".site-page-analysis-actions__metadata dd").count(), 1);
    assert.equal(await page.getByRole("complementary", { name: "페이지 정보", exact: true }).count(), 0);
    const layout = await page.locator('.site-dashboard-layout').evaluate(element => {
      const rail = element.querySelector('.site-dashboard-rail');
      const heading = rail?.querySelector('h3');
      return { railRatio: rail.getBoundingClientRect().width / element.getBoundingClientRect().width,
        headingSize: parseFloat(getComputedStyle(heading).fontSize) };
    });
    assert.ok(layout.railRatio >= 0.19 && layout.railRatio <= 0.3 && layout.headingSize >= 14,
      `The recording must retain the desktop rail proportions and readable type: ${JSON.stringify(layout)}`);
  } else {
    assert.ok(await page.locator(".dashboard-project-card").count() >= 1, "Overview must contain loaded page cards.");
    assert.ok(await page.locator('.dashboard-project-card [aria-label^="점수 "]:not([aria-label="점수 없음"])').count() >= 1);
  }
  assert.equal(await page.getByRole("alert").count(), 0, scene + ": unexpected error UI");
  assert.deepEqual(pageErrors, [], scene + ": browser error");
}

async function captureScene(scene, renderFrame, posterFrame = 30, clip) {
  console.log("Capturing " + scene + " from the current application…");
  const frameDirectory = join(output, scene);
  await mkdir(frameDirectory, { recursive: true });
  const posterPath = join(output, scene + ".png");
  const indices = stillsOnly ? [posterFrame] : Array.from({ length: FRAME_COUNT }, (_, i) => i);
  const reportViewer = scene === 'report' ? page.frameLocator('iframe[data-report-mode="live"]') : null;
  let documentEpoch;
  for (const frame of indices) {
    const framePath = join(frameDirectory, String(frame).padStart(4, "0") + ".png");
    for (let attempt = 0; ; attempt++) {
      await renderFrame(frame);
      await settle(page);
      try {
        const before = reportViewer ? await waitForReportFrame(page, reportViewer) : null;
        if (before) {
          documentEpoch ??= before.documentEpoch;
          assert.equal(before.documentEpoch, documentEpoch, 'The viewer reloaded; restart the report recording');
        }
        if (reportViewer || frame === posterFrame) await verifyScene(scene);
        await page.screenshot({ path: framePath, type: "png", ...(clip ? { clip } : {}) });
        if (before) assertSameReportFrame(before, await readReportFrameState(page, reportViewer));
        break;
      } catch (error) {
        if (!reportViewer || attempt >= 2) throw error;
        console.log(`Retrying report frame ${frame}: ${error.message}`);
      }
    }
    if (frame === posterFrame) await copyFile(framePath, posterPath);
  }
  if (!stillsOnly) {
    console.log("Encoding " + scene + ": 4K, 1440p, 1080p and WebP…");
    await encodeScene(scene, frameDirectory, posterPath);
  }
  scenes.push({ scene, posterPath, frames: indices.length, source: page.url(), viewport: page.viewportSize(),
    ...(clip ? { captureRegion: clip } : {}), verified: true });
  await saveManifest();
}

try {
  if (!resumeResults && !reportOnly) {
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
    return (location.pathname === resultPath && !!document.querySelector(".site-page-evidence-chrome")) ||
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
  // Include the complete result layout, excluding only the navigation sidebar.
  // Resize the browser so the real responsive layout fits the 16:9 media frame.
  const reportWidth = 1920;
  const reportHeight = reportWidth * 9 / 16;
  await page.setViewportSize({ width: reportWidth, height: reportHeight });
  await page.goto(baseUrl + reportPath, { waitUntil: "domcontentloaded" });
  await page.locator('.site-page-evidence-preview[aria-busy="false"][data-connection-state="ready"]').waitFor({ timeout: 60_000 });
  await settle(page);
  const layoutBox = await page.locator(".site-dashboard-layout").boundingBox();
  assert.ok(layoutBox);
  await page.setViewportSize({ width: reportWidth,
    height: Math.ceil(layoutBox.width * 9 / 16 + reportHeight - layoutBox.height) });
  await settle(page);
  const viewer = page.frameLocator('iframe[data-report-mode="live"]');
  await viewer.locator("html").evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo({ top: 0, behavior: "instant" });
    await Promise.all([...document.images].filter(image => image.getBoundingClientRect().top < innerHeight)
      .map(image => image.decode().catch(() => undefined)));
  });
  const resultBox = await page.locator(".site-dashboard-layout").boundingBox();
  assert.ok(resultBox && resultBox.width * capturePixelRatio >= 3840, "The result capture must provide native 4K pixels.");
  const reportClip = { x: resultBox.x, y: resultBox.y, width: resultBox.width, height: resultBox.width * 9 / 16 };
  assert.ok(Math.abs(reportClip.height - resultBox.height) <= 1, "The full result must fit the recording frame.");
  const maximumScroll = await viewer.locator("html").evaluate(() => document.documentElement.scrollHeight - innerHeight);
  const scrollDistance = Math.min(reportClip.height * 0.72, Math.max(0, maximumScroll));
  await page.mouse.move(1, 1);
  await settle(page);
  await captureScene("report", async frame => {
    const progress = Math.max(0, Math.min(1, (frame - 8) / 32));
    const eased = progress * progress * (3 - 2 * progress);
    await viewer.locator("html").evaluate((_, top) => window.scrollTo({ top, behavior: "instant" }), Math.round(scrollDistance * eased));
  }, 0, reportClip);

  if (withFindings) {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await settle(page);
    const card = page.locator(".site-page-evidence-card");
    const initialBox = await card.boundingBox();
    assert.ok(initialBox);
    await page.setViewportSize({ width: 1920,
      height: Math.ceil(initialBox.width * 9 / 16 + 1080 - initialBox.height) });
    await viewer.locator("html").evaluate(() => window.scrollTo({ top: 160, behavior: "instant" }));
    const marker = viewer.locator(`.ap-live-marker[data-issue-id="${findingsIssueId}"]`);
    // Offscreen markers are hidden by the bridge. Bring the source content into
    // view before clicking instead of relying on locator.click to scroll it.
    const scan = await viewer.locator("html").evaluate(() => ({
      step: Math.max(200, innerHeight / 2), max: document.documentElement.scrollHeight - innerHeight
    }));
    for (let top = 160; top <= scan.max + scan.step; top += scan.step) {
      await viewer.locator("html").evaluate((_, y) => window.scrollTo({ top: y, behavior: "instant" }), Math.min(top, scan.max));
      await waitForReportFrame(page, viewer);
      if (await marker.isVisible()) break;
    }
    await marker.click();
    const popover = viewer.locator(".ap-live-popover:visible");
    await popover.waitFor();
    await settle(page);
    const cardBox = await card.boundingBox();
    const popoverBox = await popover.boundingBox();
    assert.ok(cardBox && popoverBox);
    const clip = { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: cardBox.width * 9 / 16 };
    assert.ok(popoverBox.x >= clip.x && popoverBox.y >= clip.y &&
      popoverBox.x + popoverBox.width <= clip.x + clip.width &&
      popoverBox.y + popoverBox.height <= clip.y + clip.height,
      "The complete real issue explanation must be visible in the findings capture.");
    const posterPath = join(output, "issue-detail.png");
    await page.mouse.move(1, 1);
    await page.screenshot({ path: posterPath, clip });
    findingsCapture = { issueId: findingsIssueId, posterPath, source: page.url(),
      text: await popover.innerText(), captureRegion: clip, verified: true };
    if (!stillsOnly) await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", posterPath,
      "-vf", "scale=2560:1440:flags=lanczos", "-frames:v", "1", "-c:v", "libwebp", "-quality", "90",
      join(mediaOutput, "issue-detail.webp")], { windowsHide: true });
  }

  if (!reportOnly) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(baseUrl + overviewPath, { waitUntil: "networkidle" });
  await page.locator(".dashboard-project-card").first().waitFor();
  await settle(page);
  await captureScene("overview", async () => { await page.mouse.move(1, 1); });
  }

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
    if (findingsCapture) await copyFile(join(mediaOutput, "issue-detail.webp"), join(root, "src/assets/landing/issue-detail.webp"));
    console.log("Updated " + scenes.length + " landing posters and " + scenes.length * variants.length + " videos.");
  }
  console.log("Verified capture: " + output);
  try {
    const removed = cleanupRecordingFrames(root, output, {
      completed: true, stillsOnly, keepFrames: args.has("--keep-frames"), scenes
    });
    console.log(`Removed ${removed.length} sequence PNGs; posters, videos and capture manifest retained.`);
  } catch (error) {
    console.warn(`Recording succeeded; frame cleanup could not finish: ${error.message}`);
  }
} catch (error) {
  await page.screenshot({ path: join(output, "capture-error.png") }).catch(() => undefined);
  await writeFile(join(output, "capture-error.txt"), String(error) + "\n" + await page.locator("body").innerText()).catch(() => undefined);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
