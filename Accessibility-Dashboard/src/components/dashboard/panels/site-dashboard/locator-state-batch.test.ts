import { describe, expect, it, vi } from "vitest";

import { LocatorStateBatch } from "./locator-state-batch";
import type { LocatorIssueState } from "./types";

function fixture() {
  const scheduled: Array<{ flush: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  const publish = vi.fn<(states: Map<number, LocatorIssueState>) => void>();
  const batch = new LocatorStateBatch(publish, (flush) => {
    const cancel = vi.fn();
    scheduled.push({ flush, cancel });
    return cancel;
  });
  return { batch, publish, scheduled };
}

describe("locator state batches", () => {
  it("publishes one complete snapshot for a burst of distinct issues", () => {
    const { batch, publish, scheduled } = fixture();
    for (let id = 1; id <= 1000; id += 1) batch.enqueue(id, { status: "VISIBLE" });
    expect(scheduled).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    scheduled[0]!.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0].size).toBe(1000);
    expect(publish.mock.calls[0]![0].get(1000)?.status).toBe("VISIBLE");
  });

  it("keeps the latest status, reason and recoverability for each issue", () => {
    const { batch, publish, scheduled } = fixture();
    batch.enqueue(7, { status: "VISIBLE" });
    batch.enqueue(7, { status: "HIDDEN_STATE", reason: "STYLE_HIDDEN", recoverable: false });
    batch.enqueue(7, { status: "HIDDEN_STATE", reason: "CAROUSEL_HIDDEN", recoverable: true });
    scheduled[0]!.flush();
    expect(publish.mock.calls[0]![0].get(7)).toEqual({
      status: "HIDDEN_STATE", reason: "CAROUSEL_HIDDEN", recoverable: true
    });
  });

  it("leaves earlier snapshots immutable and retains unaffected entries", () => {
    const { batch, publish, scheduled } = fixture();
    const stable = { status: "VISIBLE" } as const;
    batch.enqueue(1, stable);
    batch.enqueue(2, { status: "OFFSCREEN" });
    scheduled[0]!.flush();
    const first = publish.mock.calls[0]![0];
    batch.enqueue(2, { status: "VISIBLE" });
    scheduled[1]!.flush();
    const next = publish.mock.calls[1]![0];
    expect(first.get(2)?.status).toBe("OFFSCREEN");
    expect(next.get(2)?.status).toBe("VISIBLE");
    expect(next.get(1)).toBe(stable);
    expect(next).not.toBe(first);
  });

  it("skips identical messages and transitions undone before publication", () => {
    const { batch, publish, scheduled } = fixture();
    batch.enqueue(1, { status: "VISIBLE" });
    scheduled[0]!.flush();
    batch.enqueue(1, { status: "VISIBLE" });
    expect(scheduled).toHaveLength(1);
    batch.enqueue(1, { status: "OFFSCREEN" });
    batch.enqueue(1, { status: "VISIBLE" });
    scheduled[1]!.flush();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("discards pending work and stale callbacks when a document resets", () => {
    const { batch, publish, scheduled } = fixture();
    batch.enqueue(1, { status: "VISIBLE" });
    const stale = scheduled[0]!;
    batch.reset();
    expect(stale.cancel).toHaveBeenCalledTimes(1);
    batch.enqueue(2, { status: "OFFSCREEN" });
    stale.flush(); // Cancellation may race an already queued callback.
    expect(publish).not.toHaveBeenCalled();
    scheduled[1]!.flush();
    expect([...publish.mock.calls[0]![0].keys()]).toEqual([2]);
    batch.reset();
    expect(publish.mock.calls[1]![0].size).toBe(0);
  });

  it("does not let a cancelled frame/timer flush the following batch", () => {
    const { batch, publish, scheduled } = fixture();
    batch.enqueue(1, { status: "VISIBLE" });
    const oldCallback = scheduled[0]!.flush;
    batch.flush(); // Timer or tab visibility beats the frame callback.
    batch.enqueue(2, { status: "VISIBLE" });
    oldCallback();
    expect(publish).toHaveBeenCalledTimes(1);
    scheduled[1]!.flush();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("cancels pending work on disconnect without changing the published snapshot", () => {
    const { batch, publish, scheduled } = fixture();
    batch.enqueue(1, { status: "VISIBLE" });
    scheduled[0]!.flush();
    batch.enqueue(2, { status: "VISIBLE" });
    batch.cancelPending();
    scheduled[1]!.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    batch.enqueue(3, { status: "VISIBLE" });
    scheduled[2]!.flush();
    expect([...publish.mock.calls[1]![0].keys()]).toEqual([1, 3]);
  });
});
