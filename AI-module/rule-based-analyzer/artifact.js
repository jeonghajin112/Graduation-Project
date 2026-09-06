'use strict';

const MAX_FRAME_URL_LENGTH = 2048;
const MAX_HTML_SNIPPET_LENGTH = 32000;

function asSelectorList(component) {
  if (typeof component === 'string') {
    return component.trim() ? [component] : [];
  }
  if (Array.isArray(component)) {
    return component.filter(selector => typeof selector === 'string' && selector.trim());
  }
  return [];
}

function normalizeAxeTarget(target) {
  if (!Array.isArray(target)) {
    return [];
  }
  return target
    .map(component => (Array.isArray(component) ? [...component] : component))
    .filter(component => asSelectorList(component).length > 0);
}

/**
 * Convert axe's cross-frame/cross-shadow selector into an explicit path.
 *
 * axe target examples:
 *   ['#submit']                         -> document element
 *   ['#payment-frame', '#submit']       -> element inside a frame
 *   [['my-widget', '#submit']]          -> element inside an open shadow root
 *
 * frameUrls contains the destination URL for each frame boundary in target.
 */
function buildPathSteps(target, frameUrls = []) {
  const normalized = normalizeAxeTarget(target);
  const steps = [];
  let rootContext = 'DOCUMENT';
  let currentFrameUrl = null;
  let frameIndex = 0;

  normalized.forEach((component, componentIndex) => {
    const selectors = asSelectorList(component);
    const entersFrame = componentIndex < normalized.length - 1;

    selectors.forEach((selector, selectorIndex) => {
      const step = {
        context: selectorIndex === 0 ? rootContext : 'SHADOW_ROOT',
        selector,
      };
      if (rootContext === 'FRAME' && currentFrameUrl) {
        step.frameUrl = currentFrameUrl;
      }
      steps.push(step);
    });

    if (entersFrame) {
      const destinationUrl = frameUrls[frameIndex] || null;
      if (destinationUrl && steps.length > 0) {
        steps[steps.length - 1].frameUrl = destinationUrl;
      }
      rootContext = 'FRAME';
      currentFrameUrl = destinationUrl;
      frameIndex += 1;
    }
  });

  return steps;
}

function redactFrameUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (['data:', 'blob:', 'javascript:', 'file:'].includes(parsed.protocol)) {
      return parsed.protocol;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().slice(0, MAX_FRAME_URL_LENGTH);
  } catch {
    return null;
  }
}

function locatorForCrossTreeSelector(frame, component) {
  const selectors = asSelectorList(component);
  if (selectors.length === 0) {
    return null;
  }

  let locator = frame.locator(selectors[0]).first();
  for (const selector of selectors.slice(1)) {
    // Playwright's CSS locators pierce open shadow roots. Chaining retains the
    // shadow-root boundary represented by axe's nested selector array.
    locator = locator.locator(selector).first();
  }
  return locator;
}

