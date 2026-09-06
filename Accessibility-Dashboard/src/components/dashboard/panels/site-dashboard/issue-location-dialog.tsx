import { Info, X } from "lucide-react";
import { useId } from "react";
import { createPortal } from "react-dom";

import { useDialogAccessibility } from "../../shared/use-dialog-accessibility";
import { getReplayIssuePathSteps } from "./issue-locator";
import { getLocatorExplanation } from "./locator-explanation";
import { toPageReplayIssue } from "./page-replay-protocol";
import type { LocatorIssueState, RecentIssueRow } from "./types";

export function IssueLocationDialog({ row, state, onClose }: {
  row: RecentIssueRow;
  state?: LocatorIssueState;
  onClose: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogAccessibility({ isOpen: true, onClose });
  const issue = row.issue;
  const locator = issue.locator;
  const explanation = getLocatorExplanation(state);
  const pathSteps = locator?.pathSteps.length ? locator.pathSteps : getReplayIssuePathSteps(issue);
  const coordinateSpace = locator?.coordinateSpace;
  const coordinateLabel = coordinateSpace === "DOCUMENT_CSS_PX"
    ? "문서 왼쪽 위 기준 · CSS px"
    : coordinateSpace === "SCREENSHOT_PX"
      ? "분석 이미지 왼쪽 위 기준 · 이미지 px"
      : "좌표 기준을 확인할 수 없음";
  const hasCoordinates = typeof locator?.x === "number" && typeof locator.y === "number";

  return createPortal(
    <div className="dashboard-modal-layer" onClick={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <article ref={dialogRef} className="dashboard-modal-surface dashboard-modal-surface--split site-issue-location-dialog" role="dialog" aria-modal="true"
        aria-labelledby={headingId} aria-describedby={descriptionId} tabIndex={-1}>
        <header className="site-issue-location-dialog__header">
          <div><h2 id={headingId} className="dashboard-modal-title">문제 위치 정보</h2><p>{toPageReplayIssue(row).title}</p></div>
          <button type="button" className="dashboard-modal-button dashboard-modal-button--icon" aria-label="위치 정보 닫기" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="site-issue-location-dialog__body" role="region" aria-label="저장된 위치 정보" tabIndex={0}>
          <section className="site-issue-location-dialog__status" aria-label="현재 표시 상태">
            <Info size={18} aria-hidden="true" />
            <div>
              <h3>{explanation.label}</h3>
              <p id={descriptionId}>{explanation.description}</p>
            </div>
          </section>
          <section aria-label="분석 당시 요소 경로">
            <h3>분석 당시 요소 경로</h3>
            {pathSteps.length > 0 ? <ol className="site-issue-location-dialog__paths">
              {pathSteps.map((step, index) => <li key={index}>
                <div className="site-issue-location-dialog__path-content">
                  <span className="site-issue-location-dialog__context">{step.context === "DOCUMENT" ? "문서" : step.context === "FRAME" ? "프레임 내부" : step.context === "SHADOW_ROOT" ? "Shadow DOM 내부" : "기타 영역"}</span>
                  <code>{step.selector || "요소 선택자 없음"}</code>
                  {step.frameUrl ? <span className="site-issue-location-dialog__url">{step.frameUrl}</span> : null}
                </div>
              </li>)}
            </ol> : <p>저장된 요소 경로가 없습니다.</p>}
            {locator?.carouselContext ? <p>분석 당시 슬라이드: {locator.carouselContext.slideIndex + 1} / {locator.carouselContext.slideCount}</p> : null}
          </section>
          <section aria-label="분석 당시 HTML">
            <h3>분석 당시 HTML</h3>
            {locator?.htmlSnippet?.trim() ? <pre><code>{locator.htmlSnippet}</code></pre> : <p>저장된 HTML이 없습니다.</p>}
          </section>
          <section aria-label="분석 당시 좌표">
            <h3>분석 당시 좌표</h3>
            {hasCoordinates ? <>
              <dl className="site-issue-location-dialog__coordinates">
                <div><dt>X</dt><dd>{locator.x}</dd></div>
                <div><dt>Y</dt><dd>{locator.y}</dd></div>
                <div><dt>너비</dt><dd>{typeof locator.width === "number" ? locator.width : "정보 없음"}</dd></div>
                <div><dt>높이</dt><dd>{typeof locator.height === "number" ? locator.height : "정보 없음"}</dd></div>
              </dl>
              <p className="site-issue-location-dialog__coordinate-basis">{coordinateLabel}</p>
            </> : <p>저장된 좌표가 없습니다.</p>}
          </section>
          <p className="site-issue-location-dialog__note">분석 시점에 저장된 정보로, 현재 페이지와 다를 수 있습니다.</p>
        </div>
      </article>
    </div>, document.body
  );
}
