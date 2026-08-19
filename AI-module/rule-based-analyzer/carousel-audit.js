'use strict';

const { enrichAxeResultsWithLocators } = require('./artifact');

const AUDIT_ATTRIBUTES = [
  'data-ua-audit-carousel-id',
  'data-ua-audit-slide-index',
  'data-ua-audit-slide-count',
];

const DEFAULT_LIMITS = Object.freeze({
  maxCarousels: 12,
  maxSlidesPerCarousel: 20,
  maxStates: 60,
});

function boundedPositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeLimits(options = {}) {
  return {
    maxCarousels: boundedPositiveInteger(
      options.maxCarousels,
      DEFAULT_LIMITS.maxCarousels,
    ),
    maxSlidesPerCarousel: boundedPositiveInteger(
      options.maxSlidesPerCarousel,
      DEFAULT_LIMITS.maxSlidesPerCarousel,
    ),
    maxStates: boundedPositiveInteger(options.maxStates, DEFAULT_LIMITS.maxStates),
  };
}

function nodeFingerprint(ruleId, node) {
  const context = node?.locator?.carouselContext || null;
  return JSON.stringify([
    ruleId,
    node?.target || [],
    node?.html || '',
    node?.failureSummary || '',
    context
      ? [context.carouselId, context.slideIndex, context.slideCount]
      : null,
  ]);
}

function mergeRuleGroup(targetResults, additionalResults) {
  const byRule = new Map((targetResults || []).map(result => [result.id, result]));
  for (const incoming of additionalResults || []) {
    const existing = byRule.get(incoming.id);
    if (!existing) {
      const copy = { ...incoming, nodes: [...(incoming.nodes || [])] };
      targetResults.push(copy);
      byRule.set(copy.id, copy);
      continue;
    }

    const seen = new Set(
      (existing.nodes || []).map(node => nodeFingerprint(existing.id, node)),
    );
    if (!Array.isArray(existing.nodes)) {
      existing.nodes = [];
    }
    for (const node of incoming.nodes || []) {
      const fingerprint = nodeFingerprint(incoming.id, node);
      if (seen.has(fingerprint)) {
        continue;
      }
      seen.add(fingerprint);
      existing.nodes.push(node);
    }
  }
}

function mergeAxeResults(target, addition) {
  for (const group of ['violations', 'passes', 'incomplete', 'inapplicable']) {
    if (!Array.isArray(target[group])) {
      target[group] = [];
    }
    mergeRuleGroup(target[group], addition[group] || []);
  }
  return target;
}

