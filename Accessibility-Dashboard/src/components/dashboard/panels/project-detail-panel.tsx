import type { ProjectPageActions } from "../dashboard-surface.types";
import { ExternalLink, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getApiErrorMessage } from "@/services/backend-api";
import { getVerifiedFaviconUrl } from "@/services/favicon-url";
import type {
  EvaluationTargetModel,
  EvaluationRequestModel,
  OrganizationModel,
  ScoreResult
} from "@/types/accessibility-domain";

import { PanelMessage, renderTargetTypeIcon } from "../shared/display";
import { buildLatestEvaluationRequestByTargetId } from "@/services/evaluation-request-selection";
import { useDialogAccessibility } from "../shared/use-dialog-accessibility";
import { formatDateTime, formatScore, mapScanStatus } from "../shared/utils";

function ProjectFavicon({
  faviconUrl,
  targetType
}: {
  faviconUrl: string | null;
  targetType: EvaluationTargetModel["targetType"];
}) {
  const [loadedFaviconUrl, setLoadedFaviconUrl] = useState<string | null>(null);
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  const hasLoadedFavicon = faviconUrl !== null && loadedFaviconUrl === faviconUrl;

  return (
    <span
      className={cn(
        "dashboard-project-favicon relative inline-flex shrink-0 items-center justify-center overflow-hidden",
        hasLoadedFavicon ? "bg-transparent" : "dashboard-project-favicon-fallback"
      )}
      data-favicon-loaded={hasLoadedFavicon ? "true" : "false"}
      aria-hidden="true"
    >
      {!hasLoadedFavicon ? (
        <span className="absolute inset-0 flex items-center justify-center">
          {renderTargetTypeIcon(targetType)}
        </span>
      ) : null}
      {faviconUrl !== null && failedFaviconUrl !== faviconUrl ? (
        <img
          src={faviconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={cn(
            "absolute inset-0 h-full w-full object-cover",
            hasLoadedFavicon ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => {
            setLoadedFaviconUrl(faviconUrl);
            setFailedFaviconUrl(null);
          }}
          onError={() => {
            setLoadedFaviconUrl(null);
            setFailedFaviconUrl(faviconUrl);
          }}
        />
      ) : null}
    </span>
  );
}

function getTargetTypeInfo(type: OrganizationModel["evaluationTargets"][number]["targetType"]) {
  if (type === "모바일 웹") {
    return "모바일 웹";
  }

  if (type === "문서") {
    return "문서";
  }

  return "PC 웹";
}

export function OrganizationModelDetailPanel({
  organization,
  evaluationRequests,
  scoreResults,
  onSiteClick,
  actions
}: {
  organization: OrganizationModel;
  evaluationRequests: EvaluationRequestModel[];
  scoreResults: ScoreResult[];
  onSiteClick: (siteId: number) => void;
  actions: ProjectPageActions | null;
}) {
  const readOnly = actions === null;
  const [deletingEvaluationTargetModel, setDeletingEvaluationTargetModel] = useState<EvaluationTargetModel | null>(null);
  const [deleteEvaluationTargetError, setDeleteEvaluationTargetError] = useState("");
  const [isDeletingEvaluationTarget, setIsDeletingEvaluationTarget] = useState(false);
  const deleteEvaluationTargetLockRef = useRef(false);
  const activeDeleteEvaluationTargetOperationIdRef = useRef<symbol | null>(null);
  const addPageButtonRef = useRef<HTMLButtonElement>(null);
  const cardGridRef = useRef<HTMLDivElement>(null);

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
      faviconUrl: getVerifiedFaviconUrl(site.faviconUrl),
      status: latestActivityRequest ? mapScanStatus(latestActivityRequest.status) : "미진행",
      totalScore: latestScoreResult?.totalScore ?? null,
      finishedAt: latestScoredRequest?.updatedAt ?? null,
      lastUpdatedAt: latestScoredRequest?.updatedAt ?? site.createdAt
    };
  });

  // Most recently analysed (or created) pages first.
  const sortedSiteRows = [...siteRows].sort(
    (a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt)
  );

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

  // The removed card took the dialog's opener with it; continue from the
  // first remaining card, or the add button when the project is now empty.
  const getDeleteFallbackFocus = useCallback(
    () =>
      cardGridRef.current?.querySelector<HTMLElement>(".dashboard-project-card > button") ??
      addPageButtonRef.current,
    []
  );

  const deleteDialogRef = useDialogAccessibility({
    isOpen: deletingEvaluationTargetModel !== null,
    onClose: closeDeleteEvaluationTargetModel,
    closeDisabled: isDeletingEvaluationTarget,
    getFallbackFocus: getDeleteFallbackFocus
  });

  const handleConfirmDeleteEvaluationTargetModel = async () => {
    if (!actions || deleteEvaluationTargetLockRef.current || !deletingEvaluationTargetModel) {
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
      await actions.onDeleteEvaluationTargetModel({
        projectId,
        siteId: target.id
      });

      if (activeDeleteEvaluationTargetOperationIdRef.current === operationId) {
        setDeletingEvaluationTargetModel(null);
        setDeleteEvaluationTargetError("");
      }
    } catch (error) {
      if (activeDeleteEvaluationTargetOperationIdRef.current === operationId) {
        setDeleteEvaluationTargetError(
          getApiErrorMessage(error, "페이지를 제거하지 못했습니다. 잠시 후 다시 시도해 주세요.")
        );
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
          ref={addPageButtonRef}
          type="button"
          onClick={actions?.onOpenCreateSiteModal}
          disabled={readOnly}
          title={readOnly ? "읽기 전용 미리보기에서는 페이지를 추가할 수 없습니다" : undefined}
          className="dashboard-project-add-button inline-flex shrink-0 items-center bg-[var(--primary)] font-semibold text-[var(--primary-foreground)] transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/40 disabled:cursor-not-allowed"
        >
          페이지 추가
        </button>
      </div>

      {sortedSiteRows.length === 0 ? (
        <div className="dashboard-project-content dashboard-project-glass rounded-[14px] border px-5 py-10 text-center text-sm text-[var(--dashboard-text-muted)] backdrop-blur-xl">
          등록된 페이지가 없습니다.
        </div>
      ) : (
        <div ref={cardGridRef} className="dashboard-project-content dashboard-project-grid grid">
          {sortedSiteRows.map((row) => (
            <article
              key={row.id}
              className="dashboard-project-card dashboard-project-glass dashboard-project-glass--interactive group relative flex flex-col overflow-hidden border backdrop-blur-xl transition-[background-color,border-color,box-shadow]"
            >
              <button
                type="button"
                aria-label={`${row.name} 상세 보기`}
                onClick={() => onSiteClick(row.id)}
                className="absolute inset-0 z-0 cursor-pointer rounded-[inherit] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--dashboard-accent)]"
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
                  className="dashboard-project-card-delete-button inline-flex items-center justify-center rounded-full text-[var(--dashboard-danger-text)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--dashboard-danger-surface)] focus:opacity-100"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div> : null}

              <div className="dashboard-project-card-header pointer-events-none relative z-[1] flex min-w-0 items-start">
                <ProjectFavicon
                  key={row.faviconUrl ?? "fallback"}
                  faviconUrl={row.faviconUrl}
                  targetType={row.targetType}
                />

                <div className="min-w-0">
                  <h3
                    className="dashboard-project-card-title truncate font-semibold text-[var(--dashboard-text-strong)]"
                    title={row.name}
                  >
                    {row.name}
                  </h3>
                  <p className="dashboard-project-card-meta mt-0.5 truncate text-[var(--dashboard-text-muted)]">
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
                    title={`${row.accessUrl} (새 창에서 열림)`}
                    onClick={(event) => event.stopPropagation()}
                    className="dashboard-project-card-url pointer-events-auto relative z-[2] flex min-w-0 items-center gap-1 truncate text-[var(--dashboard-text-muted)] hover:underline"
                  >
                    <span className="truncate">{row.accessUrl}</span>
                    <span className="sr-only"> (새 창에서 열림)</span>
                    <ExternalLink size={10} className="shrink-0" aria-hidden="true" />
                  </a>
                ) : row.accessUrl ? (
                  <p
                    data-copyable
                    className="dashboard-project-card-url min-w-0 truncate text-[var(--dashboard-text-muted)]"
                    title={row.accessUrl}
                  >
                    {row.accessUrl}
                  </p>
                ) : (
                  <p className="dashboard-project-card-url min-w-0 truncate text-[var(--dashboard-text-muted)]">
                    등록된 주소 없음
                  </p>
                )}

                <span className="dashboard-project-card-score pointer-events-none shrink-0 font-semibold tabular-nums text-[var(--dashboard-text-strong)]">
                  <span className="sr-only">점수 </span>
                  {row.totalScore !== null ? (
                    `${formatScore(row.totalScore)}점`
                  ) : (
                    <>
                      <span aria-hidden="true">-</span>
                      <span className="sr-only">없음</span>
                    </>
                  )}
                </span>
              </div>

              <div className="dashboard-project-card-footer pointer-events-none relative z-[1] mt-auto flex items-center justify-between border-t border-[var(--dashboard-card-divider)]">
                <span className="dashboard-project-card-status inline-flex min-w-0 items-center gap-1.5 text-[var(--dashboard-card-status-text)]">
                  <span
                    className={cn(
                      "dashboard-project-status-dot shrink-0 rounded-full",
                      row.status === finishedStatusLabel && "bg-emerald-400",
                      row.status === runningStatusLabel && "bg-sky-400",
                      row.status === failedStatusLabel && "bg-rose-400",
                      row.status !== finishedStatusLabel &&
                        row.status !== runningStatusLabel &&
                        row.status !== failedStatusLabel &&
                        "bg-[var(--dashboard-text-muted)]"
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{row.status}</span>
                </span>
                <time
                  className="dashboard-project-card-time shrink-0 tabular-nums text-[var(--dashboard-text-muted)]"
                  title={formatDateTime(row.finishedAt)}
                >
                  {formatDateTime(row.finishedAt)}
                </time>
              </div>
            </article>
          ))}
        </div>
      )}

      {!readOnly && deletingEvaluationTargetModel
        ? createPortal(
            <div className="dashboard-modal-layer">
              <div
                className="absolute inset-0"
                aria-hidden="true"
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
                className="dashboard-modal-surface dashboard-modal-content w-full max-w-md"
              >
                <h3
                  id="site-delete-title"
                  className="dashboard-modal-title"
                >
                  페이지 제거
                </h3>
                <p
                  id="site-delete-description"
                  className="dashboard-modal-description mt-3"
                >
                  <span className="font-semibold text-foreground">
                    {deletingEvaluationTargetModel.name}
                  </span>
                  {" "}페이지를 제거하시겠습니까?
                </p>

                {deleteEvaluationTargetError.length > 0 && (
                  <PanelMessage className="dashboard-modal-message" label={`페이지 제거 실패: ${deleteEvaluationTargetError}`} isError />
                )}

                <div className="dashboard-modal-actions">
                  <button
                    type="button"
                    disabled={isDeletingEvaluationTarget}
                    onClick={closeDeleteEvaluationTargetModel}
                    className="dashboard-modal-button"
                  >
                    취소
                  </button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={isDeletingEvaluationTarget}
                    onClick={() => {
                      void handleConfirmDeleteEvaluationTargetModel();
                    }}
                    className="dashboard-modal-button dashboard-modal-button--danger"
                  >
                    {isDeletingEvaluationTarget ? "제거 중..." : "제거"}
                  </Button>
                </div>
              </article>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
