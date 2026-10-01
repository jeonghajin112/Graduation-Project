import { describe, expect, it } from "vitest";

import type { DashboardViewModel } from "@/types/accessibility-domain";

import {
  createDirectoryRecoveryLease,
  forgetRemovedDirectoryEntry,
  protectRecoverySnapshot,
  type DirectoryRecovery
} from "./dashboard-recovery";

const timestamp = "2026-10-01T00:00:00Z";

function snapshot(projects: Array<{ id: number; targets: number[] }>): DashboardViewModel {
  const targetIds = projects.flatMap((project) => project.targets);
  return {
    organizations: projects.map((project) => ({
      id: project.id, name: `Project ${project.id}`, description: "", status: "ACTIVE", updatedAt: timestamp,
      evaluationTargets: project.targets.map((id) => ({
        id, name: `Page ${id}`, targetType: "WEB", accessUrl: `https://example.com/${id}`,
        faviconUrl: null, status: "COMPLETED", createdAt: timestamp
      }))
    })),
    evaluationRequests: targetIds.map((id) => ({
      id: id * 10, evaluationTargetId: id, status: "COMPLETED", requestedAt: timestamp, updatedAt: timestamp
    })),
    resultSummaries: targetIds.map((id) => ({ requestId: id * 10, totalScore: 90, totalIssueCount: 1, requestedAt: timestamp })),
    latestIssueCounts: targetIds.map((id) => ({ evaluationTargetId: id, requestId: id * 10 })),
    scoreResults: targetIds.map((id) => ({ id, evaluationRequestId: id * 10, totalScore: 90 }))
  };
}

function recoveryFor(baseline: DashboardViewModel): DirectoryRecovery {
  return {
    leases: new Map([[Symbol("creation"), createDirectoryRecoveryLease(baseline)]]),
    lastConsistentData: baseline
  };
}

describe("directory recovery protection", () => {
  it("keeps protecting an unconfirmed absence", () => {
    const before = snapshot([{ id: 1, targets: [101, 102] }]);
    const recovery = recoveryFor(before);
    const withoutPage = snapshot([{ id: 1, targets: [101] }]);
    expect(protectRecoverySnapshot(withoutPage, recovery)).toBe(before);
  });

  it("shows a confirmed page deletion instead of restoring the stale snapshot", () => {
    const before = snapshot([{ id: 1, targets: [101, 102] }]);
    const recovery = recoveryFor(before);
    forgetRemovedDirectoryEntry(recovery, { targetId: 102 });
    const afterDelete = snapshot([{ id: 1, targets: [101] }]);
    expect(protectRecoverySnapshot(afterDelete, recovery)).toBe(afterDelete);
  });

  it("shows a confirmed project deletion and drops it from the fallback snapshot", () => {
    const before = snapshot([{ id: 1, targets: [101] }, { id: 2, targets: [201] }]);
    const recovery = recoveryFor(before);
    forgetRemovedDirectoryEntry(recovery, { organizationId: 2 });
    expect(recovery.lastConsistentData?.organizations.map(({ id }) => id)).toEqual([1]);
    expect(recovery.lastConsistentData?.evaluationRequests.map(({ id }) => id)).toEqual([1010]);
    expect(recovery.lastConsistentData?.scoreResults.map(({ evaluationRequestId }) => evaluationRequestId)).toEqual([1010]);
    const afterDelete = snapshot([{ id: 1, targets: [101] }]);
    expect(protectRecoverySnapshot(afterDelete, recovery)).toBe(afterDelete);
  });
});
