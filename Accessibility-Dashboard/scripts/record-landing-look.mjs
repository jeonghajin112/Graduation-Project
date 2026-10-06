/**
 * Records the five live-report clips for the landing's "페이지 위에서 자세히 보기" section
 * from the real application (marker, cluster, pause, approximate area, not-shown list).
 * Reads an existing live report only; analysis and mutation requests are blocked.
 * CDP screencast at 2x pixels keeps real-time motion (popovers, sliders pausing),
 * and a drawn cursor shows where each action happens.
 *
 * Requires the running frontend (BASE_URL, default http://localhost:5173), the backend and ffmpeg.
 * LOOK_PAGE selects the page (default: 국세청 in the 정부 사이트 project).
 *   npm run record:landing-look                  (all scenes into artifacts/landing-look/<time>)
 *   npm run record:landing-look -- pause cluster (selected scenes)
 *   npm run record:landing-look -- --publish     (also copy mp4/webp into public/landing/look)
 * Review the clips before publishing: marker picks depend on the recorded page.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const publish = args.includes("--publish");
const ONLY = args.filter(arg => !arg.startsWith("--"));
const OUT = join(root, "artifacts/landing-look", new Date().toISOString().replace(/[:.]/g, "-"));
const BASE = process.env.BASE_URL || "http://localhost:5173";
const PAGE = process.env.LOOK_PAGE || "/projects/225/pages/483";
const RATIO = 10.4 / 16;
const DPR = 2;

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.6L10 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

async function openReport(browser, height) {
  const context = await browser.newContext({ viewport: { width: 1920, height }, deviceScaleFactor: DPR,
    locale: "ko-KR", timezoneId: "Asia/Seoul", colorScheme: "light", reducedMotion: "no-preference" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", route => {
    const r = route.request();
    if (r.method() !== "GET" && /\/api\/(requests|v1\/evaluations|targets|organizations)/.test(r.url())) return route.abort();
    return route.continue();
  });
  await page.goto(BASE + PAGE, { waitUntil: "domcontentloaded" });
  await page.locator('.site-page-evidence-preview[aria-busy="false"][data-connection-state="ready"]').waitFor({ timeout: 90_000 });
  const viewer = page.frameLocator('iframe[data-report-mode="live"]');
  await viewer.locator("html").evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo({ top: 0, behavior: "instant" });
    await Promise.all([...document.images].filter(i => i.getBoundingClientRect().top < innerHeight).map(i => i.decode().catch(() => {})));
  });
  // 커서: 위 문서에 그려 iframe 위에서도 보이게 한다.
  await page.evaluate(svg => {
    const c = document.createElement("div");
    c.id = "__rec-cursor";
    c.innerHTML = svg;
    Object.assign(c.style, { position: "fixed", left: "0px", top: "0px", zIndex: 2147483647, pointerEvents: "none",
      transform: "translate(-4px,-3px)", opacity: "0", transition: "opacity .25s" });
    document.body.appendChild(c);
  }, CURSOR_SVG);
  await page.mouse.move(1910, height - 10);
  await page.waitForTimeout(2500);
  return { context, page, viewer, errors };
}

function cursorTo(page, x, y, show = true) {
  return page.evaluate(([x, y, show]) => {
    const c = document.getElementById("__rec-cursor");
    c.style.left = x + "px"; c.style.top = y + "px"; c.style.opacity = show ? "1" : "0";
  }, [x, y, show]);
}

// 사람 손처럼 부드럽게 이동 (ease-in-out).
async function glide(page, from, to, ms = 900) {
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps; const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = from.x + (to.x - from.x) * e; const y = from.y + (to.y - from.y) * e;
    await page.mouse.move(x, y);
    await cursorTo(page, x, y);
    await page.waitForTimeout(16);
  }
  return to;
}

async function centerOf(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function startCapture(page, dir) {
  // Each run writes into a new timestamped folder. (Node 24's native rmSync crashes on
  // Windows for non-ASCII paths such as this project's folder, so nothing is deleted.)
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(dir, String(frames.length).padStart(5, "0") + ".jpg");
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 3840 * 2, maxHeight: 3840 * 2, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  return {
    async stop() {
      // 마지막 장면이 그대로 남도록 한 프레임 더 그리게 한다.
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.waitForTimeout(150);
      await cdp.send("Page.stopScreencast");
      return { frames, t0, t1: Date.now() / 1000 };
    }
  };
}

function encode(name, capture, clip) {
  const { frames, t1 } = capture;
  if (frames.length < 2) throw new Error(name + ": no frames captured");
  // 프레임 사이 실제 시간으로 이어 붙여 일정한 30fps 영상으로 만든다.
  const list = frames.map((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : t1;
    return `file '${f.file.replace(/\\/g, "/")}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}`;
  }).join("\n") + `\nfile '${frames[frames.length - 1].file.replace(/\\/g, "/")}'\n`;
  const listFile = join(OUT, name + "-frames.txt");
  writeFileSync(listFile, list);
  const crop = `crop=${Math.round(clip.width * DPR)}:${Math.round(clip.height * DPR)}:${Math.round(clip.x * DPR)}:${Math.round(clip.y * DPR)}`;
  for (const [suffix, width, crf] of [["", 1920, 20]]) {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", `${crop},scale=${width}:-2:flags=lanczos:out_range=tv:out_color_matrix=bt709,fps=30,format=yuv420p`,
      "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-an", "-movflags", "+faststart",
      "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      join(OUT, `${name}${suffix}.mp4`)], { windowsHide: true });
  }
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.3", "-i", join(OUT, name + ".mp4"),
    "-frames:v", "1", "-c:v", "libwebp", "-quality", "88", join(OUT, name + ".webp")], { windowsHide: true });
  console.log(name, "frames", frames.length, "seconds", (t1 - frames[0].t).toFixed(1));
}

async function visibleMarkers(viewer) {
  return viewer.locator(".ap-live-marker").evaluateAll(list => list.filter(m => {
    const r = m.getBoundingClientRect(); const s = getComputedStyle(m);
    return r.width > 0 && r.top > 40 && r.bottom < innerHeight - 40 && s.visibility !== "hidden" && Number(s.opacity) > 0.5;
  }).map(m => ({ id: m.dataset.issueId, text: m.textContent.trim(), kind: m.className.includes("--cluster") ? "cluster" : m.className.includes("--approximate") ? "approx" : "normal",
    x: m.getBoundingClientRect().left, y: m.getBoundingClientRect().top })));
}

const SCENES = {
  // 1. 문제 위치에 마커를: 마커를 눌러 설명창을 연다.
  async locate(browser) {
    const r = await openReport(browser, 1080);
    const card = await r.page.locator(".site-page-evidence-card").boundingBox();
    const clip = { x: card.x, y: card.y, width: card.width, height: card.width * RATIO };
    const markers = (await visibleMarkers(r.viewer)).filter(m => m.kind === "normal");
    const pick = markers.find(m => m.y > 150 && m.y < 450 && m.x > 300) || markers[0];
    const target = r.viewer.locator(`.ap-live-marker[data-issue-id="${pick.id}"]`).first();
    const cap = await startCapture(r.page, join(OUT, "locate-frames"));
    await r.page.waitForTimeout(900);
    let at = { x: clip.x + clip.width * 0.85, y: clip.y + clip.height * 0.9 };
    await cursorTo(r.page, at.x, at.y);
    at = await glide(r.page, at, await centerOf(target), 1100);
    await r.page.waitForTimeout(500);
    await r.page.mouse.down(); await r.page.mouse.up();
    await r.viewer.locator(".ap-live-popover:visible").waitFor();
    await r.page.waitForTimeout(2600);
    encode("locate", await cap.stop(), clip);
    await r.context.close();
  },
  // 2. 가까운 문제는 하나로: 묶음 마커를 열고 다음 문제로 넘긴다.
  async cluster(browser) {
    const r = await openReport(browser, 1080);
    const card = await r.page.locator(".site-page-evidence-card").boundingBox();
    const clip = { x: card.x, y: card.y, width: card.width, height: card.width * RATIO };
    // 설명창이 카드 안에 다 보이도록 페이지를 조금 내린 뒤 고른다.
    await r.viewer.locator("html").evaluate(() => window.scrollTo({ top: 300, behavior: "instant" }));
    await r.page.waitForTimeout(1500);
    const markers = (await visibleMarkers(r.viewer)).filter(m => m.kind === "cluster" && m.y < 420);
    // 가장 많이 묶인 마커 (넘길 때 강조 표시가 여러 요소를 따라가는 모습이 잘 보인다)
    const count = m => Number((m.text || "").replace(/\D/g, "")) || 0;
    const pick = markers.slice().sort((a, b) => count(b) - count(a))[0];
    const target = r.viewer.locator(`.ap-live-marker[data-issue-id="${pick.id}"]`).first();
    const cap = await startCapture(r.page, join(OUT, "cluster-frames"));
    await r.page.waitForTimeout(800);
    let at = { x: clip.x + clip.width * 0.8, y: clip.y + clip.height * 0.85 };
    await cursorTo(r.page, at.x, at.y);
    at = await glide(r.page, at, await centerOf(target), 1000);
    await r.page.waitForTimeout(400);
    await r.page.mouse.down(); await r.page.mouse.up();
    const popover = r.viewer.locator(".ap-live-popover:visible");
    await popover.waitFor({ timeout: 2500 }).catch(() => target.click());
    await popover.waitFor();
    await r.page.waitForTimeout(1300);
    for (let i = 0; i < 2; i++) {
      const next = popover.locator(".ap-live-popover__pager-button--next").first();
      if (!(await next.count()) || !(await next.isEnabled())) break;
      at = await glide(r.page, at, await centerOf(next), 600);
      await r.page.waitForTimeout(250);
      await r.page.mouse.down(); await r.page.mouse.up();
      await r.page.waitForTimeout(1400);
    }
    await r.page.waitForTimeout(600);
    encode("cluster", await cap.stop(), clip);
    await r.context.close();
  },
  // 3. 보는 동안 페이지가 멈춰요: 배너가 넘어가다가 마커에 올리면 멈춘다.
  async pause(browser) {
    const r = await openReport(browser, 1080);
    const card = await r.page.locator(".site-page-evidence-card").boundingBox();
    const clip = { x: card.x, y: card.y, width: card.width, height: card.width * RATIO };
    const markers = await visibleMarkers(r.viewer);
    // 메인 배너(왼쪽 위 큰 슬라이드) 안의 마커: 배너 상자 안에 있는 것을 고른다
    const banner = await r.viewer.locator("html").evaluate(() => {
      const el = [...document.querySelectorAll("div,section,ul")].filter(e => { const b = e.getBoundingClientRect(); return b.left < 60 && b.top > 60 && b.top < 200 && b.width > 400 && b.width < 1100 && b.height > 150 && b.height < 420; })
        .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
      const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    });
    // 배너 아래쪽 탭 줄의 마커는 피한다 (올리면 페이지 탭이 바뀐다).
    const inBanner = markers.filter(m => m.kind !== "approx" && m.x >= banner.left && m.x <= banner.right && m.y >= banner.top && m.y <= banner.top + (banner.bottom - banner.top) * 0.7);
    console.log("banner", banner, "markers in banner", JSON.stringify(inBanner));
    // 배너 안에 마커가 없으면 오른쪽 '알림판' 슬라이드(자동으로 넘어감) 모서리의 시각 마커를 쓴다.
    const noticeBoard = markers.find(m => m.text.startsWith("시각") && m.x > 780 && m.y > 380 && m.y < 470);
    const pick = inBanner.sort((a, b) => a.y - b.y)[0] || noticeBoard || markers[0];
    console.log("pause marker", JSON.stringify(pick));
    const target = r.viewer.locator(`.ap-live-marker[data-issue-id="${pick.id}"]`).first();
    const cap = await startCapture(r.page, join(OUT, "pause-frames"));
    let at = { x: clip.x + clip.width * 0.62, y: clip.y + clip.height * 0.92 };
    await cursorTo(r.page, at.x, at.y);
    await r.page.waitForTimeout(3200);          // 배너가 스스로 넘어가는 모습
    at = await glide(r.page, at, await centerOf(target), 900);
    await r.page.waitForTimeout(4500);          // 마우스를 올린 동안 멈춤
    at = await glide(r.page, at, { x: clip.x + clip.width * 0.62, y: clip.y + clip.height * 0.92 }, 700);
    await r.page.waitForTimeout(2600);          // 다시 움직임
    encode("pause", await cap.stop(), clip);
    await r.context.close();
  },
  // 4. 숨은 요소는 대략적 위치로: 점선 마커를 연다.
  async approx(browser) {
    const r = await openReport(browser, 1080);
    const card = await r.page.locator(".site-page-evidence-card").boundingBox();
    const clip = { x: card.x, y: card.y, width: card.width, height: card.width * RATIO };
    let pick = (await visibleMarkers(r.viewer)).find(m => m.kind === "approx");
    if (!pick) throw new Error("approximate marker not visible at the top");
    const target = r.viewer.locator(`.ap-live-marker[data-issue-id="${pick.id}"]`).first();
    const cap = await startCapture(r.page, join(OUT, "approx-frames"));
    await r.page.waitForTimeout(900);
    let at = { x: clip.x + clip.width * 0.9, y: clip.y + clip.height * 0.88 };
    await cursorTo(r.page, at.x, at.y);
    at = await glide(r.page, at, await centerOf(target), 1000);
    await r.page.waitForTimeout(500);
    await r.page.mouse.down(); await r.page.mouse.up();
    await r.viewer.locator(".ap-live-popover:visible").waitFor();
    await r.page.waitForTimeout(3000);
    encode("approx", await cap.stop(), clip);
    await r.context.close();
  },
  // 5. 표시 못 한 문제도 빠짐없이: 오른쪽 목록에서 이유별로 걸러 본다.
  async offscreen(browser) {
    const first = await openReport(browser, 1080);
    const layout = await first.page.locator(".site-dashboard-layout").boundingBox();
    await first.context.close();
    const height = 1080;
    const r = await openReport(browser, height);
    const panel = r.page.locator(".site-unavailable-locator-panel").filter({ hasText: "화면에 표시되지 않은 문제" });
    await panel.scrollIntoViewIfNeeded();
    // 오른쪽 목록이 화면의 절반쯤 차지하도록 목록 주변만 잘라 글씨가 읽히게 한다.
    const rail = await r.page.locator(".site-dashboard-rail").boundingBox();
    const panelBox = await panel.boundingBox();
    const width = rail.width * 2.1;
    const clipHeight = width * RATIO;
    const clip = { x: rail.x + rail.width - width + 8, width, height: clipHeight,
      y: Math.max(0, Math.min(panelBox.y - 70, height - clipHeight)) };
    const chip = panel.getByRole("button", { name: /분석 이후 내용이 바뀜/ }).first();
    const all = panel.getByRole("button", { name: /^전체/ }).first();
    const cap = await startCapture(r.page, join(OUT, "offscreen-frames"));
    await r.page.waitForTimeout(900);
    let at = { x: clip.x + clip.width * 0.55, y: clip.y + clip.height * 0.8 };
    await cursorTo(r.page, at.x, at.y);
    if (await chip.count()) {
      at = await glide(r.page, at, await centerOf(chip), 1100);
      await r.page.waitForTimeout(300);
      await r.page.mouse.down(); await r.page.mouse.up();
      await r.page.waitForTimeout(2200);
    }
    if (await all.count()) {
      at = await glide(r.page, at, await centerOf(all), 700);
      await r.page.waitForTimeout(300);
      await r.page.mouse.down(); await r.page.mouse.up();
      await r.page.waitForTimeout(1800);
    }
    encode("offscreen", await cap.stop(), clip);
    await r.context.close();
  }
};

mkdirSync(OUT, { recursive: true });
await (async () => {
  // 헤드리스 화면 캡처는 이 배율을 줘야 2배 픽셀로 찍힌다.
  const browser = await chromium.launch({ args: ["--force-device-scale-factor=2"] });
  try {
    for (const name of ONLY.length ? ONLY : Object.keys(SCENES)) {
      console.log("recording", name);
      await SCENES[name](browser);
    }
  } finally {
    await browser.close();
  }
  if (publish) {
    const target = join(root, "public/landing/look");
    for (const name of ONLY.length ? ONLY : Object.keys(SCENES)) {
      for (const ext of [".mp4", ".webp"]) copyFileSync(join(OUT, name + ext), join(target, name + ext));
    }
    console.log("Published to public/landing/look");
  }
  console.log("Output:", OUT);
})();
