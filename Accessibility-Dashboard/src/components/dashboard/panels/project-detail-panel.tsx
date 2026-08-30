import { ArrowDown, ArrowUp, ExternalLink, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { getApiErrorMessage } from "@/services/backend-api";
import type {
  EvaluationTargetModel,
  EvaluationRequestModel,
  OrganizationModel,
  ScoreResult
} from "@/types/accessibility-domain";

import { PanelMessage, renderTargetTypeIcon } from "../shared/display";
import { buildLatestEvaluationRequestByTargetId } from "../shared/evaluation-request-selection";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";
import { formatDateTime, mapScanStatus } from "../shared/utils";

type ProjectDetailSiteSortKey = "targetType" | "siteName" | "score" | "updatedAt";

function getFallbackFaviconUrl(accessUrl: string): string | null {
  try {
    const url = new URL(accessUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return `${url.origin}/favicon.ico`;
  } catch {
    return null;
  }
}


export function OrganizationModelDetailPanel({
  organization,
  evaluationRequests,
  scoreResults,
  isDarkMode,
  onOpenCreateSiteModal,
  onSiteClick,
  onDeleteEvaluationTargetModel,
  readOnly = false
}: {
  organization: OrganizationModel;
  evaluationRequests: EvaluationRequestModel[];
  scoreResults: ScoreResult[];
  isDarkMode: boolean;
  onOpenCreateSiteModal: () => void;
  onSiteClick: (siteId: number) => void;
  onDeleteEvaluationTargetModel: (input: { projectId: number; siteId: number }) => Promise<void>;
  readOnly?: boolean;
}) {
  const [siteSortConfig, setSiteSortConfig] = useState<{
    key: ProjectDetailSiteSortKey;
    direction: "asc" | "desc";
  }>({
    key: "updatedAt",
    direction: "desc"
  });
  const [deletingEvaluationTargetModel, setDeletingEvaluationTargetModel] = useState<EvaluationTargetModel | null>(null);
  const [deleteEvaluationTargetError, setDeleteEvaluationTargetError] = useState("");
  const [isDeletingEvaluationTarget, setIsDeletingEvaluationTarget] = useState(false);
  const deleteEvaluationTargetLockRef = useRef(false);
  const activeDeleteEvaluationTargetOperationIdRef = useRef<symbol | null>(null);

  useEffect(
    () => () => {
      activeDeleteEvaluationTargetOperationIdRef.current = null;
      deleteEvaluationTargetLockRef.current = false;
    },
    []
  );

  const activeEvaluationTargets = organization.evaluationTargets.filter((target) => target.status !== "DELETED");
  const evaluationTargetIds = new Set(activeEvaluationTargets.map((target) => target.id));
  const organizationEvaluationRequests = evaluationRequests.filter((request) =>
    evaluationTargetIds.has(request.evaluationTargetId)
  );
  const latestActivityRequestBySiteId = buildLatestEvaluationRequestByTargetId(
    organizationEvaluationRequests
  );
  const scoreByEvaluationRequestId = new Map(scoreResults.map((scoreResult) => [scoreResult.evaluationRequestId, scoreResult]));
  const scoredRequestIds = new Set(scoreByEvaluationRequestId.keys());
  const latestScoredRequestBySiteId = buildLatestEvaluationRequestByTargetId(
    organizationEvaluationRequests,
    scoredRequestIds
  );

  const evaluationTargetById = new Map(activeEvaluationTargets.map((site) => [site.id, site]));

  const siteRows = activeEvaluationTargets.map((site) => {
    const latestActivityRequest = latestActivityRequestBySiteId.get(site.id);
    const latestScoredRequest = latestScoredRequestBySiteId.get(site.id);
    const latestScoreResult = latestScoredRequest
      ? scoreByEvaluationRequestId.get(latestScoredRequest.id)
      : undefined;

    return {
      id: site.id,
      targetType: site.targetType,
      name: site.name,
      accessUrl: site.accessUrl,
      faviconUrl: site.faviconUrl ?? getFallbackFaviconUrl(site.accessUrl),
      status: latestActivityRequest ? mapScanStatus(latestActivityRequest.status) : "미진행",
      totalScore: latestScoreResult?.totalScore ?? null,
      finishedAt: latestScoredRequest?.updatedAt ?? null,
      lastUpdatedAt: latestScoredRequest?.updatedAt ?? site.createdAt
    };
  });

  const sortedSiteRows = [...siteRows].sort((a, b) => {
    const updatedDiff = Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt);

    if (siteSortConfig.key === "siteName") {
      const siteNameDiff = a.name.localeCompare(b.name, "ko");
      if (siteNameDiff !== 0) {
        return siteSortConfig.direction === "asc" ? siteNameDiff : -siteNameDiff;
      }

      return siteSortConfig.direction === "asc" ? -updatedDiff : updatedDiff;
    }

    if (siteSortConfig.key === "targetType") {
      const targetTypeDiff = a.targetType.localeCompare(b.targetType, "ko");
      if (targetTypeDiff !== 0) {
        return siteSortConfig.direction === "asc" ? targetTypeDiff : -targetTypeDiff;
      }

      return siteSortConfig.direction === "asc" ? -updatedDiff : updatedDiff;
    }

    if (siteSortConfig.key === "score") {
      const scoreDiff = (b.totalScore ?? -1) - (a.totalScore ?? -1);
      if (scoreDiff !== 0) {
        return siteSortConfig.direction === "desc" ? scoreDiff : -scoreDiff;
      }

      return siteSortConfig.direction === "desc" ? updatedDiff : -updatedDiff;
    }

    return siteSortConfig.direction === "asc" ? -updatedDiff : updatedDiff;
  });

  const handleSiteSort = (key: ProjectDetailSiteSortKey) => {
    setSiteSortConfig((current) => {
      if (current.key === key) {
        return {
          key,
          direction: current.direction === "asc" ? "desc" : "asc"
        };
      }

      return {
        key,
        direction: key === "updatedAt" || key === "score" ? "desc" : "asc"
      };
    });
  };

  const getSiteSortIndicator = (key: ProjectDetailSiteSortKey) => {
    const isActive = siteSortConfig.key === key;

    return (
      <span
        className={cn(
          "inline-flex h-4 w-3 shrink-0 items-center justify-center leading-none",
          isActive ? "opacity-100" : "opacity-0"
        )}
      >
        {siteSortConfig.direction === "asc" ? (
          <ArrowUp size={11} strokeWidth={2.4} className="block" />
        ) : (
          <ArrowDown size={11} strokeWidth={2.4} className="block" />
        )}
      </span>
    );
  };

  const getCenteredSiteSortIndicator = (key: ProjectDetailSiteSortKey) => {
    const isActive = siteSortConfig.key === key;

    return (
      <span
        className={cn(
          "pointer-events-none absolute left-full top-1/2 ml-0.5 inline-flex h-4 w-3 -translate-y-1/2 items-center justify-center leading-none",
          isActive ? "opacity-100" : "opacity-0"
        )}
      >
        {siteSortConfig.direction === "asc" ? (
          <ArrowUp size={11} strokeWidth={2.4} className="block" />
        ) : (
          <ArrowDown size={11} strokeWidth={2.4} className="block" />
        )}
      </span>
    );
  };

  const getSiteStatusBadgeClassName = (status: string) => {
    if (status === finishedStatusLabel) {
      return "site-status-badge site-status-badge-finished";
    }
    if (status === runningStatusLabel) {
      return "site-status-badge site-status-badge-running";
    }
    if (status === failedStatusLabel) {
      return "site-status-badge site-status-badge-failed";
    }
    return "site-status-badge site-status-badge-idle";
  };

  const getTargetTypeInfo = (type: OrganizationModel["evaluationTargets"][number]["targetType"]) => {
    if (type === "모바일 웹") {
      return "모바일 웹";
    }

    if (type === "문서") {
      return "문서";
    }

    return "PC 웹";
  };

  const openDeleteEvaluationTargetModel = (site: EvaluationTargetModel) => {
    setDeletingEvaluationTargetModel(site);
    setDeleteEvaluationTargetError("");
  };

  const closeDeleteEvaluationTargetModel = () => {
    if (deleteEvaluationTargetLockRef.current) {
      return;
    }
    setDeletingEvaluationTargetModel(null);
    setDeleteEvaluationTargetError("");
  };

  const deleteDialogRef = useDialogAccessibility({
    isOpen: deletingEvaluationTargetModel !== null,
    onClose: closeDeleteEvaluationTargetModel,
    closeDisabled: isDeletingEvaluationTarget
  });

  const handleConfirmDeleteEvaluationTargetModel = async () => {
    if (deleteEvaluationTargetLockRef.current || !deletingEvaluationTargetModel) {
      return;
    }

    const target = deletingEvaluationTargetModel;
    const projectId = organization.id;
    deleteEvaluationTargetLockRef.current = true;
    const operationId = Symbol("project-page-delete");
    activeDeleteEvaluationTargetOperationIdRef.current = operationId;
    setIsDeletingEvaluationTarget(true);
    setDeleteEvaluationTargetError("");

    try {
      await onDeleteEvaluationTargetModel({
        projectId,
        siteId: target.id
      });

      if (activeDeleteEvaluationTargetOperationIdRef.current === operationId) {
        setDeletingEvaluationTargetModel(null);
        setDeleteEvaluationTargetError("");
      }
    } catch (error) {
      if (activeDeleteEvaluationTargetOperationIdRef.current === operationId) {
        setDeleteEvaluationTargetError(getApiErrorMessage(error, "페이지 제거 중 오류가 발생했습니다."));
      }
    } finally {
      if (activeDeleteEvaluationTargetOperationIdRef.current === operationId) {
        activeDeleteEvaluationTargetOperationIdRef.current = null;
        deleteEvaluationTargetLockRef.current = false;
        setIsDeletingEvaluationTarget(false);
      }
    }
  };

  const finishedStatusLabel = mapScanStatus("finished");
  const failedStatusLabel = mapScanStatus("failed");
  const runningStatusLabel = mapScanStatus("queued");

  return (
    <div className="dashboard-project-panel overflow-visible">
      <div className="dashboard-project-add-action absolute top-[calc(var(--dashboard-fixed-top)+var(--dashboard-control-size)+1rem)] z-50">
        <button
          type="button"
          onClick={onOpenCreateSiteModal}
          disabled={readOnly}
          title={readOnly ? "읽기 전용 미리보기에서는 페이지를 추가할 수 없습니다" : undefined}
          className="dashboard-project-add-button inline-flex shrink-0 items-center bg-[#0071e3] font-semibold text-white transition-colors hover:bg-[#0066cc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/40 disabled:cursor-not-allowed"
        >
          페이지 추가
        </button>
      </div>

      {sortedSiteRows.length === 0 ? (
        <div
          className={`dashboard-project-content rounded-[14px] border px-5 py-10 text-center text-sm backdrop-blur-xl ${
            isDarkMode
              ? "border-white/[0.12] bg-white/[0.05] text-[#8e8e93] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.18)]"
              : "border-white/85 bg-white/65 text-[#6e6e73] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_10px_28px_rgba(29,29,31,0.07)]"
          }`}
        >
          등록된 페이지가 없습니다.
        </div>
      ) : (
        <div className="dashboard-project-content dashboard-project-grid grid">
          {sortedSiteRows.map((row) => (
            <article
              key={row.id}
              className={`dashboard-project-card group relative flex flex-col overflow-hidden border backdrop-blur-xl transition-[background-color,border-color,box-shadow] ${
                isDarkMode
                  ? "border-white/[0.12] bg-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.18)] hover:border-white/[0.2] hover:bg-white/[0.075]"
                  : "border-white/85 bg-white/65 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_10px_28px_rgba(29,29,31,0.07)] hover:border-white hover:bg-white/80"
              }`}
            >
              <button
                type="button"
                aria-label={`${row.name} 상세 보기`}
                onClick={() => onSiteClick(row.id)}
                className="absolute inset-0 z-0 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/45"
              />

              {!readOnly ? <div className="dashboard-project-card-delete absolute z-10">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    const site = evaluationTargetById.get(row.id);
                    if (site) {
                      openDeleteEvaluationTargetModel(site);
                    }
                  }}
                  aria-label={`${row.name} 제거`}
                  className={`dashboard-project-card-delete-button inline-flex items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100 focus:opacity-100 ${
                    isDarkMode
                      ? "text-[#a1a1a6] hover:bg-white/[0.07]"
                      : "text-[#86868b] hover:bg-black/[0.05]"
                  }`}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div> : null}

              <div className="dashboard-project-card-header pointer-events-none relative z-[1] flex min-w-0 items-start">
                <span
                  className={`dashboard-project-favicon relative inline-flex shrink-0 items-center justify-center overflow-hidden border bg-white ${
                    isDarkMode ? "border-white/10 text-[#6e6e73]" : "border-[#e5e5ea] text-[#86868b]"
                  }`}
                  aria-hidden="true"
                >
                  <span className="absolute inset-0 flex items-center justify-center">
                    {renderTargetTypeIcon(row.targetType)}
                  </span>
                  {row.faviconUrl ? (
                    <img
                      src={row.faviconUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : null}
                </span>

                <div className="min-w-0">
                  <h3
                    className={`dashboard-project-card-title truncate font-semibold ${
                      isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
                    }`}
                    title={row.name}
                  >
                    {row.name}
                  </h3>
                  <p className={`dashboard-project-card-meta mt-0.5 truncate ${isDarkMode ? "text-[#8e8e93]" : "text-[#86868b]"}`}>
                    {getTargetTypeInfo(row.targetType)}
                  </p>
                </div>
              </div>

              <div className="dashboard-project-card-main pointer-events-none relative z-[1] flex items-center justify-between">
                {row.accessUrl && !readOnly ? (
                  <a
                    href={row.accessUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={row.accessUrl}
                    onClick={(event) => event.stopPropagation()}
                    className={`dashboard-project-card-url pointer-events-auto relative z-[2] flex min-w-0 items-center gap-1 truncate hover:underline ${
                      isDarkMode ? "text-[#a1a1a6]" : "text-[#6e6e73]"
                    }`}
                  >
                    <span className="truncate">{row.accessUrl}</span>
                    <ExternalLink size={10} className="shrink-0" aria-hidden="true" />
                  </a>
                ) : row.accessUrl ? (
                  <p
                    className={`dashboard-project-card-url min-w-0 truncate ${
                      isDarkMode ? "text-[#a1a1a6]" : "text-[#6e6e73]"
                    }`}
                    title={row.accessUrl}
                  >
                    {row.accessUrl}
                  </p>
                ) : (
                  <p className={`dashboard-project-card-url min-w-0 truncate ${isDarkMode ? "text-[#6e6e73]" : "text-[#a1a1a6]"}`}>
                    등록된 주소 없음
                  </p>
                )}

                <span
                  className={`dashboard-project-card-score pointer-events-none shrink-0 font-semibold tabular-nums ${
                    isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
                  }`}
                  aria-label={`점수 ${row.totalScore !== null ? `${row.totalScore}점` : "없음"}`}
                >
                  {row.totalScore !== null ? `${row.totalScore}점` : "-"}
                </span>
              </div>

              <div
                className={`dashboard-project-card-footer pointer-events-none relative z-[1] mt-auto flex items-center justify-between border-t ${
                  isDarkMode ? "border-[#38383a]" : "border-[#e5e5ea]"
                }`}
              >
                <span className={`dashboard-project-card-status inline-flex min-w-0 items-center gap-1.5 ${isDarkMode ? "text-[#c7c7cc]" : "text-[#515154]"}`}>
                  <span
                    className={cn(
                      "dashboard-project-status-dot shrink-0 rounded-full",
                      row.status === finishedStatusLabel && "bg-emerald-400",
                      row.status === runningStatusLabel && "bg-sky-400",
                      row.status === failedStatusLabel && "bg-rose-400",
                      row.status !== finishedStatusLabel &&
                        row.status !== runningStatusLabel &&
                        row.status !== failedStatusLabel &&
                        (isDarkMode ? "bg-[#6e6e73]" : "bg-[#a1a1a6]")
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{row.status}</span>
                </span>
                <time
                  className={`dashboard-project-card-time shrink-0 tabular-nums ${isDarkMode ? "text-[#8e8e93]" : "text-[#86868b]"}`}
                  title={formatDateTime(row.finishedAt)}
                >
                  {formatDateTime(row.finishedAt)}
                </time>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="hidden">
          <div
            className={`project-list-table overflow-hidden rounded-[18px] border ${
              isDarkMode ? "border-[#3a3a3c] bg-[#1c1c1e]" : "border-[#d2d2d7] bg-white"
            }`}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] table-fixed text-left">
              <colgroup>
                <col className="w-[52px]" />
                <col className="w-[21%]" />
                <col className="w-[30%]" />
                <col className="w-[72px]" />
                <col className="w-[72px]" />
                <col className="w-[136px]" />
                <col className="w-11" />
              </colgroup>
              <thead className="project-list-head border-b border-slate-200/80 text-xs text-slate-500">
                <tr>
                  <th className="h-10 py-0 text-center font-medium align-middle">
                    <button
                      type="button"
                      onClick={() => handleSiteSort("targetType")}
                      className="flex h-10 w-full cursor-pointer select-none items-center justify-center px-0 text-center"
                    >
                      <span className="relative inline-flex items-center justify-center">
                        종류
                        {getCenteredSiteSortIndicator("targetType")}
                      </span>
                    </button>
                  </th>
                  <th className="h-10 py-0 font-medium align-middle">
                    <button
                      type="button"
                      onClick={() => handleSiteSort("siteName")}
                      className="flex h-10 w-full cursor-pointer select-none items-center gap-0.5 px-3 text-left"
                    >
                      페이지 이름
                      {getSiteSortIndicator("siteName")}
                    </button>
                  </th>
                  <th className="h-10 px-3 py-0 font-medium align-middle">주소</th>
                  <th className="h-10 px-3 py-0 text-center font-medium align-middle">상태</th>
                  <th className="h-10 py-0 text-center font-medium align-middle">
                    <button
                      type="button"
                      onClick={() => handleSiteSort("score")}
                      className="flex h-10 w-full cursor-pointer select-none items-center justify-center px-3 text-center"
                    >
                      <span className="relative inline-flex items-center justify-center">
                        최근 점수
                        {getCenteredSiteSortIndicator("score")}
                      </span>
                    </button>
                  </th>
                  <th className="h-10 py-0 font-medium align-middle">
                    <button
                      type="button"
                      onClick={() => handleSiteSort("updatedAt")}
                      className="flex h-10 w-full cursor-pointer select-none items-center gap-0.5 px-3 text-left"
                    >
                      최근 완료 시각
                      {getSiteSortIndicator("updatedAt")}
                    </button>
                  </th>
                  <th className="h-10 px-3 py-0 align-middle" aria-label="페이지 액션" />
                </tr>
              </thead>
              <tbody>
                {sortedSiteRows.length === 0 ? (
                  <tr className="project-list-row">
                    <td colSpan={7} className="px-4 py-6 text-center text-xs text-slate-500">
                      등록된 페이지가 없습니다.
                    </td>
                  </tr>
                ) : (
                  sortedSiteRows.map((row, index) => (
                    <tr
                      key={row.id}
                      onClick={() => onSiteClick(row.id)}
                      className={`project-list-row group h-11 cursor-pointer ${
                        index !== sortedSiteRows.length - 1
                          ? isDarkMode
                            ? "border-b border-[#3a3a3c]"
                            : "border-b border-[#e5e5ea]"
                          : ""
                      }`}
                    >
                      <td className="relative px-0 py-2 align-middle text-slate-600">
                        <div className="group/target-type relative flex items-center justify-center">
                          <span
                            className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition ${
                              isDarkMode ? "group-hover/target-type:bg-white/[0.06]" : "group-hover/target-type:bg-slate-100"
                            }`}
                            aria-label={getTargetTypeInfo(row.targetType)}
                          >
                            {renderTargetTypeIcon(row.targetType)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <div className="min-w-0">
                          <p className="truncate text-[0.8125rem] font-semibold text-slate-900">{row.name}</p>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <a
                          href={row.accessUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={row.accessUrl}
                          onClick={(event) => event.stopPropagation()}
                          className="inline-block max-w-full truncate text-[0.8125rem] leading-4 text-slate-600 hover:underline"
                        >
                          {row.accessUrl}
                        </a>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <div className="flex items-center justify-center">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold",
                              getSiteStatusBadgeClassName(row.status)
                            )}
                          >
                            {row.status}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center align-middle">
                        <span className="text-[0.8125rem] font-medium text-slate-700">
                          {row.totalScore !== null ? `${row.totalScore}점` : "-"}
                        </span>
                      </td>
                      <td className="project-list-updated px-3 py-2 align-middle text-xs tabular-nums text-slate-500">
                        {formatDateTime(row.finishedAt)}
                      </td>
                      <td className="relative px-3 py-2 text-right align-middle">
                        <div className="group/project-actions absolute right-3 top-1/2 flex h-9 w-[68px] -translate-y-1/2 items-center justify-end">
                          <div className="pointer-events-none absolute right-9 top-1/2 inline-flex h-9 w-7 -translate-y-1/2 items-center justify-end opacity-0 transition-all duration-200 ease-out group-hover/project-actions:pointer-events-auto group-hover/project-actions:translate-x-0 group-hover/project-actions:opacity-100 translate-x-1">
                            <div className="group/action relative flex items-center">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const site = evaluationTargetById.get(row.id);
                                  if (site) {
                                    openDeleteEvaluationTargetModel(site);
                                  }
                                }}
                                aria-label="제거"
                                className={`project-list-icon-action inline-flex h-7 w-7 items-center justify-center rounded-full bg-transparent transition ${
                                  isDarkMode
                                    ? "text-rose-400 hover:bg-white/[0.075] hover:text-rose-300"
                                    : "text-red-600 hover:text-red-700"
                                }`}
                              >
                                <Trash2 size={14} className={isDarkMode ? "text-rose-400" : "text-red-600"} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              </table>
            </div>
          </div>
      </div>
      {!readOnly && deletingEvaluationTargetModel
        ? createPortal(
            <div className="dashboard-modal-layer fixed inset-0 flex items-center justify-center bg-black/60 px-4 py-6">
              <div
                className="absolute inset-0"
                onClick={() => {
                  if (!isDeletingEvaluationTarget) {
                    closeDeleteEvaluationTargetModel();
                  }
                }}
              />
              <article
                ref={deleteDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="site-delete-title"
                aria-describedby="site-delete-description"
                tabIndex={-1}
                className={`relative z-10 w-full max-w-md rounded-[18px] border p-6 ${
                  isDarkMode ? "border-[#3a3a3c] bg-[#1c1c1e]" : "border-[#d2d2d7] bg-white"
                }`}
              >
                <h3
                  id="site-delete-title"
                  className={`text-lg font-semibold tracking-[-0.015em] ${
                    isDarkMode ? "text-[#f5f5f7]" : "text-[#1d1d1f]"
                  }`}
                >
                  페이지 제거
                </h3>
                <p
                  id="site-delete-description"
                  className={`mt-3 text-sm leading-6 ${isDarkMode ? "text-[#a1a1a6]" : "text-[#6e6e73]"}`}
                >
                  <span className={isDarkMode ? "font-semibold text-[#f5f5f7]" : "font-semibold text-[#1d1d1f]"}>
                    {deletingEvaluationTargetModel.name}
                  </span>
                  {" "}페이지를 제거하시겠습니까?
                </p>

                {deleteEvaluationTargetError.length > 0 && (
                  <PanelMessage label={`페이지 제거 실패: ${deleteEvaluationTargetError}`} isError />
                )}

                <div className="mt-6 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={isDeletingEvaluationTarget}
                    onClick={closeDeleteEvaluationTargetModel}
                    className={`inline-flex h-7 items-center rounded-md px-5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                      isDarkMode
                        ? "bg-[#2c2c2e] text-[#f5f5f7] hover:bg-[#3a3a3c] focus-visible:ring-white/30"
                        : "bg-[#e5e5ea] text-[#1d1d1f] hover:bg-[#d2d2d7] focus-visible:ring-[#1d1d1f]/20"
                    }`}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    disabled={isDeletingEvaluationTarget}
                    onClick={() => {
                      void handleConfirmDeleteEvaluationTargetModel();
                    }}
                    className="inline-flex h-7 items-center rounded-md bg-[#0071e3] px-5 text-xs font-semibold text-white transition-colors hover:bg-[#0066cc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/35 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isDeletingEvaluationTarget ? "제거 중..." : "제거"}
                  </button>
                </div>
              </article>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