function roundCssPixel(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function intersectRects(first, second) {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

async function clipRectToFrameViewports(rect, targetFrame) {
  let clipped = rect;
  let frame = targetFrame;

  while (frame.parentFrame()) {
    const frameElement = await frame.frameElement();
    const [outerBox, clientBox] = await Promise.all([
      frameElement.boundingBox(),
      frameElement.evaluate(element => ({
        left: element.clientLeft,
        top: element.clientTop,
        width: element.clientWidth,
        height: element.clientHeight,
        outerWidth: element.offsetWidth,
        outerHeight: element.offsetHeight,
        axisAligned: (() => {
          let current = element;
          while (current instanceof Element) {
            const transform = getComputedStyle(current).transform;
            if (transform && transform !== 'none') {
              const matrix = new DOMMatrixReadOnly(transform);
              if (Math.abs(matrix.b) > 0.0001 || Math.abs(matrix.c) > 0.0001
                  || matrix.a <= 0 || matrix.d <= 0) {
                return false;
              }
            }
            current = current.parentElement;
          }
          return true;
        })(),
      })),
    ]);
    if (!outerBox || !clientBox.axisAligned
        || clientBox.width <= 0 || clientBox.height <= 0
        || clientBox.outerWidth <= 0 || clientBox.outerHeight <= 0) {
      return null;
    }

    const scaleX = outerBox.width / clientBox.outerWidth;
    const scaleY = outerBox.height / clientBox.outerHeight;
    const contentBox = {
      x: outerBox.x + clientBox.left * scaleX,
      y: outerBox.y + clientBox.top * scaleY,
      width: clientBox.width * scaleX,
      height: clientBox.height * scaleY,
    };
    // The iframe element itself can be clipped by an overflow/clip ancestor in
    // its parent document. Intersect that rendered visibility with its content
    // box before accepting any child-frame locator.
    const visibleFrameElementBox = await clipRectToOverflowAncestors(frameElement, outerBox);
    const visibleContentBox = visibleFrameElementBox
      ? intersectRects(contentBox, visibleFrameElementBox)
      : null;
    clipped = visibleContentBox ? intersectRects(clipped, visibleContentBox) : null;
    if (!clipped) {
      return null;
    }
    frame = frame.parentFrame();
  }

  return clipped;
}

async function clipRectToOverflowAncestors(targetLocator, topLevelBox) {
  const local = await targetLocator.evaluate(element => {
    const toRect = rect => ({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
    const intersection = (first, second) => {
      const x = Math.max(first.x, second.x);
      const y = Math.max(first.y, second.y);
      const right = Math.min(first.x + first.width, second.x + second.width);
      const bottom = Math.min(first.y + first.height, second.y + second.height);
      return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
    };
    const nextComposedParent = current => {
      if (current.parentElement) {
        return current.parentElement;
      }
      const root = current.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    };
    const isAxisAlignedChain = start => {
      let current = start;
      try {
        while (current instanceof Element) {
          const transform = getComputedStyle(current).transform;
          if (transform && transform !== 'none') {
            const matrix = new DOMMatrixReadOnly(transform);
            if (Math.abs(matrix.b) > 0.0001 || Math.abs(matrix.c) > 0.0001
                || matrix.a <= 0 || matrix.d <= 0) {
              return false;
            }
          }
          current = nextComposedParent(current);
        }
        return true;
      } catch {
        return false;
      }
    };

    const elementRect = toRect(element.getBoundingClientRect());
    if (!isAxisAlignedChain(element)) {
      return { elementRect, clippedRect: null, complexClip: true };
    }
    let clippedRect = elementRect;
    let current = element;
    while (current instanceof Element) {
      const style = getComputedStyle(current);
      // Arbitrary clip paths/legacy clip rectangles cannot be represented as
      // a reliable DOM_RECT. Fail closed instead of pointing at absent pixels.
      if ((style.clipPath && style.clipPath !== 'none')
          || (style.clip && style.clip !== 'auto')) {
        return { elementRect, clippedRect: null, complexClip: true };
      }

      if (current !== element) {
        const clipsX = !['visible', 'unset'].includes(style.overflowX);
        const clipsY = !['visible', 'unset'].includes(style.overflowY);
        if (clipsX || clipsY) {
          const bounds = current.getBoundingClientRect();
          if (current.offsetWidth <= 0 || current.offsetHeight <= 0) {
            return { elementRect, clippedRect: null, complexClip: false };
          }
          const scaleX = bounds.width / current.offsetWidth;
          const scaleY = bounds.height / current.offsetHeight;
          const clipRect = {
            x: clipsX ? bounds.left + current.clientLeft * scaleX : Number.NEGATIVE_INFINITY,
            y: clipsY ? bounds.top + current.clientTop * scaleY : Number.NEGATIVE_INFINITY,
            width: clipsX ? current.clientWidth * scaleX : Number.POSITIVE_INFINITY,
            height: clipsY ? current.clientHeight * scaleY : Number.POSITIVE_INFINITY,
          };
          // Avoid Infinity arithmetic in the common one-axis clipping case.
          if (!clipsX) {
            clipRect.x = clippedRect.x;
            clipRect.width = clippedRect.width;
          }
          if (!clipsY) {
            clipRect.y = clippedRect.y;
            clipRect.height = clippedRect.height;
          }
          clippedRect = intersection(clippedRect, clipRect);
          if (!clippedRect) {
            return { elementRect, clippedRect: null, complexClip: false };
          }
        }
      }
      current = nextComposedParent(current);
    }
    return { elementRect, clippedRect, complexClip: false };
  });

  if (!local.clippedRect || local.complexClip) {
    return null;
  }
  if (local.elementRect.width <= 0 || local.elementRect.height <= 0) {
    return null;
  }

  const scaleX = topLevelBox.width / local.elementRect.width;
  const scaleY = topLevelBox.height / local.elementRect.height;
  return {
    x: topLevelBox.x + (local.clippedRect.x - local.elementRect.x) * scaleX,
    y: topLevelBox.y + (local.clippedRect.y - local.elementRect.y) * scaleY,
    width: local.clippedRect.width * scaleX,
    height: local.clippedRect.height * scaleY,
  };
}

async function resolveAxeNodeLocator(page, node) {
  const target = normalizeAxeTarget(node && node.target);
  const htmlSnippet = node && typeof node.html === 'string'
    ? node.html.slice(0, MAX_HTML_SNIPPET_LENGTH)
    : '';
  const frameUrls = [];
  let frame = page.mainFrame();
  let targetLocator = null;

  try {
    for (let index = 0; index < target.length; index += 1) {
      const locator = locatorForCrossTreeSelector(frame, target[index]);
      if (!locator) {
        break;
      }

      if (index < target.length - 1) {
        const frameElement = await locator.elementHandle();
        const childFrame = frameElement ? await frameElement.contentFrame() : null;
        if (!childFrame) {
          break;
        }
        frameUrls.push(redactFrameUrl(childFrame.url()));
        frame = childFrame;
      } else {
        targetLocator = locator;
      }
    }
  } catch {
    targetLocator = null;
  }

  const locator = {
    kind: 'DOM_RECT',
    pathSteps: buildPathSteps(target, frameUrls),
    x: null,
    y: null,
    width: null,
    height: null,
    coordinateSpace: 'DOCUMENT_CSS_PX',
    visible: false,
    htmlSnippet,
  };

  if (!targetLocator) {
    return locator;
  }

  try {
    const [box, styleVisible, scroll, carouselContext] = await Promise.all([
      targetLocator.boundingBox(),
      targetLocator.isVisible().catch(() => false),
      page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })),
      targetLocator.evaluate(element => {
        const nextComposedParent = current => {
          if (current.parentElement) {
            return current.parentElement;
          }
          const root = current.getRootNode();
          return root instanceof ShadowRoot ? root.host : null;
        };
        let current = element;
        while (current instanceof Element) {
          const carouselId = current.getAttribute('data-ua-audit-carousel-id');
          const slideIndex = current.getAttribute('data-ua-audit-slide-index');
          const slideCount = current.getAttribute('data-ua-audit-slide-count');
          if (/^[1-9]\d*$/.test(carouselId || '')
              && /^(?:0|[1-9]\d*)$/.test(slideIndex || '')
              && /^(?:[2-9]|[1-9]\d+)$/.test(slideCount || '')) {
            const parsed = {
              carouselId: Number(carouselId),
              slideIndex: Number(slideIndex),
              slideCount: Number(slideCount),
            };
            if (Number.isSafeInteger(parsed.carouselId)
                && Number.isSafeInteger(parsed.slideIndex)
                && Number.isSafeInteger(parsed.slideCount)
                && parsed.slideIndex < parsed.slideCount) {
              return parsed;
            }
          }
          current = nextComposedParent(current);
        }
        return null;
      }).catch(() => null),
    ]);

    if (carouselContext) {
      locator.carouselContext = carouselContext;
    }

    const overflowClippedBox = box
      ? await clipRectToOverflowAncestors(targetLocator, box)
      : null;
    const artifactBox = overflowClippedBox
      ? await clipRectToFrameViewports(overflowClippedBox, frame)
      : null;
    locator.visible = Boolean(styleVisible && artifactBox);
    if (locator.visible) {
      locator.x = roundCssPixel(artifactBox.x + scroll.x);
      locator.y = roundCssPixel(artifactBox.y + scroll.y);
      locator.width = roundCssPixel(artifactBox.width);
      locator.height = roundCssPixel(artifactBox.height);
    }
  } catch {
    // A detached node is a valid scan-time outcome. Keep its typed path and
    // explicitly mark it as unresolved instead of dropping the issue.
  }

  return locator;
}

async function pausePageVirtualTime(page) {
  const sessions = [];
  for (const frame of page.frames()) {
    try {
      const session = await page.context().newCDPSession(frame);
      await session.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
      sessions.push(session);
    } catch {
      // Some cross-origin/OOPIF targets may not permit a direct session. The
      // post-capture geometry revalidation below remains the safety net.
    }
  }

  return async () => {
    await Promise.all(sessions.map(async session => {
      await session.send('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget: 1,
      }).catch(() => {});
      await session.detach().catch(() => {});
    }));
  };
}

