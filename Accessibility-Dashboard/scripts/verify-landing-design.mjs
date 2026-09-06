/**
 * Verifies the scroll-world landing across desktop and mobile breakpoints.
 * The suite uses reduced motion for the viewport matrix so visual checks do
 * not download or decode the demo clips, then checks desktop scene navigation
 * and sequentially decodes the refreshed clips at each delivered resolution.
 *
 * Usage: npm run verify:landing-design
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const outDir = process.env.OUT_DIR ?? "artifacts/design-migration/landing";
mkdirSync(outDir, { recursive: true });

const CONTROL_MIN_HEIGHT_PX = 44;
const refreshedScenes = [
  { id: "input", index: 1, scrollVh: 2.25 },
  { id: "analyze", index: 2, scrollVh: 3.6 },
  { id: "report", index: 3, scrollVh: 5.15 },
  { id: "overview", index: 4, scrollVh: 6.75 }
];
const viewports = [
  { width: 3840, height: 2160 },
  { width: 2560, height: 1440 },
  { width: 2545, height: 1337, deviceScaleFactor: 1.5 },
  { width: 1440, height: 900 },
  { width: 1024, height: 900 },
  { width: 768, height: 900 },
  { width: 860, height: 844 },
  { width: 768, height: 844 },
  { width: 390, height: 844 },
  { width: 320, height: 700 }
];

async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

async function verifyReducedMotionViewport(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const pageErrors = [];
  const videoRequests = [];
  let apiRequestCount = 0;

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(".mp4")) videoRequests.push(pathname);
  });
  await page.route("**/api/**", async (route) => {
    apiRequestCount += 1;
    await route.abort("blockedbyclient");
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scroll-world-ready="true"]').waitFor();
  await page.locator("#ua-hero-title").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settle(page);

  const facts = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll(".sw-brand,.sw-topcta,.sw-nav__item,.sw-route__dot,.sw-hint")]
      .filter(isVisible)
      .map((element) => ({
        label: element.textContent?.trim() || element.getAttribute("aria-label") || element.className,
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width
      }));
    const title = document.querySelector("#ua-hero-title");
    const root = document.querySelector("[data-scroll-world-ready=true]");
    const topbar = document.querySelector(".sw-topbar");
    const route = document.querySelector(".sw-route");
    const stage = document.querySelector(".sw-stage");
    const openingPoster = document.querySelector(".sw-scene .sw-scene__still");
    const activeCopy = document.querySelector('.sw-copy[aria-hidden="false"]');
    const wordmark = document.querySelector(".sw-wordmark,.sw-brand__name");
    const topCta = document.querySelector(".sw-topcta");
    const titleStyle = title ? getComputedStyle(title) : null;
    const rootStyle = root ? getComputedStyle(root) : null;
    const topbarRect = topbar?.getBoundingClientRect();
    const rect = (element) => {
      const bounds = element?.getBoundingClientRect();
      return bounds
        ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
        : null;
    };

    return {
      ready: Boolean(root),
      mainCount: document.querySelectorAll("main#uni-access-main").length,
      h1Count: document.querySelectorAll("h1").length,
      copyCount: document.querySelectorAll(".sw-copy").length,
      activeCopyCount: document.querySelectorAll('.sw-copy[aria-hidden="false"]:not([inert])').length,
      inactiveCopyLeakCount: document.querySelectorAll('.sw-copy[aria-hidden="true"]:not([inert])').length,
      routeVisible: Boolean(route && isVisible(route)),
      horizontalProgressCount: document.querySelectorAll(".sw-scrollbar").length,
      sectionNumberCount: document.querySelectorAll(".sw-copy__num").length,
      hintCount: document.querySelectorAll(".sw-hint").length,
      hintText: document.querySelector(".sw-hint")?.textContent,
      particleCount: document.querySelectorAll(".sw-pt").length,
      videoCount: document.querySelectorAll("video").length,
      posterReady: [...document.querySelectorAll(".sw-scene__still")].every((image) => image.complete && image.naturalWidth > 0),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pageHeight: document.documentElement.scrollHeight,
      topNavCount: document.querySelectorAll(".sw-nav").length,
      titleFontSize: titleStyle ? Number.parseFloat(titleStyle.fontSize) : 0,
      titleColor: titleStyle?.color,
      rootBackground: rootStyle?.backgroundColor,
      stageRect: rect(stage),
      openingPosterRect: rect(openingPoster),
      copyWidth: activeCopy?.getBoundingClientRect().width ?? 0,
      wordmarkFontSize: wordmark ? Number.parseFloat(getComputedStyle(wordmark).fontSize) : 0,
      topCtaHeight: topCta?.getBoundingClientRect().height ?? 0,
      tagStyles: [...document.querySelectorAll(".sw-copy__tags li")].map((tag) => {
        const style = getComputedStyle(tag);
        return { color: style.color, backgroundColor: style.backgroundColor };
      }),
      hasLegacyStageClass: Boolean(document.querySelector(".sw-stage.ua-stage")),
      hasLegacyTitleClass: Boolean(document.querySelector(".sw-copy__title.ua-hero__headline")),
      topbarWithinViewport: Boolean(
        topbarRect && topbarRect.left >= -0.5 && topbarRect.right <= document.documentElement.clientWidth + 0.5
      ),
      controls
    };
  });

  const label = `${viewport.width}x${viewport.height}${viewport.deviceScaleFactor ? `@${viewport.deviceScaleFactor}x` : ""}`;
  assert.equal(facts.ready, true, `${label}: scroll world did not initialize`);
  assert.equal(facts.mainCount, 1, `${label}: landing must expose one main landmark`);
  assert.equal(facts.h1Count, 1, `${label}: landing must expose one h1`);
  assert.equal(facts.copyCount, 5, `${label}: expected five narrative scenes`);
  assert.equal(facts.activeCopyCount, 1, `${label}: exactly one scene copy must be active`);
  assert.equal(facts.inactiveCopyLeakCount, 0, `${label}: inactive copy escaped inert state`);
  assert.equal(facts.routeVisible, false, `${label}: side progress bar must stay hidden`);
  assert.equal(facts.horizontalProgressCount, 0, `${label}: obsolete top progress bar is still rendered`);
  assert.equal(facts.sectionNumberCount, 0, `${label}: decorative section counters must stay removed`);
  assert.equal(facts.hintCount, 1, `${label}: opening must show one scroll instruction cue`);
  assert.equal(facts.hintText, "SCROLL DOWN", `${label}: scroll instruction text is incorrect`);
  assert.equal(facts.particleCount, 0, `${label}: studio layout must not render particles`);
  assert.equal(facts.videoCount, 0, `${label}: reduced motion must not create videos`);
  assert.deepEqual(videoRequests, [], `${label}: reduced motion unexpectedly requested video media`);
  assert.equal(facts.posterReady, true, `${label}: one or more scene posters failed to load`);
  assert.equal(facts.overflow, 0, `${label}: page-level horizontal overflow detected`);
  assert.ok(facts.pageHeight > viewport.height * 6, `${label}: scroll narrative track is too short`);
  assert.equal(facts.topbarWithinViewport, true, `${label}: top bar exceeds the viewport`);
  assert.equal(facts.hasLegacyStageClass, false, `${label}: scroll stage leaked the legacy width-capped class`);
  assert.equal(facts.hasLegacyTitleClass, false, `${label}: scroll title leaked the legacy headline class`);
  assert.ok(
    facts.stageRect &&
      Math.abs(facts.stageRect.left) < 0.5 &&
      Math.abs(facts.stageRect.top) < 0.5 &&
      Math.abs(facts.stageRect.width - viewport.width) < 0.5 &&
      Math.abs(facts.stageRect.height - viewport.height) < 0.5,
    `${label}: stage does not match the visual viewport`
  );
  assert.ok(
    facts.openingPosterRect &&
      facts.openingPosterRect.left <= 0.5 &&
      facts.openingPosterRect.top <= 0.5 &&
      facts.openingPosterRect.right >= viewport.width - 0.5 &&
      facts.openingPosterRect.bottom >= viewport.height - 0.5,
    `${label}: opening media does not cover the visual viewport`
  );
  assert.equal(facts.rootBackground, "rgb(245, 245, 247)", `${label}: landing canvas token changed`);
  assert.notEqual(facts.titleColor, "rgb(0, 0, 0)", `${label}: title must use off-black ink`);
  assert.ok(facts.tagStyles.length > 0, `${label}: landing tags are missing`);
  for (const tagStyle of facts.tagStyles) {
    assert.deepEqual(
      tagStyle,
      { color: "rgb(255, 255, 255)", backgroundColor: "rgb(29, 29, 31)" },
      `${label}: landing tags must use white text on the black surface`
    );
  }
  if (viewport.width >= 3840 && viewport.height >= 2000) {
    assert.ok(facts.titleFontSize >= 90 && facts.titleFontSize <= 100, `${label}: 4K title scale is out of bounds`);
    assert.ok(facts.copyWidth >= 840 && facts.copyWidth <= 900, `${label}: 4K copy measure is out of bounds`);
    assert.ok(facts.topCtaHeight >= 68, `${label}: 4K primary action did not scale`);
    assert.ok(facts.wordmarkFontSize >= 25, `${label}: 4K wordmark did not scale`);
  } else if (viewport.width >= 2500 && viewport.height >= 1200) {
    assert.ok(facts.titleFontSize >= 68 && facts.titleFontSize <= 80, `${label}: QHD title scale is out of bounds`);
    assert.ok(facts.copyWidth >= 600 && facts.copyWidth <= 660, `${label}: QHD copy measure is out of bounds`);
    assert.ok(facts.topCtaHeight >= 50, `${label}: QHD primary action did not scale`);
    assert.ok(facts.wordmarkFontSize >= 21, `${label}: QHD wordmark did not scale`);
  } else {
    assert.ok(
      facts.titleFontSize >= 30 && facts.titleFontSize <= 58,
      `${label}: title scale is out of bounds (${facts.titleFontSize}px)`
    );
  }
  assert.equal(facts.topNavCount, 0, `${label}: header must stay focused on brand and primary action`);
  for (const control of facts.controls) {
    assert.ok(
      control.height >= CONTROL_MIN_HEIGHT_PX - 0.5,
      `${label}: ${control.label} target is only ${control.height}px high`
    );
  }

  if (viewport.width === 3840) {
    await page.screenshot({ path: `${outDir}/scroll-world-${label}-opening.png`, fullPage: false });
  }

  if ([390, 1440, 2545, 3840].includes(viewport.width)) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      await page.evaluate((targetFraction) => {
        const maxScroll = document.documentElement.scrollHeight - innerHeight;
        window.scrollTo(0, maxScroll * targetFraction);
      }, fraction);
      await settle(page);
      await page.waitForFunction((targetFraction) => {
        const maxScroll = document.documentElement.scrollHeight - innerHeight;
        const actualFraction = maxScroll > 0 ? scrollY / maxScroll : 0;
        return Math.abs(actualFraction - targetFraction) <= 0.002;
      }, fraction);
      assert.equal(await page.locator(".sw-route").isVisible(), false, `${label}: side bar reappeared while scrolling`);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);
  }

  await page.keyboard.press("Tab");
  assert.deepEqual(
    await page.evaluate(() => ({
      href: document.activeElement?.getAttribute("href"),
      text: document.activeElement?.textContent?.trim()
    })),
    { href: "#uni-access-main", text: "본문으로 바로가기" },
    `${label}: skip link must be first in the tab order`
  );
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "uni-access-main");

  const focus = await page.locator(".sw-topcta").evaluate((element) => {
    element.focus();
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle };
  });
  assert.equal(focus.width, "3px", `${label}: CTA focus outline must be 3px`);
  assert.equal(focus.offset, "3px", `${label}: CTA focus separation must be 3px`);
  assert.notEqual(focus.style, "none", `${label}: CTA focus outline is missing`);

  // The report scene spans 4.3–6 viewport heights; inspect its settled midpoint.
  await page.evaluate(() => window.scrollTo(0, innerHeight * 5.15));
  await page.waitForFunction(
    () => document.querySelector(".sw-copy[aria-hidden=false] .sw-copy__title")?.textContent === "문제가 있는 자리를 그대로"
  );
  await settle(page);
  const report = await page.evaluate(() => {
    const scene = document.querySelectorAll(".sw-scene")[3];
    const media = scene?.querySelector(".sw-scene__video, .sw-scene__still");
    const copy = document.querySelector('.sw-copy[aria-hidden="false"]');
    const rect = media?.getBoundingClientRect();
    const copyRect = copy?.getBoundingClientRect();
    const overlaps = Boolean(
      rect && copyRect &&
      rect.left < copyRect.right - 1 && rect.right > copyRect.left + 1 &&
      rect.top < copyRect.bottom - 1 && rect.bottom > copyRect.top + 1
    );
    return {
      title: document.querySelector(".sw-copy[aria-hidden=false] .sw-copy__title")?.textContent,
      inactiveCopyLeakCount: document.querySelectorAll('.sw-copy[aria-hidden="true"]:not([inert])').length,
      cardElementFound: Boolean(media),
      cardWidth: rect?.width ?? 0,
      cardRadius: media ? Number.parseFloat(getComputedStyle(media).borderTopLeftRadius) : 0,
      overlapsCopy: overlaps,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  assert.equal(report.title, "문제가 있는 자리를 그대로", `${label}: report copy did not activate`);
  assert.equal(report.inactiveCopyLeakCount, 0, `${label}: report transition exposed hidden CTA content`);
  assert.equal(report.cardElementFound, true, `${label}: report card surface is missing`);
  assert.equal(report.overlapsCopy, false, `${label}: report media overlaps its copy`);
  assert.ok(
    report.cardRadius >= 20,
    `${label}: report media must retain rounded card framing (${report.cardRadius}px)`
  );
  const configuredCardRatio = viewport.width <= 860 ? 0.92 : viewport.width < 1280 ? 0.48 : 0.54;
  const cardMaxHeightRatio = viewport.width <= 860 ? 0.46 : 0.82;
  const expectedCardWidth = Math.min(
    viewport.width * configuredCardRatio,
    viewport.height * cardMaxHeightRatio * (16 / 9)
  );
  assert.ok(
    Math.abs(report.cardWidth - expectedCardWidth) < 1,
    `${label}: report card width is ${Math.round(report.cardWidth)}px; expected ${Math.round(expectedCardWidth)}px`
  );
  assert.equal(report.overflow, 0, `${label}: report scene introduced horizontal overflow`);

  await page.evaluate(() => window.scrollTo(0, innerHeight * 6.75));
  await page.waitForFunction(
    () => document.querySelector(".sw-copy[aria-hidden=false] .sw-copy__title")?.textContent === "접근성을 한 화면에서"
  );
  assert.deepEqual(
    await page.locator('.sw-copy[aria-hidden="false"] .sw-copy__cta a').allTextContents(),
    ["새 페이지 분석", "라이브 리포트 보기"],
    `${label}: final actions are missing`
  );
  await page.getByRole("link", { name: "라이브 리포트 보기", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sw-copy[aria-hidden=false] .sw-copy__title")?.textContent === "문제가 있는 자리를 그대로"
  );

  assert.equal(apiRequestCount, 0, `${label}: landing unexpectedly requested an API`);
  assert.deepEqual(pageErrors, [], `${label}: browser page errors detected`);

  if (viewport.width === 1440 || viewport.width === 390) {
    await page.screenshot({ path: `${outDir}/scroll-world-${label}.png`, fullPage: false });
  }

  if (viewport.width === 1440) {
    await Promise.all([
      page.waitForURL("**/analyze"),
      page.locator(".sw-topcta").click()
    ]);
    await page.locator(".sw-root").waitFor({ state: "detached" });
    assert.equal(await page.locator(".sw-root").count(), 0, "route change must unmount the scroll world");
    assert.equal(await page.locator("video").count(), 0, "route change must release landing videos");
    assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 0, "app entry must reset page scroll");
  }

  await context.close();
  return { label, facts, report };
}

