import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { extractBridgeNumber } from "./replay-marker-test-utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const workspaceDirectory = path.resolve(dashboardDirectory, "..");
const sanitizerPath = path.join(
  workspaceDirectory,
  "ap-backend",
  "src",
  "main",
  "java",
  "com",
  "accessibility",
  "platform",
  "artifact",
  "service",
  "ReplayDocumentSanitizer.java"
);

function extractBridgeScript(source) {
  const joinedDeclaration = 'private static final String BRIDGE_SCRIPT = String.join("",';
  const joinedIndex = source.indexOf(joinedDeclaration);
  if (joinedIndex >= 0) {
    const joinedEnd = source.indexOf("\n    );", joinedIndex);
    assert.ok(joinedEnd > joinedIndex, "joined bridge script declaration must be complete");
    const blocks = [];
    const blockPattern = /"""\r?\n([\s\S]*?)\r?\n {12}"""/g;
    const declaration = source.slice(joinedIndex, joinedEnd);
    let match;
    while ((match = blockPattern.exec(declaration)) !== null) {
      blocks.push(match[1].split(/\r?\n/).map((line) => line.replace(/^ {12}/, "")).join("\n"));
    }
    assert.ok(blocks.length >= 2, "joined bridge script must contain every text block");
    return blocks.join("");
  }
  const declaration = 'private static final String BRIDGE_SCRIPT = """';
  const declarationIndex = source.indexOf(declaration);
  assert.ok(declarationIndex >= 0, "bridge script declaration must exist");
  const contentStart = source.indexOf("\n", declarationIndex) + 1;
  const contentEnd = source.indexOf('\n            """;', contentStart);
  assert.ok(contentStart > 0 && contentEnd > contentStart, "bridge script text block must be complete");
  return source
    .slice(contentStart, contentEnd)
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n");
}

function extractBridgeStyle(source) {
  const declaration = 'private static final String BRIDGE_STYLE = """';
  const declarationIndex = source.indexOf(declaration);
  assert.ok(declarationIndex >= 0, "bridge style declaration must exist");
  const contentStart = source.indexOf("\n", declarationIndex) + 1;
  const contentEnd = source.indexOf('\n            """;', contentStart);
  assert.ok(contentStart > 0 && contentEnd > contentStart, "bridge style text block must be complete");
  return source
    .slice(contentStart, contentEnd)
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n");
}

async function sendCommand(page, message) {
  await page.evaluate((command) => {
    window.postMessage({ source: "accessibility-dashboard", ...command }, "*");
  }, message);
}

async function waitForActiveSlide(page, expectedIndex, timeoutMs = 3_000) {
  await page.waitForFunction(
    (index) => {
      const slides = [...document.querySelectorAll(".swiper-slide:not(.swiper-slide-duplicate)")];
      return slides.every((slide, slideIndex) => {
        const active = slideIndex === index;
        const display = getComputedStyle(slide).display;
        return active
          ? display !== "none" && slide.getAttribute("aria-hidden") === "false"
          : display === "none" && slide.getAttribute("aria-hidden") === "true";
      });
    },
    expectedIndex,
    { timeout: timeoutMs }
  );
}

async function getSlideDomState(page) {
  return page.locator(".swiper-slide:not(.swiper-slide-duplicate)").evaluateAll((slides) =>
    slides.map((slide, index) => ({
      index,
      display: getComputedStyle(slide).display,
      ariaHidden: slide.getAttribute("aria-hidden")
    }))
  );
}

