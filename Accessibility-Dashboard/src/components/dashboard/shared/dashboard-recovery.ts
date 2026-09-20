import type { DashboardViewModel } from "@/types/accessibility-domain";

export type DirectoryRecoveryToken = symbol;

type DirectoryRecoveryLease = {
  baselineOrganizations: DashboardViewModel["organizations"];
  baselineEvaluationRequests: DashboardViewModel["evaluationRequests"];
  baselineResultSummaries: DashboardViewModel["resultSummaries"];
  baselineLatestIssueCounts: DashboardViewModel["latestIssueCounts"];
  baselineScoreResults: DashboardViewModel["scoreResults"];
  incompleteSnapshotCount: number;
  protectionActive: boolean;
};

export type DirectoryRecovery = {
  leases: Map<DirectoryRecoveryToken, DirectoryRecoveryLease>;
  lastConsistentData: DashboardViewModel | null;
};

const MAX_INCOMPLETE_RECOVERY_SNAPSHOTS = 4;

export function createDirectoryRecoveryLease(baseline: DashboardViewModel | null): DirectoryRecoveryLease {
  return {
    baselineOrganizations: baseline?.organizations ?? [],
    baselineEvaluationRequests: baseline?.evaluationRequests ?? [],
    baselineResultSummaries: baseline?.resultSummaries ?? [],
    baselineLatestIssueCounts: baseline?.latestIssueCounts ?? [],
    baselineScoreResults: baseline?.scoreResults ?? [],
    incompleteSnapshotCount: 0,
    protectionActive: true
  };
}

function getRequestStatusProgress(status: string): number | null {
  switch (status) {
    case "PENDING":
      return 0;
    case "IN_PROGRESS":
    case "RUNNING":
      return 1;
    case "COMPLETED":
    case "FAILED":
      return 2;
    default:
      return null;
  }
}

function requestStatusHasNotRolledBack(baselineStatus: string, nextStatus: string): boolean {
  if (nextStatus === baselineStatus) {
    return true;
  }
  if (baselineStatus === "COMPLETED" || baselineStatus === "FAILED") {
    // Terminal states are not interchangeable. In particular, accepting a
    // COMPLETED -> FAILED snapshot would drop the materialized result bundle.
    return false;
  }

  const baselineProgress = getRequestStatusProgress(baselineStatus);
  const nextProgress = getRequestStatusProgress(nextStatus);
  if (baselineProgress === null || nextProgress === null) {
    // A backend can add a status before this client is upgraded. Fail closed
    // for transitions we cannot order. Equality was handled above.
    return false;
  }

  return nextProgress >= baselineProgress;
}

export function requestHasNotRolledBack(
  baseline: DashboardViewModel["evaluationRequests"][number],
  next: DashboardViewModel["evaluationRequests"][number]
): boolean {
  const baselineUpdatedAt = Date.parse(baseline.updatedAt);
  const nextUpdatedAt = Date.parse(next.updatedAt);
  if (Number.isFinite(baselineUpdatedAt)) {
    if (!Number.isFinite(nextUpdatedAt) || nextUpdatedAt < baselineUpdatedAt) {
      return false;
    }
  }

  return requestStatusHasNotRolledBack(baseline.status, next.status);
}

export function protectRecoverySnapshot(
  nextData: DashboardViewModel,
  recovery: DirectoryRecovery | null
): DashboardViewModel {
  if (!recovery || recovery.leases.size === 0) {
    return nextData;
  }

  const nextOrganizationsById = new Map(
    nextData.organizations.map((organization) => [organization.id, organization])
  );
  const nextRequestsById = new Map(
    nextData.evaluationRequests.map((request) => [request.id, request])
  );
  const nextResultSummaryRequestIds = new Set(
    nextData.resultSummaries.map((summary) => summary.requestId)
  );
  const nextLatestIssueCountRequestIds = new Set(
    nextData.latestIssueCounts.map((statistics) => statistics.requestId)
  );
  const nextScoreResultKeys = new Set(
    nextData.scoreResults.map(
      (scoreResult) => `${scoreResult.id}:${scoreResult.evaluationRequestId}`
    )
  );

  let hasIncompleteActiveLease = false;
  for (const lease of recovery.leases.values()) {
    if (!lease.protectionActive) {
      continue;
    }

    const isDirectoryComplete = lease.baselineOrganizations.every(
      (protectedOrganization) => {
        const nextOrganization = nextOrganizationsById.get(protectedOrganization.id);
        if (!nextOrganization) {
          return false;
        }

        const nextTargetIds = new Set(
          nextOrganization.evaluationTargets.map((target) => target.id)
        );
        return protectedOrganization.evaluationTargets.every((target) =>
          nextTargetIds.has(target.id)
        );
      }
    );
    const areBaselineRequestsComplete = lease.baselineEvaluationRequests.every(
      (baselineRequest) => {
        const nextRequest = nextRequestsById.get(baselineRequest.id);
        return nextRequest ? requestHasNotRolledBack(baselineRequest, nextRequest) : false;
      }
    );
    const areBaselineResultsComplete =
      lease.baselineResultSummaries.every((summary) =>
        nextResultSummaryRequestIds.has(summary.requestId)
      ) &&
      lease.baselineLatestIssueCounts.every((statistics) =>
        nextLatestIssueCountRequestIds.has(statistics.requestId)
      ) &&
      lease.baselineScoreResults.every((scoreResult) =>
        nextScoreResultKeys.has(`${scoreResult.id}:${scoreResult.evaluationRequestId}`)
      );

    if (isDirectoryComplete && areBaselineRequestsComplete && areBaselineResultsComplete) {
      lease.incompleteSnapshotCount = 0;
      continue;
    }

    lease.incompleteSnapshotCount += 1;
    if (lease.incompleteSnapshotCount >= MAX_INCOMPLETE_RECOVERY_SNAPSHOTS) {
      // A real concurrent deletion is indistinguishable from a long-lived
      // stale snapshot. Expire only this lease; newer overlapping mutations
      // retain their own bounded protection window.
      lease.protectionActive = false;
      continue;
    }

    hasIncompleteActiveLease = true;
  }

  if (!hasIncompleteActiveLease) {
    // A snapshot becomes the shared fallback only when every still-protected
    // lease accepts it. This prevents a complete older lease from replacing
    // the fallback while a newer overlapping lease still sees partial data.
    recovery.lastConsistentData = nextData;
    return nextData;
  }

  // Directory and request endpoints feed every downstream result filter. If
  // an existing organization, target, or request is missing (or rolls back)
  // during creation recovery, the whole derived view model is incomplete, not
  // just its organization tree.
  // Keep the most recent internally consistent snapshot until the directory
  // recovers or the bounded protection lease above expires.
  return recovery.lastConsistentData ?? nextData;
}
