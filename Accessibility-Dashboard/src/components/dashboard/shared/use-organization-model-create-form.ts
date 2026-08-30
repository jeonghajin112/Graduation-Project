import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE_URL } from "@/config/api";
import {
  createOrganizationModel,
  getApiErrorMessage
} from "@/services/backend-api";
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  clearBlockedOrganizationCreateRecovery,
  clearPersistedOrganizationCreateAttempt,
  isPersistedOrganizationCreateAttemptStale as isPersistedAttemptStale,
  readOrganizationCreateRecovery as readPersistedOrganizationCreateRecovery,
  readPersistedOrganizationCreateAttempt,
  writePersistedOrganizationCreateAttempt
} from "@/services/organization-create-recovery-storage";
import type { PersistedOrganizationCreateAttempt } from "@/services/organization-create-recovery-storage";
import type { DashboardViewModel } from "@/types/accessibility-domain";

import {
  isDefinitiveMutationRejection,
  runMutationRequestWithDeadline
} from "./mutation-recovery";
import type { DirectoryRecoveryToken, LoadDashboard } from "./use-dashboard-data";

type OrganizationCreateCheckpoint =
  | { kind: "known"; organizationId: number }
  | { kind: "indeterminate"; name: string; previousOrganizationIds: number[] };

const REFRESH_FAILURE_MESSAGE =
  "프로젝트는 생성되었지만 목록을 불러오지 못했습니다. 생성 요청을 다시 보내지 않고 프로젝트 목록만 다시 불러와 주세요.";
const INDETERMINATE_REFRESH_FAILURE_MESSAGE =
  "프로젝트 생성 결과를 확인하지 못했습니다. 중복 생성을 막기 위해 생성 요청은 다시 보내지 않습니다. 프로젝트 목록만 다시 불러와 주세요.";
const PROJECT_REFRESH_TIMEOUT_MS = 15_000;
const PERSISTENCE_FAILURE_MESSAGE =
  "브라우저에 안전한 복구 정보를 저장하지 못해 프로젝트 생성을 시작하지 않았습니다. 저장 공간 또는 브라우저 설정을 확인해 주세요.";
const RECOVERY_DISCARD_FAILURE_MESSAGE =
  "오래된 복구 정보를 지우지 못했습니다. 브라우저 저장 공간을 확인하거나 로그아웃 후 다시 시도해 주세요.";
const BLOCKED_RECOVERY_MESSAGE =
  "이전 버전, 다른 서버 또는 손상된 프로젝트 생성 복구 정보가 남아 있어 새 생성을 잠갔습니다. 서버에 이미 생성된 프로젝트가 없는지 확인한 뒤 복구 정보를 삭제해 주세요.";

function checkpointFromPersistedAttempt(
  attempt: PersistedOrganizationCreateAttempt
): OrganizationCreateCheckpoint {
  if (attempt.phase === "reconciling" && attempt.organizationId !== null) {
    return { kind: "known", organizationId: attempt.organizationId };
  }

  // A reload while the POST was in flight makes its server outcome unknown.
  return {
    kind: "indeterminate",
    name: attempt.name,
    previousOrganizationIds: attempt.previousOrganizationIds
  };
}

function findCheckpointOrganizationId(
  checkpoint: OrganizationCreateCheckpoint,
  dashboardData: DashboardViewModel | null
): number | null {
  if (!dashboardData) {
    return null;
  }

  if (checkpoint.kind === "known") {
    return dashboardData.organizations.some(
      (organization) => organization.id === checkpoint.organizationId
    )
      ? checkpoint.organizationId
      : null;
  }

  const previousIds = new Set(checkpoint.previousOrganizationIds);
  const candidates = dashboardData.organizations.filter(
    (organization) =>
      !previousIds.has(organization.id) && organization.name.trim() === checkpoint.name
  );
  return candidates.length === 1 ? candidates[0].id : null;
}

function getRefreshFailureMessage(checkpoint: OrganizationCreateCheckpoint): string {
  return checkpoint.kind === "known"
    ? REFRESH_FAILURE_MESSAGE
    : INDETERMINATE_REFRESH_FAILURE_MESSAGE;
}

