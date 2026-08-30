import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchEvaluationArtifact,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import { wait } from "@/services/async-cancellation";
import { registerDashboardSessionCache } from "@/services/dashboard-session-cache";
import type {
  EvaluationArtifact,
  EvaluationRequestModel
} from "@/types/accessibility-domain";

export type EvaluationArtifactLoadState =
  | "idle"
  | "loading"
  | "reconciling"
  | "ready"
  | "empty"
  | "error";

type EvaluationArtifactState = {
  artifact: EvaluationArtifact | null;
  errorMessage: string | null;
  loadState: EvaluationArtifactLoadState;
  requestId: number | null;
};

export type EvaluationArtifactFixture = {
  artifact: EvaluationArtifact | null;
};

type CachedArtifactState = EvaluationArtifactState & {
  loadState: "ready" | "empty";
  requestId: number;
};

type ArtifactCacheEntry = {
  cachedAt: number;
  state: CachedArtifactState;
};

type SharedArtifactRequest = {
  abortTimer: number | null;
  consumers: number;
  controller: AbortController;
  promise: Promise<CachedArtifactState>;
};

const IDLE_STATE: EvaluationArtifactState = {
  artifact: null,
  errorMessage: null,
  loadState: "idle",
  requestId: null
};

// Result ingestion commits before the analyzer uploads the replay artifact.
// These are offsets from request completion, not a fresh 90-second window on
// every visit. An old/legacy request therefore gets one immediate lookup while
// a newly completed request keeps the probe beyond the uploader's 60s timeout.
const ARTIFACT_RETRY_OFFSETS_MS = [
  0,
  1_000,
  3_000,
  7_000,
  15_000,
  30_000,
  60_000,
  90_000
] as const;
const ARTIFACT_REQUEST_TIMEOUT_MS = 10_000;
const ARTIFACT_RECONCILIATION_DEADLINE_MS = 105_000;
const ARTIFACT_RECONCILING_UI_DELAY_MS = 3_000;
const ARTIFACT_REQUEST_TIMEOUT_MESSAGE =
  "페이지 재현 화면 응답 대기 시간이 초과되었습니다. 다시 시도해 주세요.";
const ARTIFACT_READY_CACHE_TTL_MS = 60_000;
const ARTIFACT_EMPTY_CACHE_TTL_MS = 5_000;
const ARTIFACT_CACHE_MAX_ENTRIES = 50;

const artifactCache = new Map<number, ArtifactCacheEntry>();
const sharedArtifactRequests = new Map<number, SharedArtifactRequest>();

registerDashboardSessionCache("evaluation-artifacts", () => {
  artifactCache.clear();
  for (const request of sharedArtifactRequests.values()) {
    if (request.abortTimer !== null) {
      window.clearTimeout(request.abortTimer);
      request.abortTimer = null;
    }
    request.controller.abort();
  }
  sharedArtifactRequests.clear();
});

function readArtifactCache(requestId: number, now = Date.now()): CachedArtifactState | null {
  const entry = artifactCache.get(requestId);
  if (!entry) {
    return null;
  }

  const ttlMs =
    entry.state.loadState === "ready"
      ? ARTIFACT_READY_CACHE_TTL_MS
      : ARTIFACT_EMPTY_CACHE_TTL_MS;
  const ageMs = now - entry.cachedAt;
  if (ageMs < 0 || ageMs >= ttlMs) {
    artifactCache.delete(requestId);
    return null;
  }

  // Refresh insertion order so the fixed-size map evicts the least recently
  // used request instead of a frequently revisited page.
  artifactCache.delete(requestId);
  artifactCache.set(requestId, entry);
  return entry.state;
}

function writeArtifactCache(state: CachedArtifactState): void {
  artifactCache.delete(state.requestId);
  artifactCache.set(state.requestId, { cachedAt: Date.now(), state });

  while (artifactCache.size > ARTIFACT_CACHE_MAX_ENTRIES) {
    const oldestRequestId = artifactCache.keys().next().value;
    if (typeof oldestRequestId !== "number") {
      break;
    }
    artifactCache.delete(oldestRequestId);
  }
}

function throwIfArtifactRequestAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function createArtifactRetryDelays(
  requestUpdatedAt: string,
  now = Date.now()
): number[] {
  const completedAt = Date.parse(requestUpdatedAt);
  if (!Number.isFinite(completedAt)) {
    return [0];
  }

  const elapsedSinceCompletion = Math.max(0, now - completedAt);
  const remainingOffsets = ARTIFACT_RETRY_OFFSETS_MS.filter(
    (offset) => offset > elapsedSinceCompletion
  ).map((offset) => offset - elapsedSinceCompletion);
  const attemptOffsets = [0, ...remainingOffsets];

  return attemptOffsets.map((offset, index) =>
    index === 0 ? 0 : offset - attemptOffsets[index - 1]!
  );
}

async function fetchArtifactWithDeadline(
  requestId: number,
  signal: AbortSignal,
  reconciliationDeadline: number
): Promise<EvaluationArtifact | null> {
  throwIfArtifactRequestAborted(signal);
  const remainingMs = reconciliationDeadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(ARTIFACT_REQUEST_TIMEOUT_MESSAGE);
  }

  const controller = new AbortController();
  let didTimeout = false;
  const forwardAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    controller.abort(ARTIFACT_REQUEST_TIMEOUT_MESSAGE);
  }, Math.min(ARTIFACT_REQUEST_TIMEOUT_MS, remainingMs));

  try {
    const artifact = await fetchEvaluationArtifact(requestId, controller.signal);
    throwIfArtifactRequestAborted(signal);
    if (didTimeout) {
      throw new Error(ARTIFACT_REQUEST_TIMEOUT_MESSAGE);
    }
    return artifact;
  } catch (error) {
    throwIfArtifactRequestAborted(signal);
    if (didTimeout) {
      throw new Error(ARTIFACT_REQUEST_TIMEOUT_MESSAGE);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener("abort", forwardAbort);
  }
}

async function loadArtifactWithRetry(
  requestId: number,
  requestUpdatedAt: string,
  signal: AbortSignal
): Promise<CachedArtifactState> {
  const retryDelays = createArtifactRetryDelays(requestUpdatedAt);
  const reconciliationDeadline = Date.now() + ARTIFACT_RECONCILIATION_DEADLINE_MS;

  for (const [attemptIndex, delayMs] of retryDelays.entries()) {
    if (delayMs >= reconciliationDeadline - Date.now()) {
      throw new Error(ARTIFACT_REQUEST_TIMEOUT_MESSAGE);
    }
    await wait(delayMs, signal);
    const artifact = await fetchArtifactWithDeadline(
      requestId,
      signal,
      reconciliationDeadline
    );
    throwIfArtifactRequestAborted(signal);

    if (artifact !== null) {
      const readyState: CachedArtifactState = {
        artifact,
        errorMessage: null,
        loadState: "ready",
        requestId
      };
      writeArtifactCache(readyState);
      return readyState;
    }

    if (attemptIndex === retryDelays.length - 1) {
      const emptyState: CachedArtifactState = {
        artifact: null,
        errorMessage: null,
        loadState: "empty",
        requestId
      };
      writeArtifactCache(emptyState);
      return emptyState;
    }
  }

  throw new Error("페이지 재현 화면 조회가 예기치 않게 종료되었습니다.");
}

