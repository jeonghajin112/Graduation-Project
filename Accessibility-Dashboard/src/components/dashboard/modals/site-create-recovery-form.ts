import type {
  PersistedSiteCreateAttempt,
  SiteCreateRecoveryReadResult
} from "@/services/site-create-recovery-storage";

import { EVALUATION_REQUEST_FAILED_MESSAGE } from "../shared/evaluation-request-status";

export const SITE_RECOVERY_PERSISTENCE_MESSAGE =
  "브라우저에 이전 작업 상태를 저장하지 못해 요청을 시작하지 않았습니다. 브라우저 저장 공간과 설정을 확인해 주세요.";
export const SITE_RECOVERY_BLOCKED_MESSAGE =
  "확인할 수 없는 이전 페이지 작업이 남아 있어 중복 요청을 막았습니다. 이미 페이지가 추가되었는지 확인한 뒤 이전 작업 정보를 삭제해 주세요.";
export const SITE_RECOVERY_STALE_MESSAGE =
  "오래된 페이지 작업 정보가 남아 있습니다. 목록에서 완료 여부를 확인한 뒤 이전 작업 정보를 삭제할 수 있습니다.";
export const SITE_RECOVERY_CONFLICT_MESSAGE =
  "다른 프로젝트에서 완료 여부를 확인하지 못한 페이지 작업이 남아 있어 새 요청을 시작하지 않았습니다. 해당 프로젝트에서 작업을 이어가거나 로그아웃한 뒤 다시 시도해 주세요.";
const TARGET_RECOVERY_MESSAGE =
  "이전 페이지 등록 결과를 확인하고 있습니다. 중복 등록을 막기 위해 새 요청은 보내지 않습니다.";
const REQUEST_READY_MESSAGE =
  "페이지 등록이 완료되었습니다. 준비가 되면 분석을 시작해 주세요.";
const REQUEST_RECONCILING_MESSAGE =
  "이전 분석 요청이 시작되었는지 확인이 필요합니다. 중복 분석을 막기 위해 새 요청은 보내지 않습니다.";
const REQUEST_STATUS_RECOVERY_MESSAGE =
  "기존 분석 요청의 상태를 다시 확인할 수 있습니다. 새 분석 요청은 보내지 않습니다.";

export type AnalysisRecoveryPhase = "ready" | "paused" | "failed" | null;

export type AnalysisResumePoint =
  | { kind: "create" }
  | { kind: "request"; targetId: number; previousFailedRequestId?: number }
  | { kind: "poll"; targetId: number; requestId: number };

export const initialResumePoint: AnalysisResumePoint = { kind: "create" };

/** Everything the page-add form shows about an earlier, unfinished attempt. */
export type SiteCreateRecoveryForm = {
  /** The stored record a discard may remove; null when nothing (readable) is stored. */
  rawValue: string | null;
  /** New requests stay off until the earlier attempt is settled or discarded. */
  isBlocked: boolean;
  canDiscard: boolean;
  resumePoint: AnalysisResumePoint;
  phase: AnalysisRecoveryPhase;
  siteName: string;
  baseUrl: string;
  message: string;
};

export const EMPTY_RECOVERY_FORM: SiteCreateRecoveryForm = {
  rawValue: null,
  isBlocked: false,
  canDiscard: false,
  resumePoint: initialResumePoint,
  phase: null,
  siteName: "",
  baseUrl: "",
  message: ""
};

function resumePointFromPersistedAttempt(
  attempt: PersistedSiteCreateAttempt
): AnalysisResumePoint {
  if (attempt.phase === "target-reconciling") {
    return initialResumePoint;
  }
  if (attempt.phase === "poll") {
    return { kind: "poll", targetId: attempt.targetId, requestId: attempt.requestId };
  }
  return {
    kind: "request",
    targetId: attempt.targetId,
    ...(attempt.previousFailedRequestId !== null
      ? { previousFailedRequestId: attempt.previousFailedRequestId }
      : {})
  };
}

function recoveryPhaseFromPersistedAttempt(
  attempt: PersistedSiteCreateAttempt
): AnalysisRecoveryPhase {
  if (attempt.phase === "target-reconciling") {
    return null;
  }
  if (attempt.phase === "request-ready") {
    return attempt.previousFailedRequestId === null ? "ready" : "failed";
  }
  return "paused";
}

function messageFromPersistedAttempt(attempt: PersistedSiteCreateAttempt): string {
  if (attempt.phase === "target-reconciling") {
    return TARGET_RECOVERY_MESSAGE;
  }
  if (attempt.phase === "request-ready") {
    return attempt.previousFailedRequestId === null
      ? REQUEST_READY_MESSAGE
      : EVALUATION_REQUEST_FAILED_MESSAGE;
  }
  if (attempt.phase === "request-reconciling") {
    return REQUEST_RECONCILING_MESSAGE;
  }
  return REQUEST_STATUS_RECOVERY_MESSAGE;
}

/**
 * What the form shows when it opens in `projectId`. An attempt of this project
 * resumes where it stopped; anything else that is stored blocks new requests.
 */
export function recoveryFormFromRead(
  recovery: SiteCreateRecoveryReadResult,
  projectId: number
): SiteCreateRecoveryForm {
  if (recovery.kind === "none") {
    return EMPTY_RECOVERY_FORM;
  }
  if (recovery.kind === "blocked") {
    return {
      ...EMPTY_RECOVERY_FORM,
      rawValue: recovery.rawValue,
      isBlocked: true,
      // Unavailable storage leaves nothing a discard could remove.
      canDiscard: recovery.rawValue !== null,
      message: SITE_RECOVERY_BLOCKED_MESSAGE
    };
  }
  const { attempt, isStale, rawValue } = recovery;
  if (attempt.projectId !== projectId) {
    return {
      ...EMPTY_RECOVERY_FORM,
      rawValue,
      isBlocked: true,
      canDiscard: isStale,
      message: isStale ? SITE_RECOVERY_STALE_MESSAGE : SITE_RECOVERY_CONFLICT_MESSAGE
    };
  }
  return {
    rawValue,
    isBlocked: false,
    canDiscard: isStale,
    resumePoint: resumePointFromPersistedAttempt(attempt),
    phase: recoveryPhaseFromPersistedAttempt(attempt),
    siteName: attempt.name,
    baseUrl: attempt.accessUrl,
    message: isStale ? SITE_RECOVERY_STALE_MESSAGE : messageFromPersistedAttempt(attempt)
  };
}

/**
 * The phase after an analysis request of a registered page failed. A request
 * that may already be running pauses; otherwise the form offers a new start.
 */
export function phaseAfterFailedRequest(
  persistedAttempt: PersistedSiteCreateAttempt | null,
  resumePoint: AnalysisResumePoint
): AnalysisRecoveryPhase {
  if (
    persistedAttempt?.phase === "request-reconciling" ||
    persistedAttempt?.phase === "poll" ||
    resumePoint.kind === "poll"
  ) {
    return "paused";
  }
  return persistedAttempt?.phase === "request-ready" && persistedAttempt.previousFailedRequestId === null
    ? "ready"
    : "failed";
}
