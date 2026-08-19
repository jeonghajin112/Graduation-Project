import { Link2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { SidebarItem } from "@/components/ui/sidebar";
import { API_BASE_URL } from "@/config/api";
import { wait } from "@/services/async-cancellation";
import {
  ApiRequestError,
  createEvaluationTargetModel,
  deleteEvaluationTargetModel,
  deleteOrganizationModel,
  requestEvaluationTargetRescan,
  updateOrganizationModel
} from "@/services/backend-api";
import { parseDashboardRoute } from "@/services/dashboard-route";
import {
  clearSiteCreateRecovery,
  normalizeSiteCreateAccessUrl,
  readSiteCreateRecovery,
  writeSiteCreateRecovery
} from "@/services/site-create-recovery-storage";
import type {
  PersistedSiteCreateAttempt,
  StoredSiteCreateAttempt
} from "@/services/site-create-recovery-storage";
import type {
  CreateEvaluationTargetInput as CreateEvaluationTargetModelInput,
  DashboardViewModel
} from "@/types/accessibility-domain";

import { selectLatestEvaluationRequest } from "./evaluation-request-selection";
import { useDashboardData } from "./use-dashboard-data";
import type { DirectoryRecoveryToken } from "./use-dashboard-data";
import { useDashboardTheme } from "./use-dashboard-theme";
import { useEvaluationTargetRescan } from "./use-evaluation-target-rescan";
import { useOrganizationModelCreateForm } from "./use-organization-model-create-form";
import { formatDateTime } from "./utils";

const APP_HOME_PATH = "/analyze";
const REQUEST_RECONCILE_ATTEMPTS = 3;
const REQUEST_RECONCILE_INTERVAL_MS = 250;
const TARGET_CREATE_TIMEOUT_MS = 15_000;
const TARGET_CREATE_RECONCILE_ATTEMPTS = 4;
const TARGET_CREATE_RECONCILE_INTERVAL_MS = 250;
const TARGET_CREATE_RECOVERY_MESSAGE =
  "페이지 생성 결과를 확인하지 못했습니다. 중복 생성을 막기 위해 생성 요청을 다시 보내지 않고 페이지 목록만 다시 확인합니다.";
const TARGET_REQUEST_RECOVERY_MESSAGE =
  "분석 요청 결과를 확인하지 못했습니다. 중복 분석을 막기 위해 요청을 다시 보내지 않고 요청 목록만 다시 확인합니다.";
const NETWORK_TIMEOUT_MESSAGE = "서버 응답 대기 시간이 초과되었습니다.";
const SITE_RECOVERY_PERSISTENCE_MESSAGE =
  "브라우저에 안전한 복구 정보를 저장하지 못해 요청을 시작하지 않았습니다. 저장 공간 또는 브라우저 설정을 확인해 주세요.";
const SITE_RECOVERY_BLOCKED_MESSAGE =
  "이전 버전, 다른 서버 또는 손상된 페이지 생성 복구 정보가 남아 있어 새 요청을 잠갔습니다. 복구 정보를 확인하거나 삭제한 뒤 다시 시도해 주세요.";
const SITE_RECOVERY_CONFLICT_MESSAGE =
  "완료 여부를 확인하지 못한 다른 페이지 작업이 남아 있어 새 요청을 시작하지 않았습니다. 기존 프로젝트에서 복구를 이어가거나, 24시간이 지난 뒤 명시적으로 복구 정보를 삭제하거나, 로그아웃해 주세요.";
const DEFINITIVE_TARGET_CREATE_REJECTION_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 413, 414, 415, 416, 417, 418,
  421, 422, 423, 424, 426, 428, 431, 451
]);

type TargetCreateCheckpoint = {
  key: string;
  projectId: number;
  name: string;
  accessUrl: string;
  previousTargetIds: number[];
  recoveryToken: DirectoryRecoveryToken | null;
  resolvedTargetId: number | null;
  stored: StoredSiteCreateAttempt;
};

type TargetAnalysisRequestCheckpoint = {
  targetId: number;
  knownRequestIds: number[];
  requestId: number | null;
  recoveryToken: DirectoryRecoveryToken | null;
  stored: StoredSiteCreateAttempt;
};

