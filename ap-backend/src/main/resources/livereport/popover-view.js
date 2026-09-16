function createLivePopoverView({document, popover, popoverTags, popoverDetail, createSeverityBadge, createCodeBadge, textValue, clusterIssuesFor, getState}) {
  const renderDetailContent = issue => {
    const severityBadge = createSeverityBadge(issue);
    const codeBadge = createCodeBadge(issue);
    popoverTags.replaceChildren();
    if (severityBadge) popoverTags.append(severityBadge);
    if (codeBadge) popoverTags.append(codeBadge);
    const title = document.createElement('h3');
    title.className = 'ap-live-popover__title';
    title.textContent = textValue(issue.title, 300) || '접근성 이슈';
    const message = document.createElement('p');
    message.className = 'ap-live-popover__message';
    message.textContent = textValue(issue.message, 1600) || '이 문제에 대한 상세 설명이 없습니다.';
    const path = document.createElement('code');
    path.className = 'ap-live-popover__path';
    path.textContent = textValue(issue.path, 2048) || '요소 경로 정보 없음';
    popoverDetail.replaceChildren(title, message, path);
  };
  // 묶인 이슈를 < > 로 넘길 때 팝오버 크기가 출렁이지 않도록, 가장 긴 이슈 높이에 맞춰 고정
  const sizePopoverForCluster = entry => {
    popover.style.minHeight = '';
    const issues = clusterIssuesFor(entry);
    if (issues.length < 2) return;
    const previousVisibility = popover.style.visibility;
    popover.style.visibility = 'hidden';
    let tallest = 0;
    issues.forEach(issue => {
      renderDetailContent(issue);
      tallest = Math.max(tallest, popover.offsetHeight);
    });
    popover.style.visibility = previousVisibility;
    if (tallest > 0) popover.style.minHeight = `${tallest}px`;
  };
  const positionPopover = (
    documentLeft = globalThis.scrollX,
    documentTop = globalThis.scrollY
  ) => {
    const {openEntry, openTargetEntry, viewScale, viewTopInset = 0} = getState();
    if (popover.hidden || !openEntry) return;
    const targetEntry = openTargetEntry?.element?.isConnected ? openTargetEntry : openEntry;
    const rect = targetEntry.element.getBoundingClientRect();
    const scale = 1 / viewScale;
    popover.style.transform = `scale(${scale})`;
    const width = popover.offsetWidth * scale;
    const height = popover.offsetHeight * scale;
    const viewportLeft = 12;
    const viewportTop = 12 + viewTopInset / viewScale;
    const viewportRight = innerWidth - 12;
    const viewportBottom = innerHeight - 12;
    const markerRect = openEntry.marker && !openEntry.marker.hidden
      ? openEntry.marker.getBoundingClientRect() : null;
    // 칩은 요소 위쪽에 붙어 있으므로, 팝오버가 위로 뒤집힐 때는 칩보다 더 위로 올린다
    const upperEdge = markerRect ? Math.min(rect.top, markerRect.top) : rect.top;
    let left = rect.left + 18;
    let top = rect.bottom + 10;
    if (left + width > viewportRight) left = Math.max(viewportLeft, rect.right - width - 18);
    if (top + height > viewportBottom) top = Math.max(viewportTop, upperEdge - height - 10);
    const viewportAttached = targetEntry === openEntry
      ? openEntry.markerViewportAttached === true
      : targetEntry.viewportAttached === true;
    popover.style.position = viewportAttached ? 'fixed' : 'absolute';
    popover.style.left = `${Math.max(viewportLeft, left) + (viewportAttached ? 0 : documentLeft)}px`;
    popover.style.top = `${Math.max(viewportTop, top) + (viewportAttached ? 0 : documentTop)}px`;
  };
  return {renderDetailContent, sizePopoverForCluster, positionPopover};
}
