import { UserFacingError } from "./user-facing-error";

/** A bounded cache; callers choose each value's lifetime. */
export class TimedLruCache<K, V> {
  private readonly entries = new Map<K, { cachedAt: number; ttlMs: number; value: V }>();

  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    const ageMs = Date.now() - entry.cachedAt;
    if (ageMs < 0 || ageMs >= entry.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { cachedAt: Date.now(), ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

type SharedRequest<V> = {
  abortTimer: ReturnType<typeof setTimeout> | null;
  consumers: number;
  controller: AbortController;
  promise: Promise<V>;
  settled: boolean;
};

/** Shares pending work while retaining cancellation for the last consumer. */
export class SharedRequestPool<K, V> {
  private readonly requests = new Map<K, SharedRequest<V>>();

  constructor(
    private readonly timeoutMs: number,
    private readonly timeoutMessage: string
  ) {}

  acquire(key: K, load: (signal: AbortSignal) => Promise<V>): {
    promise: Promise<V>;
    release: () => void;
  } {
    let request = this.requests.get(key);
    if (!request) {
      const controller = new AbortController();
      const cancelled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true
        });
      });
      const timeoutTimer = setTimeout(() => {
        controller.abort(new UserFacingError(this.timeoutMessage));
      }, this.timeoutMs);
      const promise = Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return load(controller.signal);
        }),
        cancelled
      ]).then((value) => {
        controller.signal.throwIfAborted();
        return value;
      });
      const created: SharedRequest<V> = {
        abortTimer: null,
        consumers: 0,
        controller,
        promise,
        settled: false
      };
      request = created;
      this.requests.set(key, created);
      const finish = () => {
        created.settled = true;
        clearTimeout(timeoutTimer);
        if (created.abortTimer !== null) {
          clearTimeout(created.abortTimer);
          created.abortTimer = null;
        }
        if (this.requests.get(key) === created) {
          this.requests.delete(key);
        }
      };
      void promise.then(finish, finish);
    }

    const shared = request;
    if (shared.abortTimer !== null) {
      clearTimeout(shared.abortTimer);
      shared.abortTimer = null;
    }
    shared.consumers += 1;
    let released = false;
    return {
      promise: shared.promise,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        shared.consumers -= 1;
        if (shared.consumers > 0 || shared.settled || shared.abortTimer !== null) {
          return;
        }
        // StrictMode remounts effects immediately; one task preserves that shared request.
        shared.abortTimer = setTimeout(() => {
          shared.abortTimer = null;
          shared.controller.abort();
          if (this.requests.get(key) === shared) {
            this.requests.delete(key);
          }
        }, 0);
      }
    };
  }

  clear(): void {
    for (const request of this.requests.values()) {
      request.controller.abort();
    }
    this.requests.clear();
  }
}