async function verifyDesktopMotionPath(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "no-preference"
  });
  const page = await context.newPage();
  const pageErrors = [];
  const videoRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(".mp4")) videoRequests.push(pathname);
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scroll-world-ready="true"]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll("video").length === 1, null, { timeout: 15_000 });
  assert.equal(await page.locator("video").count(), 1, "initial desktop view must load only the opening clip");
  assert.deepEqual(videoRequests, ["/landing/scroll-world/vid/opening-1080.mp4"]);

  const scenes = [];
  for (const scene of refreshedScenes) {
    await page.evaluate((scrollVh) => window.scrollTo(0, innerHeight * scrollVh), scene.scrollVh);
    await page.locator(`#sw-section-${scene.id}[aria-hidden="false"]:not([inert])`).waitFor();
    await page.waitForFunction((index) => {
      const element = document.querySelectorAll(".sw-scene")[index];
      const video = element?.querySelector("video");
      return element?.classList.contains("has-clip") && video && !video.seeking &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime > 0;
    }, scene.index, { timeout: 15_000 });
    await settle(page);

    const facts = await page.evaluate(({ id, index }) => {
      const element = document.querySelectorAll(".sw-scene")[index];
      const video = element.querySelector("video");
      const copy = document.getElementById(`sw-section-${id}`);
      const rect = video.getBoundingClientRect();
      const copyRect = copy.getBoundingClientRect();
      return {
        id,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        currentTime: video.currentTime,
        cardWidth: rect.width,
        cardRadius: Number.parseFloat(getComputedStyle(video).borderTopLeftRadius),
        visible: Number.parseFloat(getComputedStyle(element).opacity) > 0.99,
        withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        overlapsCopy: rect.left < copyRect.right - 1 && rect.right > copyRect.left + 1 &&
          rect.top < copyRect.bottom - 1 && rect.bottom > copyRect.top + 1,
        activeCopyCount: document.querySelectorAll('.sw-copy[aria-hidden="false"]:not([inert])').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    }, scene);
    assert.ok(videoRequests.includes(`/landing/scroll-world/vid/${scene.id}-1080.mp4`), `${scene.id}: desktop did not request its refreshed clip`);
    assert.deepEqual([facts.width, facts.height], [1920, 1080], `${scene.id}: desktop clip resolution changed`);
    assert.ok(Number.isFinite(facts.duration) && facts.duration > 0, `${scene.id}: clip duration is invalid`);
    assert.equal(facts.visible, true, `${scene.id}: decoded scene is not visible`);
    assert.equal(facts.activeCopyCount, 1, `${scene.id}: scene navigation must activate exactly one copy`);
    assert.equal(facts.withinViewport, true, `${scene.id}: video card exceeds the viewport`);
    assert.equal(facts.overlapsCopy, false, `${scene.id}: video card overlaps its copy`);
    assert.ok(Math.abs(facts.cardWidth - 1440 * 0.54) < 1, `${scene.id}: video lost its desktop card width`);
    assert.ok(facts.cardRadius >= 20, `${scene.id}: video lost its rounded card framing`);
    assert.equal(facts.overflow, 0, `${scene.id}: video introduced horizontal overflow`);
    scenes.push(facts);
  }
  assert.deepEqual(pageErrors, [], "desktop motion path raised a page error");
  await context.close();
  return scenes;
}

