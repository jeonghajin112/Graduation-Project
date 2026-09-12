import type { LocatorIssueState } from "./types";

type ScheduleFlush = (flush: () => void) => () => void;

function sameLocatorState(left: LocatorIssueState | undefined, right: LocatorIssueState): boolean {
  return left?.status === right.status && left.reason === right.reason
    && left.recoverable === right.recoverable;
}

// Owns pending messages separately from the immutable snapshots React renders.
// Replacing a document invalidates both queued callbacks and their pending data.
export class LocatorStateBatch {
  private states = new Map<number, LocatorIssueState>();
  private pending = new Map<number, LocatorIssueState>();
  private cancelScheduledFlush: (() => void) | null = null;
  private generation = 0;

  constructor(
    private readonly publish: (states: Map<number, LocatorIssueState>) => void,
    private readonly schedule: ScheduleFlush
  ) {}

  enqueue(issueId: number, state: LocatorIssueState): void {
    if (sameLocatorState(this.states.get(issueId), state)) {
      // A later message can undo an earlier pending transition in this batch.
      this.pending.delete(issueId);
      return;
    }
    this.pending.set(issueId, state);
    if (this.cancelScheduledFlush !== null) return;
    const generation = this.generation;
    this.cancelScheduledFlush = this.schedule(() => {
      if (generation === this.generation) this.flush();
    });
  }

  flush(): void {
    this.generation += 1;
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = null;
    if (this.pending.size === 0) return;
    const next = new Map(this.states);
    for (const [issueId, state] of this.pending) next.set(issueId, state);
    this.pending.clear();
    this.states = next;
    this.publish(next);
  }

  cancelPending(): void {
    this.generation += 1;
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = null;
    this.pending.clear();
  }

  reset(): void {
    this.cancelPending();
    if (this.states.size === 0) return;
    this.states = new Map();
    this.publish(this.states);
  }
}