const sanitizerSource = await readFile(sanitizerPath, "utf8");
const bridgeStyle = extractBridgeStyle(sanitizerSource);
let bridgeScript = extractBridgeScript(sanitizerSource);
const markerSize = extractBridgeNumber(bridgeScript, "MARKER_SIZE");
assert.equal(markerSize, 24, "the compact replay marker contract is 24px");
const closedShadowDeclaration = "host.attachShadow({ mode: 'closed' })";
assert.match(bridgeScript, /host\.attachShadow\(\{ mode: 'closed' \}\)/);
bridgeScript = bridgeScript.replace(closedShadowDeclaration, "host.attachShadow({ mode: 'open' })");
assert.doesNotMatch(
  bridgeScript,
  /SET_ANIMATIONS_PLAYING|animationsPlaying|animationCount|SLIDER_AUTOPLAY_MS|setInterval\s*\(|SET_DISMISS_MODE|UNDO_HIDDEN_ELEMENT|RESET_HIDDEN_ELEMENTS|dismissMode|hiddenCount|REPLAY_UI_STATE|SLIDER_PREVIOUS|SLIDER_NEXT|sliderAvailable|sliderIndex|sliderCount|reportReplayUiState|scheduleReplayUiState/,
  "the replay bridge must expose neither popup/animation controls nor an external carousel pager protocol"
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 620 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.setContent(`<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8">
        <style>
          @keyframes replay-drift {
            from { transform: translateX(0); }
            to { transform: translateX(160px); }
          }
          * { box-sizing: border-box; }
          html, body { min-height: 900px; margin: 0; }
          body { overflow: hidden; font-family: system-ui, sans-serif; }
          #fixed-header {
            position: fixed;
            inset: 0 0 auto 0;
            z-index: 40;
            height: 56px;
            padding: 16px;
            background: #111827;
            color: white;
          }
          #static-target {
            position: absolute;
            left: 40px;
            top: 80px;
            width: 120px;
            height: 40px;
            background: #cfe3ff;
          }
          #animated-target {
            position: absolute;
            left: 40px;
            top: 220px;
            width: 80px;
            height: 28px;
            background: #fef3c7;
            animation: replay-drift 220ms linear infinite alternate;
          }
          #consent-popup {
            position: fixed;
            inset: 150px auto auto 80px;
            z-index: 50;
            width: 300px;
            padding: 24px;
            background: white;
            border: 2px solid #1f2937;
          }
          #blocking-overlay {
            position: fixed;
            inset: 0;
            z-index: 49;
            background: rgba(15, 23, 42, .7);
          }
          .swiper-container { position: absolute; left: 40px; top: 280px; width: 420px; height: 100px; overflow: hidden; }
          .swiper-wrapper { display: flex; width: 1680px; height: 100px; }
          .swiper-slide { flex: 0 0 420px; width: 420px; height: 100px; padding: 24px; }
          .swiper-slide:nth-child(1) { background: #fee2e2; }
          .swiper-slide:nth-child(2) { background: #dcfce7; }
          .swiper-slide:nth-child(3) { background: #dbeafe; }
          .main-vi-prev, .main-vi-next {
            position: absolute;
            z-index: 2;
            top: 28px;
            min-width: 44px;
            min-height: 44px;
          }
          .main-vi-prev { left: 8px; }
          .main-vi-next { right: 8px; }
        </style>
      </head>
      <body style="overflow-x:scroll!important">
        <header id="fixed-header">고정 헤더</header>
        <div id="static-target">고정된 이슈</div>
        <div id="animated-target">정지 대상</div>
        <div id="blocking-overlay" class="modal-overlay"></div>
        <div id="consent-popup" class="consent-popup" role="dialog" aria-modal="true">
          <strong>알림 팝업</strong>
          <button id="popup-action" type="button">확인</button>
        </div>
        <div id="shadow-popup-host"></div>
        <div class="swiper-container" aria-label="테스트 슬라이더">
          <div class="swiper-wrapper">
            <section class="swiper-slide" data-slide="0" data-ua-audit-carousel-id="1" data-ua-audit-slide-index="0" data-ua-audit-slide-count="3">첫 번째 <button class="next" id="content-next" type="button">다음 글 읽기</button></section>
            <section class="swiper-slide" data-slide="1" data-ua-audit-carousel-id="1" data-ua-audit-slide-index="1" data-ua-audit-slide-count="3">두 번째</section>
            <section class="swiper-slide" data-slide="2" data-ua-audit-carousel-id="1" data-ua-audit-slide-index="2" data-ua-audit-slide-count="3"><span id="slide-three-host"></span></section>
            <section class="swiper-slide swiper-slide-duplicate" data-slide="clone">복제 슬라이드</section>
          </div>
          <div class="main-vi-prev">이전</div>
          <div class="main-vi-next">다음</div>
        </div>
        <div id="horizontal-overflow-probe" style="position:absolute;left:0;top:760px;width:1400px;height:1px"></div>
        <a id="blocked-link" data-uni-accessibility-replay-href="https://example.com/next">차단 링크</a>
      </body>
    </html>`);

  await page.evaluate(() => {
    const shadowHost = document.getElementById("slide-three-host");
    const shadowRoot = shadowHost.attachShadow({ mode: "open" });
    const shadowTarget = document.createElement("span");
    shadowTarget.id = "slide-three-target";
    shadowTarget.textContent = "세 번째 슬라이드의 그림자 DOM 이슈";
    shadowRoot.append(shadowTarget);

    const popupHost = document.getElementById("shadow-popup-host");
    const popupRoot = popupHost.attachShadow({ mode: "open" });
    const shadowPopup = document.createElement("div");
    shadowPopup.id = "shadow-consent-popup";
    shadowPopup.className = "cookie-popup";
    shadowPopup.setAttribute("role", "dialog");
    shadowPopup.setAttribute("aria-modal", "true");
    shadowPopup.textContent = "그림자 DOM 쿠키 팝업";
    popupRoot.append(shadowPopup);

    window.__replayOutbound = [];
    window.addEventListener("message", (event) => {
      if (event.data?.source === "accessibility-page-replay") {
        window.__replayOutbound.push(JSON.parse(JSON.stringify(event.data)));
      }
    });
  });
  await page.addStyleTag({ content: bridgeStyle });
  await page.addScriptTag({ content: bridgeScript });

  await page.waitForFunction(() =>
    (window.__replayOutbound ?? []).some((message) => message.type === "READY")
  );

  assert.equal(
    await page.locator("#consent-popup").evaluate((element) => getComputedStyle(element).display),
    "none",
    "a dialog popup must be hidden automatically as soon as the replay bridge loads"
  );
  assert.equal(
    await page.locator("#blocking-overlay").evaluate((element) => getComputedStyle(element).display),
    "none",
    "a blocking overlay must be hidden automatically as soon as the replay bridge loads"
  );
  assert.equal(
    await page.locator("#shadow-popup-host").evaluate((host) => {
      const popup = host.shadowRoot?.getElementById("shadow-consent-popup");
      return popup ? getComputedStyle(popup).display : null;
    }),
    "none",
    "a dialog popup in an open Shadow DOM must be hidden automatically"
  );
  assert.notEqual(
    await page.locator("#fixed-header").evaluate((element) => getComputedStyle(element).display),
    "none",
    "an ordinary fixed header must be preserved"
  );
  assert.equal(
    await page.locator("#fixed-header").evaluate((element) => getComputedStyle(element).position),
    "fixed"
  );
  assert.notEqual(
    await page.locator("body").evaluate((element) => getComputedStyle(element).overflowY),
    "hidden",
    "automatic popup removal must unlock body scrolling"
  );
  const unlockedScrollPosition = await page.evaluate(() => {
    window.scrollTo(0, 120);
    return {
      x: window.scrollX,
      y: window.scrollY,
      hasHorizontalOverflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
      htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
      bodyOverflowX: getComputedStyle(document.body).overflowX
    };
  });
  assert.equal(unlockedScrollPosition.x, 0);
  assert.equal(
    unlockedScrollPosition.hasHorizontalOverflow,
    true,
    "the regression fixture must contain content wider than the replay viewport"
  );
  assert.ok(["hidden", "clip"].includes(unlockedScrollPosition.htmlOverflowX));
  assert.ok(["hidden", "clip"].includes(unlockedScrollPosition.bodyOverflowX));
  assert.ok(unlockedScrollPosition.y > 0, "the replay document must be vertically scrollable after popup removal");

  const animationPositionBefore = await page.locator("#animated-target").evaluate(
    (element) => element.getBoundingClientRect().left
  );
  await page.waitForTimeout(420);
  const animationPositionAfter = await page.locator("#animated-target").evaluate(
    (element) => element.getBoundingClientRect().left
  );
  assert.ok(
    Math.abs(animationPositionAfter - animationPositionBefore) <= 0.5,
    "generic CSS animations must remain frozen for stable issue markers"
  );

  const replayIssues = [
    {
      id: 1,
      severity: "HIGH",
      title: "고정된 요소",
      pathSteps: [{ context: "DOCUMENT", selector: "#static-target" }]
    },
    {
      id: 2,
      severity: "MEDIUM",
      title: "숨은 슬라이드 요소",
      pathSteps: [
        { context: "DOCUMENT", selector: "#slide-three-host" },
        { context: "SHADOW_ROOT", selector: "#slide-three-target" }
      ]
    }
  ];
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: 1,
    issues: replayIssues
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 2
  );
  await page.waitForFunction((expectedMarkerSize) => {
    const targetRect = document.getElementById("static-target").getBoundingClientRect();
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    const marker = root.querySelector(".marker");
    const markerRect = marker.getBoundingClientRect();
    return !marker.hidden
      && markerRect.width === expectedMarkerSize
      && markerRect.height === expectedMarkerSize
      && targetRect.left - markerRect.right >= 7.5;
  }, markerSize);

  const contentNextButton = page.locator("#content-next");
  assert.equal(await contentNextButton.getAttribute("aria-label"), null);
  const slideStateBeforeContentNext = await getSlideDomState(page);
  await contentNextButton.click();
  await page.waitForTimeout(80);
  assert.deepEqual(
    await getSlideDomState(page),
    slideStateBeforeContentNext,
    "a generic content .next button must not be treated as a carousel control"
  );
  assert.equal(
    await contentNextButton.getAttribute("aria-label"),
    null,
    "a generic content .next button must keep its original accessible name"
  );

  const rawPagePreviousButton = page.locator("div.main-vi-prev");
  const rawPageNextButton = page.locator("div.main-vi-next");
  for (const [control, label] of [
    [rawPagePreviousButton, "Previous slide"],
    [rawPageNextButton, "Next slide"]
  ]) {
    assert.equal(await control.getAttribute("role"), "button");
    assert.equal(await control.getAttribute("tabindex"), "0");
    assert.equal(await control.getAttribute("aria-label"), label);
  }
  const pagePreviousButton = page.getByRole("button", { name: "Previous slide" });
  const pageNextButton = page.getByRole("button", { name: "Next slide" });
  await page.evaluate(() => {
    document.body.style.setProperty("overflow-y", "auto", "important");
    window.scrollTo(0, 180);
  });
  const scrollBeforePageClick = await page.evaluate(() => window.scrollY);
  await pageNextButton.click();
  await waitForActiveSlide(page, 1);
  assert.equal(await pageNextButton.evaluate((element) => document.activeElement === element), true);
  assert.equal(await page.evaluate(() => window.scrollY), scrollBeforePageClick);

  const manuallySelectedSlideState = await getSlideDomState(page);
  for (let repetition = 0; repetition < 2; repetition += 1) {
    const locatorStatusCountBeforeReinitialize = await page.evaluate(() =>
      window.__replayOutbound.filter((message) => message.type === "LOCATOR_STATUS").length
    );
    await sendCommand(page, {
      type: "INIT_ISSUES",
      markersVisible: true,
      selectedIssueId: 1,
      issues: replayIssues
    });
    await page.waitForFunction(
      ({ before, expectedIncrease }) =>
        window.__replayOutbound.filter((message) => message.type === "LOCATOR_STATUS").length
          >= before + expectedIncrease,
      { before: locatorStatusCountBeforeReinitialize, expectedIncrease: replayIssues.length }
    );
    assert.deepEqual(
      await getSlideDomState(page),
      manuallySelectedSlideState,
      `polling INIT_ISSUES repetition ${repetition + 1} must preserve the manually selected slide`
    );
  }

  await pagePreviousButton.focus();
  const scrollBeforePageEnter = await page.evaluate(() => window.scrollY);
  await pagePreviousButton.press("Enter");
  await waitForActiveSlide(page, 0);
  assert.equal(await pagePreviousButton.evaluate((element) => document.activeElement === element), true);
  assert.equal(await page.evaluate(() => window.scrollY), scrollBeforePageEnter);

  await pageNextButton.focus();
  const scrollBeforePageSpace = await page.evaluate(() => window.scrollY);
  await pageNextButton.press("Space");
  await waitForActiveSlide(page, 1);
  assert.equal(await pageNextButton.evaluate((element) => document.activeElement === element), true);
  assert.equal(await page.evaluate(() => window.scrollY), scrollBeforePageSpace);
  const slideStateBeforeAutoplayWait = await getSlideDomState(page);
  await page.waitForTimeout(420);
  assert.deepEqual(
    await getSlideDomState(page),
    slideStateBeforeAutoplayWait,
    "page-native slider controls must move exactly one step and never start autoplay"
  );

  await sendCommand(page, { type: "FOCUS_ISSUE", issueId: 2 });
  await waitForActiveSlide(page, 2);
  const focusedSlideState = await getSlideDomState(page);
  assert.equal(focusedSlideState[2].ariaHidden, "false");
  assert.notEqual(focusedSlideState[2].display, "none");
  assert.ok(focusedSlideState.slice(0, 2).every((slide) =>
    slide.display === "none" && slide.ariaHidden === "true"
  ));
  assert.equal(
    await page.locator('.swiper-slide[data-slide="2"]').evaluate((element) => getComputedStyle(element).display),
    "block",
    "focusing an issue in a hidden annotated slide must reveal that logical slide"
  );
  assert.equal(
    await page.locator('.swiper-slide[data-slide="0"]').evaluate((element) => getComputedStyle(element).display),
    "none"
  );
  assert.ok(
    await page.locator("#slide-three-host").evaluate((host) =>
      host.shadowRoot?.getElementById("slide-three-target")?.getBoundingClientRect().width > 0
    ),
    "the focused open Shadow DOM target must be visible in the revealed slide"
  );

  const blockedCountBefore = await page.evaluate(() =>
    window.__replayOutbound.filter((message) => message.type === "LINK_BLOCKED").length
  );
  await page.locator("#blocked-link").evaluate((element) => element.click());
  await page.waitForFunction((before) =>
    window.__replayOutbound.filter((message) => message.type === "LINK_BLOCKED").length > before,
    blockedCountBefore
  );

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    result: "PASS",
    finalSlideState: await getSlideDomState(page),
    outboundMessageTypes: [...new Set(
      await page.evaluate(() => window.__replayOutbound.map((message) => message.type))
    )],
    pageErrors
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
