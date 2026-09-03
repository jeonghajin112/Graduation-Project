import { useCallback, useEffect, useRef, useState } from "react";

import {
  createLiveReportSession,
  getApiErrorMessage,
  isAbortError,
  renewLiveReportSession
} from "@/services/backend-api";
import { registerDashboardSessionCache } from "@/services/dashboard-session-cache";
import type { EvaluationRequestModel, LiveReportSession } from "@/types/accessibility-domain";

import {
  getLiveReportSessionRefreshDelay,
  getLiveReportSessionRefreshRetryDelay,
  isSameLiveReportSessionRenewal,
  isLiveReportSessionSafelyUsable
} from "./live-report-session-policy";
import { LiveReportSessionGenerationFence } from "./live-report-session-generation";

export type LiveReportSessionLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

type LiveReportSessionState = {
  errorMessage: string | null;
  loadState: LiveReportSessionLoadState;
  requestId: number | null;
  session: LiveReportSession | null;
};

type CachedLiveReportSessionState = LiveReportSessionState & {
  loadState: "ready" | "unavailable";
  requestId: number;
};

type ReadyLiveReportSessionState = LiveReportSessionState & {
  loadState: "ready";
  requestId: number;
  session: LiveReportSession;
};

type SharedLiveReportSessionRequest = {
  abortTimer: number | null;
  consumers: number;
  controller: AbortController;
  promise: Promise<CachedLiveReportSessionState>;
};

type LiveReportSessionCacheEntry = {
  cachedAt: number;
  state: CachedLiveReportSessionState;
};

const IDLE_STATE: LiveReportSessionState = {
  errorMessage: null,
  loadState: "idle",
  requestId: null,
  session: null
};
const UNAVAILABLE_CACHE_TTL_MS = 10_000;
const SESSION_CACHE_MAX_ENTRIES = 20;
const LIVE_SESSION_REQUEST_TIMEOUT_MS = 12_000;

const sessionCache = new Map<number, LiveReportSessionCacheEntry>();
const sharedSessionRequests = new Map<string, SharedLiveReportSessionRequest>();
const sessionGenerationFence = new LiveReportSessionGenerationFence();

registerDashboardSessionCache("live-report-sessions", () => {
  sessionCache.clear();
  sessionGenerationFence.clear();
  for (const request of sharedSessionRequests.values()) {
    if (request.abortTimer !== null) {
      window.clearTimeout(request.abortTimer);
    }
    request.controller.abort();
  }
  sharedSessionRequests.clear();
});

function readSessionCache(requestId: number): CachedLiveReportSessionState | null {
  const entry = sessionCache.get(requestId);
  if (!entry) {
    return null;
  }
  const cached = entry.state;

  if (cached.loadState === "ready") {
    if (
      cached.session === null ||
      !isLiveReportSessionSafelyUsable(cached.session, window.location.origin)
    ) {
      sessionCache.delete(requestId);
      return null;
    }
  } else if (Date.now() - entry.cachedAt >= UNAVAILABLE_CACHE_TTL_MS) {
    sessionCache.delete(requestId);
    return null;
  }

  sessionCache.delete(requestId);
  sessionCache.set(requestId, entry);
  return cached;
}

function writeSessionCache(state: CachedLiveReportSessionState): void {
  sessionCache.delete(state.requestId);
  sessionCache.set(state.requestId, { cachedAt: Date.now(), state });
  while (sessionCache.size > SESSION_CACHE_MAX_ENTRIES) {
    const oldestRequestId = sessionCache.keys().next().value;
    if (typeof oldestRequestId !== "number") {
      break;
    }
    sessionCache.delete(oldestRequestId);
  }
}

