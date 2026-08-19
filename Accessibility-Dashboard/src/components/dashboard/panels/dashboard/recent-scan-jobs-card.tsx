import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { DashboardViewModel } from "@/types/accessibility-domain";

import type { ScanStatus } from "../../shared/constants";
import { formatDateTime, mapScanStatus } from "../../shared/utils";

const MAX_RECENT_SCAN_ROWS = 15;
const RECENT_SCAN_PAGE_SIZE = 5;

const scanPageTransitionVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? 18 : -18
  }),
  center: {
    opacity: 1,
    x: 0
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? -18 : 18
  })
};

export type RecentScanRow = {
  id: number;
  projectId: number | null;
  project: string;
  siteId: number;
  site: string;
  status: ScanStatus;
  totalScore: number | null;
  updatedAt: string;
};

export function buildRecentScanRows(data: DashboardViewModel): RecentScanRow[] {
  const scoreByEvaluationRequestId = new Map(data.scoreResults.map((score) => [score.evaluationRequestId, score]));
  const targetSiteLookup = new Map<number, { projectId: number; projectName: string; siteId: number; siteName: string }>();

  for (const project of data.organizations) {
    for (const targetSite of project.evaluationTargets) {
      targetSiteLookup.set(targetSite.id, {
        projectId: project.id,
        projectName: project.name,
        siteId: targetSite.id,
        siteName: targetSite.name
      });
    }
  }

  return [...data.evaluationRequests]
    .sort((a, b) => {
      const left = Date.parse(a.updatedAt);
      const right = Date.parse(b.updatedAt);
      return right - left;
    })
    .map((scanJob) => {
      const score = scoreByEvaluationRequestId.get(scanJob.id);
      const siteInfo = targetSiteLookup.get(scanJob.evaluationTargetId);

      return {
        id: scanJob.id,
        projectId: siteInfo?.projectId ?? null,
        project: siteInfo?.projectName ?? "알 수 없는 프로젝트",
        siteId: siteInfo?.siteId ?? scanJob.evaluationTargetId,
        site: siteInfo?.siteName ?? `site#${scanJob.evaluationTargetId}`,
        status: mapScanStatus(scanJob.status),
        totalScore: score?.totalScore ?? null,
        updatedAt: scanJob.updatedAt
      };
    });
}

export function RecentScanJobsCard({
  rows,
  onSiteClick
}: {
  rows: RecentScanRow[];
  onSiteClick: (input: { projectId: number; siteId: number }) => void;
}) {
  const [scanPage, setScanPage] = useState(0);
  const [scanDirection, setScanDirection] = useState(0);
  const recentScanRows = rows.slice(0, MAX_RECENT_SCAN_ROWS);

  const scanPageCount = Math.max(1, Math.ceil(recentScanRows.length / RECENT_SCAN_PAGE_SIZE));
  const activeScanPage = Math.min(scanPage, scanPageCount - 1);
  const visibleScanRows = recentScanRows.slice(
    activeScanPage * RECENT_SCAN_PAGE_SIZE,
    activeScanPage * RECENT_SCAN_PAGE_SIZE + RECENT_SCAN_PAGE_SIZE
  );
  const visibleScanPageDotCount = Math.min(scanPageCount, 3);
  const firstVisibleScanPage = Math.min(
    Math.max(activeScanPage - Math.floor(visibleScanPageDotCount / 2), 0),
    Math.max(scanPageCount - visibleScanPageDotCount, 0)
  );
  const visibleScanPageIndexes = Array.from(
    { length: visibleScanPageDotCount },
    (_, index) => firstVisibleScanPage + index
  );

  const handleScanPageChange = (nextPage: number) => {
    if (nextPage === activeScanPage) {
      return;
    }

    setScanDirection(nextPage > activeScanPage ? 1 : -1);
    setScanPage(nextPage);
  };

  return (
    <article className="dashboard-card flex min-h-[300px] flex-col rounded-xl border border-slate-200 bg-white px-4 pt-4 pb-3 xl:min-h-0 xl:self-stretch">
      <div className="mb-3 min-w-0 pl-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">최근 스캔 작업</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-1 py-0.5">
        {recentScanRows.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-3 py-4 text-sm" style={{ color: "#64748b" }}>
            표시할 스캔 작업이 없습니다.
          </p>
        ) : (
          <AnimatePresence mode="wait" initial={false} custom={scanDirection}>
            <motion.div
              key={activeScanPage}
              custom={scanDirection}
              variants={scanPageTransitionVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="space-y-2"
            >
              {visibleScanRows.map((row) => (
                <article
                  key={row.id}
                  role="button"
                  tabIndex={row.projectId === null ? -1 : 0}
                  aria-disabled={row.projectId === null}
                  onClick={() => {
                    if (row.projectId === null) {
                      return;
                    }
                    onSiteClick({ projectId: row.projectId, siteId: row.siteId });
                  }}
                  onKeyDown={(event) => {
                    if (row.projectId === null) {
                      return;
                    }
                    if (event.key !== "Enter" && event.key !== " ") {
                      return;
                    }
                    event.preventDefault();
                    onSiteClick({ projectId: row.projectId, siteId: row.siteId });
                  }}
                  className="recent-scan-card group relative min-h-[102px] cursor-pointer rounded-xl bg-white px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                >
                  <div className="relative transition-transform duration-500 ease-out group-hover:scale-[1.006]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900" title={row.project}>
                          {row.project}
                        </p>
                        <p className="mt-1 truncate text-xs" title={row.site} style={{ color: "#64748b" }}>
                          {row.site}
                        </p>
                      </div>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold ${
                          row.status === "완료"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : row.status === "진행중"
                              ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                              : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                        }`}
                      >
                        {row.status === "진행중" && (
                          <LoaderCircle size={11} strokeWidth={2.6} className="animate-spin" aria-hidden="true" />
                        )}
                        {row.status}
                      </span>
                    </div>

                    <div className="mt-3 flex items-end justify-between gap-3">
                      <p
                        className="min-w-0 truncate text-xs font-medium"
                        title={formatDateTime(row.updatedAt)}
                        style={{ color: "#64748b" }}
                      >
                        {formatDateTime(row.updatedAt)}
                      </p>
                      <p className="shrink-0 text-sm font-bold text-slate-900">
                        {row.totalScore !== null ? `${row.totalScore}점` : "-"}
                      </p>
                    </div>
                  </div>
                </article>
              ))}
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      {scanPageCount > 1 && (
        <nav className="flex h-8 shrink-0 items-center justify-center gap-1.5" aria-label="최근 스캔 작업 페이지">
          {visibleScanPageIndexes.map((pageIndex) => {
            const isActive = pageIndex === activeScanPage;

            return (
              <button
                key={pageIndex}
                type="button"
                aria-label={`최근 스캔 작업 ${pageIndex + 1}페이지 보기`}
                aria-current={isActive ? "page" : undefined}
                className="recent-scan-pager-button inline-flex h-5 w-5 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                onClick={() => handleScanPageChange(pageIndex)}
              >
                <span aria-hidden="true" className={`recent-scan-pager-dot${isActive ? " is-active" : ""}`} />
              </button>
            );
          })}
        </nav>
      )}
    </article>
  );
}
