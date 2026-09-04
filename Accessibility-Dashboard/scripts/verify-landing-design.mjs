/**
 * Verifies the scroll-world landing across desktop and mobile breakpoints.
 * The suite uses reduced motion for the viewport matrix so visual checks do
 * not download or decode the 1080p demo clips, then runs one focused motion
 * check to prove that the desktop clip path still initializes.
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
    const controls = [...document.querySelectorAll(".sw-brand,.sw-topcta,.sw-nav__item,.sw-route__dot")]
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
    const routeStyle = route ? getComputedStyle(route) : null;
    const routeFillStyle = route ? getComputedStyle(route, "::after") : null;
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
      routeCount: document.querySelectorAll(".sw-route__dot").length,
      routeLabelCount: document.querySelectorAll(".sw-route__label").length,
      routeMarkerCount: document.querySelectorAll(".sw-route__dot i").length,
      horizontalProgressCount: document.querySelectorAll(".sw-scrollbar").length,
      routeProgress: Number.parseFloat(routeStyle?.getPropertyValue("--sw-route-progress") || "0"),
      routeGaugeWidth: Number.parseFloat(routeFillStyle?.width || "0"),
      routeGaugeFillColor: routeFillStyle?.backgroundColor,
      routeGaugeOriginY: Number.parseFloat(routeFillStyle?.transformOrigin?.split(/\s+/)[1] || "0"),
      sectionNumberCount: document.querySelectorAll(".sw-copy__num").length,
      hintCount: document.querySelectorAll(".sw-hint").length,
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
  assert.equal(facts.routeCount, 5, `${label}: expected five route controls`);
  assert.equal(facts.routeLabelCount, 0, `${label}: route text labels must stay hidden`);
  assert.equal(facts.routeMarkerCount, 0, `${label}: circular route markers must stay removed`);
  assert.equal(facts.horizontalProgressCount, 0, `${label}: obsolete top progress bar is still rendered`);
  assert.ok(Math.abs(facts.routeProgress) <= 0.002, `${label}: vertical gauge must start empty`);
  assert.ok(facts.routeGaugeWidth >= 2.5, `${label}: vertical gauge is too thin to perceive`);
  assert.notEqual(facts.routeGaugeFillColor, "rgba(0, 0, 0, 0)", `${label}: vertical gauge fill is transparent`);
  assert.ok(facts.routeGaugeOriginY <= 0.5, `${label}: vertical gauge must fill from the top`);
  assert.equal(facts.sectionNumberCount, 0, `${label}: decorative section counters must stay removed`);
  assert.equal(facts.hintCount, 0, `${label}: scroll instruction cue must stay removed`);
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
    assert.ok(facts.routeGaugeWidth >= 5.5, `${label}: 4K route gauge did not scale`);
  } else if (viewport.width >= 2500 && viewport.height >= 1200) {
    assert.ok(facts.titleFontSize >= 68 && facts.titleFontSize <= 80, `${label}: QHD title scale is out of bounds`);
    assert.ok(facts.copyWidth >= 600 && facts.copyWidth <= 660, `${label}: QHD copy measure is out of bounds`);
    assert.ok(facts.topCtaHeight >= 50, `${label}: QHD primary action did not scale`);
    assert.ok(facts.wordmarkFontSize >= 21, `${label}: QHD wordmark did not scale`);
    assert.ok(facts.routeGaugeWidth >= 3.5, `${label}: QHD route gauge did not scale`);
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
    const progressSamples = [];
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      await page.evaluate((targetFraction) => {
        const maxScroll = document.documentElement.scrollHeight - innerHeight;
        window.scrollTo(0, maxScroll * targetFraction);
      }, fraction);
      await settle(page);
      await page.waitForFunction((targetFraction) => {
        const route = document.querySelector(".sw-route");
        if (!route) return false;
        const maxScroll = document.documentElement.scrollHeight - innerHeight;
        const actualFraction = maxScroll > 0 ? scrollY / maxScroll : 0;
        const value = Number.parseFloat(getComputedStyle(route).getPropertyValue("--sw-route-progress"));
        const transform = getComputedStyle(route, "::after").transform;
        const renderedScale = transform === "none" ? 1 : new DOMMatrixReadOnly(transform).m22;
        return Number.isFinite(value)
          && Math.abs(actualFraction - targetFraction) <= 0.002
          && Math.abs(value - targetFraction) <= 0.015
          && Math.abs(renderedScale - value) <= 0.02;
      }, fraction);
      progressSamples.push(await page.evaluate(() => {
        const route = document.querySelector(".sw-route");
        if (!route) return null;
        const routeStyle = getComputedStyle(route);
        const fillStyle = getComputedStyle(route, "::after");
        const transform = fillStyle.transform;
        return {
          expected: scrollY / (document.documentElement.scrollHeight - innerHeight),
          value: Number.parseFloat(routeStyle.getPropertyValue("--sw-route-progress")),
          renderedScale: transform === "none" ? 1 : new DOMMatrixReadOnly(transform).m22,
          current: route.querySelector('.sw-route__dot[aria-current="step"]')?.getAttribute("aria-label")
        };
      }));
    }
    progressSamples.forEach((sample, index) => {
      assert.ok(sample, `${label}: vertical gauge disappeared during scrolling`);
      assert.ok(sample.value >= 0 && sample.value <= 1, `${label}: gauge value escaped its range at sample ${index}`);
      assert.ok(Math.abs(sample.value - sample.expected) <= 0.015, `${label}: gauge value drifted at sample ${index}`);
      assert.ok(Math.abs(sample.renderedScale - sample.value) <= 0.02, `${label}: rendered gauge fill drifted at sample ${index}`);
      if (index > 0) {
        assert.ok(sample.value > progressSamples[index - 1].value + 0.03, `${label}: gauge did not advance at sample ${index}`);
      }
    });
    assert.ok(progressSamples[0]?.value <= 0.002, `${label}: gauge did not begin empty`);
    assert.ok(progressSamples.at(-1)?.value >= 0.998, `${label}: gauge did not finish full`);
    assert.equal(progressSamples.at(-1)?.current, "5. 프로젝트", `${label}: final gauge state did not select the last scene`);
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

  await page.getByRole("button", { name: "4. 라이브 리포트", exact: true }).click();
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
      current: document.querySelector('.sw-route__dot[aria-current="step"]')?.getAttribute("aria-label"),
      title: document.querySelector(".sw-copy[aria-hidden=false] .sw-copy__title")?.textContent,
      inactiveCopyLeakCount: document.querySelectorAll('.sw-copy[aria-hidden="true"]:not([inert])').length,
      cardElementFound: Boolean(media),
      cardWidth: rect?.width ?? 0,
      cardRadius: media ? Number.parseFloat(getComputedStyle(media).borderTopLeftRadius) : 0,
      overlapsCopy: overlaps,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  assert.equal(report.current, "4. 라이브 리포트", `${label}: report route state did not update`);
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

  await page.getByRole("button", { name: "5. 프로젝트", exact: true }).click();
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
  assert.deepEqual(pageErrors, [], "desktop motion path raised a page error");
  await context.close();
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
    const route = document.querySelector(".sw-route");
    const value = Number.parseFloat(getComputedStyle(route).getPropertyValue("--sw-route-progress"));
    return value >= 0.998;
  });
  const progress = await page.locator(".sw-route").evaluate((route) => ({
    value: Number.parseFloat(getComputedStyle(route).getPropertyValue("--sw-route-progress")),
    current: route.querySelector('[aria-current="step"]')?.getAttribute("aria-label")
  }));
  assert.ok(progress.value >= 0.998, "mobile height-only resize left the vertical gauge incomplete");
  assert.equal(progress.current, "5. 프로젝트", "mobile height-only resize lost the final scene state");
  await context.close();
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
  await verifyDesktopMotionPath(browser);
  await verifyProductPreviewAccountMenu(browser);
  writeFileSync(`${outDir}/landing-design-summary.json`, JSON.stringify(results, null, 2));
  console.log("Landing scroll-world visual checks passed.");
} finally {
  await browser.close();
}
