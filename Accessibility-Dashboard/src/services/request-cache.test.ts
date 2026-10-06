import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAbortError } from "./backend-api";
import { SharedRequestPool, TimedLruCache } from "./request-cache";
import { UserFacingError } from "./user-facing-error";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TimedLruCache", () => {
  it("distinguishes a cached empty result from a miss and expires each value on time", () => {
    const cache = new TimedLruCache<number, string | null>(3);
    cache.set(1, null, 10_000);
    cache.set(2, "metadata", 60_000);
    expect(cache.get(1)).toBeNull();
    expect(cache.get(3)).toBeUndefined();
    vi.advanceTimersByTime(10_000);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBe("metadata");
    vi.advanceTimersByTime(50_000);
    expect(cache.get(2)).toBeUndefined();
  });

  it("evicts the least recently used value and allows retry and session invalidation", () => {
    const cache = new TimedLruCache<number, string>(2);
    cache.set(1, "first", 60_000);
    cache.set(2, "second", 60_000);
    expect(cache.get(1)).toBe("first");
    cache.set(3, "third", 60_000);
    expect(cache.get(2)).toBeUndefined();
    cache.delete(1);
    expect(cache.get(1)).toBeUndefined();
    cache.clear();
    expect(cache.get(3)).toBeUndefined();
  });

  it("invalidates entries when the clock moves backwards", () => {
    const cache = new TimedLruCache<number, string>(2);
    cache.set(1, "result", 60_000);
    vi.setSystemTime(999_999);
    expect(cache.get(1)).toBeUndefined();
  });
});

describe("SharedRequestPool", () => {
  it("shares one request across StrictMode cleanup/remount and concurrent consumers", async () => {
    const pool = new SharedRequestPool<number, string>(1_000, "timeout");
    const response = deferred<string>();
    const load = vi.fn((_signal: AbortSignal) => response.promise);
    const first = pool.acquire(1, load);
    first.release();
    const remounted = pool.acquire(1, load);
    const concurrent = pool.acquire(1, load);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(remounted.promise).toBe(first.promise);
    expect(concurrent.promise).toBe(first.promise);
    remounted.release();
    remounted.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls[0]?.[0]?.aborted).toBe(false);
    response.resolve("result");
    await expect(concurrent.promise).resolves.toBe("result");
    concurrent.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts when the last consumer leaves even if the loader ignores its signal", async () => {
    const pool = new SharedRequestPool<number, string>(1_000, "timeout");
    const response = deferred<string>();
    const load = vi.fn((_signal: AbortSignal) => response.promise);
    const request = pool.acquire(1, load);
    const outcome = request.promise.catch((error: unknown) => error);
    await Promise.resolve();
    request.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls[0]?.[0].aborted).toBe(true);
    expect(isAbortError(await outcome)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a terminal timeout and allows a fresh retry instead of staying loading", async () => {
    const pool = new SharedRequestPool<number, string>(1_000, "화면 정보 조회 시간 초과");
    const first = pool.acquire(1, () => new Promise(() => {}));
    const outcome = first.promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toBe("화면 정보 조회 시간 초과");
    expect(isAbortError(error)).toBe(false);
    const retry = pool.acquire(1, async () => "recovered");
    await expect(retry.promise).resolves.toBe("recovered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish late results or remove a replacement request after clearing a session", async () => {
    const pool = new SharedRequestPool<number, string>(1_000, "timeout");
    const oldResponse = deferred<string>();
    const freshResponse = deferred<string>();
    const old = pool.acquire(1, () => oldResponse.promise);
    const commitOldResult = vi.fn();
    const oldOutcome = old.promise.then(commitOldResult, (error: unknown) => error);
    await Promise.resolve();
    pool.clear();
    const fresh = pool.acquire(1, () => freshResponse.promise);
    oldResponse.resolve("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(isAbortError(await oldOutcome)).toBe(true);
    expect(commitOldResult).not.toHaveBeenCalled();
    const secondConsumer = pool.acquire(1, async () => "unexpected replacement");
    expect(secondConsumer.promise).toBe(fresh.promise);
    freshResponse.resolve("fresh");
    await expect(secondConsumer.promise).resolves.toBe("fresh");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps independent keys separate and releases failed requests for retry", async () => {
    const pool = new SharedRequestPool<string, string>(1_000, "timeout");
    const failure = new Error("offline");
    const create = pool.acquire("create:1:0", async () => { throw failure; });
    const renew = pool.acquire("renew:1:session:0", async () => "renewed");
    await expect(create.promise).rejects.toBe(failure);
    await expect(renew.promise).resolves.toBe("renewed");
    const retry = pool.acquire("create:1:0", async () => "created");
    await expect(retry.promise).resolves.toBe("created");
    expect(vi.getTimerCount()).toBe(0);
  });
});
