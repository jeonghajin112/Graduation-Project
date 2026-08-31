import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
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

const MARKER_HALO = 6;
const CAROUSEL_CONTROL_HIT_TARGET_SIZE = 24;
const CAROUSEL_CONTROL_CLEARANCE = 4;
const POSITION_TOLERANCE = 0.8;
const MAX_HERO_ANCHOR_DISTANCE = 64;
const MAX_VISIBLE_MARKER_ANCHOR_DISTANCE = 200;

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

const rectFact = (rect) => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  width: rect.width,
  height: rect.height
});

const expandedRect = (rect, amount = MARKER_HALO) => ({
  left: rect.left - amount,
  top: rect.top - amount,
  right: rect.right + amount,
  bottom: rect.bottom + amount,
  width: rect.width + amount * 2,
  height: rect.height + amount * 2
});

const carouselCenterProtectedRect = (rect) => {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const hitWidth = Math.min(CAROUSEL_CONTROL_HIT_TARGET_SIZE, rect.width);
  const hitHeight = Math.min(CAROUSEL_CONTROL_HIT_TARGET_SIZE, rect.height);
  return {
    left: centerX - hitWidth / 2 - CAROUSEL_CONTROL_CLEARANCE,
    top: centerY - hitHeight / 2 - CAROUSEL_CONTROL_CLEARANCE,
    right: centerX + hitWidth / 2 + CAROUSEL_CONTROL_CLEARANCE,
    bottom: centerY + hitHeight / 2 + CAROUSEL_CONTROL_CLEARANCE,
    width: hitWidth + CAROUSEL_CONTROL_CLEARANCE * 2,
    height: hitHeight + CAROUSEL_CONTROL_CLEARANCE * 2
  };
};

const overlaps = (left, right) => !(
  left.right <= right.left
  || right.right <= left.left
  || left.bottom <= right.top
  || right.bottom <= left.top
);

const rectangleDistance = (left, right) => Math.hypot(
  Math.max(right.left - left.right, left.left - right.right, 0),
  Math.max(right.top - left.bottom, left.top - right.bottom, 0)
);