function clearLocatorRect(locator) {
  locator.visible = false;
  locator.x = null;
  locator.y = null;
  locator.width = null;
  locator.height = null;
}

async function revalidateAxeLocators(page, axeResults, toleranceCssPx = 0.5) {
  for (const group of ['violations', 'incomplete']) {
    for (const result of axeResults[group] || []) {
      for (const node of result.nodes || []) {
        const before = node.locator;
        if (!before || !before.visible) {
          continue;
        }
        const after = await resolveAxeNodeLocator(page, node);
        const stable = after.visible
          && ['x', 'y', 'width', 'height'].every(field => (
            Number.isFinite(before[field])
            && Number.isFinite(after[field])
            && Math.abs(before[field] - after[field]) <= toleranceCssPx
          ));
        if (!stable) {
          clearLocatorRect(before);
        }
      }
    }
  }
  return axeResults;
}

async function enrichAxeResultsWithLocators(page, axeResults) {
  const groups = ['violations', 'incomplete'];
  for (const group of groups) {
    for (const result of axeResults[group] || []) {
      for (const node of result.nodes || []) {
        node.locator = await resolveAxeNodeLocator(page, node);
      }
    }
  }
  return axeResults;
}

async function pauseDocumentAnimations(page) {
  await Promise.all(page.frames().map(frame => frame.evaluate(() => {
    if (typeof document.getAnimations !== 'function') {
      return;
    }
    for (const animation of document.getAnimations({ subtree: true })) {
      animation.pause();
    }
  }).catch(() => {})));
}

