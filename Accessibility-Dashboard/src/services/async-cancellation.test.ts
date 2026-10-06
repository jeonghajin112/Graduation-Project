import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestDeadline } from "./async-cancellation";

describe("request deadline lifetime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts at the deadline and identifies a timeout", () => {
    const deadline = createRequestDeadline({ timeoutMs: 50, timeoutReason: "slow" });
    vi.advanceTimersByTime(49);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.reason).toBe("slow");
    expect(deadline.didTimeout()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("forwards caller cancellation (already aborted: %s)", (alreadyAborted) => {
    const caller = new AbortController();
    if (alreadyAborted) caller.abort("left page");
    const deadline = createRequestDeadline({ signal: caller.signal, timeoutMs: 50 });
    if (!alreadyAborted) caller.abort("left page");
    vi.advanceTimersByTime(100);
    expect(deadline.signal.reason).toBe("left page");
    expect(deadline.didTimeout()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the timer and parent listener when disposed repeatedly", () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const deadline = createRequestDeadline({ signal: caller.signal, timeoutMs: 50 });
    deadline.dispose();
    deadline.dispose();
    caller.abort();
    vi.advanceTimersByTime(100);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.didTimeout()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("manual cancellation does not become a timeout or cancel the caller", () => {
    const caller = new AbortController();
    const deadline = createRequestDeadline({ signal: caller.signal, timeoutMs: 50 });
    deadline.controller.abort();
    vi.advanceTimersByTime(100);
    expect(caller.signal.aborted).toBe(false);
    expect(deadline.didTimeout()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