async function verifyRefreshedMediaVariants(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = [];
  try {
    // One decoder at a time keeps the 4K checks bounded on CI machines.
    for (const variant of [
      { suffix: "-1080", width: 1920, height: 1080 },
      { suffix: "-1440", width: 2560, height: 1440 },
      { suffix: "", width: 3840, height: 2160 }
    ]) {
      for (const scene of refreshedScenes) {
        const path = `/landing/scroll-world/vid/${scene.id}${variant.suffix}.mp4`;
        const facts = await page.evaluate(async (src) => {
          const video = document.createElement("video");
          video.muted = true;
          video.preload = "auto";
          video.width = 320;
          document.body.appendChild(video);
          let timer;
          let targetTime;
          try {
            return await new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`${src}: metadata/seek timed out`)), 15_000);
              video.addEventListener("error", () => reject(new Error(`${src}: media error ${video.error?.code}: ${video.error?.message}`)), { once: true });
              video.addEventListener("loadedmetadata", () => {
                if (!Number.isFinite(video.duration) || video.duration <= 0) {
                  reject(new Error(`${src}: invalid duration ${video.duration}`));
                  return;
                }
                targetTime = video.duration * 0.75;
                video.currentTime = targetTime;
              }, { once: true });
              video.addEventListener("seeked", () => resolve({
                width: video.videoWidth,
                height: video.videoHeight,
                duration: video.duration,
                targetTime,
                currentTime: video.currentTime,
                decodedData: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
              }), { once: true });
              video.src = src;
              video.load();
            });
          } finally {
            clearTimeout(timer);
            video.pause();
            video.removeAttribute("src");
            video.load();
            video.remove();
          }
        }, new URL(path, baseUrl).href);
        assert.deepEqual([facts.width, facts.height], [variant.width, variant.height], `${path}: delivered resolution does not match its tier`);
        assert.ok(Number.isFinite(facts.duration) && facts.duration > 0, `${path}: clip duration is invalid`);
        assert.equal(facts.decodedData, true, `${path}: seeking did not decode a frame`);
        assert.ok(Math.abs(facts.currentTime - facts.targetTime) < 0.1, `${path}: seek did not reach the requested frame`);
        results.push({ path, ...facts });
      }
    }
  } finally {
    await context.close();
  }
  return results;
}