async function measurePage(page) {
  return page.evaluate(() => {
    const documentElement = document.documentElement;
    const body = document.body;
    const values = element => element ? {
      scrollWidth: element.scrollWidth,
      offsetWidth: element.offsetWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      offsetHeight: element.offsetHeight,
      clientHeight: element.clientHeight,
    } : {
      scrollWidth: 0,
      offsetWidth: 0,
      clientWidth: 0,
      scrollHeight: 0,
      offsetHeight: 0,
      clientHeight: 0,
    };
    const html = values(documentElement);
    const pageBody = values(body);
    return {
      viewportWidthCssPx: window.innerWidth,
      viewportHeightCssPx: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio,
      pageWidthCssPx: Math.max(
        html.scrollWidth, html.offsetWidth, html.clientWidth,
        pageBody.scrollWidth, pageBody.offsetWidth, pageBody.clientWidth,
      ),
      pageHeightCssPx: Math.max(
        html.scrollHeight, html.offsetHeight, html.clientHeight,
        pageBody.scrollHeight, pageBody.offsetHeight, pageBody.clientHeight,
      ),
    };
  });
}

function localDateTimeIso(date = new Date()) {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localTime.toISOString().slice(0, -1);
}

async function buildDomReplayArtifactMetadata(page, options) {
  const { requestedUrl, finalUrl = page.url() } = options;
  const metrics = await measurePage(page);
  const liveFinalUrl = new URL(finalUrl);
  // The live-report gateway does not accept fragments. They identify a
  // client-side position, not a different document, so retain the analyzed
  // resource identity while storing a launchable URL.
  liveFinalUrl.hash = '';
  return {
    requestedUrl,
    finalUrl: liveFinalUrl.href,
    // Backend contract uses Java LocalDateTime rather than an offset-aware
    // timestamp, so serialize the scanner's local wall time without a trailing Z.
    capturedAt: localDateTimeIso(),
    viewportWidthCssPx: metrics.viewportWidthCssPx,
    viewportHeightCssPx: metrics.viewportHeightCssPx,
    deviceScaleFactor: metrics.deviceScaleFactor,
    pageWidthCssPx: metrics.pageWidthCssPx,
    pageHeightCssPx: metrics.pageHeightCssPx,
  };
}

