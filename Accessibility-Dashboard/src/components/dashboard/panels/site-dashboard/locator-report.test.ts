import { describe, expect, it } from "vitest";
import { buildLocatorReport, sameLocatorReport } from "./locator-report";
import type { LocatorIssueState } from "./types";

describe("locator reporting", () => {
  const issueIds = [1, 2, 3];
  const input = { requestId: 501, issueIds, issueIdsSignature: "1,2,3", issueLimit: 2, connected: true, failed: false };
  it("keeps the complete list, waits for missing states and bounds viewer participation", () => {
    const states = new Map<number, LocatorIssueState>([[1, { status: "VISIBLE" }]]);
    const before = buildLocatorReport({ ...input, states });
    expect(before.state).toBe("loading");
    expect(before.unavailableIssueIds).toEqual([3]);
    const next = buildLocatorReport({ ...input, states: new Map([...states, [2, { status: "HIDDEN_STATE", recoverable: true }]]) });
    expect(next.state).toBe("ready");
    expect(next.recoverableHiddenIssueIds).toEqual([2]);
    expect(next.issueStates[1]).toBe(before.issueStates[1]);
    expect(next.issueStates[3]).toBe(before.issueStates[3]);
    expect(sameLocatorReport(before, next)).toBe(false);
    expect(sameLocatorReport(next, buildLocatorReport({ ...input, states: new Map(Object.entries(next.issueStates).map(([id, state]) => [Number(id), state])) }))).toBe(true);
    expect(sameLocatorReport(next, { ...next, requestId: 502 })).toBe(false);
  });
  it("does not report confirmed positions when disconnected", () => {
    const report = buildLocatorReport({ ...input, states: new Map(), connected: false, failed: true });
    expect(report.state).toBe("error");
    expect(report.issueStates).toEqual({});
  });
});
