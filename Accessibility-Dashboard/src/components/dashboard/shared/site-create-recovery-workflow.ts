import type { PersistedSiteCreateAttempt } from "@/services/site-create-recovery-storage";

import { runMutationRequestWithDeadline } from "./mutation-recovery";

export { isDefinitiveMutationRejection } from "./mutation-recovery";

export const REQUEST_RECONCILE_ATTEMPTS = 3;
export const REQUEST_RECONCILE_INTERVAL_MS = 250;
export const TARGET_CREATE_TIMEOUT_MS = 15_000;
export const TARGET_CREATE_RECONCILE_ATTEMPTS = 4;
export const TARGET_CREATE_RECONCILE_INTERVAL_MS = 250;
export const TARGET_CREATE_RECOVERY_MESSAGE =
  "페이지 등록 결과를 확인하지 못했습니다. 중복 등록을 막기 위해 페이지 목록을 다시 확인해 주세요.";
export const TARGET_REQUEST_RECOVERY_MESSAGE =
  "분석 시작 여부를 확인하지 못했습니다. 중복 분석을 막기 위해 잠시 후 다시 확인해 주세요.";
export const TARGET_ANALYSIS_PREFLIGHT_MESSAGE =
  "등록된 페이지가 현재 목록과 일치하지 않아 분석을 시작하지 않았습니다. 페이지 목록을 새로 고친 뒤 다시 시도해 주세요.";
export const SITE_RECOVERY_PERSISTENCE_MESSAGE =
  "브라우저에 이전 작업 상태를 저장하지 못해 요청을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
export const SITE_RECOVERY_BLOCKED_MESSAGE =
  "확인할 수 없는 이전 페이지 작업이 남아 있어 중복 요청을 막았습니다. 이미 페이지가 추가되었는지 확인한 뒤 이전 작업 정보를 삭제해 주세요.";
export const SITE_RECOVERY_CONFLICT_MESSAGE =
  "완료 여부를 확인하지 못한 다른 페이지 작업이 남아 있어 새 요청을 시작하지 않았습니다. 해당 프로젝트에서 작업을 이어가거나 로그아웃한 뒤 다시 시도해 주세요.";

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
