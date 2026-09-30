'use strict';

// Regions whose content is not the site's own stable content are excluded from
// every check and from the score, and reported separately:
//   AD      third-party advertising, recognised by ad-serving markers even when
//           the same ad happens to be shown on both loads;
//   DYNAMIC content that differed between two loads of the page (news, product
//           and recommendation feeds). Site carousels are content the site owns
//           and are handled by carousel-audit.js, so they are never DYNAMIC.
//   POPUP   a layer popup that covered the page on arrival. popup-layers.js
//           scans it while open, then closes it before the page is analyzed.
// Stable banners and ordinary content stay in the analysis.

const { POPUP_ATTRIBUTE } = require('./popup-layers');

const EXCLUDED_REGION_ATTRIBUTE = 'data-ua-excluded-region';
const EXCLUSION_REASONS = Object.freeze(['AD', 'DYNAMIC', 'POPUP']);

const AD_ELEMENT_SELECTORS = [
  'ins.adsbygoogle', '[data-ad-slot]', '[data-ad-client]', '[data-google-query-id]',
  '[id^="google_ads_iframe"]', '[id$="_tgtLREC"]', '[aria-label="광고"]', '[aria-label="Advertisement" i]',
];
// Ads drawn in the page itself (not in an iframe) that announce themselves in
// their accessible name, like Naver's headline ad image alt="[광고]멤버십 …".
// The link around such an image is the ad, so the link is marked.
const AD_LABEL_SELECTOR = 'img[alt^="[광고]"], [aria-label^="[광고]"]';
const AD_FRAME_SOURCE = [
  'doubleclick\\.net', 'googlesyndication\\.com', 'googleadservices\\.com', 'adservice\\.google',
  'adnxs\\.com', 'criteo\\.', 'taboola\\.com', 'outbrain\\.com',
  'pstatic\\.net/melona', 'veta\\.naver\\.com', 'ad\\.naver\\.com', 'adcr\\.naver\\.com',
].join('|');

// A changed element is widened to its container while at least half of the
// container's content changed, up to a quarter of the page. A news list with a
// few repeated headlines is therefore excluded as a whole, not item by item.
const DYNAMIC_CONTAINER_MIN_CHANGED_SHARE = 0.5;
const DYNAMIC_CONTAINER_MAX_PAGE_SHARE = 0.25;
// A widened region never swallows the site's own controls that showed the same
// content on both loads, such as the tab bar above a changing feed.
const STABLE_CONTROL_SELECTOR = [
  'a[href]', 'button', 'summary', 'input', 'select', 'textarea',
  '[role="tab"]', '[role="button"]', '[role="link"]', '[role="menuitem"]',
].join(',');

