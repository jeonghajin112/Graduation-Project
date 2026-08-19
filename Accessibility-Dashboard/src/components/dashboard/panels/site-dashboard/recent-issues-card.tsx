import { CheckCircle2, CircleAlert, Info, LocateFixed, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { RecentIssueRow } from "./types";

type RecentIssuesCardProps = {
  locationAvailableIssueIds: Set<number>;
  onSelectIssue: (issueId: number) => void;
  rows: RecentIssueRow[];
  selectedIssueId: number | null;
};

/**
 * Severity must not be conveyed by colour alone (DESIGN.md WCAG AA contract),
 * so every level pairs a tinted chip with a distinct icon and a text label.
 * Colours come from the scoped --site-severity-* tokens.
 */
const severityIconByKey = {
  CRITICAL: XCircle,
  HIGH: CircleAlert,
  MEDIUM: Info,
  LOW: CheckCircle2
} as const;

function SeverityChip({ severityKey, label }: { severityKey: string; label: string }) {
  const Icon = severityIconByKey[severityKey as keyof typeof severityIconByKey] ?? Info;

  return (
    <span
      className="site-recent-issue-severity inline-flex shrink-0 items-center rounded-full text-xs font-bold"
      data-severity={severityKey}
    >
      <Icon size={13} strokeWidth={2.4} aria-hidden="true" />
      {label}
    </span>
  );
}

export function RecentIssuesCard({
  locationAvailableIssueIds,
  onSelectIssue,
  rows,
  selectedIssueId
}: RecentIssuesCardProps) {
  const [activePageIndex, setActivePageIndex] = useState(0);
  const pageSize = 2;
  const pageCount = Math.max(Math.ceil(rows.length / pageSize), 1);
  const canMoveBackward = activePageIndex > 0;
  const canMoveForward = activePageIndex < pageCount - 1;
  const visibleRows = useMemo(
    () => rows.slice(activePageIndex * pageSize, activePageIndex * pageSize + pageSize),
    [activePageIndex, rows]
  );

  useEffect(() => {
    setActivePageIndex((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  useEffect(() => {
    if (selectedIssueId === null) {
      return;
    }

    const selectedIndex = rows.findIndex(({ issue }) => issue.id === selectedIssueId);
    if (selectedIndex >= 0) {
      setActivePageIndex(Math.floor(selectedIndex / pageSize));
    }
  }, [rows, selectedIssueId]);

  return (
    <article
      aria-labelledby="site-recent-issues-heading"
      className="dashboard-card site-recent-issues-card flex h-full min-h-[440px] flex-col rounded-[18px] border-0 p-4"
    >
      <div className="site-dashboard-card-heading flex flex-wrap items-center justify-between gap-3">
        <h2 id="site-recent-issues-heading" className="text-[15px] font-bold text-[var(--dashboard-text-strong)]">
          최근 발견 이슈
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          {pageCount > 1 && (
            <nav className="flex items-center gap-1" aria-label="최근 발견 이슈 페이지 이동">
              <button
                type="button"
                aria-label={`이전 이슈 보기 (${activePageIndex + 1}/${pageCount} 페이지)`}
                disabled={!canMoveBackward}
                className="site-recent-issue-nav-button inline-flex items-center justify-center bg-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => setActivePageIndex((current) => Math.max(current - 1, 0))}
              >
                <svg width="20" height="20" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path
                    d="M22.499 12.85a.9.9 0 0 1 .57.205l.067.06a.9.9 0 0 1 .06 1.206l-.06.066-5.585 5.586-.028.027.028.027 5.585 5.587a.9.9 0 0 1 .06 1.207l-.06.066a.9.9 0 0 1-1.207.06l-.066-.06-6.25-6.25a1 1 0 0 1-.158-.212l-.038-.08a.9.9 0 0 1-.03-.606l.03-.083a1 1 0 0 1 .137-.226l.06-.066 6.25-6.25a.9.9 0 0 1 .635-.263Z"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth=".078"
                  />
                </svg>
              </button>
              <button
                type="button"
                aria-label={`다음 이슈 보기 (${activePageIndex + 1}/${pageCount} 페이지)`}
                disabled={!canMoveForward}
                className="site-recent-issue-nav-button inline-flex items-center justify-center bg-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => setActivePageIndex((current) => Math.min(current + 1, pageCount - 1))}
              >
                <svg className="rotate-180" width="20" height="20" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path
                    d="M22.499 12.85a.9.9 0 0 1 .57.205l.067.06a.9.9 0 0 1 .06 1.206l-.06.066-5.585 5.586-.028.027.028.027 5.585 5.587a.9.9 0 0 1 .06 1.207l-.06.066a.9.9 0 0 1-1.207.06l-.066-.06-6.25-6.25a1 1 0 0 1-.158-.212l-.038-.08a.9.9 0 0 1-.03-.606l.03-.083a1 1 0 0 1 .137-.226l.06-.066 6.25-6.25a.9.9 0 0 1 .635-.263Z"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth=".078"
                  />
                </svg>
              </button>
            </nav>
          )}
          <p className="site-recent-issue-count inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--dashboard-text-muted)]">
            총
            <span className="text-sm font-bold text-[var(--dashboard-text-strong)]">{rows.length}건</span>
          </p>
        </div>
      </div>

      <div className="site-recent-issue-list mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg border-0 bg-[var(--site-row-surface)] px-4 text-center text-sm font-medium text-[var(--dashboard-text-muted)]">
            표시할 이슈가 없습니다.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {visibleRows.map(({ analyzerLabel, issue, issueGuides, severity, showsAiGuide }) => (
              <li
                key={issue.id}
                className="site-recent-issue-row"
                data-selected={issue.id === selectedIssueId ? "true" : "false"}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <SeverityChip severityKey={severity.key} label={severity.label} />
                  <span className="site-recent-issue-kwcag-tag truncate rounded-full border-0 bg-[var(--site-inset-surface)] px-2 py-0.5 text-xs font-bold text-[var(--dashboard-text-strong)]">
                    KWCAG {issue.issueCode}
                  </span>
                  <span className="site-recent-issue-analyzer truncate rounded-full border-0 bg-[var(--site-inset-surface)] px-2 py-0.5 text-xs font-semibold text-[var(--dashboard-text-muted)]">
                    {analyzerLabel}
                  </span>
                </div>
                <p
                  className="site-recent-issue-title mt-2 truncate text-sm font-bold text-[var(--dashboard-text-strong)]"
                  title={issue.issueTitle}
                >
                  {issue.issueTitle}
                </p>
                <p className="site-recent-issue-message mt-1 line-clamp-2 text-xs leading-5 text-[var(--dashboard-text-muted)]">
                  {issue.message}
                </p>
                {(issue.locationPath || locationAvailableIssueIds.has(issue.id)) && (
                  <div className="site-recent-issue-detail-box mt-3 px-2.5 py-2">
                    <div className="site-recent-issue-location-heading">
                      <p className="site-recent-issue-location-label text-xs font-bold text-[var(--dashboard-text-muted)]">
                        문제 위치
                      </p>
                      {locationAvailableIssueIds.has(issue.id) && (
                        <button
                          type="button"
                          className="site-recent-issue-location-button"
                          aria-pressed={issue.id === selectedIssueId}
                          onClick={() => onSelectIssue(issue.id)}
                        >
                          <LocateFixed aria-hidden="true" size={14} />
                          위치 보기
                        </button>
                      )}
                    </div>
                    {issue.locationPath && (
                      <p
                        className="site-recent-issue-location mt-1 truncate text-xs leading-4 text-[var(--dashboard-text-strong)]"
                        title={issue.locationPath}
                      >
                        {issue.locationPath}
                      </p>
                    )}
                  </div>
                )}
                {showsAiGuide && (
                  <div className="site-recent-issue-detail-box mt-3 px-3 py-3">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <p className="site-recent-issue-guide-label shrink-0 text-xs font-bold">AI 가이드</p>
                    </div>
                    {issueGuides.length === 0 ? (
                      <>
                        <p className="mt-2 text-xs font-bold text-[var(--dashboard-text-strong)]">
                          {issue.recommendation ? "개선 권장사항" : "개선 가이드 준비 중"}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--dashboard-text-muted)]">
                          {issue.recommendation ??
                            "이슈 위치와 컴포넌트 역할을 확인한 뒤 WCAG 기준에 맞는 수정안을 연결해 주세요."}
                        </p>
                      </>
                    ) : (
                      <ul className="mt-2 flex flex-col gap-3">
                        {issueGuides.map((guide) => (
                          <li
                            key={guide.id}
                            className="rounded-lg border-0 bg-[var(--site-inset-surface)] px-2.5 py-2"
                          >
                            <p className="text-xs font-bold text-[var(--dashboard-text-strong)]">{guide.title}</p>
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--dashboard-text-muted)]">
                              {guide.guideContent}
                            </p>
                            {guide.recommendation && (
                              <p className="mt-2 text-xs font-medium leading-4 text-[var(--dashboard-text-muted)]">
                                {guide.recommendation}
                              </p>
                            )}
                            {guide.exampleCode && (
                              <pre className="site-recent-issue-code mt-2 max-h-20 overflow-auto px-2 py-2">
                                <code>{guide.exampleCode}</code>
                              </pre>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
