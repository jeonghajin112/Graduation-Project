import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE_URL } from "@/config/api";
import { createOrganizationModel, getApiErrorMessage } from "@/services/backend-api";
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  clearPersistedOrganizationCreateAttempt,
  isPersistedOrganizationCreateAttemptStale as isPersistedAttemptStale,
  readOrganizationCreateRecovery,
  writePersistedOrganizationCreateAttempt,
  type PersistedOrganizationCreateAttempt
} from "@/services/organization-create-recovery-storage";
import type { RecoveryRead } from "@/services/recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";
import type { DashboardViewModel } from "@/types/accessibility-domain";

import { isDefinitiveMutationRejection, runMutationRequestWithDeadline } from "./mutation-recovery";
import type { DirectoryRecoveryToken, LoadDashboard } from "./use-dashboard-data";
import { useMutationOperation } from "./use-mutation-operation";

type OrganizationRecovery = RecoveryRead<PersistedOrganizationCreateAttempt> | { kind: "conflict" };
type PendingRecovery = Extract<OrganizationRecovery, { kind: "valid" }>;

const REFRESH_FAILURE_MESSAGE =
  "프로젝트는 생성되었지만 목록을 불러오지 못했습니다. 생성 요청을 다시 보내지 않고 프로젝트 목록만 다시 불러와 주세요.";
const INDETERMINATE_REFRESH_FAILURE_MESSAGE =
  "프로젝트 생성 결과를 확인하지 못했습니다. 다시 시도해 주세요. 같은 요청으로 재시도하므로 프로젝트가 중복 생성되지 않습니다.";
const PROJECT_REFRESH_TIMEOUT_MS = 15_000;
const PERSISTENCE_FAILURE_MESSAGE =
  "브라우저에 이전 작업 상태를 저장하지 못해 프로젝트 생성을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
const RECOVERY_DISCARD_FAILURE_MESSAGE =
  "이전 작업 정보를 지우지 못했습니다. 브라우저 저장 공간을 확인하거나 로그아웃한 뒤 다시 시도해 주세요.";
const BLOCKED_RECOVERY_MESSAGE =
  "확인할 수 없는 이전 프로젝트 작업이 남아 있어 중복 생성을 막았습니다. 이미 프로젝트가 생성되었는지 확인한 뒤 이전 작업 정보를 삭제해 주세요.";
const RECOVERY_CONFLICT_MESSAGE =
  "프로젝트 생성 복구 상태가 다른 화면에서 변경되었습니다. 중복 생성을 막기 위해 이 화면에서는 계속할 수 없습니다. 새로고침하여 최신 상태를 확인해 주세요.";

function recoveryMessage(recovery: OrganizationRecovery): string {
  if (recovery.kind === "conflict") return RECOVERY_CONFLICT_MESSAGE;
  if (recovery.kind === "blocked") return BLOCKED_RECOVERY_MESSAGE;
  if (recovery.kind === "none") return "";
  return recovery.value.organizationId !== null
    ? REFRESH_FAILURE_MESSAGE
    : INDETERMINATE_REFRESH_FAILURE_MESSAGE;
}

