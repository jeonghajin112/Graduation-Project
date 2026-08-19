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

function rectFact(rect) {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

function assertRectClose(actual, expected, message, tolerance = 0.75) {
  for (const edge of ["left", "top", "right", "bottom", "width", "height"]) {
    assert.ok(
      Math.abs(actual[edge] - expected[edge]) <= tolerance,
      `${message}: ${edge} expected ${expected[edge]}, received ${actual[edge]}`
    );
  }
}

function parseRgb(value) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.equal(channels?.length, 3, `expected an rgb color, received ${value}`);
  return channels;
}

function contrastRatio(foreground, background) {
  const luminance = (value) => {
    const channels = parseRgb(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

async function sendCommand(page, message) {
  await page.evaluate((command) => {
    window.postMessage({ source: "accessibility-dashboard", ...command }, "*");
  }, message);
}

async function readReplayState(page) {
  return page.evaluate(() => {
    const host = document.getElementById("__uni_accessibility_replay_host");
    const root = host?.shadowRoot;
    const selectionFragments = [...(root?.querySelectorAll(".selection-fragment") ?? [])]
      .map((fragment) => {
        const rect = fragment.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      });
    return {
      activeElementId: document.activeElement?.id ?? null,
      outerScroll: { left: window.scrollX, top: window.scrollY },
      innerScroll: {
        left: document.getElementById("inner-scroll").scrollLeft,
        top: document.getElementById("inner-scroll").scrollTop
      },
      markers: [...(root?.querySelectorAll(".marker") ?? [])].map((marker) => {
        const rect = marker.getBoundingClientRect();
        const style = getComputedStyle(marker);
        return {
          label: marker.textContent,
          hidden: marker.hidden,
          pressed: marker.getAttribute("aria-pressed"),
          selected: marker.dataset.selected,
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
          },
          visual: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderTopWidth: style.borderTopWidth,
            borderTopStyle: style.borderTopStyle,
            borderTopColor: style.borderTopColor,
            boxShadow: style.boxShadow
          }
        };
      }),
      selectionFragments,
      outboundMessages: (window.__replayOutbound ?? []).map((message) =>
        JSON.parse(JSON.stringify(message))
      ),
      selectedMessages: (window.__replayOutbound ?? [])
        .filter((message) => message.type === "ISSUE_SELECTED")
        .map((message) => ({ type: message.type, issueId: message.issueId ?? null })),
      locatorStatusCount: (window.__replayOutbound ?? [])
        .filter((message) => message.type === "LOCATOR_STATUS")
        .length
    };
  });
}

async function targetRect(page, selector) {
  return page.locator(selector).evaluate((target) => {
    const rect = target.getBoundingClientRect();
    return {
      left: rect.left - 3,
      top: rect.top - 3,
      right: rect.right + 3,
      bottom: rect.bottom + 3,
      width: rect.width + 6,
      height: rect.height + 6
    };
  });
}

async function hoverWithoutLocatorScroll(page, marker, message) {
  const box = await marker.boundingBox();
  assert.ok(box, `${message}: marker must have a pointer target`);
  assert.ok(box.width > 0 && box.height > 0, `${message}: marker pointer target must have positive dimensions`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

function assertVisuallySelected(state, markerLabel, message) {
  const marker = state.markers.find((candidate) => candidate.label === markerLabel);
  assert.ok(marker, `${message}: marker ${markerLabel} must exist`);
  assert.equal(marker.hidden, false, `${message}: marker ${markerLabel} must remain visible`);
  assert.equal(marker.pressed, "true", `${message}: aria-pressed must identify marker ${markerLabel}`);
  assert.equal(marker.selected, "true", `${message}: visual selected state must identify marker ${markerLabel}`);
  assert.ok(
    state.markers.filter((candidate) => candidate.label !== markerLabel)
      .every((candidate) => candidate.pressed === "false" && candidate.selected === "false"),
    `${message}: every other marker must be deselected`
  );
}

function assertPreviewed(state, markerLabel, issueId, message) {
  assertVisuallySelected(state, markerLabel, message);
  assert.equal(
    state.selectedMessages.at(-1)?.issueId,
    issueId,
    `${message}: the last outbound ISSUE_SELECTED must identify issue ${issueId}`
  );
}

function assertCommitted(state, markerLabel, issueId, message) {
  assertVisuallySelected(state, markerLabel, message);
  assert.equal(
    state.selectedMessages.at(-1)?.issueId,
    issueId,
    `${message}: the last outbound ISSUE_SELECTED must identify issue ${issueId}`
  );
}

function assertCleared(state, message) {
  assert.ok(
    state.markers.every((candidate) => candidate.pressed === "false" && candidate.selected === "false"),
    `${message}: every marker must be deselected`
  );
  assert.equal(state.selectionFragments.length, 0, `${message}: the target highlight must be removed`);
  assert.equal(
    state.selectedMessages.at(-1)?.issueId,
    null,
    `${message}: the dashboard must receive an explicit cleared preview`
  );
}

function assertHoverDoesNotMoveViewportOrFocus(before, after, message) {
  assert.equal(after.activeElementId, before.activeElementId, `${message}: hover must not move focus`);
  assert.deepEqual(after.outerScroll, before.outerScroll, `${message}: hover must not move the outer page`);
  assert.deepEqual(after.innerScroll, before.innerScroll, `${message}: hover must not move a nested scroller`);
}

const sanitizerSource = await readFile(sanitizerPath, "utf8");
let bridgeScript = extractBridgeScript(sanitizerSource);
const markerSize = extractBridgeNumber(bridgeScript, "MARKER_SIZE");
assert.equal(markerSize, 24, "the compact replay marker contract is 24px");
assert.match(bridgeScript, /button\.addEventListener\('pointerenter'/, "markers must support pointer hover preview");
assert.match(bridgeScript, /button\.addEventListener\('pointerleave'/, "markers must clear hover preview on pointer leave");
assert.match(bridgeScript, /button\.addEventListener\('pointercancel'/, "cancelled pointers must clear hover preview");
assert.match(bridgeScript, /pointerType === 'touch'/, "touch pointer entry must not preview an issue");
assert.match(bridgeScript, /button\.addEventListener\('blur'/, "keyboard preview must clear on blur");
assert.match(bridgeScript, /button\.addEventListener\('click'/, "click activation must remain available");
assert.match(bridgeScript, /ISSUE_SELECTED/, "hover preview must use the replay selection message");
bridgeScript = bridgeScript.replace(
  "host.attachShadow({ mode: 'closed' })",
  "host.attachShadow({ mode: 'open' })"
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.setContent(`<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { min-height: 1700px; margin: 0; }
          body { font-family: system-ui, sans-serif; }
          #focus-anchor {
            position: fixed;
            right: 24px;
            top: 20px;
            width: 120px;
            height: 44px;
          }
          #inner-scroll {
            position: absolute;
            left: 140px;
            top: 420px;
            width: 460px;
            height: 240px;
            overflow: auto;
            border: 1px solid #cbd5e1;
          }
          #inner-content { position: relative; width: 720px; height: 720px; }
          .target { position: absolute; display: block; height: 44px; padding: 10px; }
          #target-a { left: 130px; top: 170px; width: 210px; background: #dbeafe; }
          #target-b { left: 110px; top: 210px; width: 250px; background: #dcfce7; }
          #hidden-target { display: none; }
        </style>
      </head>
      <body>
        <button id="focus-anchor" type="button">Focus anchor</button>
        <div id="inner-scroll">
          <div id="inner-content">
            <span id="target-a" class="target">첫 번째 접근성 문제</span>
            <span id="target-b" class="target">두 번째 접근성 문제</span>
            <span id="hidden-target">숨겨진 접근성 문제</span>
          </div>
        </div>
      </body>
    </html>`);

  await page.evaluate(() => {
    window.__replayOutbound = [];
    window.addEventListener("message", (event) => {
      if (event.data?.source === "accessibility-page-replay") {
        window.__replayOutbound.push(JSON.parse(JSON.stringify(event.data)));
      }
    });
  });
  await page.addScriptTag({ content: bridgeScript });
  await page.waitForFunction(() =>
    (window.__replayOutbound ?? []).some((message) => message.type === "READY")
  );

  const replayIssues = [
    {
      id: 101,
      severity: "HIGH",
      title: "첫 번째 문제",
      pathSteps: [{ context: "DOCUMENT", selector: "#target-a" }]
    },
    {
      id: 102,
      severity: "MEDIUM",
      title: "두 번째 문제",
      pathSteps: [{ context: "DOCUMENT", selector: "#target-b" }]
    },
    {
      id: 103,
      severity: "LOW",
      title: "숨겨진 문제",
      pathSteps: [{ context: "DOCUMENT", selector: "#hidden-target" }]
    }
  ];
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: replayIssues
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 3
  );
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    return markers.length === 3 && !markers[0].hidden && !markers[1].hidden && markers[2].hidden;
  });

  await page.evaluate(() => {
    const scroller = document.getElementById("inner-scroll");
    scroller.scrollTo({ left: 36, top: 110, behavior: "instant" });
    window.scrollTo({ left: 0, top: 260, behavior: "instant" });
    document.getElementById("focus-anchor").focus({ preventScroll: true });
  });
  await page.waitForFunction(() =>
    window.scrollY === 260
      && document.getElementById("inner-scroll").scrollTop === 110
      && document.activeElement?.id === "focus-anchor"
  );
  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    window.__stableMarkerA = markers[0];
    window.__stableMarkerB = markers[1];
  });

  const markerHost = page.locator("#__uni_accessibility_replay_host");
  const markerA = markerHost.locator(".marker").nth(0);
  const markerB = markerHost.locator(".marker").nth(1);
  const initialState = await readReplayState(page);
  assert.ok(
    initialState.markers.filter((marker) => !marker.hidden)
      .every((marker) => marker.rect.width === markerSize && marker.rect.height === markerSize),
    "every rendered replay marker must use the parsed compact marker size"
  );
  for (const marker of initialState.markers.filter((candidate) => !candidate.hidden)) {
    assert.ok(
      contrastRatio(marker.visual.color, marker.visual.backgroundColor) >= 4.5,
      `marker ${marker.label} text contrast must meet WCAG AA: ${JSON.stringify(marker.visual)}`
    );
  }
  assert.ok(
    initialState.markers.every((marker) => marker.pressed === "false" && marker.selected !== "true"),
    "INIT_ISSUES without a selected id must not select a marker"
  );
  assert.equal(initialState.selectionFragments.length, 0, "INIT_ISSUES must not create a highlight");
  assert.equal(initialState.selectedMessages.length, 0, "INIT_ISSUES must not masquerade as interaction");
  assert.equal(initialState.locatorStatusCount, 3, "the fixture must resolve each issue exactly once");

  await page.waitForTimeout(100);
  const beforeHoverB = await readReplayState(page);
  await hoverWithoutLocatorScroll(page, markerB, "hovering marker B");
  await page.waitForFunction(() =>
    window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED").length === 1
  );
  const afterHoverB = await readReplayState(page);
  assertPreviewed(afterHoverB, "2", 102, "hovering marker B");
  assert.equal(afterHoverB.selectedMessages.length, 1, "hover must notify the dashboard exactly once");
  assertHoverDoesNotMoveViewportOrFocus(initialState, afterHoverB, "hovering marker B");
  assert.equal(afterHoverB.selectionFragments.length, 1, "marker B must highlight its target");
  assertRectClose(afterHoverB.markers[1].rect, beforeHoverB.markers[1].rect, "hover must not change marker B geometry");
  assert.deepEqual(
    afterHoverB.markers[1].visual,
    beforeHoverB.markers[1].visual,
    "data-selected hover state must not change marker background, border, or box shadow"
  );
  assertRectClose(afterHoverB.selectionFragments[0], await targetRect(page, "#target-b"), "marker B highlight");
  assert.equal(
    await markerB.evaluate((marker) => marker === window.__stableMarkerB),
    true,
    "hover must preserve marker DOM identity"
  );
  assert.equal(afterHoverB.locatorStatusCount, initialState.locatorStatusCount, "hover must not reconnect locators");

  await markerB.dispatchEvent("pointerenter", { pointerType: "mouse", isPrimary: true });
  await page.waitForTimeout(60);
  const afterDuplicateEnterB = await readReplayState(page);
  assert.equal(
    afterDuplicateEnterB.selectedMessages.length,
    afterHoverB.selectedMessages.length,
    "a repeated pointerenter for the active marker must not emit a duplicate preview"
  );
  assertPreviewed(afterDuplicateEnterB, "2", 102, "repeated marker B pointerenter");

  await page.mouse.move(8, 8);
  await page.waitForFunction(() => {
    const previews = window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED");
    return previews.length === 2 && previews.at(-1)?.issueId === null;
  });
  const afterPointerLeave = await readReplayState(page);
  assertCleared(afterPointerLeave, "leaving marker B");
  assert.equal(afterPointerLeave.selectedMessages.length, 2, "leaving hover must emit one explicit clear");
  assertHoverDoesNotMoveViewportOrFocus(initialState, afterPointerLeave, "leaving marker B");

  await markerB.dispatchEvent("pointerleave", { pointerType: "mouse", isPrimary: true });
  await page.waitForTimeout(60);
  const afterDuplicateLeaveB = await readReplayState(page);
  assert.equal(
    afterDuplicateLeaveB.selectedMessages.length,
    afterPointerLeave.selectedMessages.length,
    "a repeated pointerleave after clearing must not emit a duplicate null preview"
  );
  assertCleared(afterDuplicateLeaveB, "repeated marker B pointerleave");

  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const marker = [...root.querySelectorAll(".marker")][1];
    const pointer = (type) => new PointerEvent(type, {
      bubbles: false,
      pointerType: "mouse",
      isPrimary: true
    });
    marker.dispatchEvent(pointer("pointerenter"));
    marker.dispatchEvent(pointer("pointerleave"));
    window.dispatchEvent(new MessageEvent("message", {
      source: window.parent,
      data: { source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 101 }
    }));
  });
  await page.waitForFunction(() => {
    const selections = window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED");
    return selections.at(-1)?.issueId === null;
  });
  const afterPendingClearRace = await readReplayState(page);
  assertCleared(afterPendingClearRace, "stale parent focus during marker B leave clear");
  assert.deepEqual(
    afterPendingClearRace.selectedMessages.slice(-2).map((message) => message.issueId),
    [102, null],
    "the pending pointerleave clear must win over a stale parent focus message"
  );

  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...root.querySelectorAll(".marker")];
    const pointer = (type, relatedTarget = null) => new PointerEvent(type, {
      bubbles: false,
      pointerType: "mouse",
      isPrimary: true,
      relatedTarget
    });
    markers[0].dispatchEvent(pointer("pointerenter"));
    markers[0].dispatchEvent(pointer("pointerleave", markers[1]));
    markers[1].dispatchEvent(pointer("pointerenter", markers[0]));
  });
  await page.waitForFunction(() => {
    const previews = window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED");
    return previews.at(-1)?.issueId === 102;
  });
  const afterQuickTransition = await readReplayState(page);
  assertPreviewed(afterQuickTransition, "2", 102, "quick A leave to B enter");
  assert.deepEqual(
    afterQuickTransition.selectedMessages.slice(-2).map((message) => message.issueId),
    [101, 102],
    "a quick A enter/leave followed by B enter must cancel the pending clear and finish on B"
  );
  assertHoverDoesNotMoveViewportOrFocus(initialState, afterQuickTransition, "quick A to B transition");

  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...root.querySelectorAll(".marker")];
    const pointer = (type) => new PointerEvent(type, {
      bubbles: false,
      pointerType: "mouse",
      isPrimary: true
    });
    markers[0].dispatchEvent(pointer("pointerenter"));
    markers[1].dispatchEvent(pointer("pointerenter"));
    markers[0].dispatchEvent(pointer("pointerleave"));
  });
  await page.waitForTimeout(60);
  const afterStaleLeave = await readReplayState(page);
  assertPreviewed(afterStaleLeave, "2", 102, "stale marker A leave after marker B enter");
  assert.notEqual(
    afterStaleLeave.selectedMessages.at(-1)?.issueId,
    null,
    "a stale leave from marker A must not clear the newer marker B preview"
  );

  const previewCountBeforeTouch = afterStaleLeave.selectedMessages.length;
  await markerA.dispatchEvent("pointerenter", { pointerType: "touch", isPrimary: true });
  await markerB.dispatchEvent("pointerleave", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(60);
  const afterTouchHoverEvents = await readReplayState(page);
  assertPreviewed(afterTouchHoverEvents, "2", 102, "touch hover events");
  assert.equal(
    afterTouchHoverEvents.selectedMessages.length,
    previewCountBeforeTouch,
    "touch pointer enter/leave must not preview, clear, or notify"
  );
  assertHoverDoesNotMoveViewportOrFocus(initialState, afterTouchHoverEvents, "touch hover events");

  const interactionCountBeforeStaleFocus = afterTouchHoverEvents.selectedMessages.length;
  await sendCommand(page, { type: "FOCUS_ISSUE", issueId: 101 });
  await sendCommand(page, { type: "FOCUS_ISSUE", issueId: null });
  await page.waitForTimeout(60);
  const afterStaleFocusEchoes = await readReplayState(page);
  assertPreviewed(afterStaleFocusEchoes, "2", 102, "stale parent focus echoes during marker B hover");
  assert.equal(
    afterStaleFocusEchoes.selectedMessages.length,
    interactionCountBeforeStaleFocus,
    "parent focus echoes must neither notify again nor overwrite the active hover preview"
  );
  await sendCommand(page, { type: "FOCUS_ISSUE", issueId: 102 });
  await page.waitForTimeout(30);
  const afterMatchingFocusEcho = await readReplayState(page);
  assertPreviewed(afterMatchingFocusEcho, "2", 102, "matching parent focus echo during marker B hover");

  await markerB.dispatchEvent("pointercancel", { pointerType: "mouse", isPrimary: true });
  await page.waitForFunction(() => {
    const previews = window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED");
    return previews.at(-1)?.issueId === null;
  });
  const afterClearingStaleSequence = await readReplayState(page);
  assertCleared(afterClearingStaleSequence, "cancelling the active marker B pointer");

  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const hiddenMarker = [...(root?.querySelectorAll(".marker") ?? [])][2];
    hiddenMarker.dispatchEvent(new PointerEvent("pointerenter", {
      bubbles: false,
      pointerType: "mouse",
      isPrimary: true
    }));
  });
  await page.waitForTimeout(60);
  const afterHiddenPointerEnter = await readReplayState(page);
  assertCleared(afterHiddenPointerEnter, "hidden marker pointer entry");
  assert.equal(afterHiddenPointerEnter.markers[2].hidden, true, "the unavailable marker must stay hidden");
  assert.equal(
    afterHiddenPointerEnter.selectedMessages.length,
    afterClearingStaleSequence.selectedMessages.length,
    "a hidden marker must ignore even a programmatic pointerenter"
  );
  assertHoverDoesNotMoveViewportOrFocus(initialState, afterHiddenPointerEnter, "hidden marker pointer entry");

  const messagesBeforeClick = afterHiddenPointerEnter.selectedMessages.length;
  await markerB.evaluate((button) => button.click());
  await page.waitForFunction((before) =>
    window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED").length === before + 1,
    messagesBeforeClick
  );
  let fallbackState = await readReplayState(page);
  assertCommitted(fallbackState, "2", 102, "click fallback");

  await markerB.evaluate((button) => button.click());
  await page.waitForTimeout(60);
  let repeatedFallbackState = await readReplayState(page);
  assert.equal(
    repeatedFallbackState.selectedMessages.length,
    fallbackState.selectedMessages.length,
    "repeating activation for the committed issue must not emit a duplicate selection"
  );

  const messagesBeforeEnter = repeatedFallbackState.selectedMessages.length;
  await markerA.focus();
  await markerA.press("Enter");
  await page.waitForFunction((before) =>
    window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED").length >= before + 1,
    messagesBeforeEnter
  );
  fallbackState = await readReplayState(page);
  assertCommitted(fallbackState, "1", 101, "Enter fallback");

  await markerA.evaluate((button) => button.blur());
  await page.waitForFunction(() => {
    const previews = window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED");
    return previews.at(-1)?.issueId === null;
  });
  let afterKeyboardBlur = await readReplayState(page);
  assertCleared(afterKeyboardBlur, "blurring marker A after keyboard activation");

  const messagesBeforeSpace = afterKeyboardBlur.selectedMessages.length;
  await markerB.focus();
  await markerB.press(" ");
  await page.waitForFunction((before) =>
    window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED").length >= before + 1,
    messagesBeforeSpace
  );
  fallbackState = await readReplayState(page);
  assertCommitted(fallbackState, "2", 102, "Space fallback");

  await markerB.evaluate((button) => button.blur());
  await page.waitForFunction(() => {
    const previews = window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED");
    return previews.at(-1)?.issueId === null;
  });
  afterKeyboardBlur = await readReplayState(page);
  assertCleared(afterKeyboardBlur, "blurring marker B after Space activation");

  const selectedBeforeTouchClick = afterKeyboardBlur.selectedMessages.length;
  await markerA.dispatchEvent("pointerenter", { pointerType: "touch", isPrimary: true });
  await markerA.evaluate((button) => button.click());
  await page.waitForFunction((before) =>
    window.__replayOutbound.filter((message) => message.type === "ISSUE_SELECTED").length === before + 1,
    selectedBeforeTouchClick
  );
  await markerA.dispatchEvent("pointerleave", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(60);
  fallbackState = await readReplayState(page);
  assertCommitted(fallbackState, "1", 101, "touch click fallback");
  assert.equal(
    fallbackState.selectedMessages.length,
    afterKeyboardBlur.selectedMessages.length + 1,
    "touch pointer boundaries must add only the click selection"
  );

  assert.equal(fallbackState.locatorStatusCount, initialState.locatorStatusCount, "interactions must not reconnect locators");
  assert.equal(
    await markerA.evaluate((marker) => marker === window.__stableMarkerA),
    true,
    "interactions must preserve marker A DOM identity"
  );
  assert.equal(
    await markerB.evaluate((marker) => marker === window.__stableMarkerB),
    true,
    "interactions must preserve marker B DOM identity"
  );

  assert.deepEqual(pageErrors, [], "the bridge fixture must not raise browser errors");
  console.log(JSON.stringify({
    result: "PASS",
    interactionMessages: fallbackState.selectedMessages,
    fallbackMessages: fallbackState.selectedMessages.slice(-3),
    finalMarkers: fallbackState.markers
  }, null, 2));
} finally {
  await browser.close();
}