function assertClose(actual, expected, message, tolerance = POSITION_TOLERANCE) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`
  );
}

function issue(id, selector, title = `Interactive obstacle issue ${id}`) {
  return {
    id,
    severity: id % 3 === 0 ? "HIGH" : id % 3 === 1 ? "MEDIUM" : "LOW",
    severityLabel: id % 3 === 0 ? "High" : id % 3 === 1 ? "Medium" : "Low",
    code: `interactive-${id}`,
    title,
    message: `Marker ${id} must preserve nearby page controls`,
    path: selector,
    pathSteps: [{ context: "DOCUMENT", selector }]
  };
}

function shadowIssue(id, steps, title) {
  return {
    ...issue(id, "", title),
    pathSteps: steps
  };
}

async function sendCommand(page, command) {
  await page.evaluate((message) => {
    window.postMessage({ source: "accessibility-dashboard", ...message }, "*");
  }, command);
}

async function waitForMarkers(page, count) {
  await page.waitForFunction((expected) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker").length === expected;
  }, count);
  await page.waitForTimeout(80);
}

async function setFixtureControlsNeutralized(page, neutralized) {
  await page.evaluate((shouldNeutralize) => {
    const controls = [];
    const queue = [document];
    const seen = new Set();
    while (queue.length > 0) {
      const root = queue.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      controls.push(...root.querySelectorAll("[data-test-control]"));
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && element.id !== "__uni_accessibility_replay_host") {
          queue.push(element.shadowRoot);
        }
      }
    }
    if (shouldNeutralize) {
      window.__fixtureControlPointerStyles = new Map(controls.map((control) => [control, {
        value: control.style.getPropertyValue("pointer-events"),
        priority: control.style.getPropertyPriority("pointer-events")
      }]));
      for (const control of controls) {
        control.style.setProperty("pointer-events", "none", "important");
      }
      return;
    }
    for (const control of controls) {
      const original = window.__fixtureControlPointerStyles?.get(control);
      if (!original || original.value === "") control.style.removeProperty("pointer-events");
      else control.style.setProperty("pointer-events", original.value, original.priority);
    }
    window.__fixtureControlPointerStyles = null;
  }, neutralized);
}

async function markerFacts(page) {
  return page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    return [...root.querySelectorAll(".marker")].map((marker, arrayIndex) => {
      const rect = marker.getBoundingClientRect();
      return {
        arrayIndex,
        markerIndex: marker.dataset.markerIndex,
        issueIds: (marker.dataset.issueIds ?? "").split(",").filter(Boolean).map(Number),
        groupSize: marker.dataset.groupSize,
        text: marker.textContent,
        hidden: marker.hidden,
        display: getComputedStyle(marker).display,
        rect: {
          left: rect.left + window.scrollX,
          top: rect.top + window.scrollY,
          right: rect.right + window.scrollX,
          bottom: rect.bottom + window.scrollY,
          width: rect.width,
          height: rect.height
        }
      };
    });
  });
}

async function issueTargetFirstRects(page, issues) {
  return page.evaluate((commandIssues) => commandIssues.map((entry) => {
    let root = document;
    let current = null;
    try {
      for (const step of entry.pathSteps ?? []) {
        if (step.context === "DOCUMENT") {
          root = document;
        } else if (step.context === "SHADOW_ROOT") {
          root = current?.shadowRoot;
        }
        if (!root) return null;
        current = root.querySelector(step.selector);
        if (!current) return null;
      }
      const rect = current?.getClientRects?.()[0];
      return rect && rect.width > 0 && rect.height > 0
        ? {
            left: rect.left + window.scrollX,
            top: rect.top + window.scrollY,
            right: rect.right + window.scrollX,
            bottom: rect.bottom + window.scrollY,
            width: rect.width,
            height: rect.height
          }
        : null;
    } catch {
      return null;
    }
  }), issues);
}

async function assertVisibleMarkersRemainAnchored(page, markers, issues, message) {
  const targets = await issueTargetFirstRects(page, issues);
  const distances = [];
  markers.forEach((marker) => {
    if (marker.hidden) return;
    const issueIndex = issues.findIndex((issue) => issue.id === marker.issueIds[0]);
    const target = targets[issueIndex];
    assert.ok(target, `${message}: visible marker ${marker.markerIndex} must have a rendered target`);
    const distance = rectangleDistance(marker.rect, target);
    assert.ok(
      distance <= MAX_VISIBLE_MARKER_ANCHOR_DISTANCE,
      `${message}: marker ${marker.markerIndex} drifted ${distance.toFixed(2)}px from its target; maximum is ${MAX_VISIBLE_MARKER_ANCHOR_DISTANCE}px`
    );
    distances.push(distance);
  });
  return {
    checked: distances.length,
    maximum: distances.length === 0 ? 0 : Math.max(...distances)
  };
}

async function elementDocumentRect(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      right: rect.right + window.scrollX,
      bottom: rect.bottom + window.scrollY,
      width: rect.width,
      height: rect.height
    };
  });
}

async function deepestHitId(page, x, y) {
  return page.evaluate(({ clientX, clientY }) => {
    let hit = document.elementFromPoint(clientX, clientY);
    const visited = new Set();
    while (hit?.shadowRoot && !visited.has(hit)) {
      visited.add(hit);
      const nested = hit.shadowRoot.elementFromPoint(clientX, clientY);
      if (!nested || nested === hit) break;
      hit = nested;
    }
    return {
      id: hit?.id || null,
      className: typeof hit?.className === "string" ? hit.className : null,
      text: hit?.textContent || null
    };
  }, { clientX: x, clientY: y });
}

async function activeSlideIndex(page) {
  return page.locator("#hongik-carousel .swiper-slide:not(.swiper-slide-duplicate)")
    .evaluateAll((slides) => slides.findIndex((slide) => (
      getComputedStyle(slide).display !== "none" && slide.getAttribute("aria-hidden") !== "true"
    )));
}

async function waitForActiveSlide(page, index) {
  await page.waitForFunction((expected) => {
    const slides = [...document.querySelectorAll(
      "#hongik-carousel .swiper-slide:not(.swiper-slide-duplicate)"
    )];
    return slides.length === 3 && slides.every((slide, slideIndex) => {
      const active = slideIndex === expected;
      return active
        ? getComputedStyle(slide).display !== "none" && slide.getAttribute("aria-hidden") === "false"
        : getComputedStyle(slide).display === "none" && slide.getAttribute("aria-hidden") === "true";
    });
  }, index);
}

const sanitizerSource = await readFile(sanitizerPath, "utf8");
const bridgeScriptSource = extractBridgeScript(sanitizerSource);
const MARKER_SIZE = extractBridgeNumber(bridgeScriptSource, "MARKER_SIZE");
const bridgeScript = bridgeScriptSource.replace(
  "host.attachShadow({ mode: 'closed' })",
  "host.attachShadow({ mode: 'open' })"
);

assert.equal(MARKER_SIZE, 24, "the compact replay marker contract is 24px");
assert.match(bridgeScript, /const MARKER_HALO = 6/);
assert.match(bridgeScript, /const CAROUSEL_CONTROL_HIT_TARGET_SIZE = 24/);
assert.match(bridgeScript, /const CAROUSEL_CONTROL_CLEARANCE = 4/);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.setContent(`<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; min-height: 3900px; font: 16px/1.4 system-ui, sans-serif; }
          button, input, select, textarea, summary, [role="button"], [tabindex], [contenteditable] {
            font: inherit;
          }
          #hongik-carousel { position: relative; width: 1024px; height: 500px; overflow: hidden; }
          #hongik-carousel .swiper-wrapper { position: relative; width: 100%; height: 500px; }
          #hongik-carousel .swiper-slide {
            position: absolute; inset: 0; display: none; width: 100%; height: 500px; padding: 0;
          }
          #hongik-carousel .swiper-slide:first-child { display: block; }
          #hongik-carousel .swiper-slide:nth-child(1) { background: #e2e8f0; }
          #hongik-carousel .swiper-slide:nth-child(2) { background: #dbeafe; }
          #hongik-carousel .swiper-slide:nth-child(3) { background: #dcfce7; }
          #hongik-target {
            position: absolute; left: 60px; top: 303.078px; width: 640px; height: 26px;
            margin: 0;
          }
          #hongik-static-title {
            position: absolute; left: 120px; top: 80px; width: 500px; height: 42px; margin: 0;
          }
          #hongik-static-copy {
            position: absolute; left: 120px; top: 160px; width: 560px; height: 32px; margin: 0;
          }
          #hongik-unrelated-cards { position: absolute; inset: 0; }
          #hongik-unrelated-cards a {
            position: absolute; left: 720px; width: 200px; height: 125px;
            padding: 18px; border: 1px solid #64748b; background: rgba(255,255,255,.72);
          }
          #hongik-card-link-one { top: 55px; }
          #hongik-card-link-two { top: 210px; }
          #hongik-prev, #hongik-next {
            position: absolute; z-index: 5; top: 266.531px; width: 80px; height: 80px;
            display: grid; place-items: center; background: rgba(15, 23, 42, .12);
          }
          #hongik-prev { left: 0; }
          #hongik-next { left: 944px; }

          .generic-control, .generic-target { position: absolute; }
          .generic-control { left: 100px; width: 80px; height: 80px; }
          .generic-target { left: 160px; width: 260px; height: 26px; }
          #control-button { top: 620px; }
          #target-button-nearby { top: 647px; }
          #control-link { top: 760px; }
          #target-link-nearby { top: 787px; }
          #control-input { top: 900px; }
          #target-input-nearby { top: 927px; }
          #details-fixture { position: absolute; left: 100px; top: 1040px; width: 80px; height: 80px; }
          #control-summary { width: 80px; height: 80px; }
          #target-summary-nearby { top: 1067px; }
          #control-role-button { top: 1180px; }
          #target-role-button-nearby { top: 1207px; }
          #control-tabindex { top: 1320px; }
          #target-tabindex-nearby { top: 1347px; }
          #control-custom-carousel { top: 1460px; }
          #target-custom-carousel-nearby { top: 1487px; }
          #control-contenteditable { top: 1600px; }
          #target-contenteditable-nearby { top: 1627px; }

          #control-sanitized-link { top: 1670px; }
          #target-sanitized-link-nearby { top: 1697px; }

          #ordinary-content { position: absolute; left: 1040px; top: 1810px; width: 80px; height: 80px; }
          #ordinary-target { position: absolute; left: 1100px; top: 1837px; width: 120px; height: 26px; }
          #hidden-control { position: absolute; left: 1340px; top: 1950px; width: 80px; height: 80px; }
          #hidden-control-target { position: absolute; left: 1400px; top: 1977px; width: 120px; height: 26px; }

          #interactive-target-button { position: absolute; left: 520px; top: 620px; width: 132px; height: 44px; }
          #interactive-target-link { position: absolute; left: 760px; top: 620px; width: 132px; height: 44px; }
          #ancestor-control { position: absolute; left: 500px; top: 760px; width: 440px; height: 150px; }
          #ancestor-child-target { position: absolute; left: 160px; top: 58px; width: 120px; height: 26px; }
          #container-target { position: absolute; left: 640px; top: 980px; width: 80px; height: 40px; }
          #descendant-control { position: absolute; left: -42px; top: 0; width: 40px; height: 40px; }

          #nested-shadow-host { position: absolute; left: 100px; top: 2050px; width: 440px; height: 180px; }
          #huge-ancestor-control {
            position: absolute; left: 100px; top: 2290px; width: 1000000px; height: 160px;
          }
          #huge-ancestor-target { position: absolute; left: 2px; top: 60px; width: 120px; height: 26px; }
          #dense-target { position: absolute; left: 600px; top: 2540px; width: 24px; height: 24px; z-index: 2; }
          #dense-control { display: none; position: absolute; inset: 0; width: 1000200px; height: 3900px; z-index: -1; }

          #responsive-case { position: absolute; left: 0; top: 2730px; width: 100vw; height: 130px; }
          #responsive-control { position: absolute; right: 100px; top: 10px; width: 80px; height: 80px; }
          #responsive-target { position: absolute; right: 20px; top: 37px; width: 60px; height: 26px; }
          #rtl-target { direction: rtl; position: absolute; left: 300px; top: 2910px; width: 200px; height: 36px; }
          #rtl-control { position: absolute; left: 500px; top: 2890px; width: 80px; height: 80px; }

          #nested-scroll {
            position: absolute; left: 50px; top: 3070px; width: 500px; height: 180px;
            overflow: auto; border: 1px solid #94a3b8;
          }
          #nested-scroll-content { position: relative; height: 520px; }
          #scroll-control { position: absolute; left: 0; top: 250px; width: 80px; height: 80px; }
          #scroll-target { position: absolute; left: 60px; top: 277px; width: 240px; height: 26px; }
          #transform-case {
            position: absolute; left: 650px; top: 3070px; width: 440px; height: 160px;
            transform: translate(40px, 20px);
          }
          #transform-control { position: absolute; left: 0; top: 20px; width: 80px; height: 80px; }
          #transform-target { position: absolute; left: 60px; top: 47px; width: 240px; height: 26px; }

          .excluded-control, .excluded-target { position: absolute; }
          .excluded-control { top: 3400px; width: 80px; height: 80px; }
          .excluded-target { top: 3427px; width: 120px; height: 26px; }
          #excluded-tabindex { left: 2000px; }
          #excluded-tabindex-target { left: 2060px; }
          #excluded-pointer { left: 2300px; pointer-events: none; }
          #excluded-pointer-target { left: 2360px; }
          #excluded-disabled { left: 2600px; }
          #excluded-disabled-target { left: 2660px; }
          #excluded-aria-disabled { left: 2900px; }
          #excluded-aria-disabled-target { left: 2960px; }
          #excluded-inert-wrap { position: absolute; left: 3200px; top: 3400px; width: 80px; height: 80px; }
          #excluded-inert { width: 80px; height: 80px; }
          #excluded-inert-target { left: 3260px; }
          #excluded-opacity { left: 3500px; opacity: 0; }
          #excluded-opacity-target { left: 3560px; }
          #excluded-visibility { left: 3800px; visibility: hidden; }
          #excluded-visibility-target { left: 3860px; }
        </style>
      </head>
      <body>
        <section id="hongik-carousel" class="swiper-container" aria-label="Hongik visual carousel">
          <div class="swiper-wrapper">
            <article class="swiper-slide" data-ua-audit-carousel-id="hongik" data-ua-audit-slide-index="0" data-ua-audit-slide-count="3">첫 화면</article>
            <article class="swiper-slide" data-ua-audit-carousel-id="hongik" data-ua-audit-slide-index="1" data-ua-audit-slide-count="3">
              <h2 id="hongik-static-title">홍익대학교 주요 소식</h2>
              <p id="hongik-static-copy">접근성 이슈 마커는 주변 카드 링크와 관계없이 대상 가까이에 표시됩니다.</p>
              <h2 id="hongik-target">본교 산업디자인과 학우들, 2026 Red Dot Design Award 다수 수상</h2>
              <nav id="hongik-unrelated-cards" aria-label="관련 소식" hidden>
                <a id="hongik-card-link-one" data-test-control href="#card-one">건축학부 졸업 전시회 소식</a>
                <a id="hongik-card-link-two" data-test-control href="#card-two">캠퍼스 교육 프로그램 소식</a>
              </nav>
            </article>
            <article class="swiper-slide" data-ua-audit-carousel-id="hongik" data-ua-audit-slide-index="2" data-ua-audit-slide-count="3">세 번째 화면</article>
          </div>
          <div id="hongik-prev" class="main-vi-prev" data-test-control>이전</div>
          <div id="hongik-next" class="main-vi-next" data-test-control>다음</div>
        </section>

        <button id="control-button" class="generic-control" data-test-control type="button">버튼</button>
        <span id="target-button-nearby" class="generic-target">버튼 인접 이슈</span>
        <a id="control-link" class="generic-control" data-test-control href="#link-target">링크</a>
        <span id="target-link-nearby" class="generic-target">링크 인접 이슈</span>
        <input id="control-input" class="generic-control" data-test-control aria-label="입력" value="입력">
        <span id="target-input-nearby" class="generic-target">입력 인접 이슈</span>
        <details id="details-fixture" open><summary id="control-summary" data-test-control>요약</summary></details>
        <span id="target-summary-nearby" class="generic-target">요약 인접 이슈</span>
        <div id="control-role-button" class="generic-control" data-test-control role="button">역할 버튼</div>
        <span id="target-role-button-nearby" class="generic-target">역할 버튼 인접 이슈</span>
        <div id="control-tabindex" class="generic-control" data-test-control tabindex="0">탭 이동 요소</div>
        <span id="target-tabindex-nearby" class="generic-target">tabindex 인접 이슈</span>
        <div id="control-custom-carousel" class="generic-control swiper-button-next" data-test-control>커스텀 다음</div>
        <span id="target-custom-carousel-nearby" class="generic-target">커스텀 컨트롤 인접 이슈</span>
        <div id="control-contenteditable" class="generic-control" data-test-control contenteditable="true">편집 가능</div>
        <span id="target-contenteditable-nearby" class="generic-target">편집 영역 인접 이슈</span>
        <a id="control-sanitized-link" class="generic-control" data-test-control data-uni-accessibility-replay-href="https://example.com/sanitized">정리된 링크</a>
        <span id="target-sanitized-link-nearby" class="generic-target">정리된 링크 인접 이슈</span>

        <div id="ordinary-content">일반 내용</div>
        <span id="ordinary-target">일반 내용은 장애물이 아님</span>
        <button id="hidden-control" data-test-control hidden type="button">숨은 버튼</button>
        <span id="hidden-control-target">숨은 버튼은 장애물이 아님</span>

        <button id="interactive-target-button" data-test-control type="button">이슈 대상 버튼</button>
        <a id="interactive-target-link" data-test-control href="#target-link">이슈 대상 링크</a>
        <a id="ancestor-control" data-test-control href="#ancestor">
          큰 클릭 가능 조상
          <span id="ancestor-child-target">조상 내부 이슈 대상</span>
        </a>
        <section id="container-target">
          컨테이너 이슈 대상
          <button id="descendant-control" data-test-control type="button">자손</button>
        </section>

        <div id="nested-shadow-host"></div>
        <a id="huge-ancestor-control" data-test-control href="#huge">
          <span id="huge-ancestor-target">대형 링크 내부 대상</span>
        </a>
        <button id="dense-control" data-test-control type="button">안전 슬롯이 없는 조작 영역</button>
        <span id="dense-target">밀집</span>

        <section id="responsive-case">
          <button id="responsive-control" data-test-control type="button">반응형</button>
          <span id="responsive-target">반응형 대상</span>
        </section>
        <p id="rtl-target">RTL 마커 대상</p>
        <button id="rtl-control" data-test-control type="button">RTL 우측 컨트롤</button>

        <div id="nested-scroll">
          <div id="nested-scroll-content">
            <button id="scroll-control" data-test-control type="button">스크롤 컨트롤</button>
            <span id="scroll-target">스크롤 대상</span>
          </div>
        </div>
        <section id="transform-case">
          <button id="transform-control" data-test-control type="button">변형 컨트롤</button>
          <span id="transform-target">변형 대상</span>
        </section>

        <div id="excluded-tabindex" class="excluded-control" tabindex="-1">음수 tabindex</div>
        <span id="excluded-tabindex-target" class="excluded-target">음수 tabindex 인접</span>
        <div id="excluded-pointer" class="excluded-control" role="button">포인터 없음</div>
        <span id="excluded-pointer-target" class="excluded-target">포인터 없음 인접</span>
        <button id="excluded-disabled" class="excluded-control" type="button" disabled>비활성 버튼</button>
        <span id="excluded-disabled-target" class="excluded-target">비활성 버튼 인접</span>
        <div id="excluded-aria-disabled" class="excluded-control" role="button" aria-disabled="true">ARIA 비활성</div>
        <span id="excluded-aria-disabled-target" class="excluded-target">ARIA 비활성 인접</span>
        <div id="excluded-inert-wrap" inert>
          <button id="excluded-inert" type="button">inert 내부 버튼</button>
        </div>
        <span id="excluded-inert-target" class="excluded-target">inert 인접</span>
        <button id="excluded-opacity" class="excluded-control" type="button">투명 버튼</button>
        <span id="excluded-opacity-target" class="excluded-target">투명 버튼 인접</span>
        <button id="excluded-visibility" class="excluded-control" type="button">숨김 버튼</button>
        <span id="excluded-visibility-target" class="excluded-target">숨김 버튼 인접</span>
      </body>
    </html>`);

  await page.evaluate(() => {
    const outerHost = document.getElementById("nested-shadow-host");
    const outerRoot = outerHost.attachShadow({ mode: "open" });
    outerRoot.innerHTML = `<style>
      #inner-shadow-host { display:block; position:relative; width:440px; height:180px; }
    </style><div id="inner-shadow-host"></div>`;
    const innerHost = outerRoot.getElementById("inner-shadow-host");
    const innerRoot = innerHost.attachShadow({ mode: "open" });
    innerRoot.innerHTML = `<style>
      #shadow-control { position:absolute; left:0; top:20px; width:80px; height:80px; }
      #shadow-target { position:absolute; left:60px; top:47px; width:260px; height:26px; }
    </style>
    <button id="shadow-control" data-test-control type="button">Shadow 버튼</button>
    <span id="shadow-target">중첩 Shadow DOM 대상</span>`;

    document.getElementById("nested-scroll").scrollTop = 180;
    for (const link of document.querySelectorAll("a[href]")) {
      link.addEventListener("click", (event) => event.preventDefault());
    }
  });

  await page.addScriptTag({ content: bridgeScript });
  await page.waitForFunction(() => document.getElementById("__uni_accessibility_replay_host")?.shadowRoot);

  const issues = [
    issue(4, "#hongik-target", "Hongik previous-arrow interception"),
    issue(5, "#hongik-target", "Hongik adjacent marker retains its legacy slot"),
    issue(39, "#hongik-static-title", "Static hero title stays anchored"),
    issue(40, "#hongik-static-copy", "Static hero copy stays anchored"),
    issue(10, "#target-button-nearby"),
    issue(11, "#target-link-nearby"),
    issue(12, "#target-input-nearby"),
    issue(13, "#target-summary-nearby"),
    issue(14, "#target-role-button-nearby"),
    issue(15, "#target-tabindex-nearby"),
    issue(16, "#target-custom-carousel-nearby"),
    issue(17, "#target-contenteditable-nearby"),
    issue(31, "#target-sanitized-link-nearby"),
    issue(18, "#ordinary-target"),
    issue(19, "#hidden-control-target"),
    issue(20, "#interactive-target-button"),
    issue(21, "#interactive-target-link"),
    issue(22, "#ancestor-child-target"),
    issue(23, "#container-target"),
    shadowIssue(24, [
      { context: "DOCUMENT", selector: "#nested-shadow-host" },
      { context: "SHADOW_ROOT", selector: "#inner-shadow-host" },
      { context: "SHADOW_ROOT", selector: "#shadow-target" }
    ], "Nested open Shadow DOM control"),
    issue(25, "#huge-ancestor-target"),
    issue(26, "#dense-target"),
    issue(27, "#responsive-target"),
    issue(28, "#rtl-target"),
    issue(29, "#scroll-target"),
    issue(30, "#transform-target"),
    issue(32, "#excluded-tabindex-target"),
    issue(33, "#excluded-pointer-target"),
    issue(34, "#excluded-disabled-target"),
    issue(35, "#excluded-aria-disabled-target"),
    issue(36, "#excluded-inert-target"),
    issue(37, "#excluded-opacity-target"),
    issue(38, "#excluded-visibility-target")
  ];
  const expectedMarkerCount = issues.length - 1;

  const initStartedAt = performance.now();
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await waitForMarkers(page, expectedMarkerCount);
  const initMs = performance.now() - initStartedAt;
  assert.ok(initMs < 2500, `large interactive obstacle fixture INIT exceeded 2500ms: ${initMs.toFixed(1)}ms`);

  assert.equal(await page.locator("#hongik-prev").getAttribute("role"), "button");
  assert.equal(await page.locator("#hongik-next").getAttribute("role"), "button");
  assert.equal(await page.locator("#hongik-prev").getAttribute("tabindex"), "0");
  assert.equal(await page.locator("#hongik-next").getAttribute("tabindex"), "0");

  const nextControl = page.locator("#hongik-next");
  await nextControl.focus();
  await nextControl.press("Enter");
  await waitForActiveSlide(page, 1);
  await page.waitForFunction((expectedMarkerSize) => {
    const marker = document.getElementById("__uni_accessibility_replay_host")
      ?.shadowRoot?.querySelector(".marker");
    return marker && !marker.hidden && marker.getBoundingClientRect().width === expectedMarkerSize;
  }, MARKER_SIZE);
  await page.waitForTimeout(80);

  const markerForIssue = (facts, issueId) => facts.find((marker) => marker.issueIds.includes(issueId));
  await setFixtureControlsNeutralized(page, true);
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await waitForMarkers(page, expectedMarkerCount);
  const staticBaselineFacts = await markerFacts(page);
  const staticBaseline = [39, 40].map((issueId) => markerForIssue(staticBaselineFacts, issueId));
  assert.ok(staticBaseline.every((marker) => marker && !marker.hidden), "static hero markers must be visible");
  assertClose(staticBaseline[0].rect.left, 120 - MARKER_SIZE - 8, "static title legacy left slot");
  assertClose(staticBaseline[0].rect.top, 80, "static title legacy top slot");
  assertClose(staticBaseline[1].rect.left, 120 - MARKER_SIZE - 8, "static copy legacy left slot");
  assertClose(staticBaseline[1].rect.top, 160, "static copy legacy top slot");

  await setFixtureControlsNeutralized(page, false);
  await page.evaluate(() => {
    document.getElementById("hongik-unrelated-cards").hidden = false;
    document.getElementById("dense-control").style.display = "block";
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await waitForMarkers(page, expectedMarkerCount);
  const actualLikeFacts = await markerFacts(page);
  const carouselRelocationIssueIds = new Set([4, 5, 16]);
  let legacyMarkersUnchanged = 0;
  issues.forEach((entry) => {
    if (carouselRelocationIssueIds.has(entry.id)) return;
    const actualMarker = markerForIssue(actualLikeFacts, entry.id);
    const baselineMarker = markerForIssue(staticBaselineFacts, entry.id);
    assert.deepEqual(
      actualMarker,
      baselineMarker,
      `non-carousel control geometry must not alter issue ${entry.id} marker coordinates`
    );
    legacyMarkersUnchanged += 1;
  });
  const staticWithCards = [39, 40].map((issueId) => markerForIssue(actualLikeFacts, issueId));
  staticWithCards.forEach((marker, index) => {
    assert.equal(marker.hidden, false, `static hero marker ${index + 1} remains visible with card links`);
    for (const edge of ["left", "top", "right", "bottom", "width", "height"]) {
      assertClose(
        marker.rect[edge],
        staticBaseline[index].rect[edge],
        `unrelated card links must not displace static hero marker ${index + 1} ${edge}`
      );
    }
  });

  const previousRect = await page.locator("#hongik-prev").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  const targetRect = await page.locator("#hongik-target").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
  assertClose(previousRect.left, 0, "Hongik previous control left");
  assertClose(previousRect.right, 80, "Hongik previous control right");
  assertClose(previousRect.top, 266.531, "Hongik previous control top");
  assertClose(previousRect.bottom, 346.531, "Hongik previous control bottom");
  assertClose(targetRect.left, 60, "Hongik target left");
  assertClose(targetRect.top, 303.078, "Hongik target top");

  const previousCenter = {
    x: (previousRect.left + previousRect.right) / 2,
    y: (previousRect.top + previousRect.bottom) / 2
  };
  const previousProtectedRect = carouselCenterProtectedRect(previousRect);
  assertClose(previousProtectedRect.left, 24, "Hongik protected center left");
  assertClose(previousProtectedRect.right, 56, "Hongik protected center right");
  assertClose(previousProtectedRect.top, previousCenter.y - 16, "Hongik protected center top");
  assertClose(previousProtectedRect.bottom, previousCenter.y + 16, "Hongik protected center bottom");
  const legacyMarker = {
    left: targetRect.left - MARKER_SIZE - 8,
    top: targetRect.top,
    right: targetRect.left - 8,
    bottom: targetRect.top + MARKER_SIZE,
    width: MARKER_SIZE,
    height: MARKER_SIZE
  };
  assertClose(legacyMarker.left, 60 - MARKER_SIZE - 8, "legacy Hongik marker left");
  assertClose(legacyMarker.right, 52, "legacy Hongik marker right");
  assertClose(legacyMarker.top, 303.078, "legacy Hongik marker top");
  assertClose(legacyMarker.bottom, 303.078 + MARKER_SIZE, "legacy Hongik marker bottom");
  assert.ok(
    previousCenter.x >= legacyMarker.left && previousCenter.x <= legacyMarker.right
      && previousCenter.y >= legacyMarker.top && previousCenter.y <= legacyMarker.bottom,
    "the fixture must retain the exact legacy center interception geometry"
  );
  assert.equal(
    overlaps(expandedRect(legacyMarker), previousProtectedRect),
    true,
    "the legacy marker halo must overlap the protected carousel center hotspot"
  );

  let markers = actualLikeFacts;
  const initialAnchorDistanceSummary = await assertVisibleMarkersRemainAnchored(
    page,
    markers,
    issues,
    "initial interactive obstacle layout"
  );
  const hongikMarker = markerForIssue(markers, 4);
  const legacyHongikMarker = markerForIssue(staticBaselineFacts, 4);
  const hongikMarkerFive = markerForIssue(actualLikeFacts, 5);
  assert.equal(hongikMarker.hidden, false, "Hongik target marker must find a nearby safe slot");
  assertClose(legacyHongikMarker.rect.left, legacyMarker.left, "neutralized Hongik legacy marker left");
  assertClose(legacyHongikMarker.rect.top, legacyMarker.top, "neutralized Hongik legacy marker top");
  assert.equal(
    overlaps(expandedRect(hongikMarker.rect), previousProtectedRect),
    false,
    "relocated marker 4 halo must clear the protected center hotspot"
  );
  assertClose(hongikMarker.rect.left, legacyMarker.left, "Hongik marker retains its left gutter");
  assertClose(
    hongikMarker.rect.top,
    legacyMarker.top + 40,
    "the grouped Hongik marker must move one 40px slot to clear the previous control"
  );
  assert.equal(hongikMarkerFive, hongikMarker, "issues 4 and 5 on the same heading must share one marker object");
  assert.equal(hongikMarker.groupSize, "2");
  assert.deepEqual(hongikMarker.issueIds, [4, 5]);

  const legacyCustomCarouselMarker = markerForIssue(staticBaselineFacts, 16);
  const customCarouselMarker = markerForIssue(actualLikeFacts, 16);
  const customCarouselControlRect = await elementDocumentRect(page, "#control-custom-carousel");
  const customCarouselProtectedRect = carouselCenterProtectedRect(customCarouselControlRect);
  assert.equal(customCarouselMarker.hidden, false, "known custom carousel control keeps its issue marker visible");
  assertClose(
    customCarouselMarker.rect.left,
    legacyCustomCarouselMarker.rect.left,
    "known custom carousel relocation retains its gutter"
  );
  assertClose(
    customCarouselMarker.rect.top,
    legacyCustomCarouselMarker.rect.top + 40,
    "known custom carousel collision uses the nearest safe one-slot move"
  );
  assert.equal(
    overlaps(expandedRect(customCarouselMarker.rect), customCarouselProtectedRect),
    false,
    "known custom carousel marker must clear its protected center hotspot"
  );

  const actualLikeAnchors = [
    { name: "carousel headline", marker: hongikMarker, target: targetRect },
    {
      name: "static hero title",
      marker: staticWithCards[0],
      target: await elementDocumentRect(page, "#hongik-static-title")
    },
    {
      name: "static hero copy",
      marker: staticWithCards[1],
      target: await elementDocumentRect(page, "#hongik-static-copy")
    }
  ];
  const actualLikeAnchorDistances = Object.fromEntries(actualLikeAnchors.map(({ name, marker, target }) => {
    const distance = rectangleDistance(marker.rect, target);
    assert.ok(
      distance <= MAX_HERO_ANCHOR_DISTANCE,
      `${name} marker drifted ${distance.toFixed(2)}px from its target; maximum is ${MAX_HERO_ANCHOR_DISTANCE}px`
    );
    return [name, Number(distance.toFixed(2))];
  }));

  const centerHit = await deepestHitId(page, previousCenter.x, previousCenter.y);
  assert.equal(centerHit.id, "hongik-prev", `previous center must hit the page control: ${JSON.stringify(centerHit)}`);

  const artifactDirectory = path.join(dashboardDirectory, "artifacts", "page-evidence");
  await mkdir(artifactDirectory, { recursive: true });
  const screenshotPath = path.join(artifactDirectory, "marker-interactive-obstacles.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  await page.mouse.click(previousCenter.x, previousCenter.y);
  await waitForActiveSlide(page, 0);
  assert.equal(await activeSlideIndex(page), 0, "pointer click must move exactly one slide from 1 to 0");

  await nextControl.focus();
  await nextControl.press("Space");
  await waitForActiveSlide(page, 1);
  assert.equal(await nextControl.evaluate((element) => document.activeElement === element), true);
  const previousControl = page.locator("#hongik-prev");
  await previousControl.focus();
  await previousControl.press("Enter");
  await waitForActiveSlide(page, 0);
  assert.equal(await previousControl.evaluate((element) => document.activeElement === element), true);

  markers = await markerFacts(page);
  const ordinaryMarker = markerForIssue(markers, 18);
  const hiddenControlMarker = markerForIssue(markers, 19);
  assert.equal(ordinaryMarker.hidden, false, "ordinary content must not suppress a marker");
  assertClose(ordinaryMarker.rect.left, 1100 - MARKER_SIZE - 8, "ordinary content legacy marker left");
  assertClose(ordinaryMarker.rect.top, 1837, "ordinary content legacy marker top");
  assert.equal(hiddenControlMarker.hidden, false, "a hidden control must not suppress a marker");
  assertClose(hiddenControlMarker.rect.left, 1400 - MARKER_SIZE - 8, "hidden-control legacy marker left");
  assertClose(hiddenControlMarker.rect.top, 1977, "hidden-control legacy marker top");

  const interactiveButtonMarker = markerForIssue(markers, 20);
  const interactiveLinkMarker = markerForIssue(markers, 21);
  assert.equal(interactiveButtonMarker.hidden, false, "an issue on a button must retain a visible nearby marker");
  assert.equal(interactiveLinkMarker.hidden, false, "an issue on a link must retain a visible nearby marker");
  const interactiveButtonRect = await elementDocumentRect(page, "#interactive-target-button");
  const interactiveLinkRect = await elementDocumentRect(page, "#interactive-target-link");
  assert.equal(overlaps(expandedRect(interactiveButtonMarker.rect), interactiveButtonRect), false);
  assert.equal(overlaps(expandedRect(interactiveLinkMarker.rect), interactiveLinkRect), false);

  const ancestorMarker = markerForIssue(markers, 22);
  const hugeAncestorMarker = markerForIssue(markers, 25);
  assert.equal(ancestorMarker.hidden, false, "a target enclosed by a generic clickable ancestor retains its marker");
  assert.equal(hugeAncestorMarker.hidden, false, "a target enclosed by a huge generic link retains its marker");

  const descendantMarker = markerForIssue(markers, 23);
  assert.equal(descendantMarker.hidden, false, "a generic button descendant must not suppress its container marker");

  const shadowMarker = markerForIssue(markers, 24);
  assert.equal(shadowMarker.hidden, false, "a generic Shadow DOM button must not suppress its nearby marker");

  for (const fixture of [
    { id: 32, control: "#excluded-tabindex", targetLeft: 2060, reason: "generic tabindex=-1" },
    { id: 33, control: "#excluded-pointer", targetLeft: 2360, reason: "pointer-events:none" },
    { id: 34, control: "#excluded-disabled", targetLeft: 2660, reason: "native disabled" },
    { id: 35, control: "#excluded-aria-disabled", targetLeft: 2960, reason: "aria-disabled=true" },
    { id: 36, control: "#excluded-inert", targetLeft: 3260, reason: "inert ancestor" },
    { id: 37, control: "#excluded-opacity", targetLeft: 3560, reason: "opacity:0" },
    { id: 38, control: "#excluded-visibility", targetLeft: 3860, reason: "visibility:hidden" }
  ]) {
    const marker = markerForIssue(markers, fixture.id);
    const controlRect = await elementDocumentRect(page, fixture.control);
    assert.equal(marker.hidden, false, `${fixture.reason} must not suppress its nearby marker`);
    assertClose(marker.rect.left, fixture.targetLeft - MARKER_SIZE - 8, `${fixture.reason} preserves legacy left slot`);
    assertClose(marker.rect.top, 3427, `${fixture.reason} preserves legacy top slot`);
    assert.equal(
      overlaps(expandedRect(marker.rect), controlRect),
      true,
      `${fixture.reason} fixture must prove the legacy slot was not displaced as an obstacle`
    );
  }

  const denseMarker = markerForIssue(actualLikeFacts, 26);
  const denseControlRect = await elementDocumentRect(page, "#dense-control");
  assert.equal(denseMarker.hidden, false, "even a full-page generic button must not suppress a marker");
  assert.equal(
    overlaps(expandedRect(denseMarker.rect), denseControlRect),
    true,
    "the full-page generic button fixture must prove its marker retained the legacy slot"
  );

  await page.setViewportSize({ width: 768, height: 720 });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(120);
  markers = await markerFacts(page);
  await assertVisibleMarkersRemainAnchored(
    page,
    markers,
    issues,
    "768px responsive interactive obstacle layout"
  );

  const rtlMarker = markerForIssue(markers, 28);
  assert.equal(rtlMarker.hidden, false, "RTL target must retain its marker");

  const scrollMarkerBefore = markerForIssue(markers, 29);
  const scrollMarkerIndex = scrollMarkerBefore.arrayIndex;
  await page.evaluate(() => {
    document.getElementById("nested-scroll").scrollTop = 220;
  });
  await page.waitForFunction(({ previousTop, markerIndex }) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const marker = root?.querySelectorAll(".marker")[markerIndex];
    return marker && !marker.hidden
      && Math.abs(marker.getBoundingClientRect().top + window.scrollY - previousTop) >= 35;
  }, { previousTop: scrollMarkerBefore.rect.top, markerIndex: scrollMarkerIndex });
  markers = await markerFacts(page);
  const scrollMarkerAfter = markerForIssue(markers, 29);
  assert.equal(scrollMarkerAfter.hidden, false);

  await page.evaluate(() => {
    document.getElementById("transform-case").style.transform = "translate(80px, 40px)";
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(120);
  markers = await markerFacts(page);
  await assertVisibleMarkersRemainAnchored(
    page,
    markers,
    issues,
    "scroll/transform interactive obstacle layout"
  );

  const deterministicBefore = markers
    .filter((marker) => !marker.hidden)
    .map((marker) => ({ markerIndex: marker.markerIndex, rect: marker.rect }));
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await waitForMarkers(page, expectedMarkerCount);
  const deterministicAfter = (await markerFacts(page))
    .filter((marker) => !marker.hidden)
    .map((marker) => ({ markerIndex: marker.markerIndex, rect: marker.rect }));
  assert.deepEqual(deterministicAfter, deterministicBefore, "interactive-obstacle placement must be deterministic");

  assert.deepEqual(pageErrors, [], "interactive obstacle fixture must not raise page errors");
  console.log(JSON.stringify({
    result: "PASS",
    initMs: Number(initMs.toFixed(1)),
    fixture: {
      previousRect,
      previousCenter,
      previousProtectedRect,
      legacyMarker,
      placedMarker: hongikMarker.rect,
      groupedHongikMarker: {
        issueIds: hongikMarker.issueIds,
        groupSize: hongikMarker.groupSize,
        placed: hongikMarker.rect
      },
      centerHit,
      actualLikeAnchorDistances,
      staticMarkersUnchangedByCardLinks: staticWithCards.map((marker) => marker.rect),
      allVisibleMarkers: {
        checked: initialAnchorDistanceSummary.checked,
        maximumDistance: Number(initialAnchorDistanceSummary.maximum.toFixed(2)),
        allowedDistance: MAX_VISIBLE_MARKER_ANCHOR_DISTANCE
      }
    },
    nonCarouselLegacyMarkersChecked: legacyMarkersUnchanged,
    carouselRelocationsChecked: carouselRelocationIssueIds.size,
    issuesChecked: issues.length,
    screenshotPath,
    pageErrors
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
