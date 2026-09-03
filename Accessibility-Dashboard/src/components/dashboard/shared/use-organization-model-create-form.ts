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
  writePersistedOrganizationCreateAttempt
} from "@/services/organization-create-recovery-storage";
import type {
  PersistedOrganizationCreateAttempt,
  StoredOrganizationCreateAttempt
} from "@/services/organization-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type { DashboardViewModel } from "@/types/accessibility-domain";

import {
  commitMutationOnce,
  isDefinitiveMutationRejection,
  reconcileWithRetries,
  runMutationRequestWithDeadline
} from "./mutation-recovery";
import type { DirectoryRecoveryToken, LoadDashboard } from "./use-dashboard-data";
import { useMutationOperation } from "./use-mutation-operation";

type OrganizationCreateCheckpoint =
  | { kind: "known"; organizationId: number }
  | { kind: "indeterminate"; name: string; previousOrganizationIds: number[] };

const REFRESH_FAILURE_MESSAGE =
  "프로젝트는 생성되었지만 목록을 불러오지 못했습니다. 생성 요청을 다시 보내지 않고 프로젝트 목록만 다시 불러와 주세요.";
const INDETERMINATE_REFRESH_FAILURE_MESSAGE =
  "프로젝트 생성 결과를 확인하지 못했습니다. 중복 생성을 막기 위해 생성 요청은 다시 보내지 않습니다. 프로젝트 목록만 다시 불러와 주세요.";
const PROJECT_REFRESH_TIMEOUT_MS = 15_000;
const PERSISTENCE_FAILURE_MESSAGE =
  "브라우저에 이전 작업 상태를 저장하지 못해 프로젝트 생성을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
const RECOVERY_DISCARD_FAILURE_MESSAGE =
  "이전 작업 정보를 지우지 못했습니다. 브라우저 저장 공간을 확인하거나 로그아웃한 뒤 다시 시도해 주세요.";
const BLOCKED_RECOVERY_MESSAGE =
  "확인할 수 없는 이전 프로젝트 작업이 남아 있어 중복 생성을 막았습니다. 이미 프로젝트가 생성되었는지 확인한 뒤 이전 작업 정보를 삭제해 주세요.";
