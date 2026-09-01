export type EvaluationRequestLifecyclePhase =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export const EVALUATION_REQUEST_FAILED_MESSAGE =
  "페이지 검사를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요. 같은 문제가 계속되면 관리자에게 문의해 주세요.";

export function evaluationRequestPhaseFromStatus(
  status: string
): EvaluationRequestLifecyclePhase {
  if (status === "PENDING") {
    return "queued";
  }
  if (status === "COMPLETED") {
    return "completed";
  }
  if (status === "FAILED") {
    return "failed";
  }
  return "running";
}

export function isFinalEvaluationRequestStatus(
  status: string | null
): status is "COMPLETED" | "FAILED" {
  return status === "COMPLETED" || status === "FAILED";
}
