import { X } from "lucide-react";
import { useId, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useDialogAccessibility } from "../../shared/use-dialog-accessibility";
import { formatIssueCodeLabel } from "./constants";
import { criterionCode } from "./final-report";
import { describeElement, describeIssueLine, partLabel, readIssue } from "./issue-guidance";
import { getReplayIssuePathSteps } from "./issue-locator";
import { toPageReplayIssue } from "./page-replay-protocol";
import type { RecentIssueRow } from "./types";

export function IssueLocationDialog({ row, onClose }: {
  row: RecentIssueRow;
  onClose: () => void;
}) {
  const headingId = useId();
  const dialogRef = useDialogAccessibility({ isOpen: true, onClose });
  const replayIssue = toPageReplayIssue(row);
  const code = criterionCode(row.issue.issueCode);

  return createPortal(
    <div className="dashboard-modal-layer" onClick={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <article ref={dialogRef} className="dashboard-modal-surface dashboard-modal-surface--split site-issue-location-dialog" role="dialog" aria-modal="true"
        aria-labelledby={headingId} tabIndex={-1}
        style={{ "--issue-severity-color": row.severity.color } as CSSProperties}>
        <header className="site-issue-location-dialog__header">
          <div className="site-issue-location-dialog__heading">
            <h2 id={headingId} className="site-issue-location-dialog__eyebrow">문제 상세</h2>
            <p data-copyable className="site-issue-location-dialog__title">{replayIssue.title}</p>
            <p className="site-issue-location-dialog__tags">
              <span className="site-issue-location-dialog__severity">{row.severity.label}</span>
              {code ? <span className="site-issue-location-dialog__code">{formatIssueCodeLabel(code)}</span> : null}
            </p>
          </div>
          <button type="button" className="site-issue-location-dialog__close" aria-label="문제 상세 닫기" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <IssueLocationContent row={row} />
      </article>
    </div>, document.body
  );
}

function IssueLocationContent({ row }: { row: RecentIssueRow }) {
  const issue = row.issue;
  // The card/replay message is a bounded preview. Details read the full
  // stored explanation, split into labelled rows like the final report.
  // Why it is not on screen is already the reason on its rail line.
  const reading = readIssue(row);
  const line = describeIssueLine(row, reading);
  const locator = issue.locator;
  const target = describeElement(locator?.htmlSnippet?.trim() ?? "", locator?.content);
  const pathSteps = locator?.pathSteps.length ? locator.pathSteps : getReplayIssuePathSteps(issue);
  const coordinateSpace = locator?.coordinateSpace;
  const coordinateLabel = coordinateSpace === "DOCUMENT_CSS_PX"
    ? "문서 왼쪽 위 기준 · CSS px"
    : coordinateSpace === "SCREENSHOT_PX"
      ? "분석 이미지 왼쪽 위 기준 · 이미지 px"
      : "좌표 기준을 확인할 수 없음";
  const hasCoordinates = typeof locator?.x === "number" && typeof locator.y === "number";
  // Every part of the explanation gets a labelled row, except what the
  // measured chips and the before/after comparison already show.
  const consumed = new Set(["개선 필요", ...(line.compare ? ["분석 문장", "수정 예시", "수정 이유"] : [])]);
  const rows = reading.parts.filter(part => !consumed.has(part.heading ?? ""));

  return (
        <div className="site-issue-location-dialog__body" role="region" aria-label="문제 상세 내용" tabIndex={0}>
          <section className="site-issue-location-dialog__section" aria-label="문제 설명">
            <h3>문제 설명</h3>
            <dl className="site-issue-location-dialog__specs" data-copyable>
              {target ? <div><dt>대상</dt><dd>{target}</dd></div> : null}
              {reading.contrast ? <div>
                <dt>측정값</dt>
                <dd className="site-issue-location-dialog__chips">
                  <span>{reading.contrast.text ? `글자 “${reading.contrast.text}”` : "글자 정보 없음"}</span>
                  {reading.contrast.contrast ? <span>대비 <strong>{reading.contrast.contrast}</strong></span> : null}
                  {reading.contrast.required ? <span>기준 {reading.contrast.required}</span> : null}
                </dd>
              </div> : null}
              {rows.map((part, index) => <div key={`${part.heading ?? ""}-${index}`}>
                <dt>{partLabel(part)}</dt>
                <dd className="site-issue-location-dialog__text">{part.body}</dd>
              </div>)}
              {line.metrics.length > 0 ? <div>
                <dt>개선 필요</dt>
                <dd className="site-issue-location-dialog__chips">{line.metrics.map(metric => <span key={metric}>{metric}</span>)}</dd>
              </div> : null}
            </dl>
            {line.compare ? <div className="site-issue-location-dialog__compare" data-copyable>
              <div>
                <p className="site-issue-location-dialog__compare-label">원래 문장</p>
                <p>{line.compare.before}</p>
              </div>
              <div className="site-issue-location-dialog__compare-after">
                <p className="site-issue-location-dialog__compare-label">이렇게 바꿔 보세요</p>
                <p>{line.compare.after}</p>
              </div>
              {line.compare.reason ? <p className="site-issue-location-dialog__compare-reason">{line.compare.reason}</p> : null}
            </div> : null}
          </section>
          <section className="site-issue-location-dialog__section" aria-label="분석 당시 기록">
            <h3>분석 당시 기록</h3>
            <div className="site-issue-location-dialog__records">
              <section className="site-issue-location-dialog__record" aria-label="분석 당시 요소 경로">
                <h4>요소 경로</h4>
                <div>
                  {pathSteps.length > 0 ? <ol className="site-issue-location-dialog__paths">
                    {pathSteps.map((step, index) => <li key={index}>
                      <span className="site-issue-location-dialog__context">{step.context === "DOCUMENT" ? "문서" : step.context === "FRAME" ? "프레임 내부" : step.context === "SHADOW_ROOT" ? "Shadow DOM 내부" : "기타 영역"}</span>
                      <code>{step.selector || "요소 선택자 없음"}</code>
                      {step.frameUrl ? <span data-copyable className="site-issue-location-dialog__url">{step.frameUrl}</span> : null}
                    </li>)}
                  </ol> : <p className="site-issue-location-dialog__empty">저장된 요소 경로가 없습니다.</p>}
                  {locator?.carouselContext ? <p className="site-issue-location-dialog__aside">분석 당시 슬라이드: {locator.carouselContext.slideIndex + 1} / {locator.carouselContext.slideCount}</p> : null}
                </div>
              </section>
              <section className="site-issue-location-dialog__record" aria-label="분석 당시 HTML">
                <h4>HTML</h4>
                <div>
                  {locator?.htmlSnippet?.trim() ? <pre><code>{locator.htmlSnippet}</code></pre> : <p className="site-issue-location-dialog__empty">저장된 HTML이 없습니다.</p>}
                </div>
              </section>
              <section className="site-issue-location-dialog__record" aria-label="분석 당시 좌표">
                <h4>좌표</h4>
                <div>
                  {hasCoordinates ? <>
                    <dl data-copyable className="site-issue-location-dialog__coordinates">
                      <div><dt>X</dt><dd>{locator.x}</dd></div>
                      <div><dt>Y</dt><dd>{locator.y}</dd></div>
                      <div><dt>너비</dt><dd>{typeof locator.width === "number" ? locator.width : "정보 없음"}</dd></div>
                      <div><dt>높이</dt><dd>{typeof locator.height === "number" ? locator.height : "정보 없음"}</dd></div>
                    </dl>
                    <p className="site-issue-location-dialog__aside">{coordinateLabel}</p>
                  </> : <p className="site-issue-location-dialog__empty">저장된 좌표가 없습니다.</p>}
                </div>
              </section>
            </div>
          </section>
          <p className="site-issue-location-dialog__note">분석 시점에 저장된 정보로, 현재 페이지와 다를 수 있습니다.</p>
        </div>
  );
}
