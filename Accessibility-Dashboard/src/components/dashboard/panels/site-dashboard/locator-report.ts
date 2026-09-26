import type { LocatorIssueState, LocatorReport } from "./types";

const overflowState: LocatorIssueState = Object.freeze({ status: "UNAVAILABLE", reason: "ISSUE_LIMIT_EXCEEDED" });

export function buildLocatorReport({ requestId, issueIds, issueIdsSignature, issueLimit, connected, failed, states }: {
  requestId: number | null; issueIds: readonly number[]; issueLimit: number;
  issueIdsSignature: string;
  connected: boolean; failed: boolean; states: ReadonlyMap<number, LocatorIssueState>;
}): LocatorReport {
  const issueStates: Record<number, LocatorIssueState> = {};
  const unavailableIssueIds: number[] = [];
  const recoverableHiddenIssueIds: number[] = [];
  let allLocated = connected;
  if (connected) issueIds.forEach((id, index) => {
    const state: LocatorIssueState | undefined = index >= issueLimit
      ? overflowState : states.get(id);
    if (!state) { allLocated = false; return; }
    issueStates[id] = state;
    if (state.status === "HIDDEN_STATE" && state.recoverable === true) recoverableHiddenIssueIds.push(id);
    else if (state.status === "UNAVAILABLE" || state.status === "HIDDEN_STATE") unavailableIssueIds.push(id);
  });
  return { requestId, issueIdsSignature,
    state: failed ? "error" : allLocated ? "ready" : "loading",
    unavailableIssueIds, recoverableHiddenIssueIds, issueStates };
}

export function sameLocatorReport(left: LocatorReport | null, right: LocatorReport): boolean {
  if (left === right) return true;
  if (!left || left.requestId !== right.requestId || left.issueIdsSignature !== right.issueIdsSignature || left.state !== right.state) return false;
  const leftIds = Object.keys(left.issueStates);
  if (leftIds.length !== Object.keys(right.issueStates).length) return false;
  // Batch snapshots preserve unchanged state objects. Lists are derived from
  // these states in issue order, so no payload serialization is necessary.
  return leftIds.every(id => left.issueStates[Number(id)] === right.issueStates[Number(id)]);
}
