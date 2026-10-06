export type LiveReportAutomaticRecoveryState = {
  attempted: boolean;
  requestId: number | null;
};

export type LiveReportAutomaticRecoveryDecision = {
  nextState: LiveReportAutomaticRecoveryState;
  shouldRetry: boolean;
};

export function createLiveReportAutomaticRecoveryState(
  requestId: number | null
): LiveReportAutomaticRecoveryState {
  return { attempted: false, requestId };
}

export function consumeLiveReportAutomaticRecovery(
  state: LiveReportAutomaticRecoveryState,
  requestId: number | null
): LiveReportAutomaticRecoveryDecision {
  const current = state.requestId === requestId
    ? state
    : createLiveReportAutomaticRecoveryState(requestId);
  if (requestId === null || current.attempted) {
    return { nextState: current, shouldRetry: false };
  }

  return {
    nextState: { attempted: true, requestId },
    shouldRetry: true
  };
}
