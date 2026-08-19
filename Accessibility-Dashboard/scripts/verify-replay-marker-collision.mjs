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

function expandedRect(rect, halo = 6) {
  return {
    left: rect.left - halo,
    top: rect.top - halo,
    right: rect.right + halo,
    bottom: rect.bottom + halo,
    width: rect.width + halo * 2,
    height: rect.height + halo * 2
  };
}

function overlaps(left, right) {
  return !(
    left.right <= right.left
    || right.right <= left.left
    || left.bottom <= right.top
    || right.bottom <= left.top
  );
}

function assertRectClose(actual, expected, message, tolerance = 0.75) {
  for (const edge of ["left", "top", "right", "bottom", "width", "height"]) {
    assert.ok(
      Math.abs(actual[edge] - expected[edge]) <= tolerance,
      `${message}: ${edge} expected ${expected[edge]}, received ${actual[edge]}`
    );
  }
}

function assertMarkerAvoidsTargetRects(marker, targetRects, message) {
  for (const targetRect of targetRects) {
    assert.equal(overlaps(marker, targetRect), false, message);
  }
}

async function getSelectionGeometry(page, targetSelector, markerLabels = []) {
  return page.evaluate(({ selector, labels }) => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    const target = document.querySelector(selector);
    const rectFact = (rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    });
    const layer = root.querySelector(".selection-layer");
    return {
      targetRects: [...target.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).map(rectFact),
      markers: [...root.querySelectorAll(".marker")]
        .filter((marker) => labels.includes(marker.textContent))
        .map((marker) => ({
          text: marker.textContent,
          hidden: marker.hidden,
          ...rectFact(marker.getBoundingClientRect())
        })),
      fragments: [...root.querySelectorAll(".selection-fragment")].map((fragment) => ({
        pointerEvents: getComputedStyle(fragment).pointerEvents,
        borderWidth: getComputedStyle(fragment).borderTopWidth,
        borderStyle: getComputedStyle(fragment).borderTopStyle,
        borderColor: getComputedStyle(fragment).borderTopColor,
        tabIndex: fragment.tabIndex,
        hasTabIndex: fragment.hasAttribute("tabindex"),
        ...rectFact(fragment.getBoundingClientRect())
      })),
      layer: {
        ariaHidden: layer.getAttribute("aria-hidden"),
        pointerEvents: getComputedStyle(layer).pointerEvents,
        focusableDescendants: layer.querySelectorAll(
          'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'
        ).length
      },
      targetStyle: {
        outline: target.style.getPropertyValue("outline"),
        outlinePriority: target.style.getPropertyPriority("outline"),
        outlineOffset: target.style.getPropertyValue("outline-offset"),
        outlineOffsetPriority: target.style.getPropertyPriority("outline-offset")
      }
    };
  }, { selector: targetSelector, labels: markerLabels });
}

function assertSelectionFragmentsMatch(geometry, message) {
  assert.equal(
    geometry.fragments.length,
    geometry.targetRects.length,
    `${message}: every rendered line fragment must have one overlay rectangle`
  );
  geometry.fragments.forEach((fragment, index) => {
    assertRectClose(fragment, expandedRect(geometry.targetRects[index], 3), `${message}: fragment ${index + 1}`);
    assert.equal(fragment.pointerEvents, "none");
    assert.equal(fragment.borderWidth, "3px");
    assert.equal(fragment.borderStyle, "solid");
    assert.equal(fragment.borderColor, "rgb(229, 72, 77)");
    assert.equal(fragment.tabIndex, -1);
    assert.equal(fragment.hasTabIndex, false);
  });
}

function assertInlineStyleUnchanged(actual, expected, message) {
  assert.deepEqual(actual, expected, `${message}: the bridge must not mutate the target inline outline`);
}

async function sendReplayCommand(page, message) {
  await page.evaluate((command) => {
    window.postMessage({ source: "accessibility-dashboard", ...command }, "*");
  }, message);
}

const sanitizerSource = await readFile(sanitizerPath, "utf8");
const bridgeScriptSource = extractBridgeScript(sanitizerSource);
const markerSize = extractBridgeNumber(bridgeScriptSource, "MARKER_SIZE");
const bridgeScript = bridgeScriptSource.replace(
  "host.attachShadow({ mode: 'closed' })",
  "host.attachShadow({ mode: 'open' })"
);
assert.equal(markerSize, 24, "the compact replay marker contract is 24px");
assert.match(bridgeScript, /const MARKER_SLOT_STEP = 40/);
assert.match(bridgeScript, /const MARKER_GAP = 8/);
assert.match(bridgeScript, /const MAX_SELECTION_FRAGMENTS = 128/);
assert.match(bridgeScript, /\.selection-layer/);
assert.match(bridgeScript, /\.selection-fragment/);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });

try {
  await page.setContent(`<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8">
        <style>
          html, body { min-height: 1260px; margin: 0; }
          #target, #nearby, #edge-start, #edge-end { position: absolute; display: block; height: 40px; }
          #target { left: 120px; top: 120px; width: 260px; }
          #nearby { left: 124px; top: 123px; width: 180px; }
          #edge-start { left: 0; top: 0; width: 20px; }
          #edge-end { left: 620px; top: 700px; width: 20px; }
          #clip { position: absolute; left: 0; top: 200px; width: 100px; height: 40px; overflow: hidden; }
          #off-canvas { display: block; width: 40px; height: 40px; transform: translateX(900px); }
          #inline-slide { position: absolute; left: 0; top: 0; }
          #inline-parent {
            position: absolute;
            left: 180px;
            top: 300px;
            width: 340px;
            margin: 0;
            font: 700 20px/28px system-ui, sans-serif;
            outline: 2px dashed rgb(19, 67, 111) !important;
            outline-offset: 2px !important;
          }
          #inline-anchor {
            color: #152a48;
            outline: 1px dotted rgb(117, 23, 71) !important;
            outline-offset: 4px !important;
          }
          #rtl-target {
            direction: rtl;
            position: absolute;
            left: 100px;
            top: 500px;
            width: 260px;
            height: 54px;
          }
          #nested-scroll {
            position: absolute;
            left: 80px;
            top: 780px;
            width: 360px;
            height: 140px;
            overflow: auto;
            border: 1px solid #94a3b8;
          }
          #nested-content { position: relative; height: 360px; }
          #nested-target {
            position: absolute;
            left: 120px;
            top: 50px;
            width: 160px;
            height: 36px;
          }
          #fragment-stress-wrap {
            position: absolute;
            left: 480px;
            top: 940px;
            width: 80px;
            font: 8px/4px system-ui, sans-serif;
          }
          @media (min-width: 700px) {
            #inline-parent { font-size: 24px; line-height: 32px; }
          }
        </style>
      </head>
      <body>
        <span id="target">같은 요소에 연결된 두 이슈</span>
        <span id="nearby">가까운 별도 요소</span>
        <span id="edge-start">시작</span>
        <span id="edge-end">끝</span>
        <span id="clip"><span id="off-canvas">화면 밖</span></span>
        <section id="inline-slide">
          <p id="inline-parent"><a id="inline-anchor" href="#fixture">Accessible design award<br>Second line of the same link</a></p>
        </section>
        <p id="rtl-target">RTL marker gutter fixture</p>
        <div id="nested-scroll">
          <div id="nested-content"><span id="nested-target">Nested scroll target</span></div>
        </div>
        <div id="fragment-stress-wrap"><span id="fragment-stress"></span></div>
        <script>${bridgeScript}</script>
      </body>
    </html>`);

  await page.waitForFunction(() => document.getElementById("__uni_accessibility_replay_host")?.shadowRoot);
  await page.evaluate(() => {
    const stressTarget = document.getElementById("fragment-stress");
    for (let index = 0; index < 129; index += 1) {
      stressTarget.append(document.createTextNode("x"));
      if (index < 128) stressTarget.append(document.createElement("br"));
    }
    window.postMessage({
      source: "accessibility-dashboard",
      type: "INIT_ISSUES",
      markersVisible: true,
      selectedIssueId: 1,
      issues: [
        { id: 1, severity: "HIGH", title: "첫 번째", pathSteps: [{ context: "DOCUMENT", selector: "#target" }] },
        { id: 2, severity: "MEDIUM", title: "두 번째", pathSteps: [{ context: "DOCUMENT", selector: "#target" }] },
        { id: 3, severity: "LOW", title: "세 번째", pathSteps: [{ context: "DOCUMENT", selector: "#nearby" }] },
        { id: 4, severity: "LOW", title: "시작 경계", pathSteps: [{ context: "DOCUMENT", selector: "#edge-start" }] },
        { id: 5, severity: "LOW", title: "끝 경계", pathSteps: [{ context: "DOCUMENT", selector: "#edge-end" }] },
        { id: 6, severity: "LOW", title: "화면 밖", pathSteps: [{ context: "DOCUMENT", selector: "#off-canvas" }] },
        { id: 7, severity: "MEDIUM", title: "문단 난이도", pathSteps: [{ context: "DOCUMENT", selector: "#inline-parent" }] },
        { id: 8, severity: "HIGH", title: "링크 이름", pathSteps: [{ context: "DOCUMENT", selector: "#inline-anchor" }] },
        { id: 9, severity: "LOW", title: "RTL 위치", pathSteps: [{ context: "DOCUMENT", selector: "#rtl-target" }] },
        { id: 10, severity: "LOW", title: "내부 스크롤", pathSteps: [{ context: "DOCUMENT", selector: "#nested-target" }] },
        { id: 11, severity: "LOW", title: "조각 상한", pathSteps: [{ context: "DOCUMENT", selector: "#fragment-stress" }] }
      ]
    }, "*");
  });

  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 11
  );
  await page.waitForTimeout(100);

  const allMarkerFacts = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    return [...root.querySelectorAll(".marker")].map((marker) => {
      const rect = marker.getBoundingClientRect();
      return {
        text: marker.textContent,
        hidden: marker.hidden,
        display: getComputedStyle(marker).display,
        selected: marker.dataset.selected,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    });
  });
  const markerFacts = allMarkerFacts.filter((marker) => !marker.hidden);

  assert.deepEqual(markerFacts.map((marker) => marker.text), ["1", "2", "3", "4", "5", "7", "8", "9", "10", "11"]);
  const hiddenMarker = allMarkerFacts.find((marker) => marker.text === "6");
  assert.equal(hiddenMarker?.hidden, true);
  assert.equal(hiddenMarker?.display, "none");
  assert.equal(hiddenMarker?.width, 0);
  assert.equal(hiddenMarker?.height, 0);
  assert.equal(markerFacts[0].selected, "true");
  assert.ok(markerFacts.every((marker) => marker.width === markerSize && marker.height === markerSize));
  const markerLabelAlignment = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    const markers = [...root.querySelectorAll(".marker:not([hidden])")].slice(0, 3);
    const labels = ["7", "100", "117"];
    return markers.map((marker, index) => {
      const originalText = marker.textContent;
      marker.textContent = labels[index];
      const markerRect = marker.getBoundingClientRect();
      const textRange = document.createRange();
      textRange.selectNodeContents(marker);
      const textRect = textRange.getBoundingClientRect();
      const style = getComputedStyle(marker);
      const result = {
        label: labels[index],
        display: style.display,
        placeItems: style.placeItems,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        fitsHorizontally:
          textRect.left >= markerRect.left + Number.parseFloat(style.borderLeftWidth) - 0.5
          && textRect.right <= markerRect.right - Number.parseFloat(style.borderRightWidth) + 0.5,
        fitsVertically:
          textRect.top >= markerRect.top + Number.parseFloat(style.borderTopWidth) - 0.5
          && textRect.bottom <= markerRect.bottom - Number.parseFloat(style.borderBottomWidth) + 0.5,
        horizontalOffset: Math.abs(
          (textRect.left + textRect.right) / 2 - (markerRect.left + markerRect.right) / 2
        ),
        verticalOffset: Math.abs(
          (textRect.top + textRect.bottom) / 2 - (markerRect.top + markerRect.bottom) / 2
        )
      };
      marker.textContent = originalText;
      return result;
    });
  });
  assert.ok(markerLabelAlignment.every((marker) => marker.display === "grid"));
  assert.ok(markerLabelAlignment.every((marker) => marker.placeItems === "center"));
  assert.ok(markerLabelAlignment.every((marker) => marker.padding.every((value) => value === "0px")));
  assert.ok(markerLabelAlignment.every((marker) => marker.fitsHorizontally), "7/100/117 labels must fit inside the compact marker border");
  assert.ok(markerLabelAlignment.every((marker) => marker.fitsVertically), "7/100/117 labels must fit vertically inside the compact marker border");
  assert.ok(markerLabelAlignment.every((marker) => marker.horizontalOffset <= 0.5));
  assert.ok(markerLabelAlignment.every((marker) => marker.verticalOffset <= 0.5));
  const compactMarkerScreenshotPath = path.join(
    dashboardDirectory,
    "artifacts",
    "page-evidence",
    "marker-compact-labels.png"
  );
  await mkdir(path.dirname(compactMarkerScreenshotPath), { recursive: true });
  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    [...root.querySelectorAll(".marker:not([hidden])")].slice(0, 3)
      .forEach((marker, index) => { marker.textContent = ["7", "100", "117"][index]; });
  });
  await page.screenshot({ path: compactMarkerScreenshotPath, fullPage: false });
  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    [...root.querySelectorAll(".marker:not([hidden])")].slice(0, 3)
      .forEach((marker, index) => { marker.textContent = String(index + 1); });
  });
  const documentSize = await page.evaluate(() => ({
    width: Math.max(window.innerWidth, document.documentElement.scrollWidth, document.body.scrollWidth),
    height: Math.max(window.innerHeight, document.documentElement.scrollHeight, document.body.scrollHeight)
  }));
  assert.ok(markerFacts.every((marker) => marker.left >= 6 && marker.top >= 6));
  assert.ok(markerFacts.every((marker) => marker.right <= documentSize.width - 6 && marker.bottom <= documentSize.height - 6));
  for (let leftIndex = 0; leftIndex < markerFacts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < markerFacts.length; rightIndex += 1) {
      assert.equal(
        overlaps(expandedRect(markerFacts[leftIndex]), expandedRect(markerFacts[rightIndex])),
        false,
        `marker ${leftIndex + 1} must not overlap marker ${rightIndex + 1}`
      );
    }
  }

  await page.evaluate(() => {
    window.postMessage({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 2 }, "*");
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(100);
  const positionsAfterFocus = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    return [...root.querySelectorAll(".marker:not([hidden])")].map((marker) => {
      const rect = marker.getBoundingClientRect();
      return { left: rect.left + window.scrollX, top: rect.top + window.scrollY, width: rect.width, height: rect.height };
    });
  });
  assert.deepEqual(
    positionsAfterFocus,
    markerFacts.map((marker) => ({ left: marker.left, top: marker.top, width: marker.width, height: marker.height }))
  );

  const originalInlineStyles = await page.evaluate(() => {
    const styleFact = (selector) => {
      const style = document.querySelector(selector).style;
      return {
        outline: style.getPropertyValue("outline"),
        outlinePriority: style.getPropertyPriority("outline"),
        outlineOffset: style.getPropertyValue("outline-offset"),
        outlineOffsetPriority: style.getPropertyPriority("outline-offset")
      };
    };
    return {
      parent: styleFact("#inline-parent"),
      anchor: styleFact("#inline-anchor")
    };
  });

  await sendReplayCommand(page, { type: "FOCUS_ISSUE", issueId: 8 });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 2
  );
  let anchorGeometry = await getSelectionGeometry(page, "#inline-anchor", ["7", "8"]);
  const parentGeometry = await getSelectionGeometry(page, "#inline-parent", ["7"]);
  assert.equal(anchorGeometry.targetRects.length, 2, "the inline anchor fixture must render as exactly two lines");
  assertSelectionFragmentsMatch(anchorGeometry, "two-line inline anchor selection");
  assert.equal(anchorGeometry.layer.ariaHidden, "true");
  assert.equal(anchorGeometry.layer.pointerEvents, "none");
  assert.equal(anchorGeometry.layer.focusableDescendants, 0);
  assertInlineStyleUnchanged(anchorGeometry.targetStyle, originalInlineStyles.anchor, "selected anchor");
  assertInlineStyleUnchanged(parentGeometry.targetStyle, originalInlineStyles.parent, "unselected parent");

  const parentMarker = parentGeometry.markers.find((marker) => marker.text === "7");
  const anchorMarker = anchorGeometry.markers.find((marker) => marker.text === "8");
  assert.ok(parentMarker && anchorMarker);
  assert.ok(!parentMarker.hidden && !anchorMarker.hidden);
  assert.ok(parentMarker.width === markerSize && parentMarker.height === markerSize);
  assert.ok(anchorMarker.width === markerSize && anchorMarker.height === markerSize);
  assert.ok(Math.abs(parentMarker.left - anchorMarker.left) <= 0.5, "P/A markers must share the left gutter");
  assert.ok(Math.abs(parentMarker.top - anchorMarker.top) >= 40, "P/A markers must occupy separate vertical slots");
  assert.ok(
    Math.min(...parentGeometry.targetRects.map((rect) => rect.left)) - parentMarker.right >= 7.5,
    "the parent marker must leave the 8px target gutter"
  );
  assert.ok(
    Math.min(...anchorGeometry.targetRects.map((rect) => rect.left)) - anchorMarker.right >= 7.5,
    "the anchor marker must leave the 8px target gutter"
  );
  assertMarkerAvoidsTargetRects(parentMarker, parentGeometry.targetRects, "parent marker must not cover its target");
  assertMarkerAvoidsTargetRects(anchorMarker, anchorGeometry.targetRects, "anchor marker must not cover either line");
  assert.equal(overlaps(expandedRect(parentMarker), expandedRect(anchorMarker)), false);

  await sendReplayCommand(page, { type: "FOCUS_ISSUE", issueId: 7 });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 1
  );
  const selectedParentGeometry = await getSelectionGeometry(page, "#inline-parent", ["7", "8"]);
  assertSelectionFragmentsMatch(selectedParentGeometry, "parent selection after issue switch");
  assertInlineStyleUnchanged(selectedParentGeometry.targetStyle, originalInlineStyles.parent, "selected parent");
  assertInlineStyleUnchanged(
    (await getSelectionGeometry(page, "#inline-anchor")).targetStyle,
    originalInlineStyles.anchor,
    "anchor after issue switch"
  );

  await sendReplayCommand(page, { type: "FOCUS_ISSUE", issueId: 8 });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 2
  );

  await sendReplayCommand(page, { type: "SET_MARKERS_VISIBLE", markersVisible: false });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root
      && root.querySelectorAll(".selection-fragment").length === 0
      && [...root.querySelectorAll(".marker")].every((marker) => marker.hidden);
  });
  const hiddenOverlayState = await getSelectionGeometry(page, "#inline-anchor", ["7", "8"]);
  assert.equal(hiddenOverlayState.fragments.length, 0);
  assert.equal(hiddenOverlayState.layer.ariaHidden, "true");
  assert.equal(hiddenOverlayState.layer.pointerEvents, "none");
  assertInlineStyleUnchanged(hiddenOverlayState.targetStyle, originalInlineStyles.anchor, "markers hidden");

  await sendReplayCommand(page, { type: "SET_MARKERS_VISIBLE", markersVisible: true });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 2
  );
  anchorGeometry = await getSelectionGeometry(page, "#inline-anchor", ["7", "8"]);
  assertSelectionFragmentsMatch(anchorGeometry, "selection restored after marker visibility toggle");

  const beforeWindowScroll = anchorGeometry;
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.waitForFunction((previousTop) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const fragment = root?.querySelector(".selection-fragment");
    return fragment && Math.abs(fragment.getBoundingClientRect().top - previousTop) >= 100;
  }, beforeWindowScroll.fragments[0].top);
  anchorGeometry = await getSelectionGeometry(page, "#inline-anchor", ["7", "8"]);
  assertSelectionFragmentsMatch(anchorGeometry, "selection after window scroll");
  assert.ok(Math.abs(anchorGeometry.fragments[0].top - (beforeWindowScroll.fragments[0].top - 120)) <= 0.75);
  assertMarkerAvoidsTargetRects(
    anchorGeometry.markers.find((marker) => marker.text === "8"),
    anchorGeometry.targetRects,
    "anchor marker after window scroll must remain outside both lines"
  );

  const fragmentHeightBeforeResize = anchorGeometry.fragments[0].height;
  await page.setViewportSize({ width: 720, height: 520 });
  await page.waitForFunction((previousHeight) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const fragment = root?.querySelector(".selection-fragment");
    return fragment && Math.abs(fragment.getBoundingClientRect().height - previousHeight) >= 2;
  }, fragmentHeightBeforeResize);
  anchorGeometry = await getSelectionGeometry(page, "#inline-anchor", ["7", "8"]);
  assert.equal(anchorGeometry.targetRects.length, 2);
  assertSelectionFragmentsMatch(anchorGeometry, "selection after responsive resize");
  assertInlineStyleUnchanged(anchorGeometry.targetStyle, originalInlineStyles.anchor, "anchor after resize");

  const rtlGeometry = await getSelectionGeometry(page, "#rtl-target", ["9"]);
  const rtlMarker = rtlGeometry.markers[0];
  assert.ok(rtlMarker && !rtlMarker.hidden);
  assert.ok(
    rtlMarker.left - Math.max(...rtlGeometry.targetRects.map((rect) => rect.right)) >= 7.5,
    "an RTL target marker must use the right gutter"
  );
  assertMarkerAvoidsTargetRects(rtlMarker, rtlGeometry.targetRects, "RTL marker must not cover its target");

  const nestedBefore = await getSelectionGeometry(page, "#nested-target", ["10"]);
  const nestedMarkerBefore = nestedBefore.markers[0];
  await page.evaluate(() => {
    document.getElementById("nested-scroll").scrollTop = 24;
  });
  await page.waitForFunction((previousTop) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const marker = [...(root?.querySelectorAll(".marker") ?? [])].find((candidate) => candidate.textContent === "10");
    return marker && Math.abs(marker.getBoundingClientRect().top - previousTop) >= 20;
  }, nestedMarkerBefore.top);
  const nestedAfter = await getSelectionGeometry(page, "#nested-target", ["10"]);
  const nestedMarkerAfter = nestedAfter.markers[0];
  assert.ok(Math.abs(nestedMarkerAfter.top - (nestedMarkerBefore.top - 24)) <= 0.75);
  assertMarkerAvoidsTargetRects(
    nestedMarkerAfter,
    nestedAfter.targetRects,
    "marker must track a target in a nested scroll container"
  );

  await page.evaluate(() => {
    document.getElementById("inline-slide").style.display = "none";
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const relevantMarkers = [...(root?.querySelectorAll(".marker") ?? [])]
      .filter((marker) => marker.textContent === "7" || marker.textContent === "8");
    return root?.querySelectorAll(".selection-fragment").length === 0
      && relevantMarkers.length === 2
      && relevantMarkers.every((marker) => marker.hidden);
  });
  assertInlineStyleUnchanged(
    (await getSelectionGeometry(page, "#inline-anchor")).targetStyle,
    originalInlineStyles.anchor,
    "anchor while its slide is inactive"
  );
  await page.evaluate(() => {
    document.getElementById("inline-slide").style.removeProperty("display");
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 2
  );

  await page.evaluate(() => {
    document.getElementById("inline-anchor").hidden = true;
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 0
  );
  await page.evaluate(() => {
    document.getElementById("inline-anchor").hidden = false;
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 2
  );

  await page.evaluate(() => {
    window.__detachedInlineAnchor = document.getElementById("inline-anchor");
    window.__detachedInlineAnchor.remove();
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 0
  );
  await page.evaluate(() => {
    document.getElementById("inline-parent").append(window.__detachedInlineAnchor);
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 2
  );
  assertInlineStyleUnchanged(
    (await getSelectionGeometry(page, "#inline-anchor")).targetStyle,
    originalInlineStyles.anchor,
    "anchor after detach and restore"
  );

  await sendReplayCommand(page, { type: "FOCUS_ISSUE", issueId: 11 });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 1
  );
  const stressGeometry = await getSelectionGeometry(page, "#fragment-stress", ["11"]);
  assert.ok(stressGeometry.targetRects.length > 128, "the hostile fixture must exceed the fragment cap");
  assert.equal(stressGeometry.fragments.length, 1, "targets above the cap must use one bounded union overlay");
  const stressUnion = stressGeometry.targetRects.reduce((union, rect) => ({
    left: Math.min(union.left, rect.left),
    top: Math.min(union.top, rect.top),
    right: Math.max(union.right, rect.right),
    bottom: Math.max(union.bottom, rect.bottom),
    width: Math.max(union.right, rect.right) - Math.min(union.left, rect.left),
    height: Math.max(union.bottom, rect.bottom) - Math.min(union.top, rect.top)
  }));
  assertRectClose(stressGeometry.fragments[0], expandedRect(stressUnion, 3), "capped selection union");
  assertMarkerAvoidsTargetRects(
    stressGeometry.markers[0],
    stressGeometry.targetRects,
    "capped target marker must avoid every original target fragment"
  );

  await sendReplayCommand(page, { type: "FOCUS_ISSUE", issueId: 8 });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
      ?.querySelectorAll(".selection-fragment").length === 2
  );

  const artifactDirectory = path.join(dashboardDirectory, "artifacts", "page-evidence");
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: path.join(artifactDirectory, "marker-collision.png"), fullPage: false });
  console.log(JSON.stringify({ result: "PASS", markers: markerFacts, compactMarkerScreenshotPath }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
