'use strict';

// Layer popups (notice/event overlays that public sites open over the page on
// arrival) cover the page's own content. Left open, they hide the content from
// the CV screenshot and the live report, and their text is read as page text.
// They are still content the site made, so they are not silently dropped:
//   1) findPopupLayers marks each popup with POPUP_ATTRIBUTE while it is open,
//      so its own violations can be scanned and reported under reason POPUP,
//      and capturePopupLayers saves its text (for the text analyzer) and its
//      image (for the CV analyzer) so every analyzer checks it;
//   2) hidePopupLayers then clicks the popup's own close control (so the site's
//      "do not show today" cookie logic runs) and always hides it as well,
//      because close controls without a handler or with a slow animation were
//      seen to leave the popup on screen.
// The page is then analyzed as a visitor sees it after closing the popup.
// This is a heuristic: popup markup differs by site and not every popup is
// found. A missed popup stays in the analysis exactly as before.

const POPUP_ATTRIBUTE = 'data-ua-popup';

// A popup covers at least this share of the viewport. Smaller fixed elements
// (sticky headers, chat buttons, cookie bars) are ordinary page UI.
const POPUP_MIN_VIEWPORT_SHARE = 0.2;
// Page UI such as headers rarely stacks above this; popups nearly always do.
const POPUP_MIN_Z_INDEX = 100;
const POPUP_CLOSE_PATTERN_SOURCE = '(닫기|close|오늘\\s*하루|다시\\s*보지|안\\s*보기|그만\\s*보기|×|✕)';

function findPopupsInPage({ attribute, minShare, minZIndex }) {
  const viewportArea = window.innerWidth * window.innerHeight;
  const found = [];
  for (const element of document.querySelectorAll('body *')) {
    if (found.some((popup) => popup.contains(element))) continue;
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'absolute') continue;
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    const zIndex = parseInt(style.zIndex, 10);
    if (!zIndex || zIndex < minZIndex) continue;
    const rect = element.getBoundingClientRect();
    if (Math.max(0, rect.width) * Math.max(0, rect.height) < viewportArea * minShare) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    element.setAttribute(attribute, String(found.length));
    found.push(element);
  }
  return found.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      index: Number(element.getAttribute(attribute)),
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

function hidePopupsInPage({ attribute, closePatternSource }) {
  const closePattern = new RegExp(closePatternSource, 'i');
  const results = [];
  for (const popup of document.querySelectorAll(`[${attribute}]`)) {
    let clickedClose = false;
    for (const control of popup.querySelectorAll('a, button, span, div, img, i')) {
      const label = `${control.textContent || ''} ${control.getAttribute('aria-label') || ''} `
        + `${control.getAttribute('alt') || ''} ${control.className || ''} ${control.id || ''}`;
      if (closePattern.test(label)) {
        control.click();
        clickedClose = true;
        break;
      }
    }
    // The click may already have removed the popup; otherwise hide it.
    if (popup.isConnected) popup.style.setProperty('display', 'none', 'important');
    results.push({ index: Number(popup.getAttribute(attribute)), clicked_close: clickedClose });
  }
  return results;
}

// Serializes the open popups' content into a standalone document so the text
// analyzer can check the popup text on its own (the page snapshot is taken
// after the popups are closed). Each popup's children are wrapped in a neutral
// section: the popup element itself usually carries popup/modal/dialog markers
// that the text extractor removes as hidden UI.
function serializePopupsInPage({ attribute }) {
  const popups = [...document.querySelectorAll(`[${attribute}]`)];
  if (popups.length === 0) return null;
  const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[c]);
  const sections = popups.map((popup) => {
    const copy = popup.cloneNode(true);
    copy.querySelectorAll('script, style, noscript, template').forEach((node) => node.remove());
    return `<section data-ua-popup-content="${escape(popup.getAttribute(attribute))}">${copy.innerHTML}</section>`;
  });
  return `<!doctype html><html lang="${escape(document.documentElement.lang || 'ko')}"><head>`
    + `<meta charset="utf-8"><base href="${escape(location.href)}"><title>레이어 팝업</title></head>`
    + `<body>${sections.join('\n')}</body></html>`;
}

// Document boxes (CSS px) of the popup's color-contrast findings, per popup, so
// run_all.py can drop the CV findings that duplicate them.
function popupContrastBoxesInPage({ attribute, targets }) {
  const boxes = {};
  for (const selector of targets) {
    let element = null;
    try { element = document.querySelector(selector); } catch { continue; }
    const popup = element?.closest(`[${attribute}]`);
    if (!popup) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const index = popup.getAttribute(attribute);
    (boxes[index] ||= []).push({
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  return boxes;
}

// Path of the CV image for popup `index`, derived from the page CV image path.
// run_all.py derives the same name.
function popupCvCapturePath(cvScreenshotPath, index) {
  return cvScreenshotPath.replace(/\.png$/i, '') + `-popup-${index}.png`;
}

// Saves what the other analyzers need from the popups while they are still open:
// the popup text as a standalone HTML document and, in the integrated run, one
// image per popup for the CV analyzer. Adds each popup's color-contrast boxes to
// its layer entry. Failures only skip that part of the popup analysis.
async function capturePopupLayers(page, layers, { htmlPath, cvScreenshotPath, popupAxeResults, fs }) {
  if (layers.length === 0) return;
  const html = await page.evaluate(serializePopupsInPage, { attribute: POPUP_ATTRIBUTE }).catch(() => null);
  if (html && htmlPath) fs.writeFileSync(htmlPath, html, 'utf-8');

  const targets = (popupAxeResults?.violations || [])
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes.map((node) => {
      const first = Array.isArray(node.target) ? node.target[0] : null;
      return Array.isArray(first) ? first[0] : first;
    }))
    .filter((selector) => typeof selector === 'string');
  const boxes = targets.length > 0
    ? await page.evaluate(popupContrastBoxesInPage, { attribute: POPUP_ATTRIBUTE, targets }).catch(() => ({}))
    : {};
  for (const layer of layers) layer.color_contrast_boxes = boxes[String(layer.index)] || [];

  if (!cvScreenshotPath) return;
  for (const layer of layers) {
    try {
      await page.locator(`[${POPUP_ATTRIBUTE}="${layer.index}"]`).screenshot({
        path: popupCvCapturePath(cvScreenshotPath, layer.index),
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        timeout: 15000,
      });
    } catch (error) {
      console.warn(`   레이어 팝업 ${layer.index} CV 이미지 생성 실패: ${error.message}`);
    }
  }
}

// Marks the open popups and returns their document rectangles.
async function findPopupLayers(page) {
  return page.evaluate(findPopupsInPage, {
    attribute: POPUP_ATTRIBUTE,
    minShare: POPUP_MIN_VIEWPORT_SHARE,
    minZIndex: POPUP_MIN_Z_INDEX,
  }).catch(() => []);
}

// Closes and hides the marked popups. Returns, per popup, whether its own
// close control was clicked.
async function hidePopupLayers(page) {
  const results = await page.evaluate(hidePopupsInPage, {
    attribute: POPUP_ATTRIBUTE,
    closePatternSource: POPUP_CLOSE_PATTERN_SOURCE,
  }).catch(() => []);
  // Some modals only close from the keyboard.
  await page.keyboard.press('Escape').catch(() => {});
  if (results.length > 0) await page.waitForTimeout(500);
  return results;
}

module.exports = {
  POPUP_ATTRIBUTE,
  capturePopupLayers,
  findPopupLayers,
  hidePopupLayers,
  popupCvCapturePath,
};
