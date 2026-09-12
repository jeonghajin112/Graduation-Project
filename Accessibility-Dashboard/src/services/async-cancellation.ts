/**
 * Cancellation helpers for long-running backend polling loops.
 *
 * The dashboard polls evaluation requests for up to a few minutes. Without a
 * cancellation signal those loops keep firing requests after the caller is gone
 * (route change, modal close, unmount), so every loop must be tied to a signal.
 *
 * Errors raised here reuse the DOM `AbortError` name so that the existing
 * `isAbortError` check in `backend-api.ts` recognises them.
 */

export function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Owns only the request lifetime; callers retain their recovery/error policy. */
export function createRequestDeadline({
  signal,
  timeoutMs,
  timeoutReason
}: {
  signal?: AbortSignal;
  timeoutMs: number;
  timeoutReason?: unknown;
}) {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const forwardAbort = () => controller.abort(signal?.reason);
  const dispose = () => {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", dispose);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener("abort", forwardAbort, { once: true });
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutReason);
    }, timeoutMs);
  }
  return { controller, signal: controller.signal, didTimeout: () => timedOut, dispose };
}

/** Throws an AbortError when the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

/**
 * Sleeps for `milliseconds`, rejecting immediately with an AbortError when the
 * signal aborts. A plain `setTimeout` promise would keep the loop alive for the
 * remainder of the interval before noticing the cancellation.
 */
export function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      reject(createAbortError());
    };

    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}
