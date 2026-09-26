import { X } from "lucide-react";
import { useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDialogAccessibility } from "../../shared/use-dialog-accessibility";
import { IssueLocationContent } from "./issue-location-dialog";
import { toPageReplayIssue } from "./page-replay-protocol";
import type { LocatorIssueState, RecentIssueRow } from "./types";

const PAGE_SIZE = 25;

export function AllIssuesDialog({ rows, issueStates, onClose, returnFocusRef }: {
  rows: RecentIssueRow[];
  issueStates?: Record<number, LocatorIssueState>;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement>;
}) {
  const headingId = useId();
  const dialogRef = useDialogAccessibility({ isOpen: true, onClose, returnFocusRef });
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selectedRow = visibleRows.find(row => row.issue.id === selectedId);
  const changePage = (next: number) => { setPage(next); setSelectedId(null); };

  return createPortal(
    <div className="dashboard-modal-layer" onClick={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <article ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}
        className="dashboard-modal-surface dashboard-modal-surface--split site-issue-location-dialog site-all-issues-dialog">
        <header className="site-issue-location-dialog__header">
          <h2 id={headingId} className="dashboard-modal-title">전체 문제 {rows.length.toLocaleString("ko-KR")}개</h2>
          <button type="button" className="dashboard-modal-button dashboard-modal-button--icon" aria-label="전체 문제 닫기" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="site-all-issues-dialog__content">
          <p>분석 당시 저장된 결과입니다. 현재 페이지 연결 여부와 관계없이 문제 상세를 확인할 수 있습니다.</p>
          {rows.length === 0 ? <p role="status">저장된 문제가 없습니다.</p> : <>
            <ul className="site-all-issues-dialog__list" aria-label="전체 문제 목록">
              {visibleRows.map(row => <li key={row.issue.id}>
                <button type="button" className="dashboard-modal-button" aria-expanded={selectedId === row.issue.id}
                  onClick={() => {
                    setSelectedId(row.issue.id);
                    // Focus a stable region; the detail body changes within it.
                    detailRef.current?.focus({ preventScroll: false });
                  }}>
                  <span>{row.severity.label}</span> {toPageReplayIssue(row).title}
                  <span className="sr-only"> 문제 상세</span>
                </button>
              </li>)}
            </ul>
            <nav className="site-all-issues-dialog__pager" aria-label="전체 문제 페이지">
              <button type="button" className="dashboard-modal-button" disabled={currentPage === 0} onClick={() => changePage(0)}>처음</button>
              <button type="button" className="dashboard-modal-button" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>이전</button>
              <span role="status">{currentPage + 1} / {pageCount} 페이지</span>
              <button type="button" className="dashboard-modal-button" disabled={currentPage === pageCount - 1} onClick={() => changePage(currentPage + 1)}>다음</button>
              <button type="button" className="dashboard-modal-button" disabled={currentPage === pageCount - 1} onClick={() => changePage(pageCount - 1)}>마지막</button>
            </nav>
          </>}
          <div ref={detailRef} tabIndex={-1} role="region" aria-label="선택한 문제 상세">
            {selectedRow ? <>
              <h3>{toPageReplayIssue(selectedRow).title}</h3>
              <IssueLocationContent row={selectedRow} state={issueStates?.[selectedRow.issue.id]} savedResult />
            </> : <p>목록에서 문제를 선택하면 설명과 저장된 위치 정보가 표시됩니다.</p>}
          </div>
        </div>
      </article>
    </div>, document.body
  );
}
