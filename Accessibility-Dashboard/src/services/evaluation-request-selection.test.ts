import { describe, expect, it } from "vitest";

import type { EvaluationRequestModel } from "@/types/accessibility-domain";
import {
  buildLatestEvaluationRequestByTargetId,
  compareEvaluationRequestRecency,
  selectLatestEvaluationRequest
} from "./evaluation-request-selection";

function request(id: number, evaluationTargetId: number, updatedAt: string): EvaluationRequestModel {
  return { id, evaluationTargetId, updatedAt, requestedAt: updatedAt, status: "COMPLETED" };
}

describe("evaluation request selection", () => {
  it("returns no request for empty input or an empty eligible set", () => {
    expect(selectLatestEvaluationRequest([])).toBeNull();
    expect(buildLatestEvaluationRequestByTargetId([]).size).toBe(0);
    const requests = [request(1, 101, "2026-09-09T00:00:00Z")];
    expect(selectLatestEvaluationRequest(requests, new Set())).toBeNull();
    expect(buildLatestEvaluationRequestByTargetId(requests, new Set()).size).toBe(0);
  });

  it("uses the actual instant before the ID, including time zone offsets", () => {
    const newer = request(1, 101, "2026-09-09T00:00:00Z");
    const older = request(99, 101, "2026-09-09T08:59:59+09:00");
    expect(selectLatestEvaluationRequest([newer, older])).toBe(newer);
    expect(compareEvaluationRequestRecency(newer, older)).toBeGreaterThan(0);
  });

  it("breaks ties by numeric ID regardless of input order without mutating input", () => {
    const lowerId = request(9, 101, "2026-09-09T00:00:00Z");
    const higherId = request(10, 101, "2026-09-09T09:00:00+09:00");
    for (const input of [[lowerId, higherId], [higherId, lowerId]]) {
      const frozen = Object.freeze(input);
      expect(selectLatestEvaluationRequest(frozen)).toBe(higherId);
      expect(buildLatestEvaluationRequestByTargetId(frozen).get(101)).toBe(higherId);
    }
  });

  it("chooses each target independently and can restrict selection to requests with results", () => {
    const completedA = request(1, 101, "2026-09-08T00:00:00Z");
    const pendingA = { ...request(2, 101, "2026-09-09T00:00:00Z"), status: "PENDING" as const };
    const completedB = request(3, 102, "2026-09-08T01:00:00Z");
    const requests = [pendingA, completedB, completedA];
    const all = buildLatestEvaluationRequestByTargetId(requests);
    expect(all.get(101)).toBe(pendingA);
    expect(all.get(102)).toBe(completedB);
    const eligible = new Set([1, 3]);
    expect(selectLatestEvaluationRequest(requests, eligible)).toBe(completedB);
    const withResults = buildLatestEvaluationRequestByTargetId(requests, eligible);
    expect(withResults.get(101)).toBe(completedA);
    expect(withResults.get(102)).toBe(completedB);
  });

  it("does not prefer an older running request over a newer failed request", () => {
    const running = { ...request(1, 101, "2026-09-08T00:00:00Z"), status: "IN_PROGRESS" as const };
    const failed = { ...request(2, 101, "2026-09-09T00:00:00Z"), status: "FAILED" as const };
    expect(selectLatestEvaluationRequest([failed, running])).toBe(failed);
  });

  it("ranks missing or invalid recovery dates before valid dates", () => {
    const dated = request(1, 101, "2026-09-09T00:00:00Z");
    const undated = request(99, 101, "");
    const invalid = request(100, 101, "invalid");
    expect(selectLatestEvaluationRequest([invalid, dated, undated])).toBe(dated);
    expect(buildLatestEvaluationRequestByTargetId([dated, invalid]).get(101)).toBe(dated);
  });

  it("uses ID for two undated recovery requests instead of an order-dependent NaN comparison", () => {
    const lowerId = request(4, 101, "");
    const higherId = request(8, 101, "invalid");
    expect(compareEvaluationRequestRecency(higherId, higherId)).toBe(0);
    for (const requests of [[lowerId, higherId], [higherId, lowerId]]) {
      expect(selectLatestEvaluationRequest(requests)).toBe(higherId);
      expect(buildLatestEvaluationRequestByTargetId(requests).get(101)).toBe(higherId);
    }
  });
});
