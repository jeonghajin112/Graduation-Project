function createLiveLocatorResolver({document, layer, observeMarkerShadowRoot, isObjectRecord, carouselDescriptorFor}) {
  const issuePathSteps = item => {
    const storedSteps = Array.isArray(item?.pathSteps) ? item.pathSteps : [];
    return storedSteps.length > 0 ? storedSteps
      : (typeof item?.path === 'string' && item.path ? [{context:'DOCUMENT', selector:item.path}] : []);
  };
  // Visual-engine findings have only the box measured on the analysis
  // screenshot (document CSS px). A transparent box in the marker layer stands
  // in for the missing element, so markers, scrolling and details keep using
  // the element path. The layer is excluded from mutation handling.
  const coordinateTargets = new Map();
  const coordinateTargetFor = item => {
    const box = item?.box;
    if (!isObjectRecord(box)) return null;
    let target = coordinateTargets.get(item.id);
    if (!target) {
      target = document.createElement('div');
      target.className = 'ap-live-coordinate-target';
      coordinateTargets.set(item.id, target);
    }
    target.style.setProperty('left', `${box.x}px`);
    target.style.setProperty('top', `${box.y}px`);
    target.style.setProperty('width', `${box.width}px`);
    target.style.setProperty('height', `${box.height}px`);
    if (target.parentNode !== layer) layer.append(target);
    return target;
  };
  const releaseCoordinateTargets = () => {
    coordinateTargets.forEach(target => target.remove());
    coordinateTargets.clear();
  };
  const isSimpleDocumentLocator = issue => {
    const steps = issuePathSteps(issue);
    // Coordinate targets never depend on page DOM changes.
    if (steps.length === 0 && isObjectRecord(issue?.box)) return true;
    if (steps.length !== 1 || String(steps[0]?.context || 'DOCUMENT').toUpperCase() !== 'DOCUMENT'
        || typeof steps[0]?.selector !== 'string') return false;
    return steps[0].selector.trim().split(/\s*>\s*/).every(segment =>
      /^(?:[a-zA-Z][\w-]*(?:#[\w-]+)?|#[\w-]+)(?::nth-of-type\([1-9]\d*\))?$/.test(segment));
  };
  const hasAnalyzedText = issue => issue?.analyzer === 'AI_TEXT'
    && isObjectRecord(issue.textAnalysis) && issue.textAnalysis.kind === 'text-analysis'
    && typeof issue.textAnalysis.sourceText === 'string';
  // Visual-engine findings follow the element that was under their box and
  // carry what it showed then: its text without whitespace and the path and
  // query of its image (the session mirror keeps both). A feed card that now
  // shows another article must not carry the old finding.
  const hasAnalyzedContent = issue => issue?.analyzer === 'CV_VISION'
    && isObjectRecord(issue.content) && typeof issue.content.text === 'string';
  const analyzedContentTextLength = 160;
  const imageSourcesOf = element => {
    const sources = ['data-src', 'data-original', 'src', 'poster']
      .map(name => element.getAttribute(name)).filter(Boolean);
    if (typeof element.currentSrc === 'string' && element.currentSrc) sources.push(element.currentSrc);
    const background = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(getComputedStyle(element).backgroundImage || '');
    if (background) sources.push(background[2]);
    return sources;
  };
  const matchesAnalyzedContent = (element, issue) => {
    if (!hasAnalyzedContent(issue)) return true;
    const expected = issue.content.text;
    const text = String(element.textContent || '').normalize('NFKC').replace(/\s+/g, '');
    // The analyzer keeps a bounded prefix of long container text.
    if (expected.length >= analyzedContentTextLength ? !text.startsWith(expected) : text !== expected) return false;
    const image = issue.content.image;
    if (typeof image !== 'string' || !image) return true;
    return imageSourcesOf(element).some(source => {
      try {
        const url = new URL(source, document.baseURI);
        return `${url.pathname}${url.search}`.endsWith(image);
      } catch (_) { return false; }
    });
  };
  const createLocatorQueryCache = () => ({single:new WeakMap(), all:new WeakMap(), shadowRoots:new Set()});
  const queryLocator = (root, selector, queries, all = false) => {
    const roots = all ? queries.all : queries.single;
    let selectors = roots.get(root);
    if (!selectors) roots.set(root, selectors = new Map());
    if (!selectors.has(selector)) {
      try {
        selectors.set(selector, {value:all ? root.querySelectorAll(selector) : root.querySelector(selector)});
      } catch (error) { selectors.set(selector, {error}); }
    }
    const result = selectors.get(selector);
    if (result.error) throw result.error;
    return result.value;
  };
  const matchesAnalyzedText = (element, issue) => {
    const detail = issue.textAnalysis;
    if (issue.analyzer !== 'AI_TEXT' || !isObjectRecord(detail)
        || detail.kind !== 'text-analysis' || typeof detail.sourceText !== 'string') return true;
    const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, '');
    const expected = normalize(detail.sourceText.slice(0, 800));
    if (!expected) return true;
    // Text analysis also reads attribute-based form guidance. Do not
    // mistake those valid targets for changed article/link contents.
    const candidates = [element.textContent];
    if (['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'SPAN', 'BLOCKQUOTE'].includes(element.tagName)) {
      // The analyzer excludes child blocks when extracting container text.
      const inlineTags = ['EM', 'STRONG', 'B', 'I', 'U', 'MARK', 'SMALL', 'SUB', 'SUP',
        'ABBR', 'CITE', 'Q', 'SPAN', 'A', 'TIME', 'BR'];
      candidates.push(Array.from(element.childNodes).filter(node =>
        node.nodeType === Node.TEXT_NODE || inlineTags.includes(node.nodeName)
      ).map(node => node.textContent || '').join(''));
    }
    for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
      candidates.push(element.getAttribute(attribute));
    }
    if (element instanceof HTMLInputElement
        && ['button', 'submit', 'reset'].includes(element.type)) candidates.push(element.value);
    return candidates.some(candidate => normalize(candidate).includes(expected));
  };
  const findReorderedTextTarget = (root, selector, issue, queries) => {
    const detail = issue.textAnalysis;
    if (issue.analyzer !== 'AI_TEXT' || !isObjectRecord(detail)
        || detail.kind !== 'text-analysis' || typeof detail.sourceText !== 'string'
        || detail.sourceText.replace(/\s+/g, '').length < 20) return null;
    // Only relax the numeric positions in paths emitted by the text
    // extractor. Keep the same root, hierarchy, tags and IDs; never
    // search arbitrary page text or rewrite quoted CSS attributes.
    if (!selector.split(/\s*>\s*/).every(segment =>
        /^[a-zA-Z][\w-]*(?:#[\w-]+)?(?::nth-of-type\([1-9]\d*\))?$/.test(segment))) return null;
    const structuralSelector = selector.replace(/:nth-of-type\([1-9]\d*\)/g, '');
    if (structuralSelector === selector) return null;
    const candidates = queryLocator(root, structuralSelector, queries, true);
    if (candidates.length > 500) return null;
    let match = null;
    for (const candidate of candidates) {
      if (layer.contains(candidate) || !matchesAnalyzedText(candidate, issue)) continue;
      // Duplicate headlines/cloned slides cannot identify one target.
      if (match) return null;
      match = candidate;
    }
    return match;
  };
  // Older analyses stored selectors that include the carousel audit's
  // temporary slide attributes. The live page never has them, so search
  // without them and keep only the element on the recorded logical slide.
  const auditAttribute = /\[data-ua-audit-[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\]/g;
  const queryAuditedSlideLocator = (root, selector, item, queries) => {
    const stripped = selector
      .replace(new RegExp(`(^|[\\s>+~])${auditAttribute.source}`, 'g'), '$1*')
      .replace(auditAttribute, '');
    const candidates = Array.from(queryLocator(root, stripped, queries, true));
    return candidates.find(candidate => !layer.contains(candidate)
      && carouselDescriptorFor(candidate, item?.carouselContext)) || null;
  };
  // Mirrored frames load /api/live-reports/<session>/mirror/<nonce>/<base64url host><path>.
  const upstreamOfFrame = frame => {
    let url;
    try { url = new URL(frame.getAttribute('src') || '', document.baseURI); } catch (_) { return null; }
    const mirrored = /\/mirror\/[^/]+\/([A-Za-z0-9_-]+)(\/[^?#]*)?/.exec(url.pathname);
    if (!mirrored) return url;
    try {
      const token = mirrored[1].replace(/-/g, '+').replace(/_/g, '/');
      const host = atob(token + '='.repeat((4 - token.length % 4) % 4));
      return new URL(`https://${host}${mirrored[2] || '/'}`);
    } catch (_) { return null; }
  };
  // A frame whose own selector no longer matches can still be recognized by
  // the page it loads. Only an unambiguous match is used.
  const frameForUrl = (root, frameUrl) => {
    if (typeof frameUrl !== 'string' || !frameUrl) return null;
    let expected;
    try { expected = new URL(frameUrl); } catch (_) { return null; }
    const trim = path => path.replace(/\/+$/, '');
    const matches = Array.from(root.querySelectorAll('iframe,frame')).filter(frame => {
      if (layer.contains(frame)) return false;
      const upstream = upstreamOfFrame(frame);
      return upstream && upstream.host === expected.host && trim(upstream.pathname) === trim(expected.pathname);
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const resolveIssue = (item, queries = createLocatorQueryCache()) => {
    const steps = issuePathSteps(item);
    if (steps.length === 0) {
      const target = coordinateTargetFor(item);
      return target ? {element:target, reason:null} : {element:null, reason:'EMPTY_PATH'};
    }
    let root = document;
    let current = null;
    let reordered = false;
    try {
      for (const [index, step] of steps.entries()) {
        if (!step || typeof step.selector !== 'string' || !step.selector.trim()) {
          return {element:null, reason:'INVALID_PATH_STEP'};
        }
        const context = String(step.context || 'DOCUMENT').toUpperCase();
        if (context === 'DOCUMENT') root = document;
        else if (context === 'SHADOW_ROOT') {
          if (!current) return {element:null, reason:'SHADOW_ROOT_UNAVAILABLE'};
          if (!current.shadowRoot) {
            // A closed shadow root cannot be entered; a host that is on screen
            // marks the finding. An empty host may still attach an open root.
            const box = current.getBoundingClientRect();
            return box.width > 0 && box.height > 0
              ? {element:current, reason:null, presentation:{kind:'SHADOW_HOST'}}
              : {element:null, reason:'SHADOW_ROOT_UNAVAILABLE'};
          }
          root = current.shadowRoot;
          // A document observer does not cross a shadow boundary.
          // Observe each traversed root even if the target is not mounted yet.
          observeMarkerShadowRoot(root);
          queries.shadowRoots.add(root);
        } else if (context === 'FRAME') {
          // The frame document is not reachable from here. Show the finding on
          // the frame that contains it instead of dropping its location.
          const frame = ['IFRAME', 'FRAME'].includes(current?.tagName) ? current : frameForUrl(root, step.frameUrl);
          return frame
            ? {element:frame, reason:null, presentation:{kind:'FRAME_CONTENT'}}
            : {element:null, reason:'FRAME_UNSUPPORTED'};
        } else return {element:null, reason:'UNSUPPORTED_CONTEXT'};
        current = step.selector.includes('[data-ua-audit-')
          ? queryAuditedSlideLocator(root, step.selector, item, queries)
          : queryLocator(root, step.selector, queries);
        if (index === steps.length - 1 && (!current || !matchesAnalyzedText(current, item))) {
          const recovered = findReorderedTextTarget(root, step.selector, item, queries);
          if (recovered) { current = recovered; reordered = true; }
        }
        // The frame's own selector changed; the next step enters it by its page.
        if (!current && String(steps[index + 1]?.context || '').toUpperCase() === 'FRAME') {
          current = frameForUrl(root, step.frameUrl || steps[index + 1].frameUrl);
        }
        if (!current) return {element:null, reason:'SELECTOR_NOT_FOUND'};
      }
    } catch (_) { return {element:null, reason:'INVALID_SELECTOR'}; }
    // An nth-of-type selector can still resolve after a news card was
    // replaced. Its old analysis must never label the new content.
    if (!matchesAnalyzedText(current, item) || !matchesAnalyzedContent(current, item)) {
      return {element:null, reason:'ELEMENT_CONTENT_CHANGED'};
    }
    return {element:current, reason:null, recovered:reordered};
  };
  return {isSimpleDocumentLocator, hasAnalyzedText, hasAnalyzedContent, createLocatorQueryCache, resolveIssue,
    releaseCoordinateTargets};
}