async function verifyMobileHeightOnlyResize(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 700 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-scroll-world-ready="true"]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => {
    const maxScroll = document.documentElement.scrollHeight - innerHeight;
    const activeTitle = document.querySelector('.sw-copy[aria-hidden="false"] .sw-copy__title');
    return Math.abs(scrollY - maxScroll) <= 1 && activeTitle?.textContent === "접근성을 한 화면에서";
  });
  assert.equal(await page.locator(".sw-route").isVisible(), false, "mobile resize must not restore the side bar");
  assert.equal(
    await page.locator('.sw-copy[aria-hidden="false"] .sw-copy__title').textContent(),
    "접근성을 한 화면에서",
    "mobile height-only resize lost the final scene state"
  );
  await context.close();
}

async function verifyScrollControl(browser) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const reducedMotion = viewport.width < 860 ? "reduce" : "no-preference";
    const context = await browser.newContext({ viewport, reducedMotion });
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-scroll-world-ready="true"]').waitFor();
      const down = page.getByRole("button", { name: "SCROLL DOWN: 아래로 스크롤", exact: true });
      const animation = await down.locator("svg").evaluate((arrow) => getComputedStyle(arrow).animationName);
      assert.equal(animation === "none", reducedMotion === "reduce", "scroll arrow must respect reduced motion");
      await down.click();
      await page.waitForFunction(() => Math.abs(scrollY - innerHeight * 0.8) < 2);

      for (const fraction of [0, 0.5, 0.95, 1]) {
        await page.evaluate((value) => window.scrollTo({
          top: (document.documentElement.scrollHeight - innerHeight) * value, behavior: "instant"
        }), fraction);
        const label = fraction === 1 ? "TOP: 맨 위로 이동" : "SCROLL DOWN: 아래로 스크롤";
        const control = page.getByRole("button", { name: label, exact: true });
        await control.waitFor();
        const facts = await control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const arrow = element.querySelector("i").getBoundingClientRect();
          const text = element.querySelector("span").getBoundingClientRect();
          return {
            fixed: getComputedStyle(element).position === "fixed",
            centered: Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 1,
            bottom: rect.bottom <= innerHeight && rect.top >= innerHeight - 110,
            onTop: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
            arrowAboveText: arrow.bottom <= text.top
          };
        });
        assert.ok(Object.values(facts).every(Boolean), `${viewport.width}: scroll control is obscured or misplaced at ${fraction}: ${JSON.stringify(facts)}`);
        if (fraction === 0 || fraction === 1) {
          await page.screenshot({ path: `${outDir}/scroll-control-${viewport.width}-${fraction === 1 ? "bottom" : "opening"}.png` });
        }
      }
      const top = page.getByRole("button", { name: "TOP: 맨 위로 이동", exact: true });
      if (viewport.width >= 860) {
        await top.focus();
        await top.press("Enter");
      } else {
        await top.click();
      }
      await page.waitForFunction(() => scrollY < 1);
      await down.waitFor();
      assert.equal(await down.textContent(), "SCROLL DOWN", "returning to the top must restore the down label");
    } finally {
      await context.close();
    }
  }
}