const RECOVERY_CONFLICT_MESSAGE =
  "프로젝트 생성 복구 상태가 다른 화면에서 변경되었습니다. 중복 생성을 막기 위해 이 화면에서는 계속할 수 없습니다. 새로고침하여 최신 상태를 확인해 주세요.";

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
  const restoredStoredAttempt: StoredOrganizationCreateAttempt | null =
    restoredRecovery.kind === "valid"
      ? { attempt: restoredRecovery.value, rawValue: restoredRecovery.rawValue }
      : null;
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
  const persistedRecoveryRef = useRef<StoredOrganizationCreateAttempt | null>(
    restoredStoredAttempt
  );
  const blockedRecoveryRawValueRef = useRef<string | null>(restoredBlockedRawValue);
  const recoveryConflictRef = useRef(false);
  const directoryRecoveryTokenRef = useRef<DirectoryRecoveryToken | null>(null);
  const {
    beginMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent,
    isMutationOperationLocked
  } = useMutationOperation();

  const releaseDirectoryRecovery = useCallback(() => {
    const token = directoryRecoveryTokenRef.current;
    if (token === null) {
      return;
    }

    directoryRecoveryTokenRef.current = null;
    endDirectoryRecovery(token);
  }, [endDirectoryRecovery]);

  const blockForRecoveryConflict = useCallback(() => {
    const currentRecovery = readPersistedOrganizationCreateRecovery();
    persistedRecoveryRef.current =
      currentRecovery.kind === "valid"
        ? { attempt: currentRecovery.value, rawValue: currentRecovery.rawValue }
        : null;
    blockedRecoveryRawValueRef.current =
      currentRecovery.kind === "blocked" ? currentRecovery.rawValue : null;
    recoveryConflictRef.current = true;
    createCheckpointRef.current = null;
    releaseDirectoryRecovery();
    setCreateCheckpoint(null);
    setCanDiscardOrganizationCreateRecovery(false);
    setIsOrganizationCreateRecoveryBlocked(true);
    setProjectCreateError(RECOVERY_CONFLICT_MESSAGE);
  }, [releaseDirectoryRecovery]);

  useEffect(() => {
    const checkpoint = createCheckpointRef.current;
    let restored = persistedRecoveryRef.current;
    if (checkpoint === null || restored === null) {
      return;
    }

    if (restored.attempt.phase === "posting") {
      const reconcilingAttempt: PersistedOrganizationCreateAttempt = {
        ...restored.attempt,
        phase: "reconciling",
        organizationId: null
      };
      const nextStored = writePersistedOrganizationCreateAttempt(
        reconcilingAttempt,
        restored.rawValue
      );
      if (nextStored !== null) {
        persistedRecoveryRef.current = nextStored;
        restored = nextStored;
      } else {
        blockForRecoveryConflict();
        return;
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
    void runMutationRequestWithDeadline({
      signal: restoreController.signal,
      timeoutMs: PROJECT_REFRESH_TIMEOUT_MS,
      operation: (requestSignal) =>
        loadDashboard({
          refreshAfterInFlight: true,
          clearOnError: false,
          signal: requestSignal
        })
    })
      .catch(() => null);

    return () => {
      restoreController.abort();
    };
  }, [beginDirectoryRecovery, blockForRecoveryConflict, loadDashboard]);

  useEffect(() => () => releaseDirectoryRecovery(), [releaseDirectoryRecovery]);

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

      const persistedRecovery = persistedRecoveryRef.current;
      if (
        persistedRecovery !== null &&
        !clearPersistedOrganizationCreateAttempt(persistedRecovery.rawValue)
      ) {
        blockForRecoveryConflict();
        return;
      }

      createCheckpointRef.current = null;
      persistedRecoveryRef.current = null;
      blockedRecoveryRawValueRef.current = null;
      recoveryConflictRef.current = false;
      releaseDirectoryRecovery();
      setCreateCheckpoint(null);
      setCanDiscardOrganizationCreateRecovery(false);
      setIsOrganizationCreateRecoveryBlocked(false);
      setNewOrganizationModelName("");
      setProjectCreateError("");

      if (navigateToOrganization) {
        setIsOrganizationCreateOpen(false);
        onCreated(organizationId);
      }
    },
    [blockForRecoveryConflict, onCreated, releaseDirectoryRecovery]
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
    if (recoveryConflictRef.current) {
      setProjectCreateError(RECOVERY_CONFLICT_MESSAGE);
      setCanDiscardOrganizationCreateRecovery(false);
    } else if (
      isOrganizationCreateRecoveryBlocked ||
      blockedRecoveryRawValueRef.current !== null
    ) {
      setProjectCreateError(BLOCKED_RECOVERY_MESSAGE);
      setCanDiscardOrganizationCreateRecovery(blockedRecoveryRawValueRef.current !== null);
    } else if (createCheckpoint === null) {
      setProjectCreateError("");
    } else {
      const persistedAttempt = persistedRecoveryRef.current?.attempt;
      if (persistedAttempt && isPersistedAttemptStale(persistedAttempt)) {
        setCanDiscardOrganizationCreateRecovery(true);
      }
    }
    setIsOrganizationCreateOpen(true);
  }, [createCheckpoint, isOrganizationCreateRecoveryBlocked]);

  const discardOrganizationCreateRecovery = useCallback(() => {
    if (isMutationOperationLocked() || !canDiscardOrganizationCreateRecovery) {
      return;
    }

    const blockedRawValue = blockedRecoveryRawValueRef.current;
    if (blockedRawValue !== null) {
      if (!clearBlockedOrganizationCreateRecovery(blockedRawValue)) {
        setProjectCreateError(RECOVERY_DISCARD_FAILURE_MESSAGE);
        return;
      }
      blockedRecoveryRawValueRef.current = null;
      recoveryConflictRef.current = false;
      setIsOrganizationCreateRecoveryBlocked(false);
      setCanDiscardOrganizationCreateRecovery(false);
      setNewOrganizationModelName("");
      setProjectCreateError("");
      return;
    }

    const persistedRecovery = persistedRecoveryRef.current;
    // A successful discard clears both refs synchronously before React commits
    // the new button state. Treat a same-task second click as an already handled
    // no-op instead of surfacing a false storage failure.
    if (persistedRecovery === null) {
      return;
    }
    const currentRecovery = readPersistedOrganizationCreateRecovery();
    if (
      currentRecovery.kind !== "valid" ||
      currentRecovery.rawValue !== persistedRecovery.rawValue
    ) {
      setProjectCreateError(RECOVERY_DISCARD_FAILURE_MESSAGE);
      return;
    }
    if (!isPersistedAttemptStale(currentRecovery.value)) {
      const activeCheckpoint = createCheckpointRef.current;
      setCanDiscardOrganizationCreateRecovery(false);
      if (activeCheckpoint !== null) {
        setProjectCreateError(getRefreshFailureMessage(activeCheckpoint));
      }
      return;
    }
    if (!clearPersistedOrganizationCreateAttempt(persistedRecovery.rawValue)) {
      setProjectCreateError(RECOVERY_DISCARD_FAILURE_MESSAGE);
      return;
    }

    persistedRecoveryRef.current = null;
    createCheckpointRef.current = null;
    releaseDirectoryRecovery();
    setCreateCheckpoint(null);
    setCanDiscardOrganizationCreateRecovery(false);
    setNewOrganizationModelName("");
    setProjectCreateError("");
  }, [
    canDiscardOrganizationCreateRecovery,
    isMutationOperationLocked,
    releaseDirectoryRecovery
  ]);

  const handleCreateOrganizationModel = useCallback(async () => {
    if (isMutationOperationLocked()) {
      return;
    }
    if (recoveryConflictRef.current || isOrganizationCreateRecoveryBlocked) {
      setProjectCreateError(
        recoveryConflictRef.current ? RECOVERY_CONFLICT_MESSAGE : BLOCKED_RECOVERY_MESSAGE
      );
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

    const operation = beginMutationOperation("organization-create-operation");
    if (operation === null) {
      return;
    }
    const isActiveOperation = () => isMutationOperationCurrent(operation);
    setIsCreatingOrganizationModel(true);
    setProjectCreateError("");
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
        const postingRecovery = writePersistedOrganizationCreateAttempt(
          postingAttempt,
          null
        );
        if (postingRecovery === null) {
          throw new UserFacingError(PERSISTENCE_FAILURE_MESSAGE);
        }
        persistedRecoveryRef.current = postingRecovery;
        setCanDiscardOrganizationCreateRecovery(false);
        try {
          const commitOutcome = await commitMutationOnce({
            signal: operation.signal,
            timeoutMessage: "프로젝트 생성 응답을 기다리는 시간이 초과되었습니다.",
            operation: (requestSignal) =>
              createOrganizationModel(
                {
                  name,
                  description: ""
                },
                requestSignal
              ),
            accept: (created) =>
              Number.isSafeInteger(created?.id) &&
              created.id > 0 &&
              !previousOrganizationIds.includes(created.id) &&
              created.name.trim() === name &&
              created.status === "ACTIVE"
                ? created.id
                : null
          });
          if (!isActiveOperation()) {
            return;
          }

          operationCheckpoint =
            commitOutcome.kind === "accepted"
              ? { kind: "known", organizationId: commitOutcome.value }
              : { kind: "indeterminate", name, previousOrganizationIds };
        } catch (error) {
          if (!isActiveOperation()) {
            return;
          }
          if (isDefinitiveMutationRejection(error)) {
            const activeRecovery = persistedRecoveryRef.current;
            if (
              activeRecovery !== null &&
              !clearPersistedOrganizationCreateAttempt(activeRecovery.rawValue)
            ) {
              blockForRecoveryConflict();
              return;
            }
            persistedRecoveryRef.current = null;
            throw error;
          }
          throw error;
        }

        if (!isActiveOperation()) {
          return;
        }

        const persistedRecovery = persistedRecoveryRef.current;
        const reconcilingAttempt: PersistedOrganizationCreateAttempt = {
          version: 1,
          attemptId:
            persistedRecovery?.attempt.attemptId ?? window.crypto.randomUUID(),
          apiScope: API_BASE_URL,
          phase: "reconciling",
          name,
          previousOrganizationIds,
          startedAt: persistedRecovery?.attempt.startedAt ?? Date.now(),
          organizationId:
              operationCheckpoint.kind === "known" ? operationCheckpoint.organizationId : null
        };
        if (persistedRecovery === null) {
          throw new UserFacingError(PERSISTENCE_FAILURE_MESSAGE);
        }
        const reconcilingRecovery = writePersistedOrganizationCreateAttempt(
          reconcilingAttempt,
          persistedRecovery.rawValue
        );
        if (reconcilingRecovery === null) {
          blockForRecoveryConflict();
          return;
        }
        persistedRecoveryRef.current = reconcilingRecovery;

        // Store the outcome checkpoint before starting the fallible dashboard
        // refresh. From this point every retry is GET-only, even if the server
        // returned an unusable ID or never completed its response.
        createCheckpointRef.current = operationCheckpoint;
        setCreateCheckpoint(operationCheckpoint);
      }

      if (directoryRecoveryTokenRef.current === null) {
        directoryRecoveryTokenRef.current = beginDirectoryRecovery();
      }
      if (operationCheckpoint === null) {
        throw new UserFacingError(INDETERMINATE_REFRESH_FAILURE_MESSAGE);
      }
      const checkpointToReconcile = operationCheckpoint;

      const organizationId = await reconcileWithRetries({
        attempts: 1,
        intervalMs: 0,
        signal: operation.signal,
        probe: async (requestSignal) => {
          const refreshedDashboard = await runMutationRequestWithDeadline({
            signal: requestSignal,
            timeoutMs: PROJECT_REFRESH_TIMEOUT_MS,
            operation: (refreshSignal) =>
              loadDashboard({
                refreshAfterInFlight: true,
                clearOnError: false,
                signal: refreshSignal
              })
          });
          return findCheckpointOrganizationId(
            checkpointToReconcile,
            refreshedDashboard
          );
        }
      });
      if (!isActiveOperation()) {
        return;
      }

      if (organizationId === null) {
        if (createCheckpointRef.current === checkpointToReconcile) {
          setProjectCreateError(getRefreshFailureMessage(checkpointToReconcile));
        }
        return;
      }

      finishCreatedOrganization(checkpointToReconcile, organizationId, true);
    } catch (error) {
      if (!isActiveOperation()) {
        return;
      }
      const activeCheckpoint = createCheckpointRef.current;
      if (activeCheckpoint !== null) {
        setProjectCreateError(getRefreshFailureMessage(activeCheckpoint));
      } else if (operationCheckpoint === null) {
        const persistedRecovery = persistedRecoveryRef.current;
        persistedRecoveryRef.current = null;
        setCanDiscardOrganizationCreateRecovery(false);
        if (persistedRecovery !== null) {
          clearPersistedOrganizationCreateAttempt(persistedRecovery.rawValue);
        }
        releaseDirectoryRecovery();
        setProjectCreateError(
          getApiErrorMessage(error, "프로젝트를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.")
        );
      }
    } finally {
      if (finishMutationOperation(operation)) {
        setIsCreatingOrganizationModel(false);
      }
    }
  }, [
    beginDirectoryRecovery,
    beginMutationOperation,
    blockForRecoveryConflict,
    createCheckpoint,
    dashboardData,
    finishMutationOperation,
    finishCreatedOrganization,
    isMutationOperationCurrent,
    isMutationOperationLocked,
    isOrganizationCreateRecoveryBlocked,
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
