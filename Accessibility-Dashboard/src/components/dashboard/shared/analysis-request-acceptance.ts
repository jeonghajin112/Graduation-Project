import {
  writeSiteCreateRecovery,
  type PersistedSiteCreateAttempt,
  type StoredSiteCreateAttempt
} from "@/services/site-create-recovery-storage";
import { UserFacingError } from "@/services/user-facing-error";

import { SITE_RECOVERY_PERSISTENCE_MESSAGE } from "./site-create-recovery-workflow";

type AcceptedAnalysisRequest = {
  attempt: PersistedSiteCreateAttempt;
  expectedRawValue: string | null;
  targetId: number;
  knownRequestIds: number[];
  requestId: number;
};

type StoredPollAttempt = {
  attempt: Extract<PersistedSiteCreateAttempt, { phase: "poll" }>;
  rawValue: string;
};

export function persistAcceptedAnalysisRequest({
  attempt, expectedRawValue, targetId, knownRequestIds, requestId
}: AcceptedAnalysisRequest): StoredPollAttempt {
  const stored = writeSiteCreateRecovery(
    { ...attempt, phase: "poll", targetId, knownRequestIds, requestId },
    expectedRawValue
  );
  if (stored === null || stored.attempt.phase !== "poll") {
    throw new UserFacingError(SITE_RECOVERY_PERSISTENCE_MESSAGE);
  }
  return { attempt: stored.attempt, rawValue: stored.rawValue };
}

// Only commit in-memory acceptance after durable storage succeeds. The caller
// retains ownership of its abort listener and directory recovery lease.
export function recordAcceptedAnalysisRequest(
  checkpoint: { stored: StoredSiteCreateAttempt; requestId: number | null },
  input: AcceptedAnalysisRequest
): number {
  const stored = persistAcceptedAnalysisRequest(input);
  checkpoint.stored = stored;
  checkpoint.requestId = stored.attempt.requestId;
  return stored.attempt.requestId;
}