function canDiscardRecovery(recovery: OrganizationRecovery): boolean {
  return recovery.kind === "blocked"
    ? recovery.rawValue !== null
    : recovery.kind === "valid" && isPersistedAttemptStale(recovery.value);
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
  const [recovery, setRecoveryState] = useState<OrganizationRecovery>(readOrganizationCreateRecovery);
  // One recovery record drives both the UI and asynchronous continuations.
  // The ref makes claiming completion synchronous when a poll and a retry finish together.
  const recoveryRef = useRef(recovery);
  const updateRecovery = useCallback((next: OrganizationRecovery) => {
    recoveryRef.current = next;
    setRecoveryState(next);
  }, []);
  const [isCreatingOrganizationModel, setIsCreatingOrganizationModel] = useState(false);
  const [isOrganizationCreateOpen, setIsOrganizationCreateOpen] = useState(false);
  const [newOrganizationModelName, setNewOrganizationModelName] = useState(
    recovery.kind === "valid" ? recovery.value.name : ""
  );
  const [projectCreateError, setProjectCreateError] = useState(() => recoveryMessage(recovery));
  const directoryRecoveryTokenRef = useRef<DirectoryRecoveryToken | null>(null);
  const {
    beginMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent,
    isMutationOperationLocked
  } = useMutationOperation();

  const acquireDirectoryRecovery = useCallback(() => {
    directoryRecoveryTokenRef.current ??= beginDirectoryRecovery();
  }, [beginDirectoryRecovery]);

  const releaseDirectoryRecovery = useCallback(() => {
    const token = directoryRecoveryTokenRef.current;
    directoryRecoveryTokenRef.current = null;
    if (token !== null) endDirectoryRecovery(token);
  }, [endDirectoryRecovery]);

  const resetRecovery = useCallback(() => {
    updateRecovery({ kind: "none" });
    releaseDirectoryRecovery();
    setNewOrganizationModelName("");
    setProjectCreateError("");
  }, [releaseDirectoryRecovery, updateRecovery]);

  const blockForRecoveryConflict = useCallback(() => {
    updateRecovery({ kind: "conflict" });
    releaseDirectoryRecovery();
    setProjectCreateError(RECOVERY_CONFLICT_MESSAGE);
  }, [releaseDirectoryRecovery, updateRecovery]);

  const persistRecovery = useCallback((
    attempt: PersistedOrganizationCreateAttempt,
    expectedRawValue: string | null
  ): PendingRecovery | null => {
    const stored = writePersistedOrganizationCreateAttempt(attempt, expectedRawValue);
    if (stored === null) return null;
    const next: PendingRecovery = { kind: "valid", value: stored.attempt, rawValue: stored.rawValue };
    updateRecovery(next);
    return next;
  }, [updateRecovery]);

  const refreshDirectory = useCallback((signal: AbortSignal) => runMutationRequestWithDeadline({
    signal,
    timeoutMs: PROJECT_REFRESH_TIMEOUT_MS,
    operation: (requestSignal) => loadDashboard({
      refreshAfterInFlight: true,
      clearOnError: false,
      signal: requestSignal
    })
  }), [loadDashboard]);

  useEffect(() => {
    const restored = recoveryRef.current;
    // Unknown attempts wait for an explicit retry using the same idempotency key.
    if (restored.kind !== "valid" || restored.value.organizationId === null) return;
    acquireDirectoryRecovery();
    const controller = new AbortController();
    void refreshDirectory(controller.signal).catch(() => null);
    return () => controller.abort();
  }, [acquireDirectoryRecovery, refreshDirectory]);

  useEffect(() => () => releaseDirectoryRecovery(), [releaseDirectoryRecovery]);

  const finishCreatedOrganization = useCallback((
    expected: PendingRecovery,
    organizationId: number,
    navigateToOrganization: boolean
  ) => {
    if (recoveryRef.current !== expected) return;
    if (!clearPersistedOrganizationCreateAttempt(expected.rawValue)) {
      blockForRecoveryConflict();
      return;
    }
    resetRecovery();
    if (navigateToOrganization) {
      setIsOrganizationCreateOpen(false);
      onCreated(organizationId);
    }
  }, [blockForRecoveryConflict, onCreated, resetRecovery]);

  useEffect(() => {
    if (recovery.kind !== "valid" || recovery.value.organizationId === null) return;
    const organizationId = recovery.value.organizationId;
    if (dashboardData?.organizations.some((organization) => organization.id === organizationId)) {
      // Closing the dialog must not cause a later background poll to navigate.
      finishCreatedOrganization(recovery, organizationId, isOrganizationCreateOpen);
    }
  }, [dashboardData, finishCreatedOrganization, isOrganizationCreateOpen, recovery]);

  const openOrganizationCreateModal = useCallback(() => {
    setProjectCreateError(recoveryMessage(recoveryRef.current));
    setIsOrganizationCreateOpen(true);
  }, []);

  const discardOrganizationCreateRecovery = useCallback(() => {
    const current = recoveryRef.current;
    if (isMutationOperationLocked() || !canDiscardRecovery(current)) return;
    if (current.kind !== "valid" && current.kind !== "blocked") return;
    if (current.rawValue === null || !clearPersistedOrganizationCreateAttempt(current.rawValue)) {
      setProjectCreateError(RECOVERY_DISCARD_FAILURE_MESSAGE);
      return;
    }
    resetRecovery();
  }, [isMutationOperationLocked, resetRecovery]);

  const handleCreateOrganizationModel = useCallback(async () => {
    if (isMutationOperationLocked()) return;
    let pending = recoveryRef.current;
    const isNewAttempt = pending.kind === "none";
    if (pending.kind === "blocked" || pending.kind === "conflict") {
      setProjectCreateError(recoveryMessage(pending));
      return;
    }
    const name = newOrganizationModelName.trim();
    if (pending.kind === "none") {
      if (name.length === 0 || name.length > ORGANIZATION_NAME_MAX_LENGTH) {
        setProjectCreateError(name.length === 0
          ? "프로젝트 이름은 필수입니다."
          : `프로젝트 이름은 ${ORGANIZATION_NAME_MAX_LENGTH}자 이하여야 합니다.`);
        return;
      }
    }
    const operation = beginMutationOperation("organization-create-operation");
    if (operation === null) return;
    setIsCreatingOrganizationModel(true);
    setProjectCreateError("");
    acquireDirectoryRecovery();

    try {
      if (pending.kind === "none") {
        const posting = persistRecovery({
          version: 2,
          attemptId: window.crypto.randomUUID(),
          apiScope: API_BASE_URL,
          name,
          organizationId: null,
          startedAt: Date.now()
        }, null);
        if (posting === null) throw new UserFacingError(PERSISTENCE_FAILURE_MESSAGE);
        pending = posting;
      }

      if (pending.value.organizationId === null) {
        const stored = readOrganizationCreateRecovery();
        if (stored.kind !== "valid" || stored.rawValue !== pending.rawValue) {
          blockForRecoveryConflict();
          return;
        }
        const attempt = pending.value;
        const created = await runMutationRequestWithDeadline({
          signal: operation.signal,
          timeoutMessage: "프로젝트 생성 응답을 기다리는 시간이 초과되었습니다.",
          operation: (signal) => createOrganizationModel({
            name: attempt.name,
            description: "",
            attemptId: attempt.attemptId
          }, signal)
        });
        if (!isMutationOperationCurrent(operation)) return;
        const reconciling = persistRecovery({
          ...pending.value,
          organizationId: created.id
        }, pending.rawValue);
        if (reconciling === null) {
          blockForRecoveryConflict();
          return;
        }
        pending = reconciling;
      }

      const refreshedDashboard = await refreshDirectory(operation.signal);
      if (!isMutationOperationCurrent(operation)) return;
      const organizationId = pending.value.organizationId;
      if (organizationId !== null && refreshedDashboard?.organizations.some(
        (organization) => organization.id === organizationId
      )) {
        finishCreatedOrganization(pending, organizationId, true);
      } else if (recoveryRef.current === pending) {
        setProjectCreateError(recoveryMessage(pending));
      }
    } catch (error) {
      if (!isMutationOperationCurrent(operation)) return;
      const current = recoveryRef.current;
      if (current.kind === "conflict") return;
      if (current.kind === "valid") {
        // A rejected GET says nothing about whether the earlier POST committed.
        if (!isNewAttempt || current.value.organizationId !== null || !isDefinitiveMutationRejection(error)) {
          setProjectCreateError(recoveryMessage(current));
          return;
        }
        if (!clearPersistedOrganizationCreateAttempt(current.rawValue)) {
          blockForRecoveryConflict();
          return;
        }
        updateRecovery({ kind: "none" });
      }
      releaseDirectoryRecovery();
      setProjectCreateError(getApiErrorMessage(error, "프로젝트를 만들지 못했습니다. 잠시 후 다시 시도해 주세요."));
    } finally {
      if (finishMutationOperation(operation)) setIsCreatingOrganizationModel(false);
    }
  }, [
    acquireDirectoryRecovery, beginMutationOperation, blockForRecoveryConflict,
    finishCreatedOrganization, finishMutationOperation, isMutationOperationCurrent,
    isMutationOperationLocked, newOrganizationModelName, persistRecovery, refreshDirectory,
    releaseDirectoryRecovery, updateRecovery
  ]);

  return {
    canDiscardOrganizationCreateRecovery: canDiscardRecovery(recovery),
    discardOrganizationCreateRecovery,
    hasPendingOrganizationCreate: recovery.kind === "valid",
    handleCreateOrganizationModel,
    isCreatingOrganizationModel,
    isOrganizationCreateRecoveryBlocked: recovery.kind === "blocked" || recovery.kind === "conflict",
    isOrganizationCreateOpen,
    newOrganizationModelName,
    openOrganizationCreateModal,
    projectCreateError,
    setIsOrganizationCreateOpen,
    setNewOrganizationModelName
  };
}