// Page-side worker. `collect` returns a content signature per structural key
// for every element that carries its own content; `mark` marks the excluded
// regions and returns their document rectangles. Both modes share one key
// function so the two loads are compared with the same identity.
function inspectRegions({
  mode, attribute, popupAttribute, adSelectors, adLabelSelector, adFrameSource, changedKeys, minChangedShare,
  maxPageShare, stableControlSelector,
}) {
  const body = document.body;
  if (!body) return mode === 'collect' ? {} : [];
  const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const signatureOf = (element) => {
    if (skipped.has(element.tagName)) return '';
    let signature = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) signature += node.textContent;
    }
    signature = signature.replace(/\s+/g, ' ').trim();
    if (element.tagName === 'IMG') {
      // Lazy loaders swap the real URL into src later; prefer the stable one.
      const source = element.getAttribute('data-src') || element.getAttribute('data-original')
        || element.getAttribute('src') || '';
      signature += ` img:${source.startsWith('data:') ? '' : source}`;
    }
    if (element.tagName === 'IFRAME') signature += ` frame:${element.getAttribute('src') || ''}`;
    return signature.trim();
  };
  const keyOf = (element) => {
    const parts = [];
    for (let current = element; current && current !== body; current = current.parentElement) {
      // Generated ids (long digit runs) are not stable across loads.
      if (current.id && !/\d{4,}/.test(current.id)) {
        parts.unshift(`#${current.id}`);
        return parts.join('>');
      }
      let index = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === current.tagName) index += 1;
      }
      parts.unshift(`${current.tagName.toLowerCase()}:${index}`);
    }
    parts.unshift('body');
    return parts.join('>');
  };

  if (mode === 'collect') {
    const signatures = {};
    for (const element of body.querySelectorAll('*')) {
      const signature = signatureOf(element);
      if (signature) signatures[keyOf(element)] = signature;
    }
    return signatures;
  }

  const mark = (element, reason) => {
    if (!element.closest(`[${attribute}]`)) element.setAttribute(attribute, reason);
  };
  const adFrame = new RegExp(adFrameSource, 'i');
  for (const element of body.querySelectorAll(adSelectors.join(','))) mark(element, 'AD');
  for (const element of body.querySelectorAll(adLabelSelector)) mark(element.closest('a[href]') || element, 'AD');
  for (const frame of body.querySelectorAll('iframe')) {
    if (adFrame.test(`${frame.getAttribute('src') || ''} ${frame.getAttribute('name') || ''}`)) mark(frame, 'AD');
  }

  const changed = new Set(changedKeys);
  const totals = new Map();
  const changes = new Map();
  const changedElements = [];
  const stableControls = new Set();
  const holdsStableControl = new Set();
  const countAncestors = (map, element) => {
    for (let parent = element.parentElement; parent && parent !== body; parent = parent.parentElement) {
      map.set(parent, (map.get(parent) || 0) + 1);
    }
  };
  for (const element of body.querySelectorAll('*')) {
    if (!signatureOf(element)) continue;
    countAncestors(totals, element);
    if (changed.has(keyOf(element))) {
      changedElements.push(element);
      countAncestors(changes, element);
      continue;
    }
    const control = element.closest(stableControlSelector);
    if (!control || stableControls.has(control)) continue;
    stableControls.add(control);
    for (let current = control; current && current !== body; current = current.parentElement) {
      holdsStableControl.add(current);
    }
  }
  // Excludes the region except the subtrees that hold a stable control.
  const markDynamic = (region) => {
    if (!holdsStableControl.has(region)) {
      mark(region, 'DYNAMIC');
      return;
    }
    if (stableControls.has(region)) return;
    for (const child of region.children) markDynamic(child);
  };
  const pageArea = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
  const area = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  };
  for (const element of changedElements) {
    // Site carousels rotate by design; carousel-audit.js checks every slide.
    // A closed layer popup is reported as POPUP, not as changing content.
    if (element.closest('[data-ua-audit-slide-index]') || element.closest(`[${attribute}]`)
        || element.closest(`[${popupAttribute}]`)) continue;
    let region = element;
    for (let parent = element.parentElement; parent && parent !== body; parent = parent.parentElement) {
      if (parent.closest('[data-ua-audit-slide-index]')
          || (changes.get(parent) || 0) / (totals.get(parent) || 1) < minChangedShare
          || area(parent) > pageArea * maxPageShare) break;
      region = parent;
    }
    markDynamic(region);
  }

  const regions = [];
  for (const element of body.querySelectorAll(`[${attribute}]`)) {
    if (element.parentElement?.closest(`[${attribute}]`)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    regions.push({
      reason: element.getAttribute(attribute),
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  return regions;
}

const inspectionOptions = (mode, changedKeys = []) => ({
  mode,
  attribute: EXCLUDED_REGION_ATTRIBUTE,
  popupAttribute: POPUP_ATTRIBUTE,
  adSelectors: AD_ELEMENT_SELECTORS,
  adLabelSelector: AD_LABEL_SELECTOR,
  adFrameSource: AD_FRAME_SOURCE,
  changedKeys,
  minChangedShare: DYNAMIC_CONTAINER_MIN_CHANGED_SHARE,
  maxPageShare: DYNAMIC_CONTAINER_MAX_PAGE_SHARE,
  stableControlSelector: STABLE_CONTROL_SELECTOR,
});

async function collectContentSignatures(page) {
  return page.evaluate(inspectRegions, inspectionOptions('collect')).catch(() => null);
}

// Loads the page again in the same browser context and returns its content
// signatures, or null when the comparison load fails.
async function loadComparisonSignatures(context, url, { settleMs = 5000 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(settleMs);
    return await collectContentSignatures(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// A comparison load that shares less than this share of the analysed page's
// content keys is a different page (error, block or consent screen), not a
// second visit, and cannot tell stable content from changing content.
const COMPARISON_MIN_SHARED_KEY_SHARE = 0.5;

// Content that differs, or exists in only one of the loads, is changing
// content. A feed that switches its layout or tab between visits has no
// matching keys at all, so absence counts as a change. Content that only moved
// inside the same id-anchored block is unchanged: a tab bar wraps whichever tab
// is selected, which shifts the tabs' keys while their labels stay the same.
function changedContentKeys(current, comparison) {
  if (!current || !comparison) return [];
  const keys = Object.keys(current);
  const has = (key) => Object.prototype.hasOwnProperty.call(comparison, key);
  const shared = keys.filter(has).length;
  if (keys.length === 0 || shared / keys.length < COMPARISON_MIN_SHARED_KEY_SHARE) return [];
  const anchorOf = (key) => key.split('>')[0];
  const comparisonByAnchor = new Map();
  for (const [key, signature] of Object.entries(comparison)) {
    const anchor = anchorOf(key);
    if (!comparisonByAnchor.has(anchor)) comparisonByAnchor.set(anchor, new Set());
    comparisonByAnchor.get(anchor).add(signature);
  }
  return keys.filter((key) => (!has(key) || comparison[key] !== current[key])
    && !comparisonByAnchor.get(anchorOf(key))?.has(current[key]));
}

// Marks excluded regions in the analysed document and returns their document
// rectangles. The attribute stays in the DOM snapshot, so the text analyzer
// skips the same regions.
async function markExcludedRegions(page, changedKeys = []) {
  return page.evaluate(inspectRegions, inspectionOptions('mark', changedKeys));
}

// Splits axe violations into those scored normally and those found inside an
// excluded region, grouped by the region's reason.
async function partitionAxeResultsByRegion(page, axeResults) {
  const targets = axeResults.violations.map((rule) => rule.nodes.map((node) => {
    const first = Array.isArray(node.target) ? node.target[0] : null;
    return Array.isArray(first) ? first[0] : first;
  }));
  const reasons = await page.evaluate(({ attribute, popupAttribute, targets }) => targets.map((nodes) => nodes.map((selector) => {
    if (typeof selector !== 'string') return null;
    try {
      const element = document.querySelector(selector);
      if (element?.closest(`[${popupAttribute}]`)) return 'POPUP';
      return element?.closest(`[${attribute}]`)?.getAttribute(attribute) || null;
    } catch {
      return null;
    }
  })), { attribute: EXCLUDED_REGION_ATTRIBUTE, popupAttribute: POPUP_ATTRIBUTE, targets })
    .catch(() => targets.map((nodes) => nodes.map(() => null)));

  const emptyResults = () => ({ ...axeResults, violations: [], passes: [], incomplete: [], inapplicable: [] });
  const included = { ...axeResults, violations: [] };
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, emptyResults()]));
  axeResults.violations.forEach((rule, ruleIndex) => {
    const groups = new Map();
    rule.nodes.forEach((node, nodeIndex) => {
      const reason = EXCLUSION_REASONS.includes(reasons[ruleIndex][nodeIndex]) ? reasons[ruleIndex][nodeIndex] : null;
      if (!groups.has(reason)) groups.set(reason, []);
      groups.get(reason).push(node);
    });
    for (const [reason, nodes] of groups) {
      (reason ? excluded[reason] : included).violations.push({ ...rule, nodes });
    }
  });
  return { included, excluded };
}

// Adds the violations found by scanning the open popups (before they were
// closed) to the POPUP group, skipping nodes the page scan already placed there.
function addPopupViolations(excluded, popupResults) {
  if (!popupResults) return excluded;
  const group = excluded.POPUP;
  const seen = new Set(group.violations.flatMap((rule) =>
    rule.nodes.map((node) => `${rule.id}|${JSON.stringify(node.target)}`)));
  for (const rule of popupResults.violations || []) {
    const nodes = rule.nodes.filter((node) => !seen.has(`${rule.id}|${JSON.stringify(node.target)}`));
    if (nodes.length > 0) group.violations.push({ ...rule, nodes });
  }
  return excluded;
}

module.exports = {
  addPopupViolations,
  EXCLUDED_REGION_ATTRIBUTE,
  EXCLUSION_REASONS,
  changedContentKeys,
  collectContentSignatures,
  loadComparisonSignatures,
  markExcludedRegions,
  partitionAxeResultsByRegion,
};
