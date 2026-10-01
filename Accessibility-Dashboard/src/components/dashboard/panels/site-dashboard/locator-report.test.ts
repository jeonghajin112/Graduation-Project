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
  it("lists findings the page no longer matches as unavailable and counts them separately", () => {
    const states = new Map<number, LocatorIssueState>([
      [1, { status: "UNAVAILABLE", reason: "DOCUMENT_METADATA" }],
      [2, { status: "UNAVAILABLE", reason: "ELEMENT_CONTENT_CHANGED" }],
      [3, { status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" }],
      [4, { status: "VISIBLE", reason: "SCREEN_READER_ONLY", ownerKind: "BUTTON" }],
      [5, { status: "UNAVAILABLE", reason: "SELECTOR_NOT_FOUND" }],
      [6, { status: "OFFSCREEN", reason: "APPROXIMATE_AREA", ownerKind: "REGION" }]
    ]);
    const report = buildLocatorReport({ ...input, issueIds: [1, 2, 3, 4, 5, 6], issueIdsSignature: "1,2,3,4,5,6", issueLimit: 10, states });
    expect(report.pageSettingIssueIds).toEqual([1]);
    expect(report.unavailableIssueIds).toEqual([2, 3, 5]);
    expect(report.recoverableHiddenIssueIds).toEqual([]);
  });
  it("does not report confirmed positions when disconnected", () => {
    const report = buildLocatorReport({ ...input, states: new Map(), connected: false, failed: true });
    expect(report.state).toBe("error");
    expect(report.issueStates).toEqual({});
  });
});