async function loadLiveReportSession(
  requestId: number,
  signal: AbortSignal,
  sessionToRenew: LiveReportSession | null
): Promise<CachedLiveReportSessionState> {
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromConsumer = () => requestController.abort();
  if (signal.aborted) {
    requestController.abort();
  } else {
    signal.addEventListener("abort", abortFromConsumer, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, LIVE_SESSION_REQUEST_TIMEOUT_MS);

  let session: LiveReportSession | null;
  try {
    session = sessionToRenew === null
      ? await createLiveReportSession(requestId, requestController.signal)
      : await renewLiveReportSession(
          requestId,
          sessionToRenew.sessionId,
          requestController.signal
        );
  } catch (error: unknown) {
    if (timedOut && !signal.aborted) {
      throw new Error("동적 검사 화면 준비 시간이 초과되었습니다.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortFromConsumer);
  }

  if (session === null) {
    return {
      errorMessage: null,
      loadState: "unavailable",
      requestId,
      session: null
    };
  }

  if (!isLiveReportSessionSafelyUsable(session, window.location.origin)) {
    throw new Error("The live report session did not use an isolated, unexpired viewer origin.");
  }
  if (sessionToRenew !== null && !isSameLiveReportSessionRenewal(sessionToRenew, session)) {
    throw new Error("The live report renewal changed viewer identity or did not extend expiration.");
  }

  return {
    errorMessage: null,
    loadState: "ready",
    requestId,
    session
  };
}

function acquireSessionRequest(
  requestId: number,
  sessionToRenew: LiveReportSession | null,
  generation: number
): {
  promise: Promise<CachedLiveReportSessionState>;
  release: () => void;
} {
  const requestKey = sessionToRenew === null
    ? `create:${requestId}:${generation}`
    : `renew:${requestId}:${sessionToRenew.sessionId}:${generation}`;
  let request = sharedSessionRequests.get(requestKey);
  if (!request) {
    const controller = new AbortController();
    request = {
      abortTimer: null,
      consumers: 0,
      controller,
      promise: loadLiveReportSession(requestId, controller.signal, sessionToRenew)
    };
    sharedSessionRequests.set(requestKey, request);
    const clearSettledRequest = () => {
      if (sharedSessionRequests.get(requestKey) === request) {
        sharedSessionRequests.delete(requestKey);
      }
    };
    void request.promise.then(clearSettledRequest, clearSettledRequest);
  }

  const sharedRequest = request;
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
      sharedRequest.abortTimer = window.setTimeout(() => {
        sharedRequest.abortTimer = null;
        if (sharedRequest.consumers === 0) {
          sharedRequest.controller.abort();
          if (sharedSessionRequests.get(requestKey) === sharedRequest) {
            sharedSessionRequests.delete(requestKey);
          }
        }
      }, 0);
    }
  };
}

export function useLiveReportSession(
  request: Pick<EvaluationRequestModel, "id"> | null,
  enabled = true
) {
  const requestId = request?.id ?? null;
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<LiveReportSessionState>(IDLE_STATE);
  const stateRef = useRef<LiveReportSessionState>(IDLE_STATE);
  const forceFreshSessionRef = useRef(false);

  const commitState = useCallback((nextState: LiveReportSessionState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const clearRefreshTimer = () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };
    const scheduleRefreshRevision = (targetRequestId: number, delay: number) => {
      clearRefreshTimer();
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        sessionCache.delete(targetRequestId);
        setRetryRevision((current) => current + 1);
      }, delay);
    };
    const scheduleExpiryRefresh = (nextState: CachedLiveReportSessionState) => {
      if (nextState.loadState !== "ready" || nextState.session === null) {
        return;
      }
      const delay = getLiveReportSessionRefreshDelay(nextState.session);
      if (delay === null) {
        return;
      }
      scheduleRefreshRevision(nextState.requestId, delay);
    };
    const getSafelyUsableCurrentSession = (): ReadyLiveReportSessionState | null => {
      const currentState = stateRef.current;
      if (
        currentState.requestId !== requestId ||
        currentState.loadState !== "ready" ||
        currentState.session === null ||
        !isLiveReportSessionSafelyUsable(currentState.session, window.location.origin)
      ) {
        return null;
      }
      return currentState as ReadyLiveReportSessionState;
    };
    const scheduleRefreshRetry = (currentState: ReadyLiveReportSessionState): boolean => {
      const delay = getLiveReportSessionRefreshRetryDelay(
        currentState.session,
        window.location.origin
      );
      if (delay === null) {
        return false;
      }
      sessionCache.delete(currentState.requestId);
      scheduleRefreshRevision(currentState.requestId, delay);
      return true;
    };

    if (!enabled || requestId === null) {
      forceFreshSessionRef.current = false;
      commitState(IDLE_STATE);
      return;
    }

    const forceFreshSession = forceFreshSessionRef.current;
    forceFreshSessionRef.current = false;
    const cached = forceFreshSession ? null : readSessionCache(requestId);
    if (cached !== null) {
      const currentState = getSafelyUsableCurrentSession();
      if (cached.loadState === "unavailable" && currentState !== null) {
        if (scheduleRefreshRetry(currentState)) {
          return clearRefreshTimer;
        }
      }
      commitState(cached);
      scheduleExpiryRefresh(cached);
      return clearRefreshTimer;
    }

    const currentState = forceFreshSession
      ? null
      : getSafelyUsableCurrentSession();
    const requestGeneration = sessionGenerationFence.current(requestId);
    const consumerController = new AbortController();
    const sharedRequest = acquireSessionRequest(
      requestId,
      currentState?.session ?? null,
      requestGeneration
    );
    if (currentState === null) {
      commitState({ errorMessage: null, loadState: "loading", requestId, session: null });
    }

    void sharedRequest.promise
      .then((nextState) => {
        if (
          consumerController.signal.aborted ||
          !sessionGenerationFence.isCurrent(requestId, requestGeneration)
        ) {
          return;
        }
        if (nextState.loadState === "unavailable") {
          const retainedState = getSafelyUsableCurrentSession();
          if (retainedState !== null && scheduleRefreshRetry(retainedState)) {
            return;
          }
        }
        writeSessionCache(nextState);
        commitState(nextState.loadState === "unavailable"
          ? { ...nextState, errorMessage: null }
          : nextState);
        scheduleExpiryRefresh(nextState);
      })
      .catch((error: unknown) => {
        if (
          consumerController.signal.aborted ||
          !sessionGenerationFence.isCurrent(requestId, requestGeneration) ||
          isAbortError(error)
        ) {
          return;
        }
        const retainedState = getSafelyUsableCurrentSession();
        if (retainedState !== null && scheduleRefreshRetry(retainedState)) {
          return;
        }
        commitState({
          errorMessage: getApiErrorMessage(
            error,
            "동적 검사 화면을 열 수 없어 저장된 재현 화면을 사용합니다."
          ),
          loadState: "error",
          requestId,
          session: null
        });
      });

    return () => {
      clearRefreshTimer();
      consumerController.abort();
      sharedRequest.release();
    };
  }, [commitState, enabled, requestId, retryRevision]);

  const retry = useCallback(() => {
    forceFreshSessionRef.current = true;
    if (requestId !== null) {
      sessionGenerationFence.advance(requestId);
      sessionCache.delete(requestId);
      // Expose the fresh-session transition in the same user/event turn. Waiting
      // for the retry effect would leave the exhausted iframe selected for one
      // more paint and can briefly reveal its exhausted error document before
      // the live-only loading state replaces the iframe.
      commitState({
        errorMessage: null,
        loadState: "loading",
        requestId,
        session: null
      });
    } else {
      commitState(IDLE_STATE);
    }
    setRetryRevision((current) => current + 1);
  }, [commitState, requestId]);

  const visibleState = state.requestId === requestId
    ? state
    : requestId === null
      ? IDLE_STATE
      : { errorMessage: null, loadState: "loading" as const, requestId, session: null };

  return {
    errorMessage: visibleState.errorMessage,
    loadState: visibleState.loadState,
    retry,
    session: visibleState.session
  };
}