function acquireArtifactRequest(requestId: number, requestUpdatedAt: string): {
  promise: Promise<CachedArtifactState>;
  release: () => void;
} {
  let sharedRequest = sharedArtifactRequests.get(requestId);
  if (!sharedRequest) {
    const controller = new AbortController();
    const promise = loadArtifactWithRetry(
      requestId,
      requestUpdatedAt,
      controller.signal
    );
    sharedRequest = {
      abortTimer: null,
      consumers: 0,
      controller,
      promise
    };
    sharedArtifactRequests.set(requestId, sharedRequest);
    const clearSettledRequest = () => {
      if (sharedArtifactRequests.get(requestId) === sharedRequest) {
        sharedArtifactRequests.delete(requestId);
      }
    };
    void promise.then(clearSettledRequest, clearSettledRequest);
  }

  if (sharedRequest.abortTimer !== null) {
    window.clearTimeout(sharedRequest.abortTimer);
    sharedRequest.abortTimer = null;
  }
  sharedRequest.consumers += 1;

  let released = false;
  return {
    promise: sharedRequest.promise,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      sharedRequest.consumers -= 1;
      if (sharedRequest.consumers > 0 || sharedRequest.abortTimer !== null) {
        return;
      }

      // React StrictMode immediately reacquires this request after effect
      // cleanup. One task of grace prevents a duplicate retry chain, while a
      // real unmount or request switch still aborts the shared network work.
      sharedRequest.abortTimer = window.setTimeout(() => {
        sharedRequest.abortTimer = null;
        if (sharedRequest.consumers === 0) {
          sharedRequest.controller.abort();
          if (sharedArtifactRequests.get(requestId) === sharedRequest) {
            sharedArtifactRequests.delete(requestId);
          }
        }
      }, 0);
    }
  };
}

export function useEvaluationArtifact(
  request: Pick<EvaluationRequestModel, "id" | "updatedAt"> | null,
  fixture?: EvaluationArtifactFixture
) {
  const requestId = request?.id ?? null;
  const requestUpdatedAt = request?.updatedAt ?? null;
  const hasFixture = fixture !== undefined;
  const fixtureArtifact = fixture?.artifact ?? null;
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<EvaluationArtifactState>(IDLE_STATE);
  const activeControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (requestId === null) {
      setState(IDLE_STATE);
      return;
    }

    if (hasFixture) {
      setState({
        artifact: fixtureArtifact,
        errorMessage: null,
        loadState: fixtureArtifact ? "ready" : "empty",
        requestId
      });
      return;
    }

    const cachedState = readArtifactCache(requestId);
    if (cachedState !== null) {
      setState(cachedState);
      return;
    }

    const controller = new AbortController();
    const sharedRequest = acquireArtifactRequest(requestId, requestUpdatedAt ?? "");
    activeControllerRef.current = controller;
    setState({ artifact: null, errorMessage: null, loadState: "loading", requestId });
    const reconcilingTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        setState((current) =>
          current.requestId === requestId && current.loadState === "loading"
            ? { ...current, loadState: "reconciling" }
            : current
        );
      }
    }, ARTIFACT_RECONCILING_UI_DELAY_MS);

    void sharedRequest.promise
      .then((nextState) => {
        window.clearTimeout(reconcilingTimer);
        if (!controller.signal.aborted) {
          setState(nextState);
        }
      })
      .catch((error: unknown) => {
        window.clearTimeout(reconcilingTimer);
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }

        setState({
          artifact: null,
          errorMessage: getApiErrorMessage(error, "페이지 재현 화면을 불러오지 못했어요."),
          loadState: "error",
          requestId
        });
      })
      .finally(() => {
        window.clearTimeout(reconcilingTimer);
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      });

    return () => {
      window.clearTimeout(reconcilingTimer);
      controller.abort();
      sharedRequest.release();
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    };
  }, [fixtureArtifact, hasFixture, requestId, requestUpdatedAt, retryRevision]);

  const retry = useCallback(() => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    if (requestId !== null) {
      artifactCache.delete(requestId);
    }
    setState(
      requestId === null
        ? IDLE_STATE
        : { artifact: null, errorMessage: null, loadState: "loading", requestId }
    );
    setRetryRevision((current) => current + 1);
  }, [requestId]);

  const visibleState =
    state.requestId === requestId
      ? state
      : requestId === null
        ? IDLE_STATE
        : { artifact: null, errorMessage: null, loadState: "loading" as const, requestId };

  return {
    artifact: visibleState.artifact,
    errorMessage: visibleState.errorMessage,
    loadState: visibleState.loadState,
    retry
  };
}
