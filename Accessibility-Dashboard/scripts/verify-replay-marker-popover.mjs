import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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

const POPOVER_SELECTOR = ".issue-popover";
const VIEWPORT_MARGIN = 12;
const MARKER_HALO = 6;
const MIN_ADJACENT_GAP = 12;
const PREFERRED_ADJACENT_GAP = 20;
const MAX_ADJACENT_GAP = 52;

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
      blocks.push(match[1]
        .split(/\r?\n/)
        .map((line) => line.replace(/^ {12}/, ""))
        .join("\n"));
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

function extractJavaTextBlock(source, constantName) {
  const declaration = `private static final String ${constantName} = \"\"\"`;
  const declarationIndex = source.indexOf(declaration);
  assert.ok(declarationIndex >= 0, `${constantName} declaration must exist`);
  const contentStart = source.indexOf("\n", declarationIndex) + 1;
  const contentEnd = source.indexOf('\n            \"\"\";', contentStart);
  assert.ok(contentStart > 0 && contentEnd > contentStart, `${constantName} text block must be complete`);
  return source
    .slice(contentStart, contentEnd)
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n");
}

function overlaps(left, right, tolerance = 0.5) {
  return !(
    left.right <= right.left + tolerance
    || right.right <= left.left + tolerance
    || left.bottom <= right.top + tolerance
    || right.bottom <= left.top + tolerance
  );
}

function expandRect(rect, amount) {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2
  };
}

function rectSide(subject, anchor, tolerance = 1) {
  if (subject.right <= anchor.left + tolerance) return "left";
  if (subject.left >= anchor.right - tolerance) return "right";
  if (subject.bottom <= anchor.top + tolerance) return "top";
  if (subject.top >= anchor.bottom - tolerance) return "bottom";
  return "overlap";
}

function rectangleDistance(left, right) {
  const horizontal = Math.max(left.left - right.right, right.left - left.right, 0);
  const vertical = Math.max(left.top - right.bottom, right.top - left.bottom, 0);
  return Math.hypot(horizontal, vertical);
}

async function sendCommand(page, message) {
  await page.evaluate((command) => {
    window.postMessage({ source: "accessibility-dashboard", ...command }, "*");
  }, message);
}

async function shadowFact(page) {
  return page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const visiblePopover = [...(root?.querySelectorAll(".issue-popover") ?? [])]
      .find((candidate) =>
        candidate.dataset.presentation !== "external-description"
        && !candidate.hidden
        && getComputedStyle(candidate).display !== "none"
      );
    const externalDescription = root?.querySelector(
      ".issue-popover[data-presentation='external-description']"
    ) ?? null;
    const scrollIndicator = root?.querySelector(".issue-popover-scroll-indicator") ?? null;
    const scrollIndicatorThumb = scrollIndicator?.querySelector(".issue-popover-scroll-indicator__thumb") ?? null;
    const rectFact = (rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    });
    const textBlockFact = (selector) => {
      const element = visiblePopover?.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const textNodes = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      let finalNode = null;
      let finalCharacterIndex = -1;
      for (let index = textNodes.length - 1; index >= 0 && !finalNode; index -= 1) {
        const node = textNodes[index];
        for (let characterIndex = node.data.length - 1; characterIndex >= 0; characterIndex -= 1) {
          if (/\S/u.test(node.data[characterIndex])) {
            finalNode = node;
            finalCharacterIndex = characterIndex;
            break;
          }
        }
      }
      let finalCharacterRect = null;
      if (finalNode) {
        const range = document.createRange();
        range.setStart(finalNode, finalCharacterIndex);
        range.setEnd(finalNode, finalCharacterIndex + 1);
        const rect = range.getBoundingClientRect();
        finalCharacterRect = rectFact(rect);
      }
      const popoverRect = visiblePopover.getBoundingClientRect();
      return {
        text: element.textContent ?? "",
        display: style.display,
        overflow: style.overflow,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        textOverflow: style.textOverflow,
        webkitLineClamp: style.getPropertyValue("-webkit-line-clamp"),
        maxHeight: style.maxHeight,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        finalCharacterRect,
        finalCharacterVisible: Boolean(finalCharacterRect
          && finalCharacterRect.width > 0
          && finalCharacterRect.height > 0
          && finalCharacterRect.left >= popoverRect.left - 1
          && finalCharacterRect.right <= popoverRect.right + 1
          && finalCharacterRect.top >= popoverRect.top - 1
          && finalCharacterRect.bottom <= popoverRect.bottom + 1)
      };
    };
    const scrollIndicatorFact = scrollIndicator ? (() => {
      const style = getComputedStyle(scrollIndicator);
      const thumbStyle = scrollIndicatorThumb ? getComputedStyle(scrollIndicatorThumb) : null;
      return {
        ariaHidden: scrollIndicator.getAttribute("aria-hidden"),
        hidden: scrollIndicator.hidden,
        display: style.display,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        backgroundColor: style.backgroundColor,
        rect: rectFact(scrollIndicator.getBoundingClientRect()),
        thumb: scrollIndicatorThumb ? {
          backgroundColor: thumbStyle.backgroundColor,
          borderRadius: thumbStyle.borderRadius,
          transform: thumbStyle.transform,
          rect: rectFact(scrollIndicatorThumb.getBoundingClientRect())
        } : null
      };
    })() : null;
    return {
      popoverCount: root?.querySelectorAll(".issue-popover").length ?? 0,
      scrollIndicatorCount: root?.querySelectorAll(".issue-popover-scroll-indicator").length ?? 0,
      scrollIndicator: scrollIndicatorFact,
      visiblePopoverCount: [...(root?.querySelectorAll(".issue-popover") ?? [])]
        .filter((candidate) =>
          candidate.dataset.presentation !== "external-description"
          && !candidate.hidden
          && getComputedStyle(candidate).display !== "none"
        ).length,
      popover: visiblePopover ? {
        id: visiblePopover.id || null,
        issueId: visiblePopover.dataset.issueId ?? null,
        placement: visiblePopover.dataset.placement ?? null,
        density: visiblePopover.dataset.density || "normal",
        layout: visiblePopover.dataset.layout || "vertical",
        scrollable: visiblePopover.dataset.scrollable ?? null,
        hidden: visiblePopover.hidden,
        ariaHidden: visiblePopover.getAttribute("aria-hidden"),
        ariaLabel: visiblePopover.getAttribute("aria-label"),
        role: visiblePopover.getAttribute("role"),
        tabIndex: visiblePopover.tabIndex,
        focused: root?.activeElement === visiblePopover,
        pointerEvents: getComputedStyle(visiblePopover).pointerEvents,
        maxHeight: getComputedStyle(visiblePopover).maxHeight,
        overflowX: getComputedStyle(visiblePopover).overflowX,
        overflowY: getComputedStyle(visiblePopover).overflowY,
        rect: rectFact(visiblePopover.getBoundingClientRect()),
        clientWidth: visiblePopover.clientWidth,
        clientHeight: visiblePopover.clientHeight,
        scrollWidth: visiblePopover.scrollWidth,
        scrollHeight: visiblePopover.scrollHeight,
        scrollTop: visiblePopover.scrollTop,
        maxScrollTop: Math.max(0, visiblePopover.scrollHeight - visiblePopover.clientHeight),
        clientBottom: visiblePopover.getBoundingClientRect().top + visiblePopover.clientHeight,
        visibleContentBottom: Math.max(
          ...[".issue-popover__title", ".issue-popover__message", ".issue-popover__path"]
            .map((selector) => visiblePopover.querySelector(selector))
            .filter((element) => element && !element.hidden && getComputedStyle(element).display !== "none")
            .map((element) => element.getBoundingClientRect().bottom),
          visiblePopover.getBoundingClientRect().top
        ),
        severity: visiblePopover.querySelector(".issue-popover__severity")?.textContent ?? null,
        code: visiblePopover.querySelector(".issue-popover__code")?.textContent ?? null,
        title: visiblePopover.querySelector(".issue-popover__title")?.textContent ?? null,
        message: visiblePopover.querySelector(".issue-popover__message")?.textContent ?? null,
        path: visiblePopover.querySelector(".issue-popover__path")?.textContent ?? null,
        blocks: {
          title: textBlockFact(".issue-popover__title"),
          message: textBlockFact(".issue-popover__message"),
          path: textBlockFact(".issue-popover__path")
        },
        injectedElementCount: visiblePopover.querySelectorAll("img,script,svg,iframe,object,embed").length,
        focusableCount: visiblePopover.querySelectorAll(
          'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
        ).length
      } : null,
      externalDescription: externalDescription ? (() => {
        const style = getComputedStyle(externalDescription);
        return {
          id: externalDescription.id || null,
          issueId: externalDescription.dataset.issueId ?? null,
          presentation: externalDescription.dataset.presentation ?? null,
          hidden: externalDescription.hidden,
          ariaHidden: externalDescription.getAttribute("aria-hidden"),
          role: externalDescription.getAttribute("role"),
          display: style.display,
          visibility: style.visibility,
          position: style.position,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          clip: style.clip,
          clipPath: style.clipPath,
          whiteSpace: style.whiteSpace,
          pointerEvents: style.pointerEvents,
          rect: rectFact(externalDescription.getBoundingClientRect()),
          severity: externalDescription.querySelector(".issue-popover__severity")?.textContent ?? null,
          code: externalDescription.querySelector(".issue-popover__code")?.textContent ?? null,
          title: externalDescription.querySelector(".issue-popover__title")?.textContent ?? null,
          message: externalDescription.querySelector(".issue-popover__message")?.textContent ?? null,
          path: externalDescription.querySelector(".issue-popover__path")?.textContent ?? null,
          injectedElementCount: externalDescription.querySelectorAll("img,script,svg,iframe,object,embed").length,
          focusableCount: externalDescription.querySelectorAll(
            'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
          ).length
        };
      })() : null,
      markers: [...(root?.querySelectorAll(".marker") ?? [])].map((marker) => ({
        label: marker.textContent,
        ariaLabel: marker.getAttribute("aria-label"),
        ariaDescribedBy: marker.getAttribute("aria-describedby"),
        hidden: marker.hidden || getComputedStyle(marker).display === "none",
        pressed: marker.getAttribute("aria-pressed"),
        rect: rectFact(marker.getBoundingClientRect())
      })),
      selectionFragmentCount: root?.querySelectorAll(".selection-fragment").length ?? 0,
      outbound: (window.__popoverOutbound ?? []).map((message) => JSON.parse(JSON.stringify(message))),
      activeElementIsMarker: document.activeElement === document.getElementById("__uni_accessibility_replay_host"),
      shadowActiveClass: root?.activeElement?.className ?? null,
      shadowActiveText: root?.activeElement?.textContent ?? null,
      xssFlag: window.__popoverXss ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY }
    };
  });
}

async function markerLocator(page, index) {
  const host = page.locator("#__uni_accessibility_replay_host");
  const marker = host.locator(".marker").nth(index);
  await marker.waitFor({ state: "attached" });
  return marker;
}

