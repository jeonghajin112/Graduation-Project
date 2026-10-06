function createLivePopoverView({document, popover, popoverTags, popoverDetail, createSeverityBadge, createCodeBadge, textValue, clusterIssuesFor, presentationNoteFor, getState}) {
  // 설명은 빈 줄로 나뉜 "소제목\n본문" 묶음이다. 소제목 줄만 굵게 해 본문과 구분한다.
  const messageHeadings = new Set(['분석 문장', '개선 필요', '개선 제안', '개선 안내', '수정 예시', '수정 이유', '권장사항']);
  const fillMessage = (message, text) => {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) message.append('\n');
      if (messageHeadings.has(line.trim()) && (index === 0 || lines[index - 1].trim() === '')) {
        const heading = document.createElement('strong');
        heading.className = 'ap-live-popover__heading';
        heading.textContent = line;
        message.append(heading);
      } else message.append(line);
    });
  };
  // 페이지 화면은 대시보드에서 축소되어 보이므로 팝오버를 그만큼 되키운다. transform: scale은
  // 이미 그린 글씨를 늘려 붙여 위치에 따라 글씨가 흐려지므로, zoom으로 글씨를 그 크기로 다시 그린다.
  // zoom은 left/top에도 곱해지므로 위치는 배율로 나눠 넣는다.
  const zoomSupported = globalThis.CSS?.supports?.('zoom', '2') === true;
  let appliedZoom = 1;
  const applyPopoverScale = scale => {
    if (zoomSupported) {
      appliedZoom = scale;
      popover.style.zoom = String(scale);
      popover.style.transform = '';
    } else popover.style.transform = `scale(${scale})`;
  };
  const movePopoverTo = (left, top) => {
    popover.style.left = `${left / appliedZoom}px`;
    popover.style.top = `${top / appliedZoom}px`;
  };
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
    fillMessage(message, textValue(issue.message, 1600) || '이 문제에 대한 상세 설명이 없습니다.');
    const path = document.createElement('code');
    path.className = 'ap-live-popover__path';
    path.textContent = textValue(issue.path, 2048) || '요소 경로 정보 없음';
    const noteText = presentationNoteFor(issue);
    if (noteText) {
      const note = document.createElement('p');
      note.className = 'ap-live-popover__note';
      note.textContent = noteText;
      popoverDetail.replaceChildren(title, note, message, path);
    } else popoverDetail.replaceChildren(title, message, path);
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
    // 팝오버는 사용자가 가리킨 칩에 붙인다. 요소 전체를 기준으로 하면 큰 요소일수록
    // 칩에서 멀어지고, 묶인 이슈를 넘길 때마다 기준 요소가 바뀌어 팝오버가 움직인다.
    // 칩이 숨겨진 경우(마커 끄기 등)에만 대상 요소를 기준으로 한다.
    const markerVisible = openEntry.marker?.isConnected && !openEntry.marker.hidden;
    const targetEntry = openTargetEntry?.element?.isConnected ? openTargetEntry : openEntry;
    const anchor = (markerVisible ? openEntry.marker : targetEntry.element).getBoundingClientRect();
    const scale = 1 / viewScale;
    applyPopoverScale(scale);
    const width = popover.offsetWidth * scale;
    const height = popover.offsetHeight * scale;
    const gap = 8 * scale;
    const viewportLeft = 12;
    const viewportTop = 12 + viewTopInset / viewScale;
    const viewportRight = innerWidth - 12;
    const viewportBottom = innerHeight - 12;
    const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
    const spaceBelow = viewportBottom - anchor.bottom - gap;
    const spaceAbove = anchor.top - gap - viewportTop;
    const spaceRight = viewportRight - anchor.right - gap;
    const spaceLeft = anchor.left - gap - viewportLeft;
    let left;
    let top;
    if (height <= spaceBelow || height <= spaceAbove) {
      // 칩 바로 아래, 공간이 없으면 칩 바로 위. 가로는 칩 왼쪽에 맞추고 넘치면 칩 오른쪽에 맞춘다.
      top = height <= spaceBelow ? anchor.bottom + gap : anchor.top - gap - height;
      left = anchor.left + width <= viewportRight ? anchor.left : anchor.right - width;
    } else if (width <= spaceRight || width <= spaceLeft) {
      // 위아래 모두 좁으면 칩 옆에 두고, 세로는 칩 높이에서 화면 안으로 맞춘다.
      left = width <= spaceRight ? anchor.right + gap : anchor.left - gap - width;
      top = anchor.top;
    } else {
      // 어디에도 온전히 들어가지 않으면 더 넓은 쪽에 붙인다.
      top = spaceBelow >= spaceAbove ? anchor.bottom + gap : anchor.top - gap - height;
      left = anchor.left;
    }
    left = clamp(left, viewportLeft, viewportRight - width);
    top = clamp(top, viewportTop, viewportBottom - height);
    const viewportAttached = markerVisible
      ? openEntry.markerViewportAttached === true
      : targetEntry === openEntry
        ? openEntry.markerViewportAttached === true
        : targetEntry.viewportAttached === true;
    popover.style.position = viewportAttached ? 'fixed' : 'absolute';
    movePopoverTo(left + (viewportAttached ? 0 : documentLeft), top + (viewportAttached ? 0 : documentTop));
  };
  return {renderDetailContent, sizePopoverForCluster, positionPopover, movePopoverTo};
}
