/**
 * Verifies the landing across desktop and mobile breakpoints:
 * header, hero, the hero card that grows into the scroll film, the film's
 * scenes and the feature sections after it. The viewport matrix uses reduced
 * motion so it does not download or decode the demo clips; a separate desktop
 * pass checks the card-to-film handoff, scene navigation and every clip tier.
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
const SECTION_ORDER = ["ua-hero", "uni-scroll-world", "ua-message", "ua-look", "ua-stats", "ua-report", "ua-tools", "ua-engine", "ua-compare", "ua-faq", "ua-end"];
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

/** Scroll to a point measured from the film's top (the film starts below the hero). */
async function scrollFilm(page, scrollVh) {
  await page.evaluate((value) => {
    const filmTop = document.getElementById("tour").getBoundingClientRect().top + scrollY;
    window.scrollTo(0, filmTop + Math.min(innerHeight, 1080) * value);
  }, scrollVh);
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
  await page.waitForFunction(() => [...document.querySelectorAll('.sw-scene__still')]
    .every(image => image.complete && image.naturalWidth > 0));
  await settle(page);

  const facts = await page.evaluate((order) => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const main = document.querySelector("main#uni-access-main");
    const header = document.querySelector(".ua-lnav");
    const headerRect = header?.getBoundingClientRect();
    const title = document.querySelector("#ua-hero-title");
    const stage = document.querySelector(".sw-stage");
    const film = document.getElementById("tour");
    const hero = document.querySelector(".ua-hero");
    const controls = [...document.querySelectorAll(".ua-hero__actions a, .ua-look__tab, .ua-faq__item summary, .ua-footer__wordmark")]
      .filter(isVisible)
      .map((element) => ({ label: element.textContent?.trim(), height: element.getBoundingClientRect().height }));
    const sectionOrder = [...main.children]
      .map((element) => order.find((name) => element.classList.contains(name)))
      .filter(Boolean);
    return {
      ready: Boolean(document.querySelector("[data-scroll-world-ready=true]")),
      mainCount: document.querySelectorAll("main#uni-access-main").length,
      h1Count: document.querySelectorAll("h1").length,
      h1Text: title?.textContent,
      headerOutsideMain: Boolean(header) && !header.closest("main"),
      headerWithinViewport: Boolean(headerRect && headerRect.left >= -0.5 && headerRect.right <= document.documentElement.clientWidth + 0.5),
      headerSticky: header ? getComputedStyle(header).position : null,
      engineChromeCount: document.querySelectorAll(".sw-topbar, .sw-skip-link, .sw-hint").length,
      copyCount: document.querySelectorAll(".sw-copy").length,
      activeCopyCount: document.querySelectorAll('.sw-copy[data-sw-active="true"]').length,
      hiddenCopyCount: document.querySelectorAll('.sw-copy[aria-hidden="true"], .sw-copy[inert]').length,
      inactiveCopyLeakCount: document.querySelectorAll('.sw-copy[data-sw-active="false"] :is(a[href], button):not([tabindex="-1"])').length,
      routeVisible: Boolean(document.querySelector(".sw-route") && isVisible(document.querySelector(".sw-route"))),
      videoCount: document.querySelectorAll("video").length,
      posterReady: [...document.querySelectorAll(".sw-scene__still")].every((image) => image.complete && image.naturalWidth > 0),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      diveVisible: isVisible(document.querySelector(".ua-dive")),
      // Without the growing card, the film's first frame sits in the page flow right after the hero.
      stageInFlow: stage ? getComputedStyle(stage).position === "absolute" && getComputedStyle(stage).visibility !== "hidden" : false,
      stageTopGap: stage && film ? Math.abs(stage.getBoundingClientRect().top - film.getBoundingClientRect().top) : null,
      filmAfterHero: film && hero ? film.getBoundingClientRect().top >= hero.getBoundingClientRect().bottom - 0.5 : false,
      titleFontSize: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 0,
      sectionOrder,
      kwcagRows: document.querySelectorAll(".ua-report__column li").length,
      statValues: [...document.querySelectorAll(".ua-stats__value")].map((element) => element.dataset.value),
      lookTabs: document.querySelectorAll('.ua-look [role="tab"]').length,
      faqCount: document.querySelectorAll(".ua-faq__item").length,
      controls
    };
  }, SECTION_ORDER);

  const label = `${viewport.width}x${viewport.height}${viewport.deviceScaleFactor ? `@${viewport.deviceScaleFactor}x` : ""}`;
  assert.equal(facts.ready, true, `${label}: scroll world did not initialize`);
  assert.equal(facts.mainCount, 1, `${label}: landing must expose one main landmark`);
  assert.equal(facts.h1Count, 1, `${label}: landing must expose one h1`);
  assert.equal(facts.h1Text, "공공 서비스의 웹 접근성,이제 한눈에.", `${label}: hero heading changed`);
  assert.equal(facts.headerOutsideMain, true, `${label}: the header must stay outside the main landmark`);
  assert.equal(facts.headerWithinViewport, true, `${label}: header exceeds the viewport`);
  assert.equal(facts.headerSticky, "sticky", `${label}: header must stay pinned while scrolling`);
  assert.equal(facts.engineChromeCount, 0, `${label}: the film must not add its own header, skip link or scroll cue`);
  // Phones (<=760px) skip the opening photo, whose 16:9 frame crops badly in portrait.
  const expectedScenes = viewport.width <= 760 ? 4 : 5;
  assert.equal(facts.copyCount, expectedScenes, `${label}: expected ${expectedScenes} film scenes`);
  // At the top of the page only the opening scene's (title-less) copy is live;
  // a phone film starts on a card whose copy appears once it is scrolled to.
  assert.equal(facts.activeCopyCount, expectedScenes === 5 ? 1 : 0,
    `${label}: unexpected number of active scene copies before the film`);
  assert.equal(facts.hiddenCopyCount, 0, `${label}: scene copy must stay readable by assistive technology`);
  assert.equal(facts.inactiveCopyLeakCount, 0, `${label}: inactive copy controls escaped the Tab order`);
  assert.equal(facts.routeVisible, false, `${label}: side progress bar must stay hidden`);
  assert.equal(facts.videoCount, 0, `${label}: reduced motion must not create videos`);
  assert.deepEqual(videoRequests, [], `${label}: reduced motion unexpectedly requested video media`);
  assert.equal(facts.posterReady, true, `${label}: one or more scene posters failed to load`);
  assert.equal(facts.overflow, 0, `${label}: page-level horizontal overflow detected`);
  assert.equal(facts.diveVisible, false, `${label}: the growing hero card must stay off under reduced motion`);
  assert.equal(facts.stageInFlow, true, `${label}: the film's first frame must wait in the page flow`);
  assert.ok(facts.stageTopGap !== null && facts.stageTopGap < 1, `${label}: the waiting first frame is not at the film's top`);
  assert.equal(facts.filmAfterHero, true, `${label}: the film overlaps the hero`);
  assert.deepEqual(facts.sectionOrder, SECTION_ORDER, `${label}: landing sections are out of order`);
  assert.equal(facts.kwcagRows, 33, `${label}: the report grid must list all 33 KWCAG items`);
  assert.deepEqual(facts.statValues.slice(0, 3), ["3", "33", "21"], `${label}: scope numbers changed`);
  assert.equal(facts.lookTabs, 4, `${label}: expected four live-report features`);
  assert.equal(facts.faqCount, 6, `${label}: expected six questions`);
  if (viewport.width >= 3840 && viewport.height >= 2000) {
    assert.ok(facts.titleFontSize >= 155 && facts.titleFontSize <= 161, `${label}: 4K hero title did not scale (${facts.titleFontSize}px)`);
  } else if (viewport.width >= 2500 && viewport.height >= 1200) {
    assert.ok(facts.titleFontSize >= 95 && facts.titleFontSize <= 112, `${label}: QHD hero title did not scale (${facts.titleFontSize}px)`);
  } else {
    assert.ok(facts.titleFontSize >= 40 && facts.titleFontSize <= 80, `${label}: hero title scale is out of bounds (${facts.titleFontSize}px)`);
  }
  for (const control of facts.controls) {
    assert.ok(control.height >= CONTROL_MIN_HEIGHT_PX - 0.5, `${label}: ${control.label} target is only ${control.height}px high`);
  }

  await page.screenshot({ path: `${outDir}/landing-${label}-top.png`, fullPage: false });

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

  const focus = await page.locator(".ua-hero .ua-button").evaluate((element) => {
    element.focus();
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle };
  });
  assert.equal(focus.width, "3px", `${label}: CTA focus outline must be 3px`);
  assert.equal(focus.offset, "3px", `${label}: CTA focus separation must be 3px`);
  assert.notEqual(focus.style, "none", `${label}: CTA focus outline is missing`);

  // Film distances are capped at the FHD unit even when media fills a taller viewport.
  // Without the opening scene (scroll 1.6) every later scene starts that much earlier.
  const filmShift = expectedScenes === 5 ? 0 : 1.6;
  const reportSceneIndex = expectedScenes === 5 ? 3 : 2;
  await scrollFilm(page, 5.15 - filmShift);
  await page.waitForFunction(
    () => document.querySelector(".sw-copy[data-sw-active=true] .sw-copy__title")?.textContent === "페이지와 분석 결과를 한눈에."
  );
  await settle(page);
  const report = await page.evaluate((sceneIndex) => {
    const scene = document.querySelectorAll(".sw-scene")[sceneIndex];
    const media = scene?.querySelector(".sw-scene__video, .sw-scene__still");
    const copy = document.querySelector('.sw-copy[data-sw-active="true"]');
    const rect = media?.getBoundingClientRect();
    const copyRect = copy?.getBoundingClientRect();
    return {
      inactiveCopyLeakCount: document.querySelectorAll('.sw-copy[data-sw-active="false"] :is(a[href], button):not([tabindex="-1"])').length,
      cardWidth: rect?.width ?? 0,
      cardRadius: media ? Number.parseFloat(getComputedStyle(media).borderTopLeftRadius) : 0,
      overlapsCopy: Boolean(rect && copyRect && rect.left < copyRect.right - 1 && rect.right > copyRect.left + 1 &&
        rect.top < copyRect.bottom - 1 && rect.bottom > copyRect.top + 1),
      stageFixed: getComputedStyle(document.querySelector(".sw-stage")).position === "fixed",
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  }, reportSceneIndex);
  assert.equal(report.inactiveCopyLeakCount, 0, `${label}: report transition exposed hidden CTA content`);
  assert.equal(report.overlapsCopy, false, `${label}: report media overlaps its copy`);
  assert.equal(report.stageFixed, true, `${label}: the film stage must be pinned while it plays`);
  assert.ok(report.cardRadius >= 20, `${label}: report media must retain rounded card framing (${report.cardRadius}px)`);
  const configuredCardRatio = viewport.width <= 860 ? 0.92 : viewport.width < 1280 ? 0.48 : 0.54;
  const cardMaxHeightRatio = viewport.width <= 860 ? 0.46 : 0.82;
  const expectedCardWidth = Math.min(viewport.width * configuredCardRatio, viewport.height * cardMaxHeightRatio * (16 / 9));
  assert.ok(
    Math.abs(report.cardWidth - expectedCardWidth) < 1,
    `${label}: report card width is ${Math.round(report.cardWidth)}px; expected ${Math.round(expectedCardWidth)}px`
  );
  assert.equal(report.overflow, 0, `${label}: report scene introduced horizontal overflow`);

  await scrollFilm(page, 6.75 - filmShift);
  await page.waitForFunction(
    () => document.querySelector(".sw-copy[data-sw-active=true] .sw-copy__title")?.textContent === "접근성을 한 화면에서"
  );
  assert.deepEqual(
    await page.locator('.sw-copy[data-sw-active="true"] .sw-copy__cta a').allTextContents(),
    ["새 페이지 분석"],
    `${label}: the final scene must offer only the primary action`
  );

  // After the film: the following sections cover the pinned film layers.
  await page.locator(".ua-report").scrollIntoViewIfNeeded();
  await settle(page);
  const covered = await page.evaluate(() => {
    const paper = document.querySelector(".ua-report__paper").getBoundingClientRect();
    // The report can be taller than the viewport, so probe below the fixed nav rather than at a set height.
    const navBottom = document.querySelector(".ua-lnav")?.getBoundingClientRect().bottom ?? 0;
    const hit = document.elementFromPoint(paper.left + paper.width / 2, Math.max(paper.top + 10, navBottom + 10, 80));
    return Boolean(hit?.closest(".ua-report"));
  });
  assert.equal(covered, true, `${label}: the final report section is hidden behind the film`);

  assert.equal(apiRequestCount, 0, `${label}: landing unexpectedly requested an API`);
  assert.deepEqual(pageErrors, [], `${label}: browser page errors detected`);

  if (viewport.width === 1440 || viewport.width === 390) {
    await page.screenshot({ path: `${outDir}/landing-${label}-report.png`, fullPage: false });
  }

  if (viewport.width === 1440) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await Promise.all([
      page.waitForURL("**/analyze"),
      page.locator(".ua-lnav__cta").click()
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
  assert.deepEqual(videoRequests, ["/landing/scroll-world/vid/opening.mp4"]);
  const openingBytes = await page.evaluate(() => performance.getEntriesByType("resource")
    .find((entry) => new URL(entry.name).pathname === "/landing/scroll-world/vid/opening.mp4")?.encodedBodySize);
  // The full-screen opening uses 4K on every desktop, within a bounded transfer budget.
  assert.ok(openingBytes > 0 && openingBytes <= 8 * 1024 * 1024,
    `initial desktop video exceeds the 8 MiB media budget: ${openingBytes} bytes`);

  // Before the film starts its layers stay hidden; the hero card owns the screen.
  const layout = await page.evaluate(() => ({
    stageHidden: getComputedStyle(document.querySelector(".sw-stage")).visibility === "hidden",
    diveTop: document.querySelector(".ua-dive").getBoundingClientRect().top + scrollY,
    filmTop: document.getElementById("tour").getBoundingClientRect().top + scrollY
  }));
  assert.equal(layout.stageHidden, true, "the film must stay hidden while the hero card grows");

  // The card fills the viewport exactly when the film starts, on the same frame.
  // Let the hero entrance finish first; it briefly lifts the card into place.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.animationName === "ua-hero-rise")
    .map((animation) => animation.finished)));
  await page.evaluate((y) => window.scrollTo(0, y), layout.filmTop - 1);
  await settle(page);
  const card = await page.evaluate(() => {
    const frame = document.querySelector(".ua-dive__frame").getBoundingClientRect();
    return { width: frame.width, height: frame.height, top: frame.top,
      viewportWidth: document.documentElement.clientWidth, viewportHeight: innerHeight,
      stageHidden: getComputedStyle(document.querySelector(".sw-stage")).visibility === "hidden" };
  });
  assert.ok(Math.abs(card.width - card.viewportWidth) < 2 && Math.abs(card.height - card.viewportHeight) < 2 && Math.abs(card.top) < 2,
    `the hero card must fill the viewport at the handoff: ${JSON.stringify(card)}`);
  assert.equal(card.stageHidden, true, "the film must not appear before the card has filled the viewport");
  await page.evaluate((y) => window.scrollTo(0, y), layout.filmTop + 1);
  await settle(page);
  const handoff = await page.evaluate(() => {
    const stage = document.querySelector(".sw-stage");
    const still = document.querySelector(".sw-scene .sw-scene__still").getBoundingClientRect();
    return { visible: getComputedStyle(stage).visibility !== "hidden", fixed: getComputedStyle(stage).position === "fixed",
      covers: still.left <= 0.5 && still.top <= 0.5 && still.right >= document.documentElement.clientWidth - 0.5 && still.bottom >= innerHeight - 0.5 };
  });
  assert.deepEqual(handoff, { visible: true, fixed: true, covers: true }, "the film must take over full-screen at the handoff");
  await page.screenshot({ path: `${outDir}/handoff-1440.png` });

  const scenes = [];
  for (const scene of refreshedScenes) {
    await scrollFilm(page, scene.scrollVh);
    await page.locator(`#sw-section-${scene.id}[data-sw-active="true"]`).waitFor();
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
        activeCopyCount: document.querySelectorAll('.sw-copy[data-sw-active="true"]').length,
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

  // The live-report demo loads its fixed snapshot once the section is near and starts its cursor demo in view.
  await page.locator("#look").evaluate((section) => window.scrollTo(0, section.getBoundingClientRect().top + scrollY));
  await page.locator(".ua-demo-app").evaluate((app) => app.scrollIntoView({ block: "center" }));
  await page.waitForFunction(() => document.querySelectorAll(".ua-demo-mk").length === 14, null, { timeout: 15_000 });
  await page.waitForFunction(() => window.__lookDemo?.open?.id === "6516", null, { timeout: 5_000 });
  assert.equal(videoRequests.some((path) => path.startsWith("/landing/look/")), false, "the old feature recordings must not load");

  // The message after the film lights up phrase by phrase as it scrolls in.
  await page.locator(".ua-message").evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - innerHeight * 0.2));
  await page.waitForFunction(() => document.querySelectorAll(".ua-message__phrase.is-lit").length === document.querySelectorAll(".ua-message__phrase").length);

  assert.deepEqual(pageErrors, [], "desktop motion path raised a page error");
  await context.close();
  return { openingBytes, scenes };
}