async function hoverMarker(page, index) {
  const marker = await markerLocator(page, index);
  const box = await marker.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `marker ${index + 1} must be visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return marker;
}

async function waitForVisiblePopover(page, issueId) {
  await page.waitForFunction((expectedId) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const popover = root?.querySelector(".issue-popover");
    return popover
      && !popover.hidden
      && getComputedStyle(popover).display !== "none"
      && popover.dataset.issueId === String(expectedId);
  }, issueId);
  const fact = await shadowFact(page);
  assert.equal(fact.visiblePopoverCount, 1, "exactly one issue popover may be visible");
  return fact;
}

async function waitForClearedPopover(page) {
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return [...(root?.querySelectorAll(".issue-popover") ?? [])]
      .every((candidate) => candidate.hidden || getComputedStyle(candidate).display === "none");
  });
  const fact = await shadowFact(page);
  assert.equal(fact.visiblePopoverCount, 0, "no issue popover may remain visible");
  return fact;
}

async function waitForExternalDescription(page, issue, markerIndex, message) {
  await page.waitForFunction((expectedId) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const description = root?.querySelector(
      ".issue-popover[data-presentation='external-description']"
    );
    const fallbackMessages = (window.__popoverOutbound ?? [])
      .filter((candidate) => candidate.type === "ISSUE_DETAIL_FALLBACK");
    return description
      && !description.hidden
      && description.dataset.issueId === String(expectedId)
      && fallbackMessages.at(-1)?.issueId === expectedId;
  }, issue.id);
  const fact = await shadowFact(page);
  const description = fact.externalDescription;
  const expected = boundedIssueText(issue);
  assert.equal(fact.visiblePopoverCount, 0, `${message}: no adjacent visual tooltip may remain`);
  assert.equal(fact.popover, null, `${message}: visual tooltip fact must be empty`);
  assert.ok(description, `${message}: the in-frame accessible description must remain mounted`);
  assert.equal(description.issueId, String(issue.id), `${message}: description issue id`);
  assert.equal(description.presentation, "external-description", `${message}: presentation mode`);
  assert.equal(description.hidden, false, `${message}: aria description must not use hidden`);
  assert.equal(description.ariaHidden, "false", `${message}: aria description must remain exposed`);
  assert.equal(description.role, "tooltip", `${message}: marker description retains tooltip semantics`);
  assert.equal(description.display, "block", `${message}: description remains in the accessibility tree`);
  assert.equal(description.visibility, "visible", `${message}: description remains in the accessibility tree`);
  assert.equal(description.position, "fixed", `${message}: description must not alter document layout`);
  assert.equal(description.overflowX, "hidden", `${message}: visually hidden description width`);
  assert.equal(description.overflowY, "hidden", `${message}: visually hidden description height`);
  assert.match(description.clipPath, /inset\(50%\)/, `${message}: description must be visually clipped`);
  assert.equal(description.whiteSpace, "nowrap", `${message}: description must stay one clipped box`);
  assert.equal(description.pointerEvents, "none", `${message}: duplicate content must not intercept input`);
  assert.ok(description.rect.width <= 1.1 && description.rect.height <= 1.1, `${message}: clipped geometry`);
  assert.equal(description.severity, expected.severity, `${message}: severity text`);
  assert.equal(description.code, expected.code, `${message}: code text`);
  assert.equal(description.title, expected.title, `${message}: title text`);
  assert.equal(description.message, expected.message, `${message}: full bounded message text`);
  assert.equal(description.path, expected.path, `${message}: full bounded path text`);
  assert.equal(description.injectedElementCount, 0, `${message}: untrusted text must remain text-only`);
  assert.equal(description.focusableCount, 0, `${message}: description must not add a tab stop`);
  assert.equal(
    fact.markers[markerIndex]?.ariaDescribedBy,
    description.id,
    `${message}: marker must reference the in-frame description`
  );
  const fallbackMessage = fact.outbound
    .filter((candidate) => candidate.type === "ISSUE_DETAIL_FALLBACK")
    .at(-1);
  const documentToken = fact.outbound
    .find((candidate) => candidate.type === "READY")
    ?.documentToken;
  assert.deepEqual(
    Object.keys(fallbackMessage).sort(),
    ["documentToken", "issueId", "source", "type"],
    `${message}: fallback transport must expose no untrusted content fields`
  );
  assert.match(documentToken, /^[A-Za-z0-9_-]{1,128}$/, `${message}: replay document token`);
  assert.equal(
    fallbackMessage.documentToken,
    documentToken,
    `${message}: fallback transport must identify the active replay document`
  );
  assert.equal(fallbackMessage.issueId, issue.id, `${message}: fallback transport id`);
  return fact;
}

async function waitForExternalDescriptionCleared(page, message) {
  const fact = await waitForClearedPopover(page);
  await page.waitForFunction(() => {
    const fallbackMessages = (window.__popoverOutbound ?? [])
      .filter((candidate) => candidate.type === "ISSUE_DETAIL_FALLBACK");
    return fallbackMessages.at(-1)?.issueId === null;
  });
  const cleared = await shadowFact(page);
  const clearedFallbackMessage = cleared.outbound
    .filter((candidate) => candidate.type === "ISSUE_DETAIL_FALLBACK")
    .at(-1);
  const activeDocumentToken = cleared.outbound
    .find((candidate) => candidate.type === "READY")
    ?.documentToken;
  assert.equal(cleared.externalDescription, null, `${message}: clipped aria description must be removed`);
  assert.deepEqual(
    Object.keys(clearedFallbackMessage).sort(),
    ["documentToken", "issueId", "source", "type"],
    `${message}: fallback clear must retain the exact tokenized transport shape`
  );
  assert.equal(
    clearedFallbackMessage.documentToken,
    activeDocumentToken,
    `${message}: fallback clear must identify the active replay document`
  );
  assert.ok(
    cleared.markers.every((marker) => marker.ariaDescribedBy === null),
    `${message}: every transient aria-describedby relationship must be removed`
  );
  return { ...fact, ...cleared };
}

async function targetRects(page, selector) {
  return page.locator(selector).evaluate((target) => [...target.getClientRects()].map((rect) => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  })));
}

async function assertSafePopover(
  page,
  issueId,
  markerIndex,
  targetSelector,
  message,
  { maxAdjacentGap = PREFERRED_ADJACENT_GAP } = {}
) {
  const fact = await waitForVisiblePopover(page, issueId);
  const popover = fact.popover;
  assert.ok(popover, `${message}: popover must exist`);
  const marker = fact.markers[markerIndex];
  assert.ok(marker && !marker.hidden, `${message}: marker must remain visible`);
  const rects = await targetRects(page, targetSelector);
  assert.ok(rects.length > 0, `${message}: target must have client rects`);
  assert.ok(
    rects.every((rect) => !overlaps(popover.rect, expandRect(rect, MARKER_HALO))),
    `${message}: popover must leave at least 6px around every target client rect`
  );
  assert.equal(
    overlaps(popover.rect, expandRect(marker.rect, MARKER_HALO)),
    false,
    `${message}: popover must not cover the marker or its halo`
  );
  assert.ok(
    fact.markers.every((candidate) => candidate.hidden
      || !overlaps(popover.rect, expandRect(candidate.rect, MARKER_HALO))),
    `${message}: popover must avoid every visible marker halo`
  );
  assert.ok(popover.rect.left >= VIEWPORT_MARGIN - 1, `${message}: left viewport margin`);
  assert.ok(popover.rect.top >= VIEWPORT_MARGIN - 1, `${message}: top viewport margin`);
  assert.ok(popover.rect.right <= fact.viewport.width - VIEWPORT_MARGIN + 1, `${message}: right viewport margin`);
  assert.ok(popover.rect.bottom <= fact.viewport.height - VIEWPORT_MARGIN + 1, `${message}: bottom viewport margin`);
  const maximumPopoverWidth = popover.layout === "wide"
    ? Math.min(840, fact.viewport.width - 24)
    : Math.min(360, fact.viewport.width - 24);
  assert.ok(popover.rect.width <= maximumPopoverWidth + 1, `${message}: width cap`);
  assert.ok(popover.rect.height <= Math.min(320, fact.viewport.height - 24) + 1, `${message}: height cap`);
  const side = rectSide(popover.rect, marker.rect);
  assert.notEqual(side, "overlap", `${message}: popover must occupy an adjacent side`);
  assert.ok(
    ["left", "right", "top", "bottom"].includes(popover.placement),
    `${message}: bridge must expose a declared placement family`
  );
  const gap = rectangleDistance(popover.rect, expandRect(marker.rect, MARKER_HALO));
  assert.ok(
    gap >= MIN_ADJACENT_GAP - 1 && gap <= maxAdjacentGap,
    `${message}: adjacent gap ${gap}; geometry=${JSON.stringify({
      popover: popover.rect,
      marker: marker.rect,
      targetRects: rects,
      allMarkers: fact.markers.map((candidate) => candidate.rect),
      side
    })}`
  );
  return { fact, side, placement: popover.placement, gap, targetRects: rects };
}

function boundedIssueText(issue) {
  return {
    severity: typeof issue.severityLabel === "string" ? issue.severityLabel.slice(0, 32) : "",
    code: `KWCAG ${typeof issue.code === "string" ? issue.code.slice(0, 128) : ""}`,
    title: typeof issue.title === "string" ? issue.title.slice(0, 300) : "",
    message: typeof issue.message === "string" ? issue.message.slice(0, 1600) : "",
    path: typeof issue.path === "string" ? issue.path.slice(0, 2048) : ""
  };
}

function assertUnclampedBlock(block, expectedText, message) {
  assert.ok(block, `${message}: text block must exist`);
  assert.equal(block.text, expectedText, `${message}: every bounded character must remain in textContent`);
  assert.notEqual(block.display, "-webkit-box", `${message}: legacy line-clamp display is forbidden`);
  assert.ok(
    block.webkitLineClamp === "none" || block.webkitLineClamp === "",
    `${message}: line-clamp must be disabled, received ${block.webkitLineClamp}`
  );
  assert.notEqual(block.textOverflow, "ellipsis", `${message}: ellipsis must not hide content`);
  assert.ok(
    !["hidden", "clip"].includes(block.overflowY),
    `${message}: the text block itself must not clip vertically`
  );
  assert.ok(
    block.scrollHeight <= block.clientHeight + 1,
    `${message}: all text rows must contribute to layout (${block.scrollHeight}/${block.clientHeight})`
  );
  assert.ok(
    block.scrollWidth <= block.clientWidth + 1,
    `${message}: long text must wrap instead of clipping horizontally (${block.scrollWidth}/${block.clientWidth})`
  );
}

async function assertFullPopoverContent(page, issue, message, { layout } = {}) {
  const fact = await shadowFact(page);
  assert.ok(fact.popover, `${message}: popover must be visible`);
  const expected = boundedIssueText(issue);
  assert.equal(fact.popover.severity, expected.severity, `${message}: severity safety bound`);
  assert.equal(fact.popover.code, expected.code, `${message}: code safety bound`);
  assert.equal(fact.popover.title, expected.title, `${message}: title safety bound`);
  assert.equal(fact.popover.message, expected.message, `${message}: message safety bound`);
  assert.equal(fact.popover.path, expected.path, `${message}: path safety bound`);
  assertUnclampedBlock(fact.popover.blocks.title, expected.title, `${message} title`);
  assertUnclampedBlock(fact.popover.blocks.message, expected.message, `${message} message`);
  assertUnclampedBlock(fact.popover.blocks.path, expected.path, `${message} path`);
  for (const [name, block] of Object.entries(fact.popover.blocks)) {
    assert.equal(
      block.finalCharacterVisible,
      true,
      `${message}: ${name} final character must be visible immediately; geometry=${JSON.stringify({
        popover: fact.popover.rect,
        block
      })}`
    );
  }
  assert.ok(
    !["auto", "scroll", "hidden", "clip"].includes(fact.popover.overflowX),
    `${message}: horizontal overflow may not scroll or clip`
  );
  assert.ok(
    !["auto", "scroll", "hidden", "clip"].includes(fact.popover.overflowY),
    `${message}: vertical overflow may not scroll or clip`
  );
  assert.equal(fact.popover.maxHeight, "none", `${message}: natural height must not be capped`);
  assert.ok(
    fact.popover.scrollHeight <= fact.popover.clientHeight + 1,
    `${message}: displayed content must have no vertical scroll range (${fact.popover.scrollHeight}/${fact.popover.clientHeight})`
  );
  assert.ok(
    fact.popover.scrollWidth <= fact.popover.clientWidth + 1,
    `${message}: displayed content must have no horizontal scroll range (${fact.popover.scrollWidth}/${fact.popover.clientWidth})`
  );
  assert.equal(fact.popover.scrollTop, 0, `${message}: displayed card must never scroll internally`);
  assert.equal(fact.popover.maxScrollTop, 0, `${message}: displayed card has no maximum scroll offset`);
  assert.notEqual(fact.popover.scrollable, "true", `${message}: legacy scrollable state must be absent`);
  assert.equal(fact.scrollIndicatorCount, 0, `${message}: custom scroll indicator must not exist`);
  assert.equal(fact.scrollIndicator, null, `${message}: custom scroll indicator state must be absent`);
  assert.equal(fact.popover.role, "tooltip", `${message}: non-interactive details use tooltip semantics`);
  assert.equal(fact.popover.tabIndex, -1, `${message}: tooltip must not become a separate tab stop`);
  assert.equal(fact.popover.focused, false, `${message}: tooltip never steals marker focus`);
  assert.equal(fact.popover.focusableCount, 0, `${message}: tooltip has no focusable descendants`);
  assert.ok(
    fact.popover.visibleContentBottom <= fact.popover.clientBottom + 1,
    `${message}: natural card must contain every visible content block`
  );
  if (layout) {
    assert.equal(
      fact.popover.layout,
      layout,
      `${message}: expected ${layout} layout; geometry=${JSON.stringify({
        density: fact.popover.density,
        layout: fact.popover.layout,
        rect: fact.popover.rect
      })}`
    );
  }
  return fact;
}

async function movePointerFromMarkerToPopover(page, issueId) {
  const before = await waitForVisiblePopover(page, issueId);
  const { rect } = before.popover;
  await page.mouse.move(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 48));
  await page.waitForTimeout(80);
  const after = await waitForVisiblePopover(page, issueId);
  assert.equal(after.popover.pointerEvents, "auto", "popover must accept pointer and wheel input");
  return after;
}

const sanitizerSource = await readFile(sanitizerPath, "utf8");
const bridgeStyle = extractJavaTextBlock(sanitizerSource, "BRIDGE_STYLE");
let bridgeScript = extractBridgeScript(sanitizerSource);
const MARKER_SIZE = extractBridgeNumber(bridgeScript, "MARKER_SIZE");
assert.equal(MARKER_SIZE, 24, "the compact replay marker contract is 24px");
for (const pattern of [
  /className\s*=\s*'issue-popover'/,
  /issue-popover__severity/,
  /issue-popover__code/,
  /issue-popover__title/,
  /issue-popover__message/,
  /issue-popover__path/,
  /\.issue-popover \{[^}]*pointer-events:auto/,
  /button\.addEventListener\('pointerenter'/,
  /button\.addEventListener\('pointerleave'/,
  /button\.addEventListener\('pointercancel'/,
  /button\.addEventListener\('blur'/,
  /placement: 'right'/,
  /placement: 'left'/,
  /placement: 'bottom'/,
  /placement: 'top'/,
  /POPOVER_PREFERRED_MAX_MARKER_DISTANCE = 48/,
  /POPOVER_MAX_MARKER_DISTANCE = MARKER_SLOT_STEP \+ POPOVER_GAP/,
  /candidate\.markerDistance <= POPOVER_PREFERRED_MAX_MARKER_DISTANCE/,
  /fallback: candidates\[0\] \|\| null/,
  /if \(fallbackLayout\)/,
  /placeIssuePopoverCandidate\(fallbackLayout\.selected\)/,
  /const POPOVER_DENSITIES = \['normal', 'compact', 'minimal'\]/,
  /const POPOVER_WIDE_WIDTHS = \[840, 760, 680, 600, 560\]/,
  /const POPOVER_MAX_LAYOUT_CANDIDATES = POPOVER_DENSITIES\.length \+ POPOVER_WIDE_WIDTHS\.length/,
  /layoutCandidateCount >= POPOVER_MAX_LAYOUT_CANDIDATES/,
  /dataset\.layout = 'wide'/,
  /setAttribute\('role', 'tooltip'\)/,
  /post\(\{ type: 'ISSUE_DETAIL_FALLBACK', issueId: nextIssueId \}\)/,
  /if \(issueDetailFallbackId === nextIssueId\) return/,
  /dataset\.presentation = 'external-description'/,
  /postIssueDetailFallback\(entry\.issue\.id\)/,
  /clearIssueDetailFallback\(\)/,
  /\.issue-popover\[data-presentation='external-description'\][^}]*clip-path:inset\(50%\)/,
  /SET_MARKERS_VISIBLE/
]) {
  assert.match(bridgeScript, pattern, `bridge contract missing ${pattern}`);
}
assert.doesNotMatch(
  bridgeScript,
  /issue-popover__(?:title|message|path)[^{}]*\{[^}]*-webkit-line-clamp/,
  "popover content blocks must never hide text with CSS line-clamp"
);
assert.doesNotMatch(
  bridgeScript,
  /issue-popover-scroll-indicator|data-scrollable/,
  "no-scroll popovers must not retain the legacy scroll state or custom indicator"
);
assert.doesNotMatch(
  bridgeScript,
  /issuePopover\.(?:tabIndex|scrollTop)|issuePopover\.setAttribute\(['"]tabindex/i,
  "tooltip details must not become an independently focusable scroll owner"
);
assert.doesNotMatch(
  bridgeScript,
  /ISSUE_DETAIL_FALLBACK[^\n]*(?:title|message|path|severity|code)/,
  "the bridge fallback message must carry only the trusted issue id"
);
assert.doesNotMatch(
  bridgeScript,
  /\.issue-popover\s*\{[^}]*?(?:max-height|overflow-y\s*:\s*(?:auto|scroll|hidden|clip))/,
  "the popover root must use its natural height without internal scrolling or clipping"
);
const densityCandidates = bridgeScript.match(/const POPOVER_DENSITIES = \[([^\]]+)\]/)?.[1]
  .split(",").map((value) => value.trim()).filter(Boolean) ?? [];
const wideCandidates = bridgeScript.match(/const POPOVER_WIDE_WIDTHS = \[([^\]]+)\]/)?.[1]
  .split(",").map((value) => Number.parseInt(value.trim(), 10)).filter(Number.isFinite) ?? [];
const bridgeMarkerSlotStep = Number.parseInt(
  bridgeScript.match(/const MARKER_SLOT_STEP = (\d+);/)?.[1] ?? "",
  10
);
const bridgePopoverGap = Number.parseInt(
  bridgeScript.match(/const POPOVER_GAP = (\d+);/)?.[1] ?? "",
  10
);
const bridgePreferredMaxMarkerDistance = Number.parseInt(
  bridgeScript.match(/const POPOVER_PREFERRED_MAX_MARKER_DISTANCE = (\d+);/)?.[1] ?? "",
  10
);
assert.equal(bridgeMarkerSlotStep, 40, "marker collision slots must retain their captured 40px step");
assert.equal(bridgePopoverGap, 12, "popover adjacency must retain its 12px base gap");
assert.equal(
  bridgePreferredMaxMarkerDistance,
  48,
  "ordinary placements must continue preferring the original 48px distance"
);
assert.equal(
  bridgeMarkerSlotStep + bridgePopoverGap,
  MAX_ADJACENT_GAP,
  "the fallback distance must be exactly one marker slot plus the popover gap"
);
assert.equal(MAX_ADJACENT_GAP, 52, "the marker-distance fallback contract must remain 52px");
assert.equal(densityCandidates.length, 3, "natural vertical placement must try exactly three density candidates");
assert.deepEqual(wideCandidates, [840, 760, 680, 600, 560], "wide layout widths must stay curated and bounded");
assert.equal(densityCandidates.length + wideCandidates.length, 8, "one placement pass may measure at most eight layouts");
assert.ok(
  bridgeScript.indexOf("for (const density of POPOVER_DENSITIES)")
    < bridgeScript.indexOf("for (const width of POPOVER_WIDE_WIDTHS)"),
  "natural-height vertical candidates must be exhausted before adaptive wide fallback"
);
bridgeScript = bridgeScript.replace(
  "host.attachShadow({ mode: 'closed' })",
  "host.attachShadow({ mode: 'open' })"
);

const hostileTitle = '<img src=x onerror="window.__popoverXss=1">텍스트 난이도 개선 필요';
const hostileMessage = '<script>window.__popoverXss=2</script> 건축학부 졸업 전시회에 포함된 긴 한국어 설명입니다.';
const hostilePath = '<svg onload="window.__popoverXss=3"></svg> section#cms-content > div:nth-of-type(1) > p';
const longKorean = "접근성 문제를 설명하는 매우 긴 한국어 문장입니다. ".repeat(50);
const longPath = `section#cms-content > ${"div:nth-of-type(1) > ".repeat(120)}p:nth-of-type(1)`;

const issues = [
  {
    id: 101,
    severity: "LOW",
    severityLabel: "낮음",
    code: "TEXT_DIFFICULTY",
    title: "왼쪽 후보 배치",
    message: "오른쪽의 문제 요소를 가리지 않고 마커 왼쪽에 표시합니다. ".repeat(4),
    path: "#left-candidate",
    pathSteps: [{ context: "DOCUMENT", selector: "#left-candidate" }]
  },
  {
    id: 102,
    severity: "HIGH",
    severityLabel: "높음",
    code: "LINK_NAME",
    title: "오른쪽 후보 배치",
    message: "RTL 요소의 오른쪽 마커 옆에 표시합니다. ".repeat(4),
    path: "#right-candidate",
    pathSteps: [{ context: "DOCUMENT", selector: "#right-candidate" }]
  },
  {
    id: 103,
    severity: "MEDIUM",
    severityLabel: "보통",
    code: "TOP_EDGE",
    title: "아래쪽 후보 배치",
    message: "상단의 넓은 요소 아래쪽에서 안전한 공간을 찾습니다.",
    path: "#wide-top",
    pathSteps: [{ context: "DOCUMENT", selector: "#wide-top" }]
  },
  {
    id: 104,
    severity: "CRITICAL",
    severityLabel: "심각",
    code: "BOTTOM_EDGE",
    title: "위쪽 후보 배치",
    message: "하단의 넓은 요소 위쪽에서 안전한 공간을 찾습니다.",
    path: "#wide-bottom",
    pathSteps: [{ context: "DOCUMENT", selector: "#wide-bottom" }]
  },
  {
    id: 105,
    severity: "LOW",
    severityLabel: "낮음",
    code: "HTML_ESCAPE",
    title: hostileTitle,
    message: hostileMessage,
    path: hostilePath,
    pathSteps: [{ context: "DOCUMENT", selector: "#multiline-target" }]
  },
  {
    id: 106,
    severity: "LOW".repeat(20),
    severityLabel: "낮음".repeat(30),
    code: "LONG_CODE_".repeat(30),
    title: "긴 한국어 팝오버의 줄바꿈과 좁은 화면 배치를 검사합니다. ".repeat(10),
    message: longKorean,
    path: longPath,
    pathSteps: [{ context: "DOCUMENT", selector: "#narrow-target" }]
  },
  {
    id: 107,
    severity: "MEDIUM",
    severityLabel: "보통",
    code: "NESTED_SCROLL",
    title: "중첩 스크롤 위치 추적",
    message: "중첩 스크롤러가 이동하면 팝오버도 다시 배치됩니다.",
    path: "#nested-target",
    pathSteps: [{ context: "DOCUMENT", selector: "#nested-target" }]
  },
  {
    id: 108,
    severity: "HIGH",
    severityLabel: "높음",
    code: "INACTIVE_SLIDE",
    title: "비활성 슬라이드",
    message: "숨겨진 슬라이드에는 팝오버를 표시하지 않습니다.",
    path: "#inactive-target",
    pathSteps: [{ context: "DOCUMENT", selector: "#inactive-target" }]
  },
  {
    id: 109,
    severity: "LOW",
    severityLabel: "낮음",
    code: "OFF_CANVAS",
    title: "화면 밖 요소",
    message: "화면 밖 요소에는 팝오버를 표시하지 않습니다.",
    path: "#offcanvas-target",
    pathSteps: [{ context: "DOCUMENT", selector: "#offcanvas-target" }]
  }
];

const impossibleIssue = {
  id: 110,
  severity: "HIGH",
  severityLabel: "높음",
  code: "NO_SAFE_SPACE",
  title: "안전한 인접 공간 없음",
  message: "마커에 인접한 모든 후보가 문제 요소와 겹치므로 팝오버를 표시하지 않습니다.",
  path: "#impossible-target",
  pathSteps: [{ context: "DOCUMENT", selector: "#impossible-target" }]
};

const transformedClipIssue = {
  id: 111,
  severity: "MEDIUM",
  severityLabel: "보통",
  code: "TRANSFORMED_CLIP",
  title: "변형된 중첩 스크롤 경계",
  message: "scale 변형과 overflow 경계 안에서만 마커와 팝오버가 표시됩니다.",
  path: "#transformed-target",
  pathSteps: [{ context: "DOCUMENT", selector: "#transformed-target" }]
};

const artifactBottomIssue = {
  id: 2,
  severity: "LOW",
  severityLabel: "낮음",
  code: "TEXT_DIFFICULTY",
  title: "텍스트 난이도 개선 필요",
  message: "text=건축학부의 제70회 졸업 전시회가 지난 6월 22일부터 27일까지 본교 서울캠퍼스에서 개최되었다.\nflags=[\"어려운 어휘 과다: 쉬운 단어 비율 50.0% (어려운 단어 50.0%, C등급+미등재 기준)\"]",
  path: "section#cms-content > div:nth-of-type(1) > div > div > div:nth-of-type(1) > div:nth-of-type(1) > div > p:nth-of-type(2)",
  pathSteps: [{ context: "DOCUMENT", selector: "#artifact-bottom-target" }]
};

const artifactBottomObstacleIssues = [
  {
    id: 3,
    severity: "LOW",
    severityLabel: "낮음",
    code: "OBSTACLE_THREE",
    title: "인접 마커 3",
    message: "실제 페이지의 인접 마커를 재현합니다.",
    path: "#artifact-bottom-obstacle-3",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-bottom-obstacle-3" }]
  },
  {
    id: 98,
    severity: "LOW",
    severityLabel: "낮음",
    code: "OBSTACLE_NINETY_EIGHT",
    title: "인접 마커 98",
    message: "실제 페이지의 두 번째 인접 마커를 재현합니다.",
    path: "#artifact-bottom-obstacle-98",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-bottom-obstacle-98" }]
  }
];

const artifactBottomDenseIssues = Array.from({ length: 98 }, (_, index) => {
  const markerNumber = index + 1;
  if (markerNumber === 2) return artifactBottomIssue;
  if (markerNumber === 3) return artifactBottomObstacleIssues[0];
  if (markerNumber === 98) return artifactBottomObstacleIssues[1];
  return {
    id: 10_000 + markerNumber,
    severity: "LOW",
    severityLabel: "낮음",
    code: "UNRESOLVED_FIXTURE",
    title: `해당 페이지 밖 이슈 ${markerNumber}`,
    message: "현재 재현 화면에는 없는 이슈입니다.",
    path: `#artifact-bottom-unresolved-${markerNumber}`,
    pathSteps: [{ context: "DOCUMENT", selector: `#artifact-bottom-unresolved-${markerNumber}` }]
  };
});

const artifactSlideTwoIssue = {
  id: 2323,
  severity: "LOW",
  severityLabel: "낮음",
  code: "TEXT_DIFFICULTY",
  title: "텍스트 난이도 개선 필요",
  message: "text=세계적인 디자인 공모전인 2026 Red Dot Design Award에서 본교 산업디자인과 학우들이 우수한 성과를 거두며 글로벌 디자인 경쟁력을 입증했다. 바로가기\nflags=[\"form_guide 텍스트 길이 과다: 92글자 (기준: 50글자)\"]",
  path: "section#cms-content > div:nth-of-type(1) > div > div > div:nth-of-type(1) > div:nth-of-type(2) > div > p:nth-of-type(2) > a",
  pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-description-link" }]
};

const artifactSlideTwoResolvedIssues = new Map([
  [4, {
    id: 40_004,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_TITLE_BLOCK",
    title: "슬라이드 2 제목 블록",
    message: "마커 4의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-title-block",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-title-block" }]
  }],
  [5, {
    id: 40_005,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_TITLE_LINK",
    title: "슬라이드 2 제목 링크",
    message: "마커 5의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-title-link",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-title-link" }]
  }],
  [6, {
    id: 40_006,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_DESCRIPTION_BLOCK",
    title: "슬라이드 2 설명 블록",
    message: "마커 6의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-description-block",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-description-block" }]
  }],
  [7, {
    id: 40_007,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_DESCRIPTION_LINK",
    title: "슬라이드 2 설명 링크",
    message: "마커 7이 마커 100과 같은 복수 줄 대상을 공유합니다.",
    path: "#artifact-slide-two-description-link",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-description-link" }]
  }],
  [34, {
    id: 40_034,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_LOWER_LEFT",
    title: "하단 왼쪽 마커",
    message: "마커 34의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-lower-left",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-lower-left" }]
  }],
  [62, {
    id: 40_062,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_LOWER_CENTER",
    title: "하단 중앙 마커",
    message: "마커 62의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-lower-center",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-lower-center" }]
  }],
  [81, {
    id: 40_081,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_LOWER_RIGHT",
    title: "하단 오른쪽 마커",
    message: "마커 81의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-lower-right",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-lower-right" }]
  }],
  [99, {
    id: 40_099,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_IMAGE_LINK",
    title: "슬라이드 2 이미지 링크",
    message: "마커 99가 마커 100 팝오버의 하단 경계를 재현합니다.",
    path: "#artifact-slide-two-image-link",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-image-link" }]
  }],
  [100, artifactSlideTwoIssue],
  [109, {
    id: 40_109,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_LOWER_LEFT_DUPLICATE",
    title: "하단 왼쪽 두 번째 마커",
    message: "마커 109의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-lower-left",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-lower-left" }]
  }],
  [117, {
    id: 40_117,
    severity: "LOW",
    severityLabel: "낮음",
    code: "SLIDE_TWO_LOWER_RIGHT_DUPLICATE",
    title: "하단 오른쪽 두 번째 마커",
    message: "마커 117의 실제 화면 위치를 재현합니다.",
    path: "#artifact-slide-two-lower-right",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-slide-two-lower-right" }]
  }]
]);

const artifactSlideTwoDenseIssues = Array.from({ length: 117 }, (_, index) => {
  const markerNumber = index + 1;
  return artifactSlideTwoResolvedIssues.get(markerNumber) ?? {
    id: 40_000 + markerNumber,
    severity: "LOW",
    severityLabel: "낮음",
    code: "UNRESOLVED_SLIDE_TWO_FIXTURE",
    title: `현재 슬라이드 밖 이슈 ${markerNumber}`,
    message: "슬라이드 2 경계 재현에서는 표시되지 않는 이슈입니다.",
    path: `#artifact-slide-two-unresolved-${markerNumber}`,
    pathSteps: [{ context: "DOCUMENT", selector: `#artifact-slide-two-unresolved-${markerNumber}` }]
  };
});

const artifactTopIssue = {
  id: 34,
  severity: "LOW",
  severityLabel: "낮음",
  code: "TEXT_DIFFICULTY",
  title: "텍스트 난이도 개선 필요",
  message: "text=몽골의 푸른 하늘 아래 피어난 희망… 본교 세종캠퍼스 '몽땅' 봉사단, 하계 봉사활동 성료 본교 세종캠퍼스 몽골 국제사회봉사단 ‘몽땅’이 몽골 현지에서 따뜻한 나눔과 교류의 결실을 맺었다. 일반 2026.08.10\nflags=[\"link 텍스트 길이 과다: 119글자 (기준: 30글자)\",\"위치 참조: \\\"아래(의)\\\" 사용\"]",
  path: "section#cms-content > div:nth-of-type(2) > div > div:nth-of-type(1) > div:nth-of-type(1) > ul > li:nth-of-type(1) > a",
  pathSteps: [{ context: "DOCUMENT", selector: "#artifact-top-target" }]
};

const artifactTopObstacleIssues = new Map([
  [3, {
    id: 30_003,
    severity: "LOW",
    severityLabel: "낮음",
    code: "TOP_OBSTACLE_THREE",
    title: "상단 인접 마커 3",
    message: "실제 페이지의 상단 인접 마커를 재현합니다.",
    path: "#artifact-top-obstacle-3",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-top-obstacle-3" }]
  }],
  [98, {
    id: 30_098,
    severity: "LOW",
    severityLabel: "낮음",
    code: "TOP_OBSTACLE_NINETY_EIGHT",
    title: "상단 인접 마커 98",
    message: "실제 페이지의 98번째 상단 인접 마커를 재현합니다.",
    path: "#artifact-top-obstacle-98",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-top-obstacle-98" }]
  }],
  [109, {
    id: 30_109,
    severity: "LOW",
    severityLabel: "낮음",
    code: "TOP_OBSTACLE_ONE_HUNDRED_NINE",
    title: "하단 인접 마커 109",
    message: "거대한 이미지 대상 아래의 인접 마커를 재현합니다.",
    path: "#artifact-top-obstacle-109",
    pathSteps: [{ context: "DOCUMENT", selector: "#artifact-top-obstacle-109" }]
  }]
]);

const artifactTopDenseIssues = Array.from({ length: 109 }, (_, index) => {
  const markerNumber = index + 1;
  if (markerNumber === 34) return artifactTopIssue;
  if (artifactTopObstacleIssues.has(markerNumber)) return artifactTopObstacleIssues.get(markerNumber);
  return {
    id: 20_000 + markerNumber,
    severity: "LOW",
    severityLabel: "낮음",
    code: "UNRESOLVED_TOP_FIXTURE",
    title: `해당 페이지 밖 이슈 ${markerNumber}`,
    message: "현재 재현 화면에서는 없는 이슈입니다.",
    path: `#artifact-top-unresolved-${markerNumber}`,
    pathSteps: [{ context: "DOCUMENT", selector: `#artifact-top-unresolved-${markerNumber}` }]
  };
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.setContent(`<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; width: 100%; min-height: 1500px; }
          body { font-family: system-ui, sans-serif; background: #eef2f6; }
          .target { position: absolute; display: block; padding: 12px; border: 1px solid #334155; background: #fff; }
          #left-candidate { left: 620px; top: 30px; width: 120px; height: 590px; }
          #right-candidate { left: 80px; top: 30px; width: 120px; height: 590px; direction: rtl; }
          #wide-top { left: 30px; top: 8px; width: 840px; height: 60px; }
          #wide-bottom { left: 30px; top: 570px; width: 840px; height: 60px; }
          #multiline-wrap { position: absolute; left: 700px; top: 450px; width: 180px; font-size: 18px; line-height: 28px; }
          #multiline-target { background: #fff7ed; }
          #narrow-target { position: absolute; left: 118px; top: 92px; width: 84px; height: 54px; }
          .narrow-mode #narrow-target { left: 12px; top: 30px; width: 296px; height: 54px; }
          .narrow-mode #left-candidate,
          .narrow-mode #right-candidate,
          .narrow-mode #wide-top,
          .narrow-mode #wide-bottom,
          .narrow-mode #multiline-wrap,
          .narrow-mode #nested-scroll,
          .narrow-mode #transformed-clip,
          .narrow-mode #impossible-target { display: none; }
          #nested-scroll { position: absolute; left: 180px; top: 850px; width: 520px; height: 240px; overflow: auto; border: 2px solid #94a3b8; background: #fff; }
          #nested-content { position: relative; width: 760px; height: 700px; }
          #nested-target { left: 360px; top: 250px; width: 150px; height: 70px; }
          #transformed-clip { position: absolute; left: 600px; top: 850px; width: 300px; height: 200px; overflow: hidden; border: 2px solid #475569; transform: scale(.5); transform-origin: top left; background: #fff; }
          #transformed-content { position: relative; width: 700px; height: 700px; }
          #transformed-target { left: 360px; top: 250px; width: 150px; height: 70px; }
          #inactive-slide { display: none; }
          #inactive-target { left: 420px; top: 300px; width: 120px; height: 60px; }
          #offcanvas-target { left: -4000px; top: 200px; width: 100px; height: 60px; }
          #impossible-target { position: absolute; left: 12px; top: 60px; width: 876px; height: 570px; }
          #focus-anchor { position: fixed; right: 12px; bottom: 12px; width: 120px; height: 44px; }
          #__uni_accessibility_replay_host::before,
          #__uni_accessibility_replay_host::after { content: "hostile"; display: block; position: fixed; inset: 0; pointer-events: auto; z-index: 2147483647; }
        </style>
      </head>
      <body>
        <div id="wide-top" class="target">상단 전체 너비 대상</div>
        <div id="left-candidate" class="target">왼쪽 팝오버 후보</div>
        <div id="right-candidate" class="target" dir="rtl">오른쪽 팝오버 후보</div>
        <p id="multiline-wrap"><a id="multiline-target" href="#fixture">여러 줄에 걸쳐 표시되는 접근성 문제 요소입니다</a></p>
        <div id="wide-bottom" class="target">하단 전체 너비 대상</div>
        <div id="narrow-target" class="target">좁은 화면</div>
        <div id="nested-scroll">
          <div id="nested-content"><div id="nested-target" class="target">중첩 스크롤 대상</div></div>
        </div>
        <div id="transformed-clip">
          <div id="transformed-content"><div id="transformed-target" class="target">변형된 클립 대상</div></div>
        </div>
        <section id="inactive-slide"><div id="inactive-target" class="target">비활성 슬라이드</div></section>
        <div id="offcanvas-target" class="target">화면 밖 대상</div>
        <div id="impossible-target" class="target">팝오버를 위한 안전한 인접 공간이 없는 대상</div>
        <button id="focus-anchor" type="button">포커스 기준</button>
      </body>
    </html>`);

  const originalTargets = await page.evaluate(() => {
    const selectors = [
      "#left-candidate",
      "#right-candidate",
      "#wide-top",
      "#wide-bottom",
      "#multiline-target",
      "#narrow-target",
      "#nested-target",
      "#transformed-target",
      "#inactive-target",
      "#offcanvas-target"
      ,"#impossible-target"
    ];
    return Object.fromEntries(selectors.map((selector) => [selector, document.querySelector(selector).outerHTML]));
  });

  await page.evaluate(() => {
    window.__popoverOutbound = [];
    window.addEventListener("message", (event) => {
      if (event.data?.source === "accessibility-page-replay") {
        window.__popoverOutbound.push(JSON.parse(JSON.stringify(event.data)));
      }
    });
  });
  await page.addStyleTag({ content: bridgeStyle });
  await page.addScriptTag({ content: bridgeScript });
  await page.waitForFunction(() =>
    (window.__popoverOutbound ?? []).some((message) => message.type === "READY")
  );
  const hostilePseudoState = await page.evaluate(() => {
    const host = document.getElementById("__uni_accessibility_replay_host");
    const fact = (pseudo) => {
      const style = getComputedStyle(host, pseudo);
      return { content: style.content, display: style.display, pointerEvents: style.pointerEvents };
    };
    return { before: fact("::before"), after: fact("::after") };
  });
  for (const [pseudo, state] of Object.entries(hostilePseudoState)) {
    assert.equal(state.content, "none", `${pseudo} hostile generated content must be neutralized`);
    assert.equal(state.display, "none", `${pseudo} hostile overlay must not render`);
    assert.equal(state.pointerEvents, "none", `${pseudo} hostile overlay must not intercept input`);
  }
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: 101,
    issues
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker").length === 9;
  });
  await page.waitForTimeout(80);

  const initial = await shadowFact(page);
  assert.equal(initial.visiblePopoverCount, 0, "INIT selectedIssueId must not display a hover popover");
  assert.equal(initial.popoverCount, 1, "the bridge must own one reusable popover node");
  assert.equal(initial.markers[0].pressed, "true", "INIT may retain selection without opening the popover");
  assert.equal(initial.markers[7].hidden, true, "inactive slide marker must be hidden");
  assert.equal(initial.markers[8].hidden, true, "off-canvas marker must be hidden");
  const initialLocatorCount = initial.outbound.filter((message) => message.type === "LOCATOR_STATUS").length;
  assert.equal(initialLocatorCount, 9, "each fixture issue must resolve exactly once");
  await sendCommand(page, { type: "FOCUS_ISSUE", issueId: 102 });
  await page.waitForTimeout(50);
  assert.equal((await shadowFact(page)).visiblePopoverCount, 0, "external FOCUS_ISSUE must not open the hover popover");
  await sendCommand(page, { type: "FOCUS_ISSUE", issueId: null });
  await page.waitForTimeout(50);
  assert.equal((await shadowFact(page)).visiblePopoverCount, 0, "external focus clear must keep the popover closed");

  const expectedSides = ["left", "right", "bottom", "top"];
  const targetSelectors = ["#left-candidate", "#right-candidate", "#wide-top", "#wide-bottom"];
  const observedSides = [];
  const edgeFacts = [];
  for (let index = 0; index < expectedSides.length; index += 1) {
    await sendCommand(page, {
      type: "INIT_ISSUES",
      markersVisible: true,
      selectedIssueId: null,
      issues: [issues[index]]
    });
    await page.waitForFunction(() =>
      document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 1
    );
    await hoverMarker(page, 0);
    const placement = await assertSafePopover(
      page,
      issues[index].id,
      0,
      targetSelectors[index],
      `${expectedSides[index]} candidate`
    );
    assert.ok(expectedSides.includes(placement.side), `${expectedSides[index]} scenario must choose a declared placement`);
    observedSides.push(placement.side);
    edgeFacts.push({
      expected: expectedSides[index],
      observed: placement.side,
      popover: placement.fact.popover.rect,
      marker: placement.fact.markers[0].rect,
      target: placement.targetRects
    });
    assert.equal(placement.fact.popover.ariaHidden, "false", "visible details must be exposed to assistive technology");
    assert.equal(placement.fact.popover.role, "tooltip", "non-interactive details need tooltip semantics");
    assert.equal(placement.fact.popover.tabIndex, -1, "tooltip details must not add a tab stop");
    assert.equal(placement.fact.popover.pointerEvents, "auto", "popover must accept pointer lifetime input");
    assert.equal(placement.fact.popover.focusableCount, 0, "popover must not add unrelated focusable descendants");
    assert.equal(
      placement.fact.markers[0].ariaDescribedBy,
      placement.fact.popover.id,
      "active marker must describe itself with the visible details region"
    );
    await assertFullPopoverContent(page, issues[index], `${expectedSides[index]} candidate content`, {
      layout: "vertical"
    });
    await page.mouse.move(890, 340);
    await waitForClearedPopover(page);
  }
  assert.ok(observedSides.includes("bottom"), `edge scenarios must execute a bottom placement: ${JSON.stringify(edgeFacts)}`);

  await page.setViewportSize({ width: 768, height: 620 });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [impossibleIssue]
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 1
  );
  await hoverMarker(page, 0);
  const impossibleState = await waitForExternalDescription(
    page,
    impossibleIssue,
    0,
    "768px no-safe-space geometry"
  );
  assert.ok(impossibleState.selectionFragmentCount > 0, "external fallback must retain target highlighting");
  assert.ok(impossibleState.markers[0].ariaLabel.includes(impossibleIssue.severityLabel));
  assert.ok(impossibleState.markers[0].ariaLabel.includes(`KWCAG ${impossibleIssue.code}`));
  assert.ok(impossibleState.markers[0].ariaLabel.includes(impossibleIssue.title));
  assert.equal(impossibleState.markers[0].ariaLabel.includes(impossibleIssue.message), false);
  assert.equal(impossibleState.markers[0].ariaLabel.includes(impossibleIssue.path), false);
  const impossibleFallbackCount = impossibleState.outbound.filter(
    (message) => message.type === "ISSUE_DETAIL_FALLBACK" && message.issueId === impossibleIssue.id
  ).length;
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(80);
  assert.equal(
    (await shadowFact(page)).outbound.filter(
      (message) => message.type === "ISSUE_DETAIL_FALLBACK" && message.issueId === impossibleIssue.id
    ).length,
    impossibleFallbackCount,
    "reposition passes must deduplicate the external fallback message"
  );
  await page.mouse.move(760, 10);
  await waitForExternalDescriptionCleared(page, "768px pointer leave");
  await page.setViewportSize({ width: 900, height: 650 });

  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 9
  );

  await hoverMarker(page, 0);
  const densePlacement = await assertSafePopover(page, 101, 0, "#left-candidate", "dense marker placement");
  assert.ok(densePlacement.fact.markers.length >= 7, "dense fixture must include multiple visible marker obstacles");
  await page.mouse.move(890, 340);
  await waitForClearedPopover(page);

  await hoverMarker(page, 4);
  const multiline = await assertSafePopover(page, 105, 4, "#multiline-target", "multiline hostile content");
  assert.ok(multiline.targetRects.length >= 2, "multiline fixture must expose multiple target rectangles");
  assert.equal(multiline.fact.popover.severity, "낮음");
  assert.equal(multiline.fact.popover.code, "KWCAG HTML_ESCAPE");
  assert.equal(multiline.fact.popover.title, hostileTitle);
  assert.equal(multiline.fact.popover.message, hostileMessage);
  assert.equal(multiline.fact.popover.path, hostilePath);
  await assertFullPopoverContent(page, issues[4], "multiline hostile content");
  assert.equal(multiline.fact.popover.injectedElementCount, 0, "issue content must be inserted as text, never HTML");
  assert.equal(multiline.fact.xssFlag, null, "hostile issue text must not execute script or event attributes");

  const beforeQuickMessages = multiline.fact.outbound.filter((message) => message.type === "ISSUE_SELECTED").length;
  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
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
  const quick = await waitForVisiblePopover(page, 102);
  assert.deepEqual(
    quick.outbound
      .filter((message) => message.type === "ISSUE_SELECTED")
      .slice(-2)
      .map((message) => message.issueId),
    [101, 102],
    "quick A to B hover must not emit an intervening null"
  );
  assert.ok(
    quick.outbound.filter((message) => message.type === "ISSUE_SELECTED").length >= beforeQuickMessages + 2,
    "quick transition must notify both marker previews"
  );

  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
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
  const staleLeave = await waitForVisiblePopover(page, 102);
  assert.equal(staleLeave.markers[1].pressed, "true", "stale A leave must not clear B");

  const markerB = await markerLocator(page, 1);
  await markerB.dispatchEvent("pointercancel", { pointerType: "mouse", isPrimary: true });
  await waitForClearedPopover(page);
  const afterCancel = await shadowFact(page);
  assert.equal(afterCancel.selectionFragmentCount, 0, "pointercancel must clear the target highlight");
  assert.ok(afterCancel.markers.every((marker) => marker.pressed === "false"), "pointercancel must clear marker state");

  const markerA = await markerLocator(page, 0);
  await markerA.dispatchEvent("pointerenter", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(40);
  assert.equal((await shadowFact(page)).visiblePopoverCount, 0, "touch boundaries must not behave as hover");
  await markerA.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await markerA.dispatchEvent("click", { pointerType: "touch", isPrimary: true });
  await waitForVisiblePopover(page, 101);
  await markerA.dispatchEvent("pointerleave", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(40);
  assert.equal((await shadowFact(page)).popover?.issueId, "101", "touch leave must not clear a tapped selection");
  await page.locator("#focus-anchor").dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await waitForClearedPopover(page);

  await sendCommand(page, { type: "SET_MARKERS_VISIBLE", markersVisible: false });
  await waitForClearedPopover(page);
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return [...(root?.querySelectorAll(".marker") ?? [])].every((marker) => marker.hidden);
  });
  let hiddenState = await shadowFact(page);
  assert.ok(hiddenState.markers.every((marker) => marker.hidden), "marker toggle must hide every marker");
  assert.equal(hiddenState.selectionFragmentCount, 0, "marker toggle must clear target highlighting");
  await sendCommand(page, { type: "SET_MARKERS_VISIBLE", markersVisible: true });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return [...(root?.querySelectorAll(".marker") ?? [])].slice(0, 7).some((marker) => !marker.hidden);
  });

  await page.mouse.move(4, 4);
  await page.keyboard.press("Tab");
  await markerA.focus();
  await waitForVisiblePopover(page, 101);
  await page.locator("#focus-anchor").focus();
  await page.waitForTimeout(100);
  const keyboardBlurDebug = await shadowFact(page);
  assert.equal(
    keyboardBlurDebug.visiblePopoverCount,
    0,
    `keyboard blur must close the popover: ${JSON.stringify(keyboardBlurDebug)}`
  );
  hiddenState = await shadowFact(page);
  assert.equal(hiddenState.selectionFragmentCount, 0, "keyboard blur must clear the target highlight");

  await page.mouse.click(850, 620);
  const keyboardMarker = await markerLocator(page, 1);
  await keyboardMarker.evaluate((marker) => marker.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  await waitForVisiblePopover(page, 102);
  let keyboardOpenState = await assertFullPopoverContent(page, issues[1], "Enter marker preview");
  assert.equal(keyboardOpenState.shadowActiveClass, "marker", "Enter must keep focus on the originating marker");
  const escapeBefore = await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }));
  await page.keyboard.press("Escape");
  let escapeState = await waitForClearedPopover(page);
  await page.waitForTimeout(100);
  escapeState = await shadowFact(page);
  assert.equal(escapeState.visiblePopoverCount, 0, "Escape marker focus restoration must not reopen the popover");
  assert.equal(escapeState.shadowActiveClass, "marker", "Escape must restore focus to the originating marker");
  assert.equal(escapeState.shadowActiveText, "2", "Escape must restore the matching marker, not an adjacent marker");
  assert.equal(escapeState.markers[1].pressed, "false", "Escape must clear marker selection state");
  assert.equal(escapeState.markers[1].ariaDescribedBy, null, "Escape must remove the transient description link");
  assert.equal(escapeState.selectionFragmentCount, 0, "Escape must clear target highlighting");
  assert.deepEqual(
    await page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY })),
    escapeBefore,
    "Escape must restore marker focus without scrolling the replay page"
  );

  const spaceMarker = await markerLocator(page, 1);
  await page.mouse.click(850, 620);
  await spaceMarker.evaluate((marker) => marker.focus({ preventScroll: true }));
  await page.keyboard.press("Space");
  await waitForVisiblePopover(page, 102);
  keyboardOpenState = await assertFullPopoverContent(page, issues[1], "Space marker preview");
  assert.equal(keyboardOpenState.shadowActiveClass, "marker", "Space must keep focus on the originating marker");
  await page.locator("#focus-anchor").focus();
  await waitForClearedPopover(page);

  const markerIdentityAndCounts = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    window.__stablePopoverMarker = root.querySelectorAll(".marker")[0];
    return {
      locator: window.__popoverOutbound.filter((message) => message.type === "LOCATOR_STATUS").length,
      initReady: window.__popoverOutbound.filter((message) => message.type === "READY").length
    };
  });
  await hoverMarker(page, 0);
  await waitForVisiblePopover(page, 101);
  await page.mouse.move(890, 340);
  await waitForClearedPopover(page);
  const afterOrdinaryHover = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    return {
      sameMarker: root.querySelectorAll(".marker")[0] === window.__stablePopoverMarker,
      locator: window.__popoverOutbound.filter((message) => message.type === "LOCATOR_STATUS").length,
      initReady: window.__popoverOutbound.filter((message) => message.type === "READY").length
    };
  });
  assert.equal(afterOrdinaryHover.sameMarker, true, "hover must preserve marker DOM identity");
  assert.deepEqual(afterOrdinaryHover, { sameMarker: true, ...markerIdentityAndCounts }, "hover must not churn INIT/READY or locators");

  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [issues[1]]
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 1
  );
  await waitForClearedPopover(page);
  assert.equal((await shadowFact(page)).markers.length, 1, "severity-filter INIT must leave only filtered markers");
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 9
  );

  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [transformedClipIssue]
  });
  await page.evaluate(() => {
    document.getElementById("transformed-clip").scrollTo({ left: 300, top: 200, behavior: "instant" });
    window.scrollTo({ top: 760, behavior: "instant" });
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker").length === 1 && !root.querySelector(".marker").hidden;
  });
  await hoverMarker(page, 0);
  await assertSafePopover(page, 111, 0, "#transformed-target", "transformed clip visible");
  await page.evaluate(() => {
    document.getElementById("transformed-clip").scrollTo({ left: 0, top: 0, behavior: "instant" });
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelector(".marker")?.hidden
      && [...(root?.querySelectorAll(".issue-popover") ?? [])]
        .every((popover) => popover.hidden || getComputedStyle(popover).display === "none");
  });
  const transformedClipped = await shadowFact(page);
  assert.equal(transformedClipped.selectionFragmentCount, 0, "transformed clip-out must clear the highlight");
  assert.equal(
    transformedClipped.outbound.filter((message) => message.type === "ISSUE_SELECTED").at(-1)?.issueId,
    null,
    "transformed clip-out must notify an explicit selection clear"
  );
  await page.mouse.move(4, 4);
  await page.evaluate(() => {
    document.getElementById("transformed-clip").scrollTo({ left: 300, top: 200, behavior: "instant" });
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root && !root.querySelector(".marker").hidden;
  });
  assert.equal((await shadowFact(page)).visiblePopoverCount, 0, "restored transformed target must not resurrect a stale popover");
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 9
  );

  await page.evaluate(() => {
    document.getElementById("nested-scroll").scrollTo({ left: 120, top: 180, behavior: "instant" });
    window.scrollTo({ top: 760, behavior: "instant" });
  });
  await page.waitForTimeout(80);
  const nestedMarker = await markerLocator(page, 6);
  await nestedMarker.evaluate((marker) => marker.click());
  const nestedBefore = await assertSafePopover(page, 107, 6, "#nested-target", "nested scroll before");
  await page.evaluate(() => {
    document.getElementById("nested-scroll").scrollTo({ left: 162, top: 216, behavior: "instant" });
  });
  await page.waitForFunction((previousTop) => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const popover = root?.querySelector(".issue-popover");
    return popover && !popover.hidden && Math.abs(popover.getBoundingClientRect().top - previousTop) >= 20;
  }, nestedBefore.fact.popover.rect.top);
  const nestedAfter = await assertSafePopover(page, 107, 6, "#nested-target", "nested scroll after");
  assert.ok(
    Math.abs(nestedAfter.fact.popover.rect.top - nestedBefore.fact.popover.rect.top) >= 20,
    "nested scroll must reposition the popover"
  );

  await page.evaluate(() => {
    document.getElementById("nested-scroll").scrollTo({ left: 0, top: 0, behavior: "instant" });
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker")[6]?.hidden
      && [...root.querySelectorAll(".issue-popover")]
        .every((popover) => popover.hidden || getComputedStyle(popover).display === "none");
  });
  const clippedNested = await shadowFact(page);
  assert.equal(clippedNested.selectionFragmentCount, 0, "fully clipped target must clear its highlight");
  assert.equal(
    clippedNested.outbound.filter((message) => message.type === "ISSUE_SELECTED").at(-1)?.issueId,
    null,
    "fully clipped active target must notify an explicit selection clear"
  );
  await page.evaluate(() => {
    document.getElementById("nested-scroll").scrollTo({ left: 162, top: 216, behavior: "instant" });
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root && !root.querySelectorAll(".marker")[6].hidden;
  });
  assert.equal((await shadowFact(page)).visiblePopoverCount, 0, "scrolling a target back must not resurrect a stale popover");
  await hoverMarker(page, 6);
  await assertSafePopover(page, 107, 6, "#nested-target", "nested scroll restored");

  await page.setViewportSize({ width: 720, height: 560 });
  await page.waitForTimeout(100);
  await assertSafePopover(page, 107, 6, "#nested-target", "resize reposition");

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    document.getElementById("inactive-slide").style.display = "block";
    window.dispatchEvent(new Event("resize"));
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [issues[7]]
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker").length === 1 && !root.querySelector(".marker").hidden;
  });
  await hoverMarker(page, 0);
  await waitForVisiblePopover(page, 108);
  await page.evaluate(() => {
    document.getElementById("inactive-slide").style.display = "none";
    window.dispatchEvent(new Event("resize"));
  });
  await waitForClearedPopover(page);
  assert.equal((await shadowFact(page)).markers[0].hidden, true, "inactive slide must hide its marker again");
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 9
  );
  await sendCommand(page, { type: "FOCUS_ISSUE", issueId: 109 });
  await page.waitForTimeout(60);
  assert.equal((await shadowFact(page)).visiblePopoverCount, 0, "off-canvas target must fail closed");

  await page.setViewportSize({ width: 1238, height: 478 });
  await page.evaluate(() => {
    document.documentElement.classList.remove("narrow-mode");
    document.getElementById("inactive-slide").style.display = "none";
    const createFixture = (id) => {
      const element = document.createElement("div");
      element.id = id;
      element.className = "target";
      element.textContent = id;
      document.body.appendChild(element);
      return element;
    };
    const target = createFixture("artifact-bottom-target");
    Object.assign(target.style, {
      left: "430px",
      top: "390px",
      width: "180px",
      height: "40px"
    });
    for (const id of ["artifact-bottom-obstacle-3", "artifact-bottom-obstacle-98"]) {
      const obstacle = createFixture(id);
      obstacle.style.display = "none";
    }
    document.getElementById("focus-anchor").focus({ preventScroll: true });
    window.scrollTo({ top: 300, behavior: "instant" });
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [artifactBottomIssue]
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker").length === 1 && !root.querySelector(".marker").hidden;
  });
  const normalBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: document.activeElement?.id ?? null
  }));
  await hoverMarker(page, 0);
  const artifactNormal = await assertSafePopover(
    page,
    2,
    0,
    "#artifact-bottom-target",
    "artifact 66 roomy placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  assert.equal(
    artifactNormal.fact.popover.density,
    "normal",
    "a roomy artifact 66 target must preserve the full normal popover density"
  );
  await assertFullPopoverContent(page, artifactBottomIssue, "artifact 66 roomy placement", {
    layout: "vertical"
  });
  assert.ok(
    artifactNormal.fact.popover.rect.height <= 321,
    `normal artifact card must respect its 320px viewport cap: ${artifactNormal.fact.popover.rect.height}`
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    normalBefore,
    "normal popover preview must not move scroll or focus"
  );
  await page.mouse.move(1200, 20);
  await waitForClearedPopover(page);

  await page.evaluate(() => {
    const target = document.getElementById("artifact-bottom-target");
    Object.assign(target.style, {
      left: "60px",
      top: "487px",
      width: "872px",
      height: "34px"
    });
    const obstacleThree = document.getElementById("artifact-bottom-obstacle-3");
    Object.assign(obstacleThree.style, {
      display: "block",
      left: "60px",
      top: "527px",
      width: "20px",
      height: "20px"
    });
    const obstacleNinetyEight = document.getElementById("artifact-bottom-obstacle-98");
    Object.assign(obstacleNinetyEight.style, {
      display: "block",
      left: "60px",
      top: "567px",
      width: "20px",
      height: "20px"
    });
    window.dispatchEvent(new Event("resize"));
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: artifactBottomDenseIssues
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    return markers.length === 3 && markers.every((marker) => !marker.hidden);
  });
  await page.waitForTimeout(80);
  const artifactGeometry = await shadowFact(page);
  const artifactTargetRect = (await targetRects(page, "#artifact-bottom-target"))[0];
  assert.deepEqual(
    {
      left: Math.round(artifactTargetRect.left),
      top: Math.round(artifactTargetRect.top),
      right: Math.round(artifactTargetRect.right),
      bottom: Math.round(artifactTargetRect.bottom)
    },
    { left: 60, top: 187, right: 932, bottom: 221 },
    "artifact fixture must reproduce the long issue target at the lower viewport edge"
  );
  assert.deepEqual(
    {
      left: Math.round(artifactGeometry.markers[0].rect.left),
      top: Math.round(artifactGeometry.markers[0].rect.top),
      right: Math.round(artifactGeometry.markers[0].rect.right),
      bottom: Math.round(artifactGeometry.markers[0].rect.bottom)
    },
    { left: 52 - MARKER_SIZE, top: 187, right: 52, bottom: 187 + MARKER_SIZE },
    "artifact fixture must reproduce marker 2 at its captured coordinates"
  );
  assert.deepEqual(
    artifactGeometry.markers.map((marker) => marker.label),
    ["2", "3", "98"],
    "artifact fixture must retain the captured neighboring marker obstacles"
  );
  assert.equal(artifactGeometry.scroll.y, 300, "artifact fixture must exercise the internal scroll offset");

  const constrainedBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: document.activeElement?.id ?? null
  }));
  await hoverMarker(page, 0);
  const artifactConstrained = await assertSafePopover(
    page,
    2,
    0,
    "#artifact-bottom-target",
    "artifact 66 lower-edge constrained placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  await assertFullPopoverContent(page, artifactBottomIssue, "artifact 66 lower-edge constrained placement");
  assert.ok(
    artifactConstrained.fact.popover.rect.height < artifactNormal.fact.popover.rect.height,
    "wide constrained placement must reduce height without removing content"
  );
  assert.ok(
    artifactConstrained.fact.popover.rect.height <= 239,
    `captured lower-edge geometry allows at most about 239px, received ${artifactConstrained.fact.popover.rect.height}`
  );
  assert.ok(
    (artifactConstrained.fact.popover.layout === "wide" && artifactConstrained.fact.popover.rect.width >= 560)
      || (artifactConstrained.fact.popover.layout === "vertical"
        && artifactConstrained.fact.popover.density === "minimal"
        && artifactConstrained.fact.popover.rect.width <= 360),
    `lower-edge constrained details must use the first natural no-scroll layout that fits: ${JSON.stringify({
      layout: artifactConstrained.fact.popover.layout,
      density: artifactConstrained.fact.popover.density,
      rect: artifactConstrained.fact.popover.rect
    })}`
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    constrainedBefore,
    "constrained popover preview must not move scroll or focus"
  );
  const lowerEdgeArtifactDirectory = path.join(dashboardDirectory, "artifacts", "page-evidence");
  await mkdir(lowerEdgeArtifactDirectory, { recursive: true });
  const lowerEdgeScreenshotPath = path.join(lowerEdgeArtifactDirectory, "marker-popover-lower-edge.png");
  await movePointerFromMarkerToPopover(page, 2);
  await page.screenshot({ path: lowerEdgeScreenshotPath, fullPage: false });
  await page.mouse.move(1200, 20);
  const artifactCleared = await waitForClearedPopover(page);
  assert.equal(artifactCleared.selectionFragmentCount, 0, "leaving marker 2 must clear its target highlight");
  assert.ok(
    artifactCleared.markers.every((marker) => marker.pressed === "false"),
    "leaving marker 2 must clear every marker selection state"
  );
  assert.ok(
    artifactCleared.markers.every((marker) => marker.ariaDescribedBy === null),
    "leaving marker and popover must remove every transient description relationship"
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    constrainedBefore,
    "leaving the constrained popover must preserve scroll and focus"
  );

  const lowerKeyboardMarker = await markerLocator(page, 0);
  await lowerKeyboardMarker.evaluate((marker) => marker.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  const lowerKeyboardPlacement = await assertSafePopover(
    page,
    2,
    0,
    "#artifact-bottom-target",
    "artifact 66 lower-edge keyboard placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  await assertFullPopoverContent(page, artifactBottomIssue, "artifact 66 lower-edge keyboard content");
  assert.equal(
    lowerKeyboardPlacement.fact.shadowActiveClass,
    "marker",
    "lower-edge keyboard activation must retain marker focus"
  );
  await page.mouse.move(1200, 20);
  assert.equal(
    (await shadowFact(page)).visiblePopoverCount,
    1,
    "pointer leave must not close marker-focused details"
  );
  await page.keyboard.press("Escape");
  await waitForClearedPopover(page);
  assert.equal(
    (await shadowFact(page)).scroll.y,
    constrainedBefore.scrollY,
    "keyboard close must preserve the replay scroll offset"
  );
  await page.evaluate(() => {
    for (const id of [
      "artifact-bottom-target",
      "artifact-bottom-obstacle-3",
      "artifact-bottom-obstacle-98"
    ]) document.getElementById(id)?.remove();
  });

  await page.setViewportSize({ width: 1238, height: 478 });
  await page.evaluate(() => {
    document.documentElement.classList.remove("narrow-mode");
    const bindDocumentRects = (id, documentRects) => {
      const element = document.createElement("div");
      element.id = id;
      element.textContent = id;
      const union = documentRects.reduce((result, rect) => ({
        left: Math.min(result.left, rect.left),
        top: Math.min(result.top, rect.top),
        right: Math.max(result.right, rect.right),
        bottom: Math.max(result.bottom, rect.bottom)
      }), documentRects[0]);
      Object.assign(element.style, {
        position: "absolute",
        left: `${union.left}px`,
        top: `${union.top}px`,
        width: `${union.right - union.left}px`,
        height: `${union.bottom - union.top}px`,
        pointerEvents: "none"
      });
      const viewportRect = (rect) => new DOMRect(
        rect.left - window.scrollX,
        rect.top - window.scrollY,
        rect.right - rect.left,
        rect.bottom - rect.top
      );
      element.getClientRects = () => documentRects.map(viewportRect);
      element.getBoundingClientRect = () => viewportRect(union);
      document.body.appendChild(element);
    };

    bindDocumentRects("artifact-slide-two-title-block", [
      { left: 60, top: 279.28125, right: 1060, bottom: 395.28125 }
    ]);
    bindDocumentRects("artifact-slide-two-title-link", [
      { left: 60, top: 280.28125, right: 1005.3125, bottom: 336.28125 },
      { left: 60, top: 338.28125, right: 385.234375, bottom: 394.28125 }
    ]);
    bindDocumentRects("artifact-slide-two-description-block", [
      { left: 60, top: 411.28125, right: 1060, bottom: 479.28125 }
    ]);
    bindDocumentRects("artifact-slide-two-description-link", [
      { left: 60, top: 414.28125, right: 995.078125, bottom: 441.28125 },
      { left: 60, top: 448.28125, right: 432.5, bottom: 475.28125 }
    ]);
    bindDocumentRects("artifact-slide-two-lower-left", [
      { left: 40, top: 629.28125, right: 578, bottom: 1134.28125 }
    ]);
    bindDocumentRects("artifact-slide-two-lower-center", [
      { left: 659, top: 629.28125, right: 887.5, bottom: 1027.78125 }
    ]);
    bindDocumentRects("artifact-slide-two-lower-right", [
      { left: 968.5, top: 629.28125, right: 1198, bottom: 1028.78125 }
    ]);
    bindDocumentRects("artifact-slide-two-image-link", [
      { left: 0, top: 0, right: 1238, bottom: 589.28125 }
    ]);
    document.getElementById("focus-anchor").focus({ preventScroll: true });
    window.scrollTo({ top: 300, behavior: "instant" });
    window.dispatchEvent(new Event("resize"));
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: artifactSlideTwoDenseIssues
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    return markers.length === 11 && markers.every((marker) => !marker.hidden);
  });
  await page.waitForTimeout(80);

  const slideTwoGeometry = await shadowFact(page);
  assert.deepEqual(
    slideTwoGeometry.markers.map((marker) => marker.label),
    ["4", "5", "6", "7", "34", "62", "81", "99", "100", "109", "117"],
    "artifact 66 slide 2 fixture must retain every captured visible marker obstacle"
  );
  assert.deepEqual(
    slideTwoGeometry.markers.map((marker) => ({
      label: marker.label,
      left: Math.round(marker.rect.left),
      top: Math.round(marker.rect.top),
      right: Math.round(marker.rect.right),
      bottom: Math.round(marker.rect.bottom)
    })),
    [
      { label: "4", left: 52 - MARKER_SIZE, top: -21, right: 52, bottom: -21 + MARKER_SIZE },
      { label: "5", left: 52 - MARKER_SIZE, top: 20, right: 52, bottom: 20 + MARKER_SIZE },
      { label: "6", left: 52 - MARKER_SIZE, top: 111, right: 52, bottom: 111 + MARKER_SIZE },
      { label: "7", left: 52 - MARKER_SIZE, top: 154, right: 52, bottom: 154 + MARKER_SIZE },
      { label: "34", left: 32 - MARKER_SIZE, top: 329, right: 32, bottom: 329 + MARKER_SIZE },
      { label: "62", left: 651 - MARKER_SIZE, top: 329, right: 651, bottom: 329 + MARKER_SIZE },
      { label: "81", left: 961 - MARKER_SIZE, top: 329, right: 961, bottom: 329 + MARKER_SIZE },
      { label: "99", left: 80, top: 297, right: 80 + MARKER_SIZE, bottom: 297 + MARKER_SIZE },
      { label: "100", left: 52 - MARKER_SIZE, top: 194, right: 52, bottom: 194 + MARKER_SIZE },
      { label: "109", left: 32 - MARKER_SIZE, top: 369, right: 32, bottom: 369 + MARKER_SIZE },
      { label: "117", left: 961 - MARKER_SIZE, top: 369, right: 961, bottom: 369 + MARKER_SIZE }
    ],
    "artifact 66 slide 2 fixture must reproduce marker 100 and all visible halo obstacles"
  );
  const slideTwoTargetRects = await targetRects(page, "#artifact-slide-two-description-link");
  assert.deepEqual(
    slideTwoTargetRects.map((rect) => ({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom)
    })),
    [
      { left: 60, top: 114, right: 995, bottom: 141 },
      { left: 60, top: 148, right: 433, bottom: 175 }
    ],
    "artifact 66 marker 100 fixture must retain both captured target lines"
  );
  assert.equal(slideTwoGeometry.scroll.y, 300, "slide 2 fixture must retain its captured replay scroll offset");

  const slideTwoBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: document.activeElement?.id ?? null
  }));
  await hoverMarker(page, 8);
  const slideTwoPlacement = await assertSafePopover(
    page,
    artifactSlideTwoIssue.id,
    8,
    "#artifact-slide-two-description-link",
    "artifact 66 slide 2 marker 100 fallback placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  await assertFullPopoverContent(page, artifactSlideTwoIssue, "artifact 66 slide 2 marker 100 content", {
    layout: "wide"
  });
  assert.equal(slideTwoPlacement.fact.popover.density, "normal", "marker 100 must retain full content density");
  assert.equal(slideTwoPlacement.fact.popover.placement, "bottom", "marker 100 must use the captured bottom placement");
  assert.ok(
    slideTwoPlacement.gap > bridgePreferredMaxMarkerDistance
      && slideTwoPlacement.gap <= MAX_ADJACENT_GAP,
    `marker 100 must exercise only the bounded 48px-to-52px fallback: ${slideTwoPlacement.gap}`
  );
  assert.ok(
    Math.abs(slideTwoPlacement.fact.popover.rect.left - 108) <= 1
      && Math.abs(slideTwoPlacement.fact.popover.rect.top - 193) <= 1
      && Math.abs(slideTwoPlacement.fact.popover.rect.width - 840) <= 1
      && Math.abs(slideTwoPlacement.fact.popover.rect.height - 91) <= 1,
    `marker 100 must reproduce the captured safe wide card: ${JSON.stringify(slideTwoPlacement.fact.popover.rect)}`
  );
  assert.equal(slideTwoPlacement.fact.selectionFragmentCount, 2, "marker 100 must highlight both target lines");
  assert.equal(
    slideTwoPlacement.fact.markers[8].ariaDescribedBy,
    slideTwoPlacement.fact.popover.id,
    "marker 100 must expose the visible full details as its description"
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    slideTwoBefore,
    "marker 100 hover must preserve replay scroll and document focus"
  );
  await movePointerFromMarkerToPopover(page, artifactSlideTwoIssue.id);
  await page.mouse.move(1200, 20);
  let slideTwoCleared = await waitForClearedPopover(page);
  assert.equal(slideTwoCleared.selectionFragmentCount, 0, "leaving marker 100 and its card clears highlighting");
  assert.ok(
    slideTwoCleared.markers.every((marker) => marker.pressed === "false" && marker.ariaDescribedBy === null),
    "leaving marker 100 and its card clears marker state and descriptions"
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    slideTwoBefore,
    "marker 100 pointer lifecycle must preserve replay scroll and document focus"
  );

  const slideTwoTouchMarker = await markerLocator(page, 8);
  await slideTwoTouchMarker.dispatchEvent("pointerenter", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(40);
  assert.equal((await shadowFact(page)).visiblePopoverCount, 0, "marker 100 touch boundaries must not emulate hover");
  await slideTwoTouchMarker.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await slideTwoTouchMarker.dispatchEvent("click", { pointerType: "touch", isPrimary: true });
  await assertSafePopover(
    page,
    artifactSlideTwoIssue.id,
    8,
    "#artifact-slide-two-description-link",
    "artifact 66 slide 2 marker 100 touch placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  await slideTwoTouchMarker.dispatchEvent("pointerleave", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(40);
  assert.equal((await shadowFact(page)).popover?.issueId, "2323", "touch leave must retain marker 100's pinned details");
  await page.locator("#focus-anchor").dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  slideTwoCleared = await waitForClearedPopover(page);
  assert.equal(slideTwoCleared.selectionFragmentCount, 0, "outside touch must clear marker 100 highlighting");
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    slideTwoBefore,
    "marker 100 touch lifecycle must preserve replay scroll and document focus"
  );

  const slideTwoKeyboardMarker = await markerLocator(page, 8);
  await slideTwoKeyboardMarker.evaluate((marker) => marker.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  const slideTwoKeyboardPlacement = await assertSafePopover(
    page,
    artifactSlideTwoIssue.id,
    8,
    "#artifact-slide-two-description-link",
    "artifact 66 slide 2 marker 100 keyboard placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  await assertFullPopoverContent(page, artifactSlideTwoIssue, "artifact 66 slide 2 marker 100 keyboard content", {
    layout: "wide"
  });
  assert.equal(slideTwoKeyboardPlacement.fact.shadowActiveClass, "marker", "marker 100 keyboard preview retains focus");
  assert.equal(slideTwoKeyboardPlacement.fact.shadowActiveText, "100", "keyboard focus must remain on marker 100");
  await page.mouse.move(1200, 20);
  assert.equal((await shadowFact(page)).visiblePopoverCount, 1, "pointer leave must not close focused marker 100 details");
  await page.keyboard.press("Escape");
  slideTwoCleared = await waitForClearedPopover(page);
  assert.equal(slideTwoCleared.shadowActiveText, "100", "Escape restores focus to marker 100");
  assert.equal(slideTwoCleared.markers[8].ariaDescribedBy, null, "Escape clears marker 100's description link");
  assert.equal(slideTwoCleared.selectionFragmentCount, 0, "Escape clears marker 100 highlighting");
  assert.equal(slideTwoCleared.scroll.y, 300, "marker 100 keyboard lifecycle preserves the replay scroll offset");

  await page.evaluate(() => {
    for (const id of [
      "artifact-slide-two-title-block",
      "artifact-slide-two-title-link",
      "artifact-slide-two-description-block",
      "artifact-slide-two-description-link",
      "artifact-slide-two-lower-left",
      "artifact-slide-two-lower-center",
      "artifact-slide-two-lower-right",
      "artifact-slide-two-image-link"
    ]) document.getElementById(id)?.remove();
  });

  await page.setViewportSize({ width: 872, height: 478 });
  await page.evaluate(() => {
    document.documentElement.classList.remove("narrow-mode");
    const createFixture = (id) => {
      const element = document.createElement("div");
      element.id = id;
      element.className = "target";
      element.textContent = id;
      document.body.appendChild(element);
      return element;
    };
    const target = createFixture("artifact-top-target");
    Object.assign(target.style, {
      left: "52px",
      top: "629px",
      width: "774px",
      height: "430px"
    });
    const obstacleThree = createFixture("artifact-top-obstacle-3");
    Object.assign(obstacleThree.style, {
      left: "75px",
      top: "494px",
      width: "20px",
      height: "20px"
    });
    const obstacleNinetyEight = createFixture("artifact-top-obstacle-98");
    Object.assign(obstacleNinetyEight.style, {
      left: "75px",
      top: "534px",
      width: "20px",
      height: "20px"
    });
    const obstacleOneHundredNine = createFixture("artifact-top-obstacle-109");
    Object.assign(obstacleOneHundredNine.style, {
      left: "56px",
      top: "677px",
      width: "20px",
      height: "20px"
    });
    document.getElementById("focus-anchor").focus({ preventScroll: true });
    window.scrollTo({ top: 470, behavior: "instant" });
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: artifactTopDenseIssues
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    return markers.length === 4 && markers.every((marker) => !marker.hidden);
  });
  await page.waitForTimeout(80);

  const artifactTopGeometry = await shadowFact(page);
  const artifactTopTargetRect = (await targetRects(page, "#artifact-top-target"))[0];
  assert.deepEqual(
    {
      left: Math.round(artifactTopTargetRect.left),
      top: Math.round(artifactTopTargetRect.top),
      right: Math.round(artifactTopTargetRect.right),
      bottom: Math.round(artifactTopTargetRect.bottom)
    },
    { left: 52, top: 159, right: 826, bottom: 589 },
    "top-edge artifact fixture must reproduce the viewport-spanning image target"
  );
  assert.deepEqual(
    artifactTopGeometry.markers.map((marker) => marker.label),
    ["3", "34", "98", "109"],
    "top-edge artifact fixture must retain the captured marker numbering"
  );
  assert.deepEqual(
    artifactTopGeometry.markers.map((marker) => ({
      left: Math.round(marker.rect.left),
      top: Math.round(marker.rect.top),
      right: Math.round(marker.rect.right),
      bottom: Math.round(marker.rect.bottom)
    })),
    [
      { left: 67 - MARKER_SIZE, top: 24, right: 67, bottom: 24 + MARKER_SIZE },
      { left: 44 - MARKER_SIZE, top: 159, right: 44, bottom: 159 + MARKER_SIZE },
      { left: 67 - MARKER_SIZE, top: 64, right: 67, bottom: 64 + MARKER_SIZE },
      { left: 48 - MARKER_SIZE, top: 207, right: 48, bottom: 207 + MARKER_SIZE }
    ],
    "top-edge artifact fixture must reproduce marker 34 and all visible obstacle rects"
  );
  assert.equal(artifactTopGeometry.scroll.y, 470, "top-edge fixture must retain its replay scroll offset");
  const artifactTopMaximumSafeHeight = 159 - MARKER_HALO - VIEWPORT_MARGIN;
  assert.equal(artifactTopMaximumSafeHeight, 141, "captured geometry exposes only a 141px target-safe top strip");

  const artifactTopBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: document.activeElement?.id ?? null
  }));
  await hoverMarker(page, 1);
  const artifactTopPlacement = await assertSafePopover(
    page,
    34,
    1,
    "#artifact-top-target",
    "artifact 66 top-edge constrained placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  assert.equal(artifactTopPlacement.fact.popover.placement, "top", "bridge must expose top placement metadata");
  assert.ok(
    artifactTopPlacement.fact.popover.rect.bottom <= artifactTopTargetRect.top - MARKER_HALO + 1,
    `top-edge artifact card must stay inside the only safe strip above the marker halo: ${JSON.stringify({
      popover: artifactTopPlacement.fact.popover.rect,
      marker: artifactTopPlacement.fact.markers[1].rect,
      target: artifactTopTargetRect,
      layout: artifactTopPlacement.fact.popover.layout,
      density: artifactTopPlacement.fact.popover.density,
      placement: artifactTopPlacement.fact.popover.placement
    })}`
  );
  assert.ok(
    artifactTopPlacement.fact.popover.rect.height <= artifactTopMaximumSafeHeight + 1,
    `top-edge artifact card must fit its target-safe natural-height strip, received ${artifactTopPlacement.fact.popover.rect.height}`
  );
  await assertFullPopoverContent(page, artifactTopIssue, "artifact 66 top-edge constrained content", {
    layout: "wide"
  });
  assert.ok(
    artifactTopPlacement.fact.popover.rect.width >= 560,
    `top-edge artifact must use the wide grid, received ${artifactTopPlacement.fact.popover.rect.width}`
  );
  await movePointerFromMarkerToPopover(page, 34);
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    artifactTopBefore,
    "marker-to-card travel must preserve replay scroll and focus"
  );
  const topEdgeScreenshotPath = path.join(lowerEdgeArtifactDirectory, "marker-popover-top-edge.png");
  await page.screenshot({ path: topEdgeScreenshotPath, fullPage: false });
  await page.mouse.move(860, 466);
  const artifactTopCleared = await waitForClearedPopover(page);
  assert.equal(artifactTopCleared.selectionFragmentCount, 0, "leaving top-edge marker and card clears highlighting");
  assert.ok(
    artifactTopCleared.markers.every((marker) => marker.pressed === "false"),
    "leaving top-edge marker and card clears marker selection"
  );
  assert.ok(
    artifactTopCleared.markers.every((marker) => marker.ariaDescribedBy === null),
    "leaving top-edge marker and card clears transient descriptions"
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    artifactTopBefore,
    "top-edge pointer lifecycle must preserve replay scroll and focus"
  );

  const topKeyboardMarker = await markerLocator(page, 1);
  await topKeyboardMarker.evaluate((marker) => marker.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  const topKeyboardPlacement = await assertSafePopover(
    page,
    34,
    1,
    "#artifact-top-target",
    "artifact 66 top-edge keyboard placement",
    { maxAdjacentGap: MAX_ADJACENT_GAP }
  );
  await assertFullPopoverContent(page, artifactTopIssue, "artifact 66 top-edge keyboard content", {
    layout: "wide"
  });
  assert.equal(
    topKeyboardPlacement.fact.shadowActiveClass,
    "marker",
    "top-edge keyboard activation must retain marker focus"
  );
  await page.mouse.move(860, 466);
  assert.equal(
    (await shadowFact(page)).visiblePopoverCount,
    1,
    "pointer leave must not close marker-focused top-edge details"
  );
  await page.keyboard.press("Escape");
  await waitForClearedPopover(page);
  assert.equal((await shadowFact(page)).scroll.y, 470, "top-edge keyboard close preserves replay scroll");

  await page.setViewportSize({ width: 320, height: 478 });
  await page.evaluate(() => {
    const target = document.getElementById("artifact-top-target");
    Object.assign(target.style, {
      left: "46px",
      top: "612px",
      width: "262px",
      height: "430px"
    });
    for (const id of ["artifact-top-obstacle-3", "artifact-top-obstacle-98"]) {
      document.getElementById(id).style.display = "none";
    }
    const obstacleOneHundredNine = document.getElementById("artifact-top-obstacle-109");
    Object.assign(obstacleOneHundredNine.style, {
      display: "block",
      left: "46px",
      top: "660px"
    });
    document.getElementById("focus-anchor").focus({ preventScroll: true });
    window.scrollTo({ top: 470, behavior: "instant" });
    window.dispatchEvent(new Event("resize"));
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: artifactTopDenseIssues
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    return markers.length === 4
      && markers[0].hidden
      && !markers[1].hidden
      && markers[2].hidden
      && !markers[3].hidden;
  });
  const extremeTopBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: document.activeElement?.id ?? null
  }));
  const extremeTopTargetRect = (await targetRects(page, "#artifact-top-target"))[0];
  assert.deepEqual(
    {
      left: Math.round(extremeTopTargetRect.left),
      top: Math.round(extremeTopTargetRect.top),
      right: Math.round(extremeTopTargetRect.right),
      bottom: Math.round(extremeTopTargetRect.bottom)
    },
    { left: 46, top: 142, right: 308, bottom: 572 },
    "320px top-edge fixture must span nearly the full narrow viewport"
  );
  await hoverMarker(page, 1);
  const extremeTopState = await waitForExternalDescription(
    page,
    artifactTopIssue,
    1,
    "320px extreme top-edge external detail"
  );
  assert.ok(extremeTopState.selectionFragmentCount > 0, "320px external detail retains target highlighting");
  assert.equal(extremeTopState.markers[1].pressed, "true", "320px external detail marker remains active");
  const extremeTopScreenshotPath = path.join(lowerEdgeArtifactDirectory, "marker-popover-top-edge-320.png");
  await page.screenshot({ path: extremeTopScreenshotPath, fullPage: false });
  await page.mouse.move(308, 466);
  await waitForExternalDescriptionCleared(page, "320px extreme top-edge pointer leave");
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    extremeTopBefore,
    "320px external-detail pointer lifecycle must preserve replay scroll and focus"
  );

  const extremeKeyboardMarker = await markerLocator(page, 1);
  await extremeKeyboardMarker.evaluate((marker) => marker.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  await waitForExternalDescription(
    page,
    artifactTopIssue,
    1,
    "320px extreme top-edge keyboard detail"
  );
  await page.keyboard.press("Escape");
  await waitForExternalDescriptionCleared(page, "320px extreme top-edge Escape");

  await page.evaluate(() => {
    const obstacleThree = document.getElementById("artifact-top-obstacle-3");
    Object.assign(obstacleThree.style, {
      display: "block",
      left: "46px",
      top: "488px"
    });
    const obstacleNinetyEight = document.getElementById("artifact-top-obstacle-98");
    Object.assign(obstacleNinetyEight.style, {
      display: "block",
      left: "122px",
      top: "528px"
    });
    window.dispatchEvent(new Event("resize"));
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: artifactTopDenseIssues
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    return markers.length === 4 && markers.every((marker) => !marker.hidden);
  });
  const noSafeTopBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: document.activeElement?.id ?? null
  }));
  await hoverMarker(page, 1);
  const noSafeTopState = await waitForExternalDescription(
    page,
    artifactTopIssue,
    1,
    "320px top-edge geometry with visible 3/98 obstacles"
  );
  assert.ok(noSafeTopState.selectionFragmentCount > 0, "external top-edge issue retains target highlighting");
  assert.equal(noSafeTopState.markers[1].pressed, "true", "external fallback marker remains active");
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    noSafeTopBefore,
    "external top-edge preview must preserve replay scroll and focus"
  );
  const noSafeTopScreenshotPath = path.join(
    lowerEdgeArtifactDirectory,
    "marker-popover-top-edge-320-no-safe-space.png"
  );
  await page.screenshot({ path: noSafeTopScreenshotPath, fullPage: false });
  await page.mouse.move(308, 466);
  await waitForExternalDescriptionCleared(page, "320px obstacle fallback pointer leave");
  await page.evaluate(() => {
    for (const id of [
      "artifact-top-target",
      "artifact-top-obstacle-3",
      "artifact-top-obstacle-98",
      "artifact-top-obstacle-109"
    ]) document.getElementById(id)?.remove();
  });

  await page.evaluate(() => {
    document.getElementById("inactive-slide").style.display = "none";
    document.documentElement.classList.add("narrow-mode");
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.setViewportSize({ width: 390, height: 568 });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [issues[5]]
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 1
  );
  await hoverMarker(page, 0);
  const narrow390State = await waitForExternalDescription(
    page,
    issues[5],
    0,
    "390px long Korean external detail"
  );
  assert.ok(narrow390State.selectionFragmentCount > 0, "390px fallback retains target highlighting");
  await page.mouse.move(4, 4);
  await waitForExternalDescriptionCleared(page, "390px pointer leave");

  await page.setViewportSize({ width: 320, height: 568 });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [issues[5]]
  });
  await page.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelectorAll(".marker").length === 1
  );
  await page.waitForTimeout(100);
  const narrowBefore = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: document.activeElement?.id ?? null
  }));
  await hoverMarker(page, 0);
  const narrowState = await waitForExternalDescription(
    page,
    issues[5],
    0,
    "320px long Korean external detail"
  );
  assert.ok(narrowState.selectionFragmentCount > 0, "narrow external detail retains target highlighting");

  const artifactDirectory = path.join(dashboardDirectory, "artifacts", "page-evidence");
  await mkdir(artifactDirectory, { recursive: true });
  const screenshotPath = path.join(artifactDirectory, "marker-popover-narrow.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  await page.mouse.move(4, 4);
  await waitForExternalDescriptionCleared(page, "320px pointer leave");
  assert.deepEqual(
    await page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElementId: document.activeElement?.id ?? null
    })),
    narrowBefore,
    "leaving narrow external detail must preserve replay scroll and focus"
  );

  const narrowKeyboardMarker = await markerLocator(page, 0);
  await narrowKeyboardMarker.evaluate((marker) => marker.focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  await waitForExternalDescription(
    page,
    issues[5],
    0,
    "320px keyboard external detail"
  );
  await page.keyboard.press("Escape");
  await waitForExternalDescriptionCleared(page, "320px keyboard Escape");
  assert.equal((await shadowFact(page)).scroll.y, narrowBefore.scrollY, "narrow keyboard close preserves replay scroll");

  const narrowTouchMarker = await markerLocator(page, 0);
  await narrowTouchMarker.dispatchEvent("pointerenter", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(40);
  assert.equal((await shadowFact(page)).externalDescription, null, "touch boundaries must not emulate hover");
  await narrowTouchMarker.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await narrowTouchMarker.dispatchEvent("click", { pointerType: "touch", isPrimary: true });
  await waitForExternalDescription(page, issues[5], 0, "320px tapped external detail");
  await narrowTouchMarker.dispatchEvent("pointerleave", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(40);
  assert.equal(
    (await shadowFact(page)).externalDescription?.issueId,
    String(issues[5].id),
    "touch leave must retain the pinned external description"
  );
  await page.locator("#focus-anchor").dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await waitForExternalDescriptionCleared(page, "320px outside touch dismiss");

  await hoverMarker(page, 0);
  await waitForExternalDescription(page, issues[5], 0, "320px marker-toggle setup");
  await sendCommand(page, { type: "SET_MARKERS_VISIBLE", markersVisible: false });
  await waitForExternalDescriptionCleared(page, "320px marker hide");
  // Move away before restoring. Keeping the pointer over the hidden marker's
  // coordinates legitimately creates a fresh pointerenter when it reappears;
  // that is a new hover, not stale fallback state being resurrected.
  await page.mouse.move(4, 4);
  await sendCommand(page, { type: "SET_MARKERS_VISIBLE", markersVisible: true });
  await page.waitForFunction(() => {
    const marker = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot?.querySelector(".marker");
    return marker && !marker.hidden;
  });
  assert.equal((await shadowFact(page)).externalDescription, null, "marker restore must not resurrect stale details");

  await page.evaluate(() => {
    document.documentElement.classList.remove("narrow-mode");
  });
  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: [issues[5]]
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker").length === 1 && !root.querySelector(".marker").hidden;
  });
  const smallTargetRect = (await targetRects(page, "#narrow-target"))[0];
  assert.ok(
    Math.abs(smallTargetRect.width - 84) <= 1 && Math.abs(smallTargetRect.height - 54) <= 1,
    "small-target regression must preserve its exact 84x54 geometry"
  );
  await hoverMarker(page, 0);
  const smallTargetState = await waitForExternalDescription(
    page,
    issues[5],
    0,
    "320px small-target external detail"
  );
  assert.ok(smallTargetState.selectionFragmentCount > 0, "small-target fallback retains highlighting");
  await page.mouse.move(4, 4);
  await waitForExternalDescriptionCleared(page, "320px small-target pointer leave");

  const finalTargets = await page.evaluate((selectors) =>
    Object.fromEntries(selectors.map((selector) => [selector, document.querySelector(selector).outerHTML])),
  Object.keys(originalTargets));
  assert.deepEqual(finalTargets, originalTargets, "popover and highlighting must not mutate original target DOM");
  assert.deepEqual(pageErrors, [], "the bridge fixture must not raise page errors");

  console.log(JSON.stringify({
    result: "PASS",
    forcedSides: expectedSides,
    artifactLowerEdge: {
      density: artifactConstrained.fact.popover.density,
      layout: artifactConstrained.fact.popover.layout,
      rect: artifactConstrained.fact.popover.rect,
      clientHeight: artifactConstrained.fact.popover.clientHeight,
      scrollHeight: artifactConstrained.fact.popover.scrollHeight,
      clientWidth: artifactConstrained.fact.popover.clientWidth,
      scrollWidth: artifactConstrained.fact.popover.scrollWidth,
      scrollIndicatorCount: artifactConstrained.fact.scrollIndicatorCount
    },
    artifactTopEdge: {
      density: artifactTopPlacement.fact.popover.density,
      layout: artifactTopPlacement.fact.popover.layout,
      placement: artifactTopPlacement.fact.popover.placement,
      rect: artifactTopPlacement.fact.popover.rect,
      clientHeight: artifactTopPlacement.fact.popover.clientHeight,
      scrollHeight: artifactTopPlacement.fact.popover.scrollHeight,
      clientWidth: artifactTopPlacement.fact.popover.clientWidth,
      scrollWidth: artifactTopPlacement.fact.popover.scrollWidth,
      maximumSafeHeight: artifactTopMaximumSafeHeight,
      markerRects: artifactTopGeometry.markers.map((marker) => marker.rect),
      targetRect: artifactTopTargetRect,
      scrollIndicatorCount: artifactTopPlacement.fact.scrollIndicatorCount
    },
    extremeTopEdge: {
      visiblePopoverCount: extremeTopState.visiblePopoverCount,
      selectionFragmentCount: extremeTopState.selectionFragmentCount,
      targetRect: extremeTopTargetRect
    },
    noSafeTopEdge: {
      visiblePopoverCount: noSafeTopState.visiblePopoverCount,
      markerLabels: noSafeTopState.markers.map((marker) => marker.label),
      selectionFragmentCount: noSafeTopState.selectionFragmentCount
    },
    narrow: {
      visiblePopoverCount: narrowState.visiblePopoverCount,
      selectionFragmentCount: narrowState.selectionFragmentCount
    },
    smallTarget: {
      visiblePopoverCount: smallTargetState.visiblePopoverCount,
      selectionFragmentCount: smallTargetState.selectionFragmentCount,
      target: smallTargetRect
    },
    lowerEdgeScreenshotPath,
    topEdgeScreenshotPath,
    extremeTopScreenshotPath,
    noSafeTopScreenshotPath,
    screenshotPath
  }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