async function runWithNetworkDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal
): Promise<T> {
  if (callerSignal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const controller = new AbortController();
  let didTimeout = false;
  const forwardCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, TARGET_CREATE_TIMEOUT_MS);

  try {
    const value = await operation(controller.signal);
    if (callerSignal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (didTimeout) {
      throw new Error(NETWORK_TIMEOUT_MESSAGE);
    }
    return value;
  } catch (error) {
    if (callerSignal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (didTimeout) {
      throw new Error(NETWORK_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", forwardCallerAbort);
  }
}

function buildTargetCreateKey({
  projectId,
  name,
  accessUrl
}: CreateEvaluationTargetModelInput): string {
  return `${projectId}\u0000${name.trim()}\u0000${normalizeSiteCreateAccessUrl(accessUrl)}`;
}

function findCheckpointTargetId(
  checkpoint: TargetCreateCheckpoint,
  data: DashboardViewModel | null
): number | null {
  const organization = data?.organizations.find(
    (candidate) => candidate.id === checkpoint.projectId
  );
  if (!organization) {
    return null;
  }

  const previousIds = new Set(checkpoint.previousTargetIds);
  const candidates = organization.evaluationTargets.filter(
    (target) =>
      !previousIds.has(target.id) &&
      target.name.trim() === checkpoint.name &&
      normalizeSiteCreateAccessUrl(target.accessUrl) === checkpoint.accessUrl
  );
  if (checkpoint.resolvedTargetId !== null) {
    return organization.evaluationTargets.some(
      (target) => target.id === checkpoint.resolvedTargetId
    )
      ? checkpoint.resolvedTargetId
      : null;
  }
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function buildPersistedTargetCreateKey(attempt: PersistedSiteCreateAttempt): string {
  return buildTargetCreateKey({
    projectId: attempt.projectId,
    name: attempt.name,
    accessUrl: attempt.accessUrl
  });
}

function getPersistedTargetId(attempt: PersistedSiteCreateAttempt): number | null {
  return attempt.phase === "target-reconciling" ? null : attempt.targetId;
}

function isDefinitiveMutationRejection(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status !== null &&
    DEFINITIVE_TARGET_CREATE_REJECTION_STATUSES.has(error.status)
  );
}

export function useDashboardController({
  onBootstrapComplete
}: {
  onBootstrapComplete?: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isDarkMode, themeMode, setThemeMode } = useDashboardTheme();
  const routeState = useMemo(() => parseDashboardRoute(location.pathname), [location.pathname]);
  const {
    beginDirectoryRecovery,
    dashboardData,
    dashboardError,
    endDirectoryRecovery,
    isDashboardLoading,
    loadDashboard,
    setDashboardError
  } = useDashboardData({ onBootstrapComplete });

  const [isSiteCreateOpen, setIsSiteCreateOpen] = useState(false);
  const organizationCreationNavigationRef = useRef<number | null>(null);
  const targetCreateCheckpointRef = useRef<TargetCreateCheckpoint | null>(null);
  const targetAnalysisRequestCheckpointRef = useRef<TargetAnalysisRequestCheckpoint | null>(null);

  useEffect(() => {
    const targetCheckpoint = targetCreateCheckpointRef.current;
    if (
      targetCheckpoint?.resolvedTargetId !== null &&
      targetCheckpoint?.resolvedTargetId !== undefined &&
      dashboardData?.organizations.some((organization) =>
        organization.evaluationTargets.some(
          (target) => target.id === targetCheckpoint.resolvedTargetId
        )
      )
    ) {
      if (targetCheckpoint.recoveryToken !== null) {
        endDirectoryRecovery(targetCheckpoint.recoveryToken);
      }
      targetCreateCheckpointRef.current = null;
    }

    const requestCheckpoint = targetAnalysisRequestCheckpointRef.current;
    if (
      requestCheckpoint?.requestId !== null &&
      requestCheckpoint?.requestId !== undefined &&
      requestCheckpoint.recoveryToken !== null &&
      dashboardData?.evaluationRequests.some(
        (request) => request.id === requestCheckpoint.requestId
      )
    ) {
      endDirectoryRecovery(requestCheckpoint.recoveryToken);
      requestCheckpoint.recoveryToken = null;
    }
  }, [dashboardData?.evaluationRequests, dashboardData?.organizations, endDirectoryRecovery]);
  const handleOrganizationModelCreated = useCallback(
    (projectId: number) => {
      // Claim the intended destination synchronously. Effects from the render
      // that removed the previous project must not overwrite this navigation.
      organizationCreationNavigationRef.current = projectId;
      navigate(`/projects/${projectId}`);
    },
    [navigate]
  );
  const organizationCreateForm = useOrganizationModelCreateForm({
    beginDirectoryRecovery,
    dashboardData,
    endDirectoryRecovery,
    loadDashboard,
    onCreated: handleOrganizationModelCreated
  });

  const selectedOrganizationModel = useMemo(() => {
    if (routeState.selectedOrganizationModelId !== null) {
      return (
        dashboardData?.organizations.find(
          (organization) => organization.id === routeState.selectedOrganizationModelId
        ) ?? null
      );
    }

    if (routeState.kind !== "recentPage" || routeState.selectedEvaluationTargetModelId === null) {
      return null;
    }

    return (
      dashboardData?.organizations.find((organization) =>
        organization.evaluationTargets.some(
          (target) => target.id === routeState.selectedEvaluationTargetModelId
        )
      ) ?? null
    );
  }, [
    dashboardData?.organizations,
    routeState.kind,
    routeState.selectedEvaluationTargetModelId,
    routeState.selectedOrganizationModelId
  ]);

  const selectedEvaluationTargetModel = useMemo(() => {
    if (!selectedOrganizationModel || routeState.selectedEvaluationTargetModelId === null) {
      return null;
    }

    return (
      selectedOrganizationModel.evaluationTargets.find((target) => target.id === routeState.selectedEvaluationTargetModelId) ?? null
    );
  }, [routeState.selectedEvaluationTargetModelId, selectedOrganizationModel]);

  const isProjectDetailView =
    routeState.menu === "projects" &&
    selectedOrganizationModel !== null &&
    selectedEvaluationTargetModel === null;
  const isSiteDetailView =
    routeState.menu === "projects" &&
    selectedOrganizationModel !== null &&
    selectedEvaluationTargetModel !== null;

  useEffect(() => {
    setIsSiteCreateOpen(false);
  }, [selectedOrganizationModel?.id]);

  // Project list page removed — bare /projects goes to app home (quick analyze).
  useEffect(() => {
    if (routeState.kind === "invalidProject") {
      navigate(APP_HOME_PATH, { replace: true });
    }
  }, [navigate, routeState.kind]);

  // Reports menu is temporarily hidden from the sidebar.
  useEffect(() => {
    if (routeState.menu === "reports") {
      navigate(APP_HOME_PATH, { replace: true });
    }
  }, [navigate, routeState.menu]);

  useEffect(() => {
    const creationTargetId = organizationCreationNavigationRef.current;
    if (
      creationTargetId !== null &&
      routeState.selectedOrganizationModelId === creationTargetId &&
      dashboardData?.organizations.some((project) => project.id === creationTargetId)
    ) {
      organizationCreationNavigationRef.current = null;
    }
  }, [dashboardData, routeState.selectedOrganizationModelId]);

  useEffect(() => {
    if (
      organizationCreationNavigationRef.current !== null ||
      !dashboardData ||
      routeState.selectedOrganizationModelId === null
    ) {
      return;
    }

    const projectStillExists = dashboardData.organizations.some((project) => project.id === routeState.selectedOrganizationModelId);
    if (!projectStillExists) {
      navigate(APP_HOME_PATH, { replace: true });
    }
  }, [
    dashboardData,
    navigate,
    routeState.selectedOrganizationModelId
  ]);

  useEffect(() => {
    if (
      organizationCreationNavigationRef.current !== null ||
      !dashboardData ||
      routeState.selectedEvaluationTargetModelId === null
    ) {
      return;
    }

    if (routeState.kind === "recentPage" && !selectedEvaluationTargetModel) {
      navigate(APP_HOME_PATH, { replace: true });
      return;
    }

    if (
      routeState.kind === "projectPage" &&
      selectedOrganizationModel &&
      !selectedEvaluationTargetModel
    ) {
      navigate(`/projects/${routeState.selectedOrganizationModelId}`, { replace: true });
    }
  }, [
    dashboardData,
    navigate,
    routeState.kind,
    routeState.selectedEvaluationTargetModelId,
    routeState.selectedOrganizationModelId,
    selectedEvaluationTargetModel,
    selectedOrganizationModel
  ]);

  const handleUpdateOrganizationModel = useCallback(
    async ({ projectId, name, description }: { projectId: number; name: string; description: string }) => {
      await updateOrganizationModel({
        projectId,
        name,
        description
      });

      await loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
    },
    [loadDashboard]
  );

  const handleDeleteOrganizationModel = useCallback(
    async (projectId: number) => {
      await deleteOrganizationModel(projectId);

      if (routeState.selectedOrganizationModelId === projectId) {
        navigate(APP_HOME_PATH, { replace: true });
      }

      await loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
    },
    [loadDashboard, navigate, routeState.selectedOrganizationModelId]
  );

  const handleCreateEvaluationTargetModel = useCallback(
    async (
      input: CreateEvaluationTargetModelInput,
      signal?: AbortSignal
    ): Promise<number> => {
      const normalizedInput = {
        projectId: input.projectId,
        name: input.name.trim(),
        accessUrl: normalizeSiteCreateAccessUrl(input.accessUrl)
      };
      const key = buildTargetCreateKey(normalizedInput);

      const releaseTargetCheckpoint = (checkpoint: TargetCreateCheckpoint | null) => {
        if (checkpoint?.recoveryToken !== null && checkpoint?.recoveryToken !== undefined) {
          endDirectoryRecovery(checkpoint.recoveryToken);
        }
        if (targetCreateCheckpointRef.current === checkpoint) {
          targetCreateCheckpointRef.current = null;
        }
      };

      const finishTargetRecovery = (
        checkpoint: TargetCreateCheckpoint,
        targetId: number
      ): number => {
        const nextStored = writeSiteCreateRecovery(
          {
            ...checkpoint.stored.attempt,
            phase: "request-ready",
            targetId,
            previousFailedRequestId: null
          },
          checkpoint.stored.rawValue
        );
        if (nextStored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        checkpoint.stored = nextStored;
        checkpoint.resolvedTargetId = targetId;
        releaseTargetCheckpoint(checkpoint);
        return targetId;
      };

      const reconcileCheckpoint = async (
        checkpoint: TargetCreateCheckpoint
      ): Promise<number | null> => {
        const reconcileController = new AbortController();
        const forwardCallerAbort = () => reconcileController.abort();
        if (signal?.aborted) {
          reconcileController.abort();
        } else {
          signal?.addEventListener("abort", forwardCallerAbort, { once: true });
        }
        const timeoutId = window.setTimeout(
          () => reconcileController.abort(),
          TARGET_CREATE_TIMEOUT_MS
        );

        try {
          for (let attempt = 0; attempt < TARGET_CREATE_RECONCILE_ATTEMPTS; attempt += 1) {
            if (signal?.aborted) {
              throw new DOMException("The operation was aborted.", "AbortError");
            }
            if (reconcileController.signal.aborted) {
              return null;
            }
            if (attempt > 0) {
              await wait(TARGET_CREATE_RECONCILE_INTERVAL_MS, reconcileController.signal);
            }

            const refreshedData = await loadDashboard({
              refreshAfterInFlight: true,
              clearOnError: false,
              forceDirectoryRefresh: true,
              signal: reconcileController.signal
            });
            const recoveredTargetId = findCheckpointTargetId(checkpoint, refreshedData);
            if (recoveredTargetId !== null) {
              return recoveredTargetId;
            }
          }
          return null;
        } catch (error) {
          if (reconcileController.signal.aborted && !signal?.aborted) {
            return null;
          }
          throw error;
        } finally {
          window.clearTimeout(timeoutId);
          signal?.removeEventListener("abort", forwardCallerAbort);
        }
      };

      const persistedRecovery = readSiteCreateRecovery();
      if (persistedRecovery.kind === "blocked") {
        throw new Error(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      if (persistedRecovery.kind === "valid") {
        const persistedKey = buildPersistedTargetCreateKey(persistedRecovery.attempt);
        if (persistedKey === key) {
          const persistedTargetId = getPersistedTargetId(persistedRecovery.attempt);
          if (persistedTargetId !== null) {
            return persistedTargetId;
          }

          let existingCheckpoint = targetCreateCheckpointRef.current;
          if (
            existingCheckpoint === null ||
            existingCheckpoint.stored.attempt.attemptId !==
              persistedRecovery.attempt.attemptId
          ) {
            releaseTargetCheckpoint(existingCheckpoint);
            existingCheckpoint = {
              key,
              projectId: persistedRecovery.attempt.projectId,
              name: persistedRecovery.attempt.name,
              accessUrl: persistedRecovery.attempt.accessUrl,
              previousTargetIds: persistedRecovery.attempt.previousTargetIds,
              recoveryToken: beginDirectoryRecovery(),
              resolvedTargetId: null,
              stored: {
                attempt: persistedRecovery.attempt,
                rawValue: persistedRecovery.rawValue
              }
            };
            targetCreateCheckpointRef.current = existingCheckpoint;
          } else {
            existingCheckpoint.stored = {
              attempt: persistedRecovery.attempt,
              rawValue: persistedRecovery.rawValue
            };
          }

          const recoveredTargetId = await reconcileCheckpoint(existingCheckpoint);
          if (recoveredTargetId !== null) {
            return finishTargetRecovery(existingCheckpoint, recoveredTargetId);
          }
          throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
        }

        throw new Error(SITE_RECOVERY_CONFLICT_MESSAGE);
      }

      const existingCheckpoint = targetCreateCheckpointRef.current;
      if (existingCheckpoint !== null) {
        releaseTargetCheckpoint(existingCheckpoint);
      }

      const previousTargetIds =
        dashboardData?.organizations
          .find((organization) => organization.id === normalizedInput.projectId)
          ?.evaluationTargets.map((target) => target.id) ?? [];
      const recoveryToken = beginDirectoryRecovery();
      const stored = writeSiteCreateRecovery(
        {
          version: 1,
          attemptId: window.crypto.randomUUID(),
          apiScope: API_BASE_URL,
          projectId: normalizedInput.projectId,
          name: normalizedInput.name,
          accessUrl: normalizedInput.accessUrl,
          previousTargetIds,
          startedAt: Date.now(),
          phase: "target-reconciling"
        },
        null
      );
      if (stored === null) {
        endDirectoryRecovery(recoveryToken);
        throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      const checkpoint: TargetCreateCheckpoint = {
        key,
        projectId: normalizedInput.projectId,
        name: normalizedInput.name,
        accessUrl: normalizedInput.accessUrl,
        previousTargetIds,
        recoveryToken,
        resolvedTargetId: null,
        stored
      };
      targetCreateCheckpointRef.current = checkpoint;

      try {
        const createdTarget = await runWithNetworkDeadline(
          (requestSignal) => createEvaluationTargetModel(normalizedInput, requestSignal),
          signal
        );
        if (!Number.isSafeInteger(createdTarget?.id) || createdTarget.id <= 0) {
          throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
        }
        return finishTargetRecovery(checkpoint, createdTarget.id);
      } catch (error) {
        if (isDefinitiveMutationRejection(error)) {
          const didClear = clearSiteCreateRecovery(checkpoint.stored.rawValue);
          releaseTargetCheckpoint(checkpoint);
          if (!didClear) {
            throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          throw error;
        }

        // A timeout, connection reset, 5xx, or unusable success body can all
        // occur after the server committed the target. The durable checkpoint
        // was written before the POST, so every later retry is GET-only.
        targetCreateCheckpointRef.current = checkpoint;
        if (signal?.aborted) {
          throw error;
        }
      }

      const recoveredTargetId = await reconcileCheckpoint(checkpoint);
      if (recoveredTargetId !== null) {
        return finishTargetRecovery(checkpoint, recoveredTargetId);
      }
      throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
    },
    [beginDirectoryRecovery, dashboardData?.organizations, endDirectoryRecovery, loadDashboard]
  );

  const handleRequestEvaluationTargetAnalysis = useCallback(
    async (
      targetId: number,
      signal?: AbortSignal,
      previousFailedRequestId?: number
    ): Promise<number> => {
      const releaseRequestCheckpoint = (
        checkpoint: TargetAnalysisRequestCheckpoint | null
      ) => {
        if (checkpoint?.recoveryToken !== null && checkpoint?.recoveryToken !== undefined) {
          endDirectoryRecovery(checkpoint.recoveryToken);
        }
        if (targetAnalysisRequestCheckpointRef.current === checkpoint) {
          targetAnalysisRequestCheckpointRef.current = null;
        }
      };

      const reconcileCheckpoint = async (
        checkpoint: TargetAnalysisRequestCheckpoint
      ): Promise<number | null> =>
        runWithNetworkDeadline(async (reconcileSignal) => {
          const knownRequestIds = new Set(checkpoint.knownRequestIds);
          for (let attempt = 0; attempt < REQUEST_RECONCILE_ATTEMPTS; attempt += 1) {
            if (attempt > 0) {
              await wait(REQUEST_RECONCILE_INTERVAL_MS, reconcileSignal);
            }

            const reconciledData = await loadDashboard({
              refreshAfterInFlight: true,
              clearOnError: false,
              forceDirectoryRefresh: true,
              signal: reconcileSignal
            });
            const candidates = (reconciledData?.evaluationRequests ?? []).filter(
              (request) =>
                request.evaluationTargetId === checkpoint.targetId &&
                !knownRequestIds.has(request.id)
            );
            if (candidates.length === 1) {
              return candidates[0]!.id;
            }
            if (candidates.length > 1) {
              // Without a server correlation key, choosing either candidate
              // could attach this modal to another actor's request.
              return null;
            }
          }
          return null;
        }, signal);

      const replaceRequestId =
        Number.isSafeInteger(previousFailedRequestId) && (previousFailedRequestId ?? 0) > 0
          ? previousFailedRequestId ?? null
          : null;
      const persistedRecovery = readSiteCreateRecovery();
      if (persistedRecovery.kind === "blocked") {
        throw new Error(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      let stored: StoredSiteCreateAttempt | null = null;
      if (persistedRecovery.kind === "valid") {
        const persistedTargetId = getPersistedTargetId(persistedRecovery.attempt);
        if (persistedTargetId === targetId) {
          stored = {
            attempt: persistedRecovery.attempt,
            rawValue: persistedRecovery.rawValue
          };
        } else {
          throw new Error(SITE_RECOVERY_CONFLICT_MESSAGE);
        }
      }

      if (stored?.attempt.phase === "target-reconciling") {
        throw new Error(TARGET_CREATE_RECOVERY_MESSAGE);
      }

      if (stored?.attempt.phase === "poll") {
        if (replaceRequestId === null) {
          targetAnalysisRequestCheckpointRef.current = {
            targetId,
            knownRequestIds: stored.attempt.knownRequestIds,
            requestId: stored.attempt.requestId,
            recoveryToken: null,
            stored
          };
          return stored.attempt.requestId;
        }
        if (replaceRequestId !== stored.attempt.requestId) {
          throw new Error(TARGET_REQUEST_RECOVERY_MESSAGE);
        }
        const requestReady = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "request-ready",
            targetId,
            previousFailedRequestId: replaceRequestId
          },
          stored.rawValue
        );
        if (requestReady === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        stored = requestReady;
      }

      if (stored === null) {
        const project = dashboardData?.organizations.find((organization) =>
          organization.evaluationTargets.some((target) => target.id === targetId)
        );
        const target = project?.evaluationTargets.find(
          (candidate) => candidate.id === targetId
        );
        if (!project || !target) {
          throw new Error("등록된 페이지 정보를 확인하지 못했습니다. 목록을 새로 고친 뒤 다시 시도해 주세요.");
        }
        stored = writeSiteCreateRecovery(
          {
            version: 1,
            attemptId: window.crypto.randomUUID(),
            apiScope: API_BASE_URL,
            projectId: project.id,
            name: target.name,
            accessUrl: normalizeSiteCreateAccessUrl(target.accessUrl),
            previousTargetIds: project.evaluationTargets.map((candidate) => candidate.id),
            startedAt: Date.now(),
            phase: "request-ready",
            targetId,
            previousFailedRequestId: replaceRequestId
          },
          null
        );
        if (stored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
      }

      if (stored.attempt.phase === "request-reconciling") {
        let existingCheckpoint = targetAnalysisRequestCheckpointRef.current;
        if (
          existingCheckpoint === null ||
          existingCheckpoint.stored.attempt.attemptId !== stored.attempt.attemptId
        ) {
          releaseRequestCheckpoint(existingCheckpoint);
          existingCheckpoint = {
            targetId,
            knownRequestIds: stored.attempt.knownRequestIds,
            requestId: null,
            recoveryToken: beginDirectoryRecovery(),
            stored
          };
          targetAnalysisRequestCheckpointRef.current = existingCheckpoint;
        } else {
          existingCheckpoint.stored = stored;
          existingCheckpoint.knownRequestIds = stored.attempt.knownRequestIds;
          existingCheckpoint.requestId = null;
        }

        const recoveredRequestId = await reconcileCheckpoint(existingCheckpoint);
        if (recoveredRequestId === null) {
          throw new Error(TARGET_REQUEST_RECOVERY_MESSAGE);
        }
        const pollStored = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "poll",
            targetId,
            knownRequestIds: stored.attempt.knownRequestIds,
            requestId: recoveredRequestId
          },
          stored.rawValue
        );
        if (pollStored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        existingCheckpoint.stored = pollStored;
        existingCheckpoint.requestId = recoveredRequestId;
        if (existingCheckpoint.recoveryToken !== null) {
          endDirectoryRecovery(existingCheckpoint.recoveryToken);
          existingCheckpoint.recoveryToken = null;
        }
        return recoveredRequestId;
      }

      if (stored.attempt.phase !== "request-ready") {
        throw new Error(SITE_RECOVERY_BLOCKED_MESSAGE);
      }

      const effectiveFailedRequestId =
        replaceRequestId ?? stored.attempt.previousFailedRequestId;
      if (
        replaceRequestId !== null &&
        stored.attempt.previousFailedRequestId !== replaceRequestId
      ) {
        const updatedReady = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "request-ready",
            targetId,
            previousFailedRequestId: replaceRequestId
          },
          stored.rawValue
        );
        if (updatedReady === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        stored = updatedReady;
      }

      releaseRequestCheckpoint(targetAnalysisRequestCheckpointRef.current);

      const knownRequestIds = new Set(
        (dashboardData?.evaluationRequests ?? [])
          .filter((request) => request.evaluationTargetId === targetId)
          .map((request) => request.id)
      );
      if (effectiveFailedRequestId !== null) {
        knownRequestIds.add(effectiveFailedRequestId);
      }

      // Acquire snapshot protection before the force-refresh preflight. A
      // transient empty directory/request response must not erase the current
      // route and completed results before we decide whether a POST is needed.
      const recoveryToken = beginDirectoryRecovery();
      let beforeRequest: DashboardViewModel | null;
      try {
        beforeRequest = await runWithNetworkDeadline(
          (requestSignal) =>
            loadDashboard({
              refreshAfterInFlight: true,
              clearOnError: false,
              forceDirectoryRefresh: true,
              signal: requestSignal
            }),
          signal
        );
      } catch (error) {
        endDirectoryRecovery(recoveryToken);
        throw error;
      }
      if (beforeRequest === null) {
        endDirectoryRecovery(recoveryToken);
        throw new Error("분석 요청 목록을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }
      for (const request of beforeRequest.evaluationRequests) {
        if (request.evaluationTargetId === targetId) {
          knownRequestIds.add(request.id);
        }
      }

      const inFlightRequest = selectLatestEvaluationRequest(
        beforeRequest.evaluationRequests.filter(
          (request) =>
            request.evaluationTargetId === targetId &&
            request.status !== "COMPLETED" &&
            request.status !== "FAILED"
        ) ?? []
      );
      if (inFlightRequest) {
        const pollStored = writeSiteCreateRecovery(
          {
            ...stored.attempt,
            phase: "poll",
            targetId,
            knownRequestIds: [...knownRequestIds],
            requestId: inFlightRequest.id
          },
          stored.rawValue
        );
        endDirectoryRecovery(recoveryToken);
        if (pollStored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        targetAnalysisRequestCheckpointRef.current = {
          targetId,
          knownRequestIds: [...knownRequestIds],
          requestId: inFlightRequest.id,
          recoveryToken: null,
          stored: pollStored
        };
        return inFlightRequest.id;
      }

      const requestReconciling = writeSiteCreateRecovery(
        {
          ...stored.attempt,
          phase: "request-reconciling",
          targetId,
          knownRequestIds: [...knownRequestIds],
          previousFailedRequestId: effectiveFailedRequestId
        },
        stored.rawValue
      );
      if (requestReconciling === null) {
        endDirectoryRecovery(recoveryToken);
        throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
      }
      const checkpoint: TargetAnalysisRequestCheckpoint = {
        targetId,
        knownRequestIds: [...knownRequestIds],
        requestId: null,
        recoveryToken,
        stored: requestReconciling
      };
      targetAnalysisRequestCheckpointRef.current = checkpoint;

      try {
        const requestId = await runWithNetworkDeadline(
          (requestSignal) => requestEvaluationTargetRescan(targetId, requestSignal),
          signal
        );
        if (requestId !== null) {
          const pollStored = writeSiteCreateRecovery(
            {
              ...checkpoint.stored.attempt,
              phase: "poll",
              targetId,
              knownRequestIds: checkpoint.knownRequestIds,
              requestId
            },
            checkpoint.stored.rawValue
          );
          if (pollStored === null) {
            throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          checkpoint.stored = pollStored;
          checkpoint.requestId = requestId;
          return requestId;
        }
      } catch (error) {
        if (isDefinitiveMutationRejection(error)) {
          const requestReady = writeSiteCreateRecovery(
            {
              ...checkpoint.stored.attempt,
              phase: "request-ready",
              targetId,
              previousFailedRequestId: effectiveFailedRequestId
            },
            checkpoint.stored.rawValue
          );
          if (checkpoint.recoveryToken !== null) {
            endDirectoryRecovery(checkpoint.recoveryToken);
          }
          targetAnalysisRequestCheckpointRef.current = null;
          if (requestReady === null) {
            throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
          }
          throw error;
        }
        if (signal?.aborted) {
          throw error;
        }
      }

      // A lost POST response does not prove that the server rejected the
      // request. Reconcile the request list before allowing a retry so the UI
      // does not start a duplicate scan for the same target.
      const recoveredRequestId = await reconcileCheckpoint(checkpoint);
      if (recoveredRequestId !== null) {
        const pollStored = writeSiteCreateRecovery(
          {
            ...checkpoint.stored.attempt,
            phase: "poll",
            targetId,
            knownRequestIds: checkpoint.knownRequestIds,
            requestId: recoveredRequestId
          },
          checkpoint.stored.rawValue
        );
        if (pollStored === null) {
          throw new Error(SITE_RECOVERY_PERSISTENCE_MESSAGE);
        }
        checkpoint.stored = pollStored;
        checkpoint.requestId = recoveredRequestId;
        if (checkpoint.recoveryToken !== null) {
          endDirectoryRecovery(checkpoint.recoveryToken);
          checkpoint.recoveryToken = null;
        }
        return recoveredRequestId;
      }

      throw new Error(TARGET_REQUEST_RECOVERY_MESSAGE);
    },
    [
      beginDirectoryRecovery,
      dashboardData,
      endDirectoryRecovery,
      loadDashboard
    ]
  );

  const handleDeleteEvaluationTargetModel = useCallback(
    async ({ projectId, siteId }: { projectId: number; siteId: number }) => {
      await deleteEvaluationTargetModel({
        projectId,
        siteId
      });

      await loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
    },
    [loadDashboard]
  );
  const { handleRescanEvaluationTargetModel, isRescanningSite } = useEvaluationTargetRescan({
    dashboardData,
    loadDashboard,
    onError: setDashboardError,
    selectedEvaluationTargetModel,
    selectedOrganizationModel
  });

  const sidebarLinks: SidebarItem[] = useMemo(
    () => [
      {
        label: "새 페이지 분석",
        href: APP_HOME_PATH,
        icon: <Link2 size={18} />,
        onClick: () => navigate(APP_HOME_PATH),
        active: routeState.menu === "analyze"
      }
    ],
    [navigate, routeState.menu]
  );

  const headerTitle =
    routeState.menu === "analyze"
      ? "새 페이지 분석"
      : routeState.menu === "reports"
        ? "리포트"
        : isSiteDetailView
          ? selectedEvaluationTargetModel!.name
          : isProjectDetailView
            ? selectedOrganizationModel!.name
            : "프로젝트";
  // Project detail: do not surface organization/project description in the header
  // (create UI no longer collects it). Site detail still shows the page URL.
  const headerDescription = isSiteDetailView
    ? selectedEvaluationTargetModel!.accessUrl
    : "";
  const headerDescriptionHref = isSiteDetailView ? headerDescription : "";
  const siteLatestScanLabel = useMemo(() => {
    if (!isSiteDetailView || !selectedEvaluationTargetModel) {
      return "";
    }

    const latestUpdatedAt = (dashboardData?.evaluationRequests ?? [])
      .filter((request) => request.evaluationTargetId === selectedEvaluationTargetModel.id)
      .map((request) => request.updatedAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

    return latestUpdatedAt ? formatDateTime(latestUpdatedAt) : "스캔 기록 없음";
  }, [dashboardData?.evaluationRequests, isSiteDetailView, selectedEvaluationTargetModel]);

  const goToProject = useCallback(
    (projectId: number) => {
      navigate(`/projects/${projectId}`);
    },
    [navigate]
  );
  const goToProjectsRoot = useCallback(() => {
    navigate(APP_HOME_PATH);
  }, [navigate]);
  const goToSite = useCallback(
    (siteId: number) => {
      if (!selectedOrganizationModel) {
        return;
      }
      navigate(`/projects/${selectedOrganizationModel.id}/pages/${siteId}`);
    },
    [navigate, selectedOrganizationModel]
  );
  const goToRecentPage = useCallback(
    (pageId: number) => {
      navigate(`/recent-pages/${pageId}`);
    },
    [navigate]
  );
  const goBackToProject = useCallback(() => {
    if (!selectedOrganizationModel) {
      return;
    }
    navigate(`/projects/${selectedOrganizationModel.id}`);
  }, [navigate, selectedOrganizationModel]);
  const refreshDashboard = useCallback(
    () => loadDashboard({ refreshAfterInFlight: true, clearOnError: false }),
    [loadDashboard]
  );
  const refreshDashboardForSiteCreate = useCallback(
    (signal?: AbortSignal) =>
      loadDashboard({ refreshAfterInFlight: true, clearOnError: false, signal }),
    [loadDashboard]
  );
  const handleQuickAnalyzeComplete = useCallback(
    async ({ siteId }: { projectId: number; siteId: number }) => {
      await loadDashboard({ refreshAfterInFlight: true, clearOnError: false });
      navigate(`/recent-pages/${siteId}`);
    },
    [loadDashboard, navigate]
  );
  const organizations = dashboardData?.organizations ?? [];
  const selectedOrganizationModelId = selectedOrganizationModel?.id ?? null;

  return {
    canDiscardOrganizationCreateRecovery:
      organizationCreateForm.canDiscardOrganizationCreateRecovery,
    dashboardData,
    dashboardError,
    goBackToProject,
    goToProject,
    goToProjectsRoot,
    goToRecentPage,
    goToSite,
    handleQuickAnalyzeComplete,
    handleCreateEvaluationTargetModel,
    handleRequestEvaluationTargetAnalysis,
    handleDeleteEvaluationTargetModel,
    handleCreateOrganizationModel: organizationCreateForm.handleCreateOrganizationModel,
    discardOrganizationCreateRecovery:
      organizationCreateForm.discardOrganizationCreateRecovery,
    handleDeleteOrganizationModel,
    handleUpdateOrganizationModel,
    handleRescanEvaluationTargetModel,
    headerDescription,
    headerDescriptionHref,
    headerTitle,
    hasCreatedOrganization: organizationCreateForm.hasCreatedOrganization,
    isCreatingOrganizationModel: organizationCreateForm.isCreatingOrganizationModel,
    isOrganizationCreateRecoveryBlocked:
      organizationCreateForm.isOrganizationCreateRecoveryBlocked,
    isDarkMode,
    isDashboardLoading,
    isOrganizationCreateOpen: organizationCreateForm.isOrganizationCreateOpen,
    isRescanningSite,
    isSiteCreateOpen,
    menu: routeState.menu,
    newOrganizationModelName: organizationCreateForm.newOrganizationModelName,
    openOrganizationCreateModal: organizationCreateForm.openOrganizationCreateModal,
    openSiteCreateModal: () => {
      setIsSiteCreateOpen(true);
    },
    organizations,
    projectCreateError: organizationCreateForm.projectCreateError,
    refreshDashboard,
    refreshDashboardForSiteCreate,
    selectedEvaluationTargetModel,
    selectedOrganizationModel,
    selectedOrganizationModelId,
    sidebarSelection: routeState.sidebarSelection,
    siteLatestScanLabel,
    setIsOrganizationCreateOpen: organizationCreateForm.setIsOrganizationCreateOpen,
    setIsSiteCreateOpen,
    setNewOrganizationModelName: organizationCreateForm.setNewOrganizationModelName,
    setThemeMode,
    sidebarLinks,
    themeMode
  };
}