async function verifyProductPreviewAccountMenu(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/product-preview`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-dashboard-product-preview="true"]').waitFor();
  await page.locator(".dashboard-account-menu-trigger").click();
  const menu = page.getByRole("menu", { name: "계정 메뉴" });
  await menu.waitFor();
  const metrics = await menu.evaluate((element) => {
    const item = element.querySelector(".dashboard-account-menu-item");
    const icon = item?.querySelector("svg");
    if (!item || !icon) return null;
    const menuStyle = getComputedStyle(element);
    return {
      width: Math.round(element.getBoundingClientRect().width),
      borderTopWidth: menuStyle.borderTopWidth,
      itemFontSize: Number.parseFloat(getComputedStyle(item).fontSize),
      iconWidth: Math.round(icon.getBoundingClientRect().width)
    };
  });
  assert.ok(metrics, "account dropdown metrics missing");
  assert.equal(metrics.borderTopWidth, "0px", "account dropdown must not render an outer border");
  assert.ok(metrics.width <= 240, `account dropdown is too wide (${metrics.width}px)`);
  assert.ok(metrics.itemFontSize <= 14, `account dropdown type is too large (${metrics.itemFontSize}px)`);
  assert.ok(metrics.iconWidth <= 20, `account dropdown icon is too large (${metrics.iconWidth}px)`);
  await page.locator('[data-dashboard-product-preview="true"]').screenshot({
    path: `${outDir}/product-preview-account-menu.png`
  });
  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  const results = [];
  for (const viewport of viewports) {
    results.push(await verifyReducedMotionViewport(browser, viewport));
  }
  await verifyMobileHeightOnlyResize(browser);
  await verifyScrollControl(browser);
  const scenes = await verifyDesktopMotionPath(browser);
  const variants = await verifyRefreshedMediaVariants(browser);
  await verifyProductPreviewAccountMenu(browser);
  writeFileSync(`${outDir}/landing-design-summary.json`, JSON.stringify(results, null, 2));
  writeFileSync(`${outDir}/landing-media-summary.json`, JSON.stringify({ scenes, variants }, null, 2));
  console.log("Landing scroll-world visual checks passed.");
} finally {
  await browser.close();
}
