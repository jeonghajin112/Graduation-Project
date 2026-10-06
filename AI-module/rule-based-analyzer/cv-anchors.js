'use strict';

// The CV analyzer reads text from a full-page screenshot, so its findings only
// carry screenshot boxes. Boxes drift as soon as content above them changes
// height (feeds, banners) or the viewer width differs, so the live report must
// not place markers by coordinates alone. At the moment of the CV capture this
// collects every visible element with its document rectangle, a selector and a
// content signature. run_all.py attaches the smallest element under each CV
// box to the finding; the live report then follows that element and hides the
// marker when the element's content is no longer the analysed content.

const MAX_ANCHOR_ELEMENTS = 20000;
const MAX_ANCHOR_PAGE_SHARE = 0.25;
const MAX_SIGNATURE_TEXT_LENGTH = 160;
const MAX_SIGNATURE_IMAGE_LENGTH = 2048;
const MAX_SNIPPET_LENGTH = 600;

function inspectAnchors({ maxElements, maxPageShare, maxTextLength, maxImageLength, maxSnippetLength }) {
  const body = document.body;
  if (!body) return [];
  const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'WBR']);
  const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&'));
  const selectors = new Map([[document.documentElement, 'html']]);
  const selectorOf = (element) => {
    if (selectors.has(element)) return selectors.get(element);
    let selector;
    // Generated ids (long digit runs) are not stable across visits.
    if (element.id && !/\d{4,}/.test(element.id)
        && document.querySelectorAll(`#${cssEscape(element.id)}`).length === 1) {
      selector = `#${cssEscape(element.id)}`;
    } else {
      const parent = element.parentElement;
      // localName keeps the case of SVG elements such as linearGradient.
      const tag = cssEscape(element.localName);
      let index = 0;
      let sameTagSiblings = 0;
      for (const sibling of parent.children) {
        if (sibling.tagName !== element.tagName) continue;
        sameTagSiblings += 1;
        if (sibling === element) index = sameTagSiblings;
      }
      selector = `${selectorOf(parent)} > ${sameTagSiblings > 1 ? `${tag}:nth-of-type(${index})` : tag}`;
    }
    selectors.set(element, selector);
    return selector;
  };
  // Resource identity without scheme and host: the live report serves the
  // same path and query from its session mirror.
  const resourcePath = (value) => {
    if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null;
    try {
      const url = new URL(value, document.baseURI);
      return `${url.pathname}${url.search}`.slice(0, maxImageLength);
    } catch {
      return null;
    }
  };
  const imageOf = (element, style) => {
    if (element.tagName === 'IMG') {
      return resourcePath(element.getAttribute('data-src') || element.getAttribute('data-original')
        || element.currentSrc || element.getAttribute('src'));
    }
    if (element.tagName === 'VIDEO') return resourcePath(element.getAttribute('poster'));
    if (element.tagName === 'IFRAME') return resourcePath(element.getAttribute('src'));
    const background = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(style.backgroundImage || '');
    return background ? resourcePath(background[2]) : null;
  };
  const snippetOf = (element) => {
    const shallow = element.cloneNode(false);
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) shallow.appendChild(node.cloneNode(false));
    }
    return shallow.outerHTML.slice(0, maxSnippetLength);
  };

  const pageArea = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
  const anchors = [];
  for (const element of body.querySelectorAll('*')) {
    if (anchors.length >= maxElements) break;
    if (skipped.has(element.tagName)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.width * rect.height > pageArea * maxPageShare) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || style.display === 'contents') continue;
    anchors.push({
      x: Math.round((rect.left + window.scrollX) * 100) / 100,
      y: Math.round((rect.top + window.scrollY) * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      selector: selectorOf(element),
      text: (element.textContent || '').normalize('NFKC').replace(/\s+/g, '').slice(0, maxTextLength),
      image: imageOf(element, style),
      htmlSnippet: snippetOf(element),
    });
  }
  return anchors;
}

// Returns the anchor candidates of the page as it is when called, or [] when
// the page cannot be inspected.
async function collectCvAnchors(page) {
  return page.evaluate(inspectAnchors, {
    maxElements: MAX_ANCHOR_ELEMENTS,
    maxPageShare: MAX_ANCHOR_PAGE_SHARE,
    maxTextLength: MAX_SIGNATURE_TEXT_LENGTH,
    maxImageLength: MAX_SIGNATURE_IMAGE_LENGTH,
    maxSnippetLength: MAX_SNIPPET_LENGTH,
  }).catch(() => []);
}

module.exports = { collectCvAnchors, MAX_SIGNATURE_TEXT_LENGTH };
