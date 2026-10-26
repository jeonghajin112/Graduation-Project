import type { DashboardViewModel, RequestStatus } from "@/types/accessibility-domain";

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
  const source: DashboardViewModel = baseline ?? {
    organizations: [],
    evaluationRequests: [],
    resultSummaries: [],
    latestIssueCounts: [],
    scoreResults: []
  };
  return {
    baselineOrganizations: source.organizations,
    baselineEvaluationRequests: source.evaluationRequests,
    baselineResultSummaries: source.resultSummaries,
    baselineLatestIssueCounts: source.latestIssueCounts,
    baselineScoreResults: source.scoreResults,
    incompleteSnapshotCount: 0,
    protectionActive: true
  };
}

const REQUEST_STATUS_PROGRESS: Record<RequestStatus, number> = {
  PENDING: 0,
  IN_PROGRESS: 1,
  COMPLETED: 2,
  FAILED: 2
};

function requestStatusHasNotRolledBack(baselineStatus: RequestStatus, nextStatus: RequestStatus): boolean {
  if (nextStatus === baselineStatus) {
    return true;
  }
  if (baselineStatus === "COMPLETED" || baselineStatus === "FAILED") {
    // Terminal states are not interchangeable. In particular, accepting a
    // COMPLETED -> FAILED snapshot would drop the materialized result bundle.
    return false;
  }

  return REQUEST_STATUS_PROGRESS[nextStatus] >= REQUEST_STATUS_PROGRESS[baselineStatus];
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

function indexSnapshot(nextData: DashboardViewModel) {
  return {
    organizationsById: new Map(
      nextData.organizations.map((organization) => [organization.id, organization])
    ),
    requestsById: new Map(
      nextData.evaluationRequests.map((request) => [request.id, request])
    ),
    resultSummaryRequestIds: new Set(
      nextData.resultSummaries.map((summary) => summary.requestId)
    ),
    latestIssueCountRequestIds: new Set(
      nextData.latestIssueCounts.map((statistics) => statistics.requestId)
    ),
    scoreResultKeys: new Set(
      nextData.scoreResults.map(
        (scoreResult) => `${scoreResult.id}:${scoreResult.evaluationRequestId}`
      )
    )
  };
}

/** Whether the snapshot still contains everything this lease protects. */
function snapshotCoversLease(
  lease: DirectoryRecoveryLease,
  next: ReturnType<typeof indexSnapshot>
): boolean {
  const isDirectoryComplete = lease.baselineOrganizations.every(
    (protectedOrganization) => {
      const nextOrganization = next.organizationsById.get(protectedOrganization.id);
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
      const nextRequest = next.requestsById.get(baselineRequest.id);
      return nextRequest ? requestHasNotRolledBack(baselineRequest, nextRequest) : false;
    }
  );
  const areBaselineResultsComplete =
    lease.baselineResultSummaries.every((summary) =>
      next.resultSummaryRequestIds.has(summary.requestId)
    ) &&
    lease.baselineLatestIssueCounts.every((statistics) =>
      next.latestIssueCountRequestIds.has(statistics.requestId)
    ) &&
    lease.baselineScoreResults.every((scoreResult) =>
      next.scoreResultKeys.has(`${scoreResult.id}:${scoreResult.evaluationRequestId}`)
    );

  return isDirectoryComplete && areBaselineRequestsComplete && areBaselineResultsComplete;
}

export function protectRecoverySnapshot(
  nextData: DashboardViewModel,
  recovery: DirectoryRecovery | null
): DashboardViewModel {
  if (!recovery || recovery.leases.size === 0) {
    return nextData;
  }

  const next = indexSnapshot(nextData);
  let hasIncompleteActiveLease = false;
  for (const lease of recovery.leases.values()) {
    if (!lease.protectionActive) {
      continue;
    }

    if (snapshotCoversLease(lease, next)) {
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

export type DirectoryRemoval = { organizationId: number } | { targetId: number };

function pruneRemovedDirectoryEntry(
  snapshot: DashboardViewModel,
  removal: DirectoryRemoval
): DashboardViewModel {
  const removedTargetIds = new Set<number>();
  const organizations = snapshot.organizations.flatMap((organization) => {
    if ("organizationId" in removal) {
      if (organization.id !== removal.organizationId) {
        return [organization];
      }
      organization.evaluationTargets.forEach((target) => removedTargetIds.add(target.id));
      return [];
    }
    if (!organization.evaluationTargets.some((target) => target.id === removal.targetId)) {
      return [organization];
    }
    removedTargetIds.add(removal.targetId);
    return [{
      ...organization,
      evaluationTargets: organization.evaluationTargets.filter((target) => target.id !== removal.targetId)
    }];
  });
  if ("targetId" in removal) {
    removedTargetIds.add(removal.targetId);
  }
  const removedRequestIds = new Set(
    snapshot.evaluationRequests
      .filter((request) => removedTargetIds.has(request.evaluationTargetId))
      .map((request) => request.id)
  );
  return {
    ...snapshot,
    organizations,
    evaluationRequests: snapshot.evaluationRequests.filter((request) => !removedRequestIds.has(request.id)),
    resultSummaries: snapshot.resultSummaries.filter((summary) => !removedRequestIds.has(summary.requestId)),
    latestIssueCounts: snapshot.latestIssueCounts.filter(
      (statistics) => !removedTargetIds.has(statistics.evaluationTargetId)
    ),
    scoreResults: snapshot.scoreResults.filter(
      (scoreResult) => !removedRequestIds.has(scoreResult.evaluationRequestId)
    )
  };
}

/**
 * A confirmed deletion is not a stale snapshot. Remove the deleted entry from
 * every protection baseline and from the fallback snapshot so an overlapping
 * creation lease cannot keep showing it after the refresh.
 */
export function forgetRemovedDirectoryEntry(
  recovery: DirectoryRecovery | null,
  removal: DirectoryRemoval
): void {
  if (!recovery) {
    return;
  }
  for (const lease of recovery.leases.values()) {
    const pruned = pruneRemovedDirectoryEntry({
      organizations: lease.baselineOrganizations,
      evaluationRequests: lease.baselineEvaluationRequests,
      resultSummaries: lease.baselineResultSummaries,
      latestIssueCounts: lease.baselineLatestIssueCounts,
      scoreResults: lease.baselineScoreResults
    }, removal);
    lease.baselineOrganizations = pruned.organizations;
    lease.baselineEvaluationRequests = pruned.evaluationRequests;
    lease.baselineResultSummaries = pruned.resultSummaries;
    lease.baselineLatestIssueCounts = pruned.latestIssueCounts;
    lease.baselineScoreResults = pruned.scoreResults;
  }
  if (recovery.lastConsistentData) {
    recovery.lastConsistentData = pruneRemovedDirectoryEntry(recovery.lastConsistentData, removal);
  }
}
