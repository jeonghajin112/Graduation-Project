import { ApiRequestError } from "@/services/backend-api";
import { UserFacingError } from "@/services/user-facing-error";

export const DEFAULT_MUTATION_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MUTATION_TIMEOUT_MESSAGE =
  "요청 처리에 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.";
export const ANALYSIS_POLL_ATTEMPTS = 52;

const DEFINITIVE_MUTATION_REJECTION_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 413, 414, 415, 416, 417, 418,
  421, 422, 423, 424, 426, 428, 431, 451
]);

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function getAnalysisPollDelayMs(attempt: number): number {
  if (attempt <= 10) {
    return 1_500;
  }
  if (attempt <= 30) {
    return 3_000;
  }
  return 5_000;
}

export function waitForDocumentVisible(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  if (document.visibilityState !== "hidden") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      cleanup();
      reject(abortError());
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function runMutationRequestWithDeadline<T>({
  operation,
  signal,
  timeoutMessage = DEFAULT_MUTATION_TIMEOUT_MESSAGE,
  timeoutMs = DEFAULT_MUTATION_REQUEST_TIMEOUT_MS
}: {
  operation: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  timeoutMessage?: string;
  timeoutMs?: number;
}): Promise<T> {
  if (signal?.aborted) {
    throw abortError();
  }

  const controller = new AbortController();
  let didTimeout = false;
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    controller.abort(timeoutMessage);
  }, timeoutMs);

  try {
    const result = await operation(controller.signal);
    if (signal?.aborted) {
      throw abortError();
    }
    if (didTimeout) {
      throw new UserFacingError(timeoutMessage);
    }
    return result;
  } catch (error) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (didTimeout) {
      throw new UserFacingError(timeoutMessage);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export function isDefinitiveMutationRejection(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status !== null &&
    DEFINITIVE_MUTATION_REJECTION_STATUSES.has(error.status)
  );
}