/**
 * Serialize an internal DOM snapshot from either the current rendered document
 * or retained response HTML. Executable content is removed from the local copy;
 * the page used for axe analysis is not mutated by this function.
 */
async function serializeDomReplayHtml(page, options = {}) {
  const {
    baseUrl = null,
    sourceHtml = null,
    sourceMode = 'RENDERED_DOM',
  } = options;

  return page.evaluate(({ replayBaseUrl, replaySourceHtml, replaySourceMode }) => {
    const sourceDocument = replaySourceHtml === null
      ? document
      : new DOMParser().parseFromString(replaySourceHtml, 'text/html');
    const root = sourceDocument.documentElement.cloneNode(true);

    const copyRuntimeState = (originalRoot, replayRoot) => {
      const originalControls = originalRoot.querySelectorAll(
        'input, textarea, option, details, dialog, progress, meter',
      );
      const replayControls = replayRoot.querySelectorAll(
        'input, textarea, option, details, dialog, progress, meter',
      );
      originalControls.forEach((original, index) => {
        const replay = replayControls[index];
        if (!replay) return;
        const tag = original.tagName.toLowerCase();
        if (tag === 'input') {
          const type = (original.getAttribute('type') || 'text').toLowerCase();
          const identity = `${original.id || ''} ${original.name || ''} ${original.autocomplete || ''}`;
          const sensitive = ['password', 'file', 'hidden'].includes(type)
            || /(?:csrf|xsrf|token|secret|session|auth|credential|api[-_]?key)/i.test(identity);
          if (sensitive) {
            replay.removeAttribute('value');
          } else {
            replay.setAttribute('value', original.value);
          }
          if (original.checked) replay.setAttribute('checked', '');
          else replay.removeAttribute('checked');
        } else if (tag === 'textarea') {
          replay.textContent = original.value;
        } else if (tag === 'option') {
          if (original.selected) replay.setAttribute('selected', '');
          else replay.removeAttribute('selected');
        } else if (tag === 'details' || tag === 'dialog') {
          if (original.open) replay.setAttribute('open', '');
          else replay.removeAttribute('open');
        } else if ('value' in original) {
          replay.setAttribute('value', String(original.value));
        }
      });

      const originalMedia = originalRoot.querySelectorAll('img, source, video');
      const replayMedia = replayRoot.querySelectorAll('img, source, video');
      originalMedia.forEach((original, index) => {
        const replay = replayMedia[index];
        if (replay && original.currentSrc && !original.currentSrc.startsWith('blob:')) {
          replay.setAttribute('src', original.currentSrc);
        }
      });
    };

    const appendOpenShadowRoots = (originalRoot, replayRoot) => {
      const originalElements = [...originalRoot.querySelectorAll('*')];
      const replayElements = [...replayRoot.querySelectorAll('*')];
      originalElements.forEach((original, index) => {
        const replay = replayElements[index];
        const shadow = original.shadowRoot;
        if (!replay || !shadow || shadow.mode !== 'open') return;

        const template = sourceDocument.createElement('template');
        template.setAttribute('shadowrootmode', 'open');
        if (shadow.delegatesFocus) {
          template.setAttribute('shadowrootdelegatesfocus', '');
        }
        for (const child of shadow.childNodes) {
          template.content.append(child.cloneNode(true));
        }
        replay.prepend(template);
        copyRuntimeState(shadow, template.content);
        appendOpenShadowRoots(shadow, template.content);
      });
    };

    // cloneNode()/outerHTML omit runtime open shadow roots and form state. Emit
    // declarative shadow templates recursively so typed SHADOW_ROOT path steps
    // can be reconstructed. Closed roots are intentionally unavailable.
    if (replaySourceHtml === null) {
      copyRuntimeState(sourceDocument, root);
      appendOpenShadowRoots(sourceDocument.documentElement, root);
    }

    const replayRoots = [root];
    for (let rootIndex = 0; rootIndex < replayRoots.length; rootIndex += 1) {
      const replayRoot = replayRoots[rootIndex];
      // querySelectorAll() does not enter template.content. Queue every
      // template fragment (declarative shadow DOM and ordinary inert templates)
      // so executable markup cannot survive there and be activated later.
      replayRoot.querySelectorAll('template').forEach(template => {
        replayRoots.push(template.content);
      });
      replayRoot.querySelectorAll('script, object, embed').forEach(element => element.remove());
      replayRoot.querySelectorAll('meta[http-equiv]').forEach(element => {
        const directive = (element.getAttribute('http-equiv') || '').toLowerCase();
        if (['refresh', 'content-security-policy', 'content-type'].includes(directive)) {
          element.remove();
        }
      });
      replayRoot.querySelectorAll('link[rel]').forEach(element => {
        const rel = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
        const as = (element.getAttribute('as') || '').toLowerCase();
        if (rel.includes('modulepreload') || (rel.includes('preload') && as === 'script')) {
          element.remove();
        }
      });
      const elements = [...replayRoot.querySelectorAll('*')];
      if (replayRoot instanceof Element) elements.unshift(replayRoot);
      elements.forEach(element => {
        for (const attribute of [...element.attributes]) {
          const name = attribute.name.toLowerCase();
          if (name.startsWith('on')) {
            element.removeAttribute(attribute.name);
            continue;
          }
          if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name)
              && /^\s*javascript:/i.test(attribute.value)) {
            element.removeAttribute(attribute.name);
          }
        }
        if (element.tagName.toLowerCase() === 'iframe') {
          // Nested frames may still provide visual context, but are denied script,
          // form, popup, and top-navigation privileges in the replay document.
          element.setAttribute('sandbox', '');
        }
      });
    }

    let head = root.querySelector('head');
    if (!head) {
      head = sourceDocument.createElement('head');
      root.prepend(head);
    }
    head.querySelectorAll(
      'base, meta[charset], meta[name="accessibility-replay-source"]',
    ).forEach(element => element.remove());
    const charset = sourceDocument.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.prepend(charset);

    const resolvedBaseUrl = replayBaseUrl || sourceDocument.baseURI;
    if (resolvedBaseUrl) {
      const base = sourceDocument.createElement('base');
      base.setAttribute('href', resolvedBaseUrl);
      charset.after(base);
    }

    const sourceMarker = replaySourceMode || 'RENDERED_DOM';
    root.setAttribute('data-accessibility-replay', 'DOM_REPLAY');
    root.setAttribute('data-accessibility-replay-source', sourceMarker);
    const marker = sourceDocument.createElement('meta');
    marker.setAttribute('name', 'accessibility-replay-source');
    marker.setAttribute('content', sourceMarker);
    head.append(marker);

    const serializeDoctype = doctype => {
      if (!doctype) return '<!doctype html>';
      let value = `<!DOCTYPE ${doctype.name}`;
      if (doctype.publicId) value += ` PUBLIC \"${doctype.publicId}\"`;
      if (doctype.systemId) value += `${doctype.publicId ? '' : ' SYSTEM'} \"${doctype.systemId}\"`;
      return `${value}>`;
    };
    return `${serializeDoctype(sourceDocument.doctype)}\n${root.outerHTML}`;
  }, {
    replayBaseUrl: baseUrl,
    replaySourceHtml: sourceHtml,
    replaySourceMode: sourceMode,
  });
}

module.exports = {
  buildDomReplayArtifactMetadata,
  buildPathSteps,
  clipRectToFrameViewports,
  clipRectToOverflowAncestors,
  enrichAxeResultsWithLocators,
  measurePage,
  localDateTimeIso,
  normalizeAxeTarget,
  pauseDocumentAnimations,
  pausePageVirtualTime,
  redactFrameUrl,
  revalidateAxeLocators,
  resolveAxeNodeLocator,
  serializeDomReplayHtml,
};