async function verifyLookTabs(browser) {
  // The live-report demo: arrow keys and clicks select scenes; reduced motion shows each scene's final state.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-scroll-world-ready="true"]').waitFor();
    await page.locator("#look").evaluate((section) => window.scrollTo(0, section.getBoundingClientRect().top + scrollY));
    await page.locator(".ua-demo-app").evaluate((app) => app.scrollIntoView({ block: "center" }));
    await page.waitForFunction(() => document.querySelectorAll(".ua-demo-mk").length === 14, null, { timeout: 15_000 });
    const selected = () => page.locator('.ua-look [role="tab"][aria-selected="true"]').getAttribute("id");
    assert.equal(await selected(), "ua-look-tab-locate");
    // Reduced motion: no cursor demo, the scene's last state (the search-box popover) is shown at once.
    assert.equal(await page.evaluate(() => window.__lookDemo.paused), true, "reduced motion must not autoplay the demo");
    assert.equal(await page.locator(".ua-demo-pop").count(), 1, "reduced motion must show the scene's final popover");
    await page.locator("#ua-look-tab-locate").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.equal(await selected(), "ua-look-tab-approx");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "ua-look-tab-approx");
    await page.keyboard.press("End");
    assert.equal(await selected(), "ua-look-tab-offscreen");
    assert.equal(await page.locator("#ua-look-panel").getAttribute("aria-labelledby"), "ua-look-tab-offscreen");
    assert.match(await page.locator(".ua-demo-rail__state").getAttribute("src"), /\/landing\/look-demo\/rail-f2-g1\.webp$/);
    await page.keyboard.press("Home");
    assert.equal(await selected(), "ua-look-tab-locate");
    await page.locator("#ua-look-tab-cluster").click();
    assert.equal(await selected(), "ua-look-tab-cluster");
    assert.equal(await page.locator(".ua-demo-pop__pager").count(), 1, "the cluster scene must open a paged popover");
    // Keyboard users keep their place: paging redraws the popover and a filter
    // redraws the rail, but focus stays on the matching button, so Escape still works.
    const focusInfo = () => page.evaluate(() => {
      const active = document.activeElement;
      return {
        inPager: Boolean(active?.closest(".ua-demo-pop__pager")),
        marker: active?.classList.contains("ua-demo-mk") ?? false,
        key: active?.dataset?.key ?? null
      };
    });
    await page.locator(".ua-demo-pop__pager button:not([disabled])").first().focus();
    await page.keyboard.press("Enter");
    assert.equal((await focusInfo()).inPager, true, "paging must keep focus on a pager button");
    await page.keyboard.press("Escape");
    assert.equal((await focusInfo()).marker, true, "Escape after paging must return focus to the marker");
    const railFilter = page.locator('[data-demo="rail"] .ua-demo-hot[aria-pressed="false"]').first();
    const filterKey = await railFilter.getAttribute("data-key");
    await railFilter.focus();
    await page.keyboard.press("Enter");
    assert.equal((await focusInfo()).key, filterKey, "a rail filter must keep focus after the rail redraws");
    assert.equal(await page.locator(`[data-demo="rail"] .ua-demo-hot[data-key="${filterKey}"]`).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('.ua-look [role="tab"][tabindex="0"]').count(), 1, "only the selected tab may be in the Tab order");
    // The sidebar and the report tabs only show hover states; clicking them changes nothing.
    const railBefore = await page.locator(".ua-demo-rail__state").getAttribute("src");
    await page.locator(".ua-demo-tabs-hot .ua-demo-hot").nth(1).click({ force: true });
    await page.locator(".ua-demo-side-hot .ua-demo-hot").nth(3).click({ force: true });
    assert.equal(await page.locator(".ua-demo-rail__state").getAttribute("src"), railBefore);
    assert.equal(new URL(page.url()).pathname, "/", "demo hover areas must not navigate");
    await page.locator(".ua-look").screenshot({ path: `${outDir}/look-cluster-1440.png` });
  } finally {
    await context.close();
  }
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
      // The opening scene ships only its 4K original (it sets no clip variants).
      for (const scene of [...(variant.suffix ? [] : [{ id: "opening" }]), ...refreshedScenes]) {
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
  // Finish initial assets/font layout before isolating a height-only resize.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => {
    const maxScroll = document.documentElement.scrollHeight - innerHeight;
    const activeTitle = document.querySelector('.sw-copy[data-sw-active="true"] .sw-copy__title');
    return Math.abs(scrollY - maxScroll) <= 1 && activeTitle?.textContent === "접근성을 한 화면에서";
  });
  assert.equal(await page.locator(".sw-route").isVisible(), false, "mobile resize must not restore the side bar");
  assert.equal(
    await page.locator('.sw-copy[data-sw-active="true"] .sw-copy__title').textContent(),
    "접근성을 한 화면에서",
    "mobile height-only resize lost the final scene state"
  );
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
  assert.equal(metrics.borderTopWidth, "1px", "account dropdown must render a visible outer border");
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
  await verifyLookTabs(browser);
  const scenes = await verifyDesktopMotionPath(browser);
  const variants = await verifyRefreshedMediaVariants(browser);
  await verifyProductPreviewAccountMenu(browser);
  writeFileSync(`${outDir}/landing-design-summary.json`, JSON.stringify(results, null, 2));
  writeFileSync(`${outDir}/landing-media-summary.json`, JSON.stringify({ scenes, variants }, null, 2));
  console.log("Landing visual checks passed.");
} finally {
  await browser.close();
}
