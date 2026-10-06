import { describe, expect, it } from "vitest";

import {
  consumeLiveReportAutomaticRecovery,
  createLiveReportAutomaticRecoveryState
} from "./live-report-recovery";

describe("live report automatic recovery", () => {
  it("allows exactly one automatic fresh-session retry per evaluation request", () => {
    const initial = createLiveReportAutomaticRecoveryState(501);
    const firstFailure = consumeLiveReportAutomaticRecovery(initial, 501);
    expect(firstFailure.shouldRetry).toBe(true);

    const replacementFailure = consumeLiveReportAutomaticRecovery(
      firstFailure.nextState,
      501
    );
    expect(replacementFailure.shouldRetry).toBe(false);
    expect(replacementFailure.nextState).toEqual({ attempted: true, requestId: 501 });
  });

  it("restores one retry when the analyzed request changes", () => {
    const consumed = consumeLiveReportAutomaticRecovery(
      createLiveReportAutomaticRecoveryState(501),
      501
    );
    const nextRequest = consumeLiveReportAutomaticRecovery(consumed.nextState, 502);

    expect(nextRequest.shouldRetry).toBe(true);
    expect(nextRequest.nextState).toEqual({ attempted: true, requestId: 502 });
  });

  it("does not retry when no analyzed request owns the session", () => {
    expect(consumeLiveReportAutomaticRecovery(
      createLiveReportAutomaticRecoveryState(null),
      null
    ).shouldRetry).toBe(false);
  });
});
