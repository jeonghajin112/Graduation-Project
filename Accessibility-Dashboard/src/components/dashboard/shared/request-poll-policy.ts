// Missing or failing reads are observations, never synthetic server statuses.
export type RequestPollObservation = { failures: number; firstFailureAt: number; nextAttemptAt: number; lastAttemptAt: number; paused: boolean; removed?: boolean };
export function failedPoll(previous: RequestPollObservation | undefined, now: number): RequestPollObservation {
  const failures = (previous?.failures ?? 0) + 1;
  const firstFailureAt = previous && previous.failures > 0 ? previous.firstFailureAt : now;
  return { failures, firstFailureAt, lastAttemptAt: now,
    nextAttemptAt: now + Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4)),
    paused: failures >= 5 && now - firstFailureAt >= 120_000 };
}