export function useOrganizationModelCreateForm({
  beginDirectoryRecovery,
  dashboardData,
  endDirectoryRecovery,
  loadDashboard,
  onCreated
}: {
  beginDirectoryRecovery: () => DirectoryRecoveryToken;
  dashboardData: DashboardViewModel | null;
  endDirectoryRecovery: (token: DirectoryRecoveryToken) => void;
  loadDashboard: LoadDashboard;
  onCreated: (projectId: number) => void;
}) {
  const [restoredRecovery] = useState(readPersistedOrganizationCreateRecovery);
  const restoredAttempt =
    restoredRecovery.kind === "valid" ? restoredRecovery.value : null;
  const isRestoredRecoveryBlocked = restoredRecovery.kind === "blocked";
  const restoredBlockedRawValue =
    restoredRecovery.kind === "blocked" ? restoredRecovery.rawValue : null;
  const restoredCheckpoint = restoredAttempt
    ? checkpointFromPersistedAttempt(restoredAttempt)
    : null;
  const [isCreatingOrganizationModel, setIsCreatingOrganizationModel] = useState(false);
  const [isOrganizationCreateOpen, setIsOrganizationCreateOpen] = useState(false);
  const [newOrganizationModelName, setNewOrganizationModelName] = useState(
    restoredAttempt?.name ?? ""
  );
  const [projectCreateError, setProjectCreateError] = useState(
    isRestoredRecoveryBlocked
      ? BLOCKED_RECOVERY_MESSAGE
      : restoredCheckpoint
        ? getRefreshFailureMessage(restoredCheckpoint)
        : ""
  );
  const [createCheckpoint, setCreateCheckpoint] = useState<OrganizationCreateCheckpoint | null>(
    restoredCheckpoint
  );
  const [canDiscardOrganizationCreateRecovery, setCanDiscardOrganizationCreateRecovery] =
    useState(
      restoredBlockedRawValue !== null ||
        (restoredAttempt ? isPersistedAttemptStale(restoredAttempt) : false)
    );
  const [isOrganizationCreateRecoveryBlocked, setIsOrganizationCreateRecoveryBlocked] =
    useState(isRestoredRecoveryBlocked);
  const createCheckpointRef = useRef<OrganizationCreateCheckpoint | null>(restoredCheckpoint);
  const persistedAttemptRef = useRef<PersistedOrganizationCreateAttempt | null>(restoredAttempt);
  const blockedRecoveryRawValueRef = useRef<string | null>(restoredBlockedRawValue);
  const directoryRecoveryTokenRef = useRef<DirectoryRecoveryToken | null>(null);
  const submissionLockRef = useRef(false);
  const isMountedRef = useRef(false);
  const activeOperationIdRef = useRef<symbol | null>(null);
  const createAbortControllerRef = useRef<AbortController | null>(null);
  const refreshAbortControllerRef = useRef<AbortController | null>(null);
  const restoreRefreshAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeOperationIdRef.current = null;
      createAbortControllerRef.current?.abort();
      createAbortControllerRef.current = null;
      refreshAbortControllerRef.current?.abort();
      refreshAbortControllerRef.current = null;
      restoreRefreshAbortControllerRef.current?.abort();
      restoreRefreshAbortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const checkpoint = createCheckpointRef.current;
    const restored = persistedAttemptRef.current;
    if (checkpoint === null || restored === null) {
      return;
    }

    if (restored.phase === "posting") {
      const reconcilingAttempt: PersistedOrganizationCreateAttempt = {
        ...restored,
        phase: "reconciling",
        organizationId: null
      };
      if (
        writePersistedOrganizationCreateAttempt(reconcilingAttempt, restored.attemptId)
      ) {
        persistedAttemptRef.current = reconcilingAttempt;
      }
    }
    if (directoryRecoveryTokenRef.current === null) {
      directoryRecoveryTokenRef.current = beginDirectoryRecovery();
    }

    // A restored attempt can be mounted in the same document after a route
    // change. Reconcile it immediately against a fresh overview snapshot. The
    // effect owns its controller so StrictMode cleanup can abort and restart
    // the request without marking the attempt as completed.
    const restoreController = new AbortController();
    restoreRefreshAbortControllerRef.current = restoreController;
    const restoreTimeoutId = window.setTimeout(() => {
      restoreController.abort();
    }, PROJECT_REFRESH_TIMEOUT_MS);
    void loadDashboard({
      refreshAfterInFlight: true,
      clearOnError: false,
      signal: restoreController.signal
    })
      .catch(() => null)
      .finally(() => {
        window.clearTimeout(restoreTimeoutId);
        if (restoreRefreshAbortControllerRef.current === restoreController) {
          restoreRefreshAbortControllerRef.current = null;
        }
      });

    return () => {
      window.clearTimeout(restoreTimeoutId);
      restoreController.abort();
      if (restoreRefreshAbortControllerRef.current === restoreController) {
        restoreRefreshAbortControllerRef.current = null;
      }
    };
  }, [beginDirectoryRecovery, loadDashboard]);

  const releaseDirectoryRecovery = useCallback(() => {
    const token = directoryRecoveryTokenRef.current;
    if (token === null) {
      return;
    }

    directoryRecoveryTokenRef.current = null;
    endDirectoryRecovery(token);
  }, [endDirectoryRecovery]);

  const finishCreatedOrganization = useCallback(
    (
      checkpoint: OrganizationCreateCheckpoint,
      organizationId: number,
      navigateToOrganization: boolean
    ) => {
      // The explicit refresh and the background poll can both observe the
      // project. Claim the checkpoint synchronously so completion runs once.
      if (createCheckpointRef.current !== checkpoint) {
        return;
      }

      createCheckpointRef.current = null;
      const persistedAttemptId = persistedAttemptRef.current?.attemptId;
      persistedAttemptRef.current = null;
      if (persistedAttemptId !== undefined) {
        clearPersistedOrganizationCreateAttempt(persistedAttemptId);
      }
      releaseDirectoryRecovery();
      setCreateCheckpoint(null);
      setCanDiscardOrganizationCreateRecovery(false);
      setNewOrganizationModelName("");
      setProjectCreateError("");

      if (navigateToOrganization) {
        setIsOrganizationCreateOpen(false);
        onCreated(organizationId);
      }
    },
    [onCreated, releaseDirectoryRecovery]
  );

  useEffect(() => {
    if (createCheckpoint === null) {
      return;
    }

    const organizationId = findCheckpointOrganizationId(createCheckpoint, dashboardData);
    if (organizationId !== null) {
      // A closed modal means the user dismissed the recovery flow. Clear the
      // checkpoint without surprising them with a later route change.
      finishCreatedOrganization(createCheckpoint, organizationId, isOrganizationCreateOpen);
    }
  }, [createCheckpoint, dashboardData, finishCreatedOrganization, isOrganizationCreateOpen]);

  const openOrganizationCreateModal = useCallback(() => {
    if (blockedRecoveryRawValueRef.current !== null) {
      setProjectCreateError(BLOCKED_RECOVERY_MESSAGE);
      setCanDiscardOrganizationCreateRecovery(true);
    } else if (createCheckpoint === null) {
      setProjectCreateError("");
    } else {
      const persistedAttempt = persistedAttemptRef.current;
      if (persistedAttempt && isPersistedAttemptStale(persistedAttempt)) {
        setCanDiscardOrganizationCreateRecovery(true);
      }
    }
    setIsOrganizationCreateOpen(true);
  }, [createCheckpoint]);

  const discardOrganizationCreateRecovery = useCallback(() => {
    if (submissionLockRef.current || !canDiscardOrganizationCreateRecovery) {
      return;
    }

    const blockedRawValue = blockedRecoveryRawValueRef.current;
    if (blockedRawValue !== null) {
      if (!clearBlockedOrganizationCreateRecovery(blockedRawValue)) {
        setProjectCreateError(RECOVERY_DISCARD_FAILURE_MESSAGE);
        return;
      }
      blockedRecoveryRawValueRef.current = null;
      setIsOrganizationCreateRecoveryBlocked(false);
      setCanDiscardOrganizationCreateRecovery(false);
      setNewOrganizationModelName("");
      setProjectCreateError("");
      return;
    }

    const persistedAttempt = persistedAttemptRef.current;
    // A successful discard clears both refs synchronously before React commits
    // the new button state. Treat a same-task second click as an already handled
    // no-op instead of surfacing a false storage failure.
    if (persistedAttempt === null) {
      return;
    }
    const currentPersistedAttempt = readPersistedOrganizationCreateAttempt();
    if (
      currentPersistedAttempt === null ||
      currentPersistedAttempt.attemptId !== persistedAttempt.attemptId ||
      currentPersistedAttempt.startedAt !== persistedAttempt.startedAt
    ) {
      setProjectCreateError(RECOVERY_DISCARD_FAILURE_MESSAGE);
      return;
    }
    if (!isPersistedAttemptStale(currentPersistedAttempt)) {
      const activeCheckpoint = createCheckpointRef.current;
      setCanDiscardOrganizationCreateRecovery(false);
      if (activeCheckpoint !== null) {
        setProjectCreateError(getRefreshFailureMessage(activeCheckpoint));
      }
      return;
    }
    if (
      !clearPersistedOrganizationCreateAttempt(persistedAttempt.attemptId)
    ) {
      setProjectCreateError(RECOVERY_DISCARD_FAILURE_MESSAGE);
      return;
    }

    restoreRefreshAbortControllerRef.current?.abort();
    restoreRefreshAbortControllerRef.current = null;
    persistedAttemptRef.current = null;
    createCheckpointRef.current = null;
    releaseDirectoryRecovery();
    setCreateCheckpoint(null);
    setCanDiscardOrganizationCreateRecovery(false);
    setNewOrganizationModelName("");
    setProjectCreateError("");
  }, [canDiscardOrganizationCreateRecovery, releaseDirectoryRecovery]);

  const handleCreateOrganizationModel = useCallback(async () => {
    if (submissionLockRef.current) {
      return;
    }
    if (blockedRecoveryRawValueRef.current !== null) {
      setProjectCreateError(BLOCKED_RECOVERY_MESSAGE);
      return;
    }

    const name = newOrganizationModelName.trim();
    if (createCheckpoint === null && name.length === 0) {
      setProjectCreateError("프로젝트 이름은 필수입니다.");
      return;
    }
    if (createCheckpoint === null && name.length > ORGANIZATION_NAME_MAX_LENGTH) {
      setProjectCreateError(
        `프로젝트 이름은 ${ORGANIZATION_NAME_MAX_LENGTH}자 이하여야 합니다.`
      );
      return;
    }
    if (createCheckpoint === null && dashboardData === null) {
      setProjectCreateError("프로젝트 목록을 불러온 뒤 다시 시도해 주세요.");
      return;
    }

    submissionLockRef.current = true;
    setIsCreatingOrganizationModel(true);
    setProjectCreateError("");
    const operationId = Symbol("organization-create-operation");
    activeOperationIdRef.current = operationId;
    const isActiveOperation = () =>
      isMountedRef.current && activeOperationIdRef.current === operationId;
    let operationCheckpoint = createCheckpoint;

    try {
      if (operationCheckpoint === null) {
        if (directoryRecoveryTokenRef.current === null) {
          directoryRecoveryTokenRef.current = beginDirectoryRecovery();
        }

        const previousOrganizationIds = dashboardData?.organizations.map(
          (organization) => organization.id
        ) ?? [];
        const postingAttempt: PersistedOrganizationCreateAttempt = {
          version: 1,
          attemptId: window.crypto.randomUUID(),
          apiScope: API_BASE_URL,
          phase: "posting",
          name,
          previousOrganizationIds,
          startedAt: Date.now()
        };
        if (!writePersistedOrganizationCreateAttempt(postingAttempt, null)) {
          throw new Error(PERSISTENCE_FAILURE_MESSAGE);
        }
        persistedAttemptRef.current = postingAttempt;
        setCanDiscardOrganizationCreateRecovery(false);
        const createController = new AbortController();
        createAbortControllerRef.current = createController;
        try {
          const created = await runMutationRequestWithDeadline({
            signal: createController.signal,
            timeoutMessage: "프로젝트 생성 응답을 기다리는 시간이 초과되었습니다.",
            operation: (requestSignal) =>
              createOrganizationModel(
                {
                  name,
                  description: ""
                },
                requestSignal
              )
          });
          if (!isActiveOperation()) {
            return;
          }

          operationCheckpoint =
            Number.isSafeInteger(created?.id) &&
            created.id > 0 &&
            !previousOrganizationIds.includes(created.id) &&
            created.name.trim() === name &&
            created.status === "ACTIVE"
              ? { kind: "known", organizationId: created.id }
              : { kind: "indeterminate", name, previousOrganizationIds };
        } catch (error) {
          if (!isActiveOperation()) {
            return;
          }
          if (isDefinitiveMutationRejection(error)) {
            throw error;
          }

          // A timeout, network failure, 5xx, or unusable success response can
          // happen after the server committed the project. From here on every
          // retry must reconcile the directory instead of repeating the POST.
          operationCheckpoint = { kind: "indeterminate", name, previousOrganizationIds };
        } finally {
          if (createAbortControllerRef.current === createController) {
            createAbortControllerRef.current = null;
          }
        }

        if (!isActiveOperation()) {
          return;
        }

        const persistedAttempt = persistedAttemptRef.current;
        const reconcilingAttempt: PersistedOrganizationCreateAttempt = {
          version: 1,
          attemptId: persistedAttempt?.attemptId ?? window.crypto.randomUUID(),
          apiScope: API_BASE_URL,
          phase: "reconciling",
          name,
          previousOrganizationIds,
          startedAt: persistedAttempt?.startedAt ?? Date.now(),
          organizationId:
              operationCheckpoint.kind === "known" ? operationCheckpoint.organizationId : null
        };
        if (
          persistedAttempt !== null &&
          writePersistedOrganizationCreateAttempt(
            reconcilingAttempt,
            persistedAttempt.attemptId
          )
        ) {
          persistedAttemptRef.current = reconcilingAttempt;
        }

        // Store the outcome checkpoint before starting the fallible dashboard
        // refresh. From this point every retry is GET-only, even if the server
        // returned an unusable ID or never completed its response.
        createCheckpointRef.current = operationCheckpoint;
        setCreateCheckpoint(operationCheckpoint);
      }

      if (directoryRecoveryTokenRef.current === null) {
        directoryRecoveryTokenRef.current = beginDirectoryRecovery();
      }

      const refreshController = new AbortController();
      refreshAbortControllerRef.current = refreshController;
      const refreshTimeoutId = window.setTimeout(() => {
        refreshController.abort();
      }, PROJECT_REFRESH_TIMEOUT_MS);
      let refreshedDashboard: DashboardViewModel | null;
      try {
        refreshedDashboard = await loadDashboard({
          refreshAfterInFlight: true,
          clearOnError: false,
          signal: refreshController.signal
        });
      } finally {
        window.clearTimeout(refreshTimeoutId);
        if (refreshAbortControllerRef.current === refreshController) {
          refreshAbortControllerRef.current = null;
        }
      }
      if (!isActiveOperation()) {
        return;
      }
      const organizationId = findCheckpointOrganizationId(
        operationCheckpoint,
        refreshedDashboard
      );

      if (organizationId === null) {
        if (createCheckpointRef.current === operationCheckpoint) {
          setProjectCreateError(getRefreshFailureMessage(operationCheckpoint));
        }
        return;
      }

      finishCreatedOrganization(operationCheckpoint, organizationId, true);
    } catch (error) {
      if (!isActiveOperation()) {
        return;
      }
      const activeCheckpoint = createCheckpointRef.current;
      if (activeCheckpoint !== null) {
        setProjectCreateError(getRefreshFailureMessage(activeCheckpoint));
      } else if (operationCheckpoint === null) {
        const persistedAttemptId = persistedAttemptRef.current?.attemptId;
        persistedAttemptRef.current = null;
        setCanDiscardOrganizationCreateRecovery(false);
        if (persistedAttemptId !== undefined) {
          clearPersistedOrganizationCreateAttempt(persistedAttemptId);
        }
        releaseDirectoryRecovery();
        setProjectCreateError(getApiErrorMessage(error, "프로젝트 생성 중 오류가 발생했습니다."));
      }
    } finally {
      if (activeOperationIdRef.current === operationId) {
        activeOperationIdRef.current = null;
        submissionLockRef.current = false;
        if (isMountedRef.current) {
          setIsCreatingOrganizationModel(false);
        }
      }
    }
  }, [
    beginDirectoryRecovery,
    createCheckpoint,
    dashboardData,
    finishCreatedOrganization,
    loadDashboard,
    newOrganizationModelName,
    releaseDirectoryRecovery
  ]);

  return {
    canDiscardOrganizationCreateRecovery,
    discardOrganizationCreateRecovery,
    hasCreatedOrganization: createCheckpoint !== null,
    handleCreateOrganizationModel,
    isCreatingOrganizationModel,
    isOrganizationCreateRecoveryBlocked,
    isOrganizationCreateOpen,
    newOrganizationModelName,
    openOrganizationCreateModal,
    projectCreateError,
    setIsOrganizationCreateOpen,
    setNewOrganizationModelName
  };
}
