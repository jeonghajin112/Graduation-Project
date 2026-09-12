function createLiveLocatorResolver({document, layer, observeMarkerShadowRoot, isObjectRecord}) {
  const issuePathSteps = item => {
    const storedSteps = Array.isArray(item?.pathSteps) ? item.pathSteps : [];
    return storedSteps.length > 0 ? storedSteps
      : (typeof item?.path === 'string' && item.path ? [{context:'DOCUMENT', selector:item.path}] : []);
  };
  const isSimpleDocumentLocator = issue => {
    const steps = issuePathSteps(issue);
    if (steps.length !== 1 || String(steps[0]?.context || 'DOCUMENT').toUpperCase() !== 'DOCUMENT'
        || typeof steps[0]?.selector !== 'string') return false;
    return steps[0].selector.trim().split(/\s*>\s*/).every(segment =>
      /^(?:[a-zA-Z][\w-]*(?:#[\w-]+)?|#[\w-]+)(?::nth-of-type\([1-9]\d*\))?$/.test(segment));
  };
  const hasAnalyzedText = issue => issue?.analyzer === 'AI_TEXT'
    && isObjectRecord(issue.textAnalysis) && issue.textAnalysis.kind === 'text-analysis'
    && typeof issue.textAnalysis.sourceText === 'string';
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
  const resolveIssue = (item, queries = createLocatorQueryCache()) => {
    const steps = issuePathSteps(item);
    if (steps.length === 0) return {element:null, reason:'EMPTY_PATH'};
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
          if (!current || !current.shadowRoot) return {element:null, reason:'SHADOW_ROOT_UNAVAILABLE'};
          root = current.shadowRoot;
          // A document observer does not cross a shadow boundary.
          // Observe each traversed root even if the target is not mounted yet.
          observeMarkerShadowRoot(root);
          queries.shadowRoots.add(root);
        } else if (context === 'FRAME') {
          return {element:null, reason:'FRAME_UNSUPPORTED'};
        } else return {element:null, reason:'UNSUPPORTED_CONTEXT'};
        current = queryLocator(root, step.selector, queries);
        if (index === steps.length - 1 && (!current || !matchesAnalyzedText(current, item))) {
          const recovered = findReorderedTextTarget(root, step.selector, item, queries);
          if (recovered) { current = recovered; reordered = true; }
        }
        if (!current) return {element:null, reason:'SELECTOR_NOT_FOUND'};
      }
    } catch (_) { return {element:null, reason:'INVALID_SELECTOR'}; }
    // An nth-of-type selector can still resolve after a news card was
    // replaced. Its old analysis must never label the new content.
    if (!matchesAnalyzedText(current, item)) return {element:null, reason:'ELEMENT_CONTENT_CHANGED'};
    return {element:current, reason:null, recovered:reordered};
  };
  return {isSimpleDocumentLocator, hasAnalyzedText, createLocatorQueryCache, resolveIssue};
}
