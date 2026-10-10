import type {
  EvaluationRequestModel,
  EvaluationResultSummary,
  ScoreResult
} from "@/types/accessibility-domain";

import type { ScoreChartItem } from "./types";
import { formatShortDate, formatShortTime } from "./utils";

export const TREND_SLOT_COUNT = 7;

/**
 * The target's most recent scored analyses, oldest first. Requests without a
 * finite score (running, failed or never scored) are skipped, not drawn as 0.
 */
export function buildScoreTrend(
  evaluationRequests: readonly EvaluationRequestModel[],
  evaluationTargetId: number,
  resultSummaries: readonly EvaluationResultSummary[],
  scoreResults: readonly ScoreResult[],
  limit = TREND_SLOT_COUNT
): ScoreChartItem[] {
  const scoreByRequestId = new Map(scoreResults.map((result) => [result.evaluationRequestId, result.totalScore]));
  const summaryByRequestId = new Map(resultSummaries.map((summary) => [summary.requestId, summary]));

  return evaluationRequests
    .filter((request) => request.evaluationTargetId === evaluationTargetId)
    .map((request) => {
      const summary = summaryByRequestId.get(request.id);
      // Only a score result is a score. The overview summary reports 0 for a
      // completed request that has none, so it supplies the issue count only.
      const score = scoreByRequestId.get(request.id) ?? null;
      if (score === null || !Number.isFinite(score)) return null;
      const date = summary?.requestedAt ?? request.requestedAt ?? request.updatedAt;
      return {
        slot: 0,
        requestId: request.id,
        date,
        label: formatShortDate(date),
        score: Math.round(score * 10) / 10,
        issueCount: summary?.totalIssueCount ?? null
      } satisfies ScoreChartItem;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))
    .slice(-Math.max(0, limit))
    .map((item, slot) => ({ ...item, slot }));
}

/** Left-pads a trend with placeholder slots so a short history keeps its width. */
export function padScoreTrend(items: readonly ScoreChartItem[], slotCount = TREND_SLOT_COUNT): ScoreChartItem[] {
  const emptySlotCount = Math.max(0, slotCount - items.length);
  return [
    ...Array.from({ length: emptySlotCount }, (_, slot) => ({
      slot, date: "", label: "", score: 0, issueCount: 0, isPlaceholder: true
    } satisfies ScoreChartItem)),
    ...items.map((item, index) => ({ ...item, slot: emptySlotCount + index }))
  ];
}

export type TrendAxisLabel = {
  day: string;
  time: string;
};

/**
 * The date and time of every analysis. Each point repeats its date, even on
 * the same day, so no time is left without the day it belongs to.
 */
export function trendAxisLabels(items: readonly ScoreChartItem[]): TrendAxisLabel[] {
  return items.map((item) => ({ day: formatShortDate(item.date), time: formatShortTime(item.date) }));
}

export type ScoreChange = {
  previous: ScoreChartItem;
  scoreDelta: number;
  /** Null when either analysis has no recorded issue count. */
  issueDelta: number | null;
};

/** How the given analysis compares with the analysis just before it. */
export function compareWithPrevious(items: readonly ScoreChartItem[], requestId: number | null): ScoreChange | null {
  if (requestId === null) return null;
  const index = items.findIndex((item) => item.requestId === requestId);
  if (index < 1) return null;
  const current = items[index]!;
  const previous = items[index - 1]!;
  return {
    previous,
    scoreDelta: Math.round((current.score - previous.score) * 10) / 10,
    issueDelta: current.issueCount === null || previous.issueCount === null ? null : current.issueCount - previous.issueCount
  };
}
