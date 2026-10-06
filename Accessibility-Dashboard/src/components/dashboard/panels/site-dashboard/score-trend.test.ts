import { describe, expect, it } from "vitest";

import type { EvaluationRequestModel, EvaluationResultSummary, ScoreResult } from "@/types/accessibility-domain";

import { buildScoreTrend, compareWithPrevious, padScoreTrend } from "./score-trend";

function request(id: number, requestedAt: string, targetId = 7): EvaluationRequestModel {
  return { id, evaluationTargetId: targetId, status: "COMPLETED", requestedAt, updatedAt: requestedAt };
}

const requests = [
  request(3, "2026-09-30T10:00:00Z"),
  request(1, "2026-09-28T10:00:00Z"),
  request(2, "2026-09-29T10:00:00Z"),
  request(4, "2026-10-01T10:00:00Z"),
  request(9, "2026-09-27T10:00:00Z", 8)
];
const summaries: EvaluationResultSummary[] = [
  { requestId: 1, totalScore: 55.04, totalIssueCount: 80, requestedAt: "2026-09-28T10:00:00Z" },
  { requestId: 2, totalScore: 59.1, totalIssueCount: 72, requestedAt: "2026-09-29T10:00:00Z" },
  { requestId: 4, totalScore: 61.4, totalIssueCount: 69, requestedAt: "2026-10-01T10:00:00Z" }
];
// Request 3 has only a score row, as a summary can arrive later.
const scores: ScoreResult[] = [{ id: 30, evaluationRequestId: 3, totalScore: 58 }];

describe("score trend", () => {
  it("orders the target's scored analyses by date and skips other targets", () => {
    const trend = buildScoreTrend(requests, 7, summaries, scores);
    expect(trend.map(({ requestId, score, issueCount, slot }) => [requestId, score, issueCount, slot])).toEqual([
      [1, 55, 80, 0], [2, 59.1, 72, 1], [3, 58, null, 2], [4, 61.4, 69, 3]
    ]);
    expect(buildScoreTrend(requests, 7, summaries, scores, 2).map(({ requestId }) => requestId)).toEqual([3, 4]);
  });

  it("pads short histories on the left", () => {
    const padded = padScoreTrend(buildScoreTrend(requests, 7, summaries, scores), 6);
    expect(padded.map(({ isPlaceholder, slot }) => [Boolean(isPlaceholder), slot])).toEqual([
      [true, 0], [true, 1], [false, 2], [false, 3], [false, 4], [false, 5]
    ]);
  });

  it("compares an analysis with the one before it", () => {
    const trend = buildScoreTrend(requests, 7, summaries, scores);
    expect(compareWithPrevious(trend, 2)).toMatchObject({ scoreDelta: 4.1, issueDelta: -8 });
    // The previous analysis has no issue count, so only the score is compared.
    expect(compareWithPrevious(trend, 4)).toMatchObject({ scoreDelta: 3.4, issueDelta: null });
    expect(compareWithPrevious(trend, 1)).toBeNull();
    expect(compareWithPrevious(trend, 99)).toBeNull();
    expect(compareWithPrevious(trend, null)).toBeNull();
  });
});