function managerKey() {
  return `__ua_carousel_audit_${process.pid}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
}

async function initializeFrameManager(frame, payload) {
  return frame.evaluate(config => {
    const ATTR_CAROUSEL_ID = 'data-ua-audit-carousel-id';
    const ATTR_SLIDE_INDEX = 'data-ua-audit-slide-index';
    const ATTR_SLIDE_COUNT = 'data-ua-audit-slide-count';
    const auditAttributes = [ATTR_CAROUSEL_ID, ATTR_SLIDE_INDEX, ATTR_SLIDE_COUNT];
    const snapshotAttributes = [
      'style',
      'class',
      'aria-current',
      'aria-hidden',
      'hidden',
      'inert',
      'tabindex',
    ];

    const collectOpenRoots = () => {
      const roots = [document];
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        for (const element of roots[rootIndex].querySelectorAll('*')) {
          if (element.shadowRoot && element.shadowRoot.mode === 'open') {
            roots.push(element.shadowRoot);
          }
        }
      }
      return roots;
    };

    const roots = collectOpenRoots();
    for (const root of roots) {
      for (const element of root.querySelectorAll(
        `[${ATTR_CAROUSEL_ID}],[${ATTR_SLIDE_INDEX}],[${ATTR_SLIDE_COUNT}]`,
      )) {
        for (const attribute of auditAttributes) {
          element.removeAttribute(attribute);
        }
      }
    }

    const nextComposedParent = element => {
      if (element.parentElement) {
        return element.parentElement;
      }
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    };

    const isRendered = element => {
      if (!(element instanceof Element)) {
        return false;
      }
      let current = element;
      while (current instanceof Element) {
        const style = getComputedStyle(current);
        if (style.display === 'none'
            || style.visibility === 'hidden'
            || style.visibility === 'collapse'
            || Number.parseFloat(style.opacity || '1') === 0) {
          return false;
        }
        current = nextComposedParent(current);
      }
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return true;
      }
      return Array.from(element.querySelectorAll('*')).some(descendant => {
        const style = getComputedStyle(descendant);
        if (style.display === 'none'
            || style.visibility === 'hidden'
            || style.visibility === 'collapse') {
          return false;
        }
        const childRect = descendant.getBoundingClientRect();
        return childRect.width > 0 && childRect.height > 0;
      });
    };

    const truthyMarker = (element, attribute) => {
      if (!element.hasAttribute(attribute)) {
        return false;
      }
      const value = (element.getAttribute(attribute) || '').trim().toLowerCase();
      return value !== 'false' && value !== '0';
    };
    const isClone = element => (
      element.matches('.swiper-slide-duplicate,.slick-cloned,.is-clone')
      || truthyMarker(element, 'data-clone')
      || truthyMarker(element, 'data-duplicate')
    );

    const standardSlides = (wrapper, type) => {
      const selector = type === 'swiper'
        ? '.swiper-slide'
        : type === 'slick'
          ? '.slick-slide'
          : '.splide__slide';
      return Array.from(wrapper.children)
        .filter(child => child instanceof Element && child.matches(selector));
    };

    const genericSlides = wrapper => Array.from(wrapper.children).filter(child => (
      child instanceof Element
      && child.matches(
        '[data-slide],[aria-roledescription="slide"],.carousel-slide,.slide',
      )
    ));

    const candidates = [];
    const seenWrappers = new Set();
    const pushCandidate = (wrapper, type, allSlides, rootElement) => {
      if (!(wrapper instanceof Element) || seenWrappers.has(wrapper)) {
        return;
      }
      seenWrappers.add(wrapper);
      for (const slide of allSlides) {
        for (const attribute of auditAttributes) {
          slide.removeAttribute(attribute);
        }
      }
      const slides = allSlides.filter(slide => !isClone(slide));
      if (slides.length < 2) {
        return;
      }
      candidates.push({
        wrapper,
        root: rootElement instanceof Element ? rootElement : wrapper,
        type,
        allSlides,
        slides,
      });
    };

    for (const root of roots) {
      for (const wrapper of root.querySelectorAll(
        '.swiper-wrapper,.slick-track,.splide__list',
      )) {
        const type = wrapper.matches('.swiper-wrapper')
          ? 'swiper'
          : wrapper.matches('.slick-track')
            ? 'slick'
            : 'splide';
        const rootSelector = type === 'swiper'
          ? '.swiper'
          : type === 'slick'
            ? '.slick-slider'
            : '.splide';
        pushCandidate(
          wrapper,
          type,
          standardSlides(wrapper, type),
          wrapper.closest(rootSelector) || wrapper.parentElement,
        );
      }

      for (const genericRoot of root.querySelectorAll(
        '[data-carousel],[aria-roledescription="carousel"],.carousel,.slider',
      )) {
        if (genericRoot.querySelector('.swiper-wrapper,.slick-track,.splide__list')) {
          continue;
        }
        const directTrack = Array.from(genericRoot.children).find(child => (
          child instanceof Element
          && child.matches('[data-carousel-track],.carousel-track,.slides')
        ));
        const wrapper = directTrack || genericRoot;
        pushCandidate(wrapper, 'generic', genericSlides(wrapper), genericRoot);
      }
    }

    const snapshot = element => ({
      element,
      computedDisplay: getComputedStyle(element).display,
      attributes: Object.fromEntries(snapshotAttributes.map(attribute => [
        attribute,
        element.hasAttribute(attribute) ? element.getAttribute(attribute) : null,
      ])),
    });
    const restoreSnapshot = entry => {
      for (const [attribute, value] of Object.entries(entry.attributes)) {
        if (value === null) {
          entry.element.removeAttribute(attribute);
        } else {
          entry.element.setAttribute(attribute, value);
        }
      }
    };
    const deepestActiveElement = () => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };

    const manager = {
      activeElement: deepestActiveElement(),
      carousels: [],
      cloneSnapshots: [...new Set(candidates.flatMap(candidate => (
        candidate.allSlides.filter(isClone)
      )))].map(snapshot),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    let skippedHidden = 0;
    let skippedOversized = 0;
    let skippedLimit = 0;

    const restoreScroll = () => {
      try {
        window.scrollTo(manager.scrollX, manager.scrollY);
      } catch { }
    };

    const restoreFocus = () => {
      try {
        if (manager.activeElement?.isConnected
            && deepestActiveElement() !== manager.activeElement) {
          manager.activeElement.focus({ preventScroll: true });
        }
      } catch { }
    };

    const annotate = carousel => {
      carousel.slides.forEach((slide, slideIndex) => {
        slide.setAttribute(ATTR_CAROUSEL_ID, String(carousel.id));
        slide.setAttribute(ATTR_SLIDE_INDEX, String(slideIndex));
        slide.setAttribute(ATTR_SLIDE_COUNT, String(carousel.slides.length));
      });
    };

    const initialSlideIndex = candidate => {
      const explicitlyActive = candidate.slides.findIndex(slide => (
        slide.matches(
          '.swiper-slide-active,.slick-current,.is-active,[aria-current="true"]',
        )
        || slide.getAttribute('aria-hidden') === 'false'
      ));
      if (explicitlyActive >= 0) {
        return explicitlyActive;
      }
      const rendered = candidate.slides.findIndex(isRendered);
      return rendered >= 0 ? rendered : 0;
    };

    const suppressAllClones = () => {
      for (const entry of manager.cloneSnapshots) {
        entry.element.style.setProperty('display', 'none', 'important');
        entry.element.setAttribute('aria-hidden', 'true');
        entry.element.setAttribute('inert', '');
      }
    };

    const restoreCarousel = (carousel, suppressClones = true) => {
      restoreSnapshot(carousel.wrapperSnapshot);
      for (const entry of carousel.slideSnapshots) {
        restoreSnapshot(entry);
      }
      annotate(carousel);
      if (suppressClones) {
        suppressAllClones();
      }
      restoreScroll();
    };

    for (const candidate of candidates) {
      if (!isRendered(candidate.root) && !isRendered(candidate.wrapper)) {
        skippedHidden += 1;
        continue;
      }
      if (candidate.slides.length > config.maxSlidesPerCarousel) {
        skippedOversized += 1;
        continue;
      }
      const baselineSlideIndex = initialSlideIndex(candidate);
      const additionalStateCount = candidate.slides.length - 1;
      if (manager.carousels.length >= config.remainingCarousels
          || additionalStateCount > config.remainingStates) {
        skippedLimit += 1;
        continue;
      }

      const carousel = {
        ...candidate,
        id: config.firstCarouselId + manager.carousels.length,
        baselineSlideIndex,
        wrapperSnapshot: snapshot(candidate.wrapper),
        slideSnapshots: candidate.allSlides.map(snapshot),
      };
      const snapshotBySlide = new Map(
        carousel.slideSnapshots.map(entry => [entry.element, entry]),
      );
      const visibleDisplay = carousel.slides
        .map(slide => snapshotBySlide.get(slide)?.computedDisplay)
        .find(display => display && display !== 'none') || 'block';
      carousel.activeDisplays = carousel.slideSnapshots.map(entry => (
        entry.computedDisplay && entry.computedDisplay !== 'none'
          ? entry.computedDisplay
          : visibleDisplay
      ));
      manager.carousels.push(carousel);
      annotate(carousel);
      config.remainingStates -= additionalStateCount;
    }

    manager.activate = (carouselIndex, slideIndex) => {
      const carousel = manager.carousels[carouselIndex];
      if (!carousel || slideIndex < 0 || slideIndex >= carousel.slides.length) {
        return { rendered: false };
      }
      restoreCarousel(carousel);
      carousel.wrapper.style.setProperty('transform', 'none', 'important');
      carousel.wrapper.style.setProperty('transition', 'none', 'important');

      carousel.allSlides.forEach((slide, allSlideIndex) => {
        const logicalIndex = carousel.slides.indexOf(slide);
        const active = logicalIndex === slideIndex;
        if (!active) {
          slide.style.setProperty('display', 'none', 'important');
          slide.setAttribute('aria-hidden', 'true');
          slide.setAttribute('inert', '');
          return;
        }
        slide.removeAttribute('hidden');
        slide.removeAttribute('inert');
        slide.setAttribute('aria-hidden', 'false');
        slide.style.setProperty(
          'display',
          carousel.activeDisplays[allSlideIndex],
          'important',
        );
        slide.style.setProperty('visibility', 'visible', 'important');
        slide.style.setProperty('opacity', '1', 'important');
        slide.style.setProperty('position', 'relative', 'important');
        slide.style.setProperty('transform', 'none', 'important');
        slide.style.setProperty('left', '0', 'important');
        slide.style.setProperty('right', 'auto', 'important');
        slide.style.setProperty('top', '0', 'important');
        slide.style.setProperty('bottom', 'auto', 'important');
        slide.style.setProperty('width', '100%', 'important');
      });

      const activeSlide = carousel.slides[slideIndex];
      return {
        carouselId: carousel.id,
        slideIndex,
        slideCount: carousel.slides.length,
        type: carousel.type,
        rendered: isRendered(activeSlide),
      };
    };
    manager.prepareBaseline = () => {
      suppressAllClones();
      restoreScroll();
    };
    manager.restore = carouselIndex => {
      const carousel = manager.carousels[carouselIndex];
      if (carousel) {
        restoreCarousel(carousel);
      }
    };
    manager.finish = () => {
      for (const carousel of manager.carousels) {
        restoreCarousel(carousel, false);
      }
      for (const entry of manager.cloneSnapshots) {
        restoreSnapshot(entry);
      }
      restoreFocus();
      restoreScroll();
    };

    Object.defineProperty(window, config.managerKey, {
      configurable: true,
      enumerable: false,
      value: manager,
      writable: false,
    });

    return {
      accepted: manager.carousels.map((carousel, localIndex) => ({
        carouselId: carousel.id,
        localIndex,
        baselineSlideIndex: carousel.baselineSlideIndex,
        slideCount: carousel.slides.length,
        type: carousel.type,
      })),
      detected: candidates.length,
      skippedHidden,
      skippedLimit,
      skippedOversized,
    };
  }, payload);
}

async function prepareManagers(page, limits) {
  const key = managerKey();
  const managers = [];
  const summary = {
    version: 'carousel-state-v1',
    carouselsDetected: 0,
    carouselsScanned: 0,
    statesScanned: 0,
    statesSkippedUnrenderable: 0,
    frameworks: { generic: 0, slick: 0, splide: 0, swiper: 0 },
    skipped: { hidden: 0, limit: 0, oversized: 0 },
    limits: { ...limits },
  };
  let nextCarouselId = 1;
  let remainingCarousels = limits.maxCarousels;
  let remainingStates = limits.maxStates;

  for (const frame of page.frames()) {
    try {
      const initialized = await initializeFrameManager(frame, {
        firstCarouselId: nextCarouselId,
        managerKey: key,
        maxSlidesPerCarousel: limits.maxSlidesPerCarousel,
        remainingCarousels,
        remainingStates,
      });
      managers.push({ frame, key, carousels: initialized.accepted });
      summary.carouselsDetected += initialized.detected;
      summary.skipped.hidden += initialized.skippedHidden;
      summary.skipped.limit += initialized.skippedLimit;
      summary.skipped.oversized += initialized.skippedOversized;
      for (const carousel of initialized.accepted) {
        summary.carouselsScanned += 1;
        summary.frameworks[carousel.type] += 1;
        nextCarouselId += 1;
        remainingCarousels -= 1;
        remainingStates -= carousel.slideCount - 1;
      }
    } catch {
      // A frame can detach or reject evaluation while the main page remains
      // auditable. Other frames and the base axe scan still proceed.
    }
  }
  return { key, managers, summary };
}

async function invokeManager(frame, key, method, ...args) {
  return frame.evaluate(({ managerKey: keyName, methodName, values }) => {
    const manager = window[keyName];
    if (!manager || typeof manager[methodName] !== 'function') {
      return null;
    }
    return manager[methodName](...values);
  }, { managerKey: key, methodName: method, values: args });
}

async function finishManagers(managers, key) {
  await Promise.all(managers.map(async ({ frame }) => {
    try {
      await invokeManager(frame, key, 'finish');
      await frame.evaluate(keyName => {
        try {
          delete window[keyName];
        } catch { }
      }, key);
    } catch { }
  }));
}

/**
 * Run axe once for the original state and once for every bounded non-baseline
 * logical slide.
 * The function never invokes carousel APIs or click handlers. During traversal,
 * network requests are aborted and only scanner-owned inline state is changed.
 */
async function analyzeWithCarouselStates(page, scanPage, options = {}) {
  if (typeof scanPage !== 'function') {
    throw new TypeError('scanPage must be a function returning axe results');
  }

  const limits = normalizeLimits(options);
  const blockNetwork = route => route.abort('blockedbyclient');
  let routeInstalled = false;
  let prepared = { key: null, managers: [], summary: null };
  try {
    await page.route('**/*', blockNetwork);
    routeInstalled = true;
    prepared = await prepareManagers(page, limits);

    await Promise.all(prepared.managers.map(({ frame }) => (
      invokeManager(frame, prepared.key, 'prepareBaseline').catch(() => null)
    )));

    const merged = await scanPage();
    await enrichAxeResultsWithLocators(page, merged);

    for (const manager of prepared.managers) {
      for (const carousel of manager.carousels) {
        for (let slideIndex = 0; slideIndex < carousel.slideCount; slideIndex += 1) {
          if (slideIndex === carousel.baselineSlideIndex) {
            continue;
          }
          let activated = null;
          try {
            activated = await invokeManager(
              manager.frame,
              prepared.key,
              'activate',
              carousel.localIndex,
              slideIndex,
            );
            if (!activated?.rendered) {
              prepared.summary.statesSkippedUnrenderable += 1;
              continue;
            }
            const stateResults = await scanPage();
            await enrichAxeResultsWithLocators(page, stateResults);
            mergeAxeResults(merged, stateResults);
            prepared.summary.statesScanned += 1;
          } finally {
            await invokeManager(
              manager.frame,
              prepared.key,
              'restore',
              carousel.localIndex,
            ).catch(() => {});
          }
        }
      }
    }

    merged.carouselAudit = prepared.summary;
    return merged;
  } finally {
    if (prepared.key) {
      await finishManagers(prepared.managers, prepared.key);
    }
    if (routeInstalled) {
      await page.unroute('**/*', blockNetwork).catch(() => {});
    }
  }
}

module.exports = {
  AUDIT_ATTRIBUTES,
  DEFAULT_LIMITS,
  analyzeWithCarouselStates,
  mergeAxeResults,
  normalizeLimits,
};
