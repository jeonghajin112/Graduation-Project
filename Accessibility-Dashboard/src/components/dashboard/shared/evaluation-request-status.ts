export type EvaluationRequestLifecyclePhase =
  | "queued"
  | "running"
  | "completed"
  | "failed";

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
