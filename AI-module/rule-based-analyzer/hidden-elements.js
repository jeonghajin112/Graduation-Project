'use strict';

// Marks elements that are not rendered at the analysis viewport (display:none,
// the hidden attribute, visibility:hidden, content-visibility:hidden) before
// the DOM snapshot is written. Such content reaches no user in this state:
// axe skips it, the screenshot does not show it, and the text analyzer skips
// the marked elements so all engines evaluate the same page.
// Screen-reader-only text (clipped or moved off screen) and transparent
// elements are still read aloud, so they are not marked. Carousel slides are
// checked slide by slide by carousel-audit.js and are never marked.

const HIDDEN_ELEMENT_ATTRIBUTE = 'data-ua-hidden';
const CAROUSEL_SLIDE_SELECTOR = [
  '.swiper-slide', '.slick-slide', '.splide__slide', '[data-slide]',
  '[aria-roledescription="slide"]', '.carousel-slide', '.slide',
].join(',');

function markHiddenInPage({ attribute, slideSelector }) {
  const body = document.body;
  if (!body) return 0;
  const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  let marked = 0;
  for (const element of body.querySelectorAll('*')) {
    if (skipped.has(element.tagName) || element.closest(`[${attribute}]`)) continue;
    if (element.closest(slideSelector)) continue;
    const style = getComputedStyle(element);
    let hidden = style.display === 'none' || style.contentVisibility === 'hidden';
    if (!hidden && (style.visibility === 'hidden' || style.visibility === 'collapse')) {
      // A child can override visibility; keep such subtrees readable.
      const parentVisible = !element.parentElement
        || getComputedStyle(element.parentElement).visibility === 'visible';
      hidden = parentVisible && !Array.from(element.querySelectorAll('*')).slice(0, 2000)
        .some(descendant => getComputedStyle(descendant).visibility === 'visible');
    }
    if (!hidden) continue;
    element.setAttribute(attribute, 'true');
    marked += 1;
  }
  return marked;
}

async function markHiddenElements(page) {
  return page.evaluate(markHiddenInPage, {
    attribute: HIDDEN_ELEMENT_ATTRIBUTE,
    slideSelector: CAROUSEL_SLIDE_SELECTOR,
  }).catch(() => 0);
}

module.exports = {
  HIDDEN_ELEMENT_ATTRIBUTE,
  markHiddenElements,
};
