import type { PersistedSiteCreateAttempt } from "@/services/site-create-recovery-storage";

import { runMutationRequestWithDeadline } from "./mutation-recovery";

export { isDefinitiveMutationRejection } from "./mutation-recovery";

export const REQUEST_RECONCILE_ATTEMPTS = 3;
export const REQUEST_RECONCILE_INTERVAL_MS = 250;
export const TARGET_CREATE_TIMEOUT_MS = 15_000;
export const TARGET_CREATE_RECONCILE_ATTEMPTS = 4;
export const TARGET_CREATE_RECONCILE_INTERVAL_MS = 250;
export const TARGET_CREATE_RECOVERY_MESSAGE =
  "페이지 생성 결과를 확인하지 못했습니다. 중복 생성을 막기 위해 생성 요청을 다시 보내지 않고 페이지 목록만 다시 확인합니다.";
export const TARGET_REQUEST_RECOVERY_MESSAGE =
  "분석 요청 결과를 확인하지 못했습니다. 중복 분석을 막기 위해 요청을 다시 보내지 않고 요청 목록만 다시 확인합니다.";
export const TARGET_ANALYSIS_PREFLIGHT_MESSAGE =
  "등록된 페이지가 비활성화되었거나 복구 정보와 일치하지 않아 분석을 시작하지 않았습니다. 페이지 목록을 새로 고친 뒤 다시 시도해 주세요.";
export const SITE_RECOVERY_PERSISTENCE_MESSAGE =
  "브라우저에 안전한 복구 정보를 저장하지 못해 요청을 시작하지 않았습니다. 저장 공간 또는 브라우저 설정을 확인해 주세요.";
export const SITE_RECOVERY_BLOCKED_MESSAGE =
  "이전 버전, 다른 서버 또는 손상된 페이지 생성 복구 정보가 남아 있어 새 요청을 잠갔습니다. 복구 정보를 확인하거나 삭제한 뒤 다시 시도해 주세요.";
export const SITE_RECOVERY_CONFLICT_MESSAGE =
  "완료 여부를 확인하지 못한 다른 페이지 작업이 남아 있어 새 요청을 시작하지 않았습니다. 기존 프로젝트에서 복구를 이어가거나, 24시간이 지난 뒤 명시적으로 복구 정보를 삭제하거나, 로그아웃해 주세요.";

export async function runWithNetworkDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal
): Promise<T> {
  return runMutationRequestWithDeadline({
    operation,
    signal: callerSignal,
    timeoutMs: TARGET_CREATE_TIMEOUT_MS
  });
}

export function getPersistedTargetId(attempt: PersistedSiteCreateAttempt): number | null {
  return attempt.phase === "target-reconciling" ? null : attempt.targetId;
}
