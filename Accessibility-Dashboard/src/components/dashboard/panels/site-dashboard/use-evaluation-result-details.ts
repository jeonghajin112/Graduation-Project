import { useCallback, useEffect, useState } from "react";

import {
  fetchEvaluationIssueViewModels,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import { registerDashboardSessionCache } from "@/services/dashboard-session-cache";
import { UserFacingError } from "@/services/user-facing-error";
import type {
  AnalysisResult,
  EvaluationRequestModel,
  IssueResultModel
} from "@/types/accessibility-domain";

export type EvaluationResultDetailsLoadState = "idle" | "loading" | "ready" | "error";

type EvaluationResultDetailsState = {
  analysisResults: AnalysisResult[];
  errorMessage: string | null;
  issueResults: IssueResultModel[];
  loadState: EvaluationResultDetailsLoadState;
  requestId: number | null;
};

type EvaluationIssueViewModels = Pick<
  EvaluationResultDetailsState,
  "analysisResults" | "issueResults"
>;

export type EvaluationResultDetailsFixture = EvaluationIssueViewModels;

type SharedDetailsRequest = {
  abortTimer: number | null;
  controller: AbortController;
  consumers: number;
  promise: Promise<EvaluationIssueViewModels>;
  timeoutTimer: number | null;
};

type DetailsCacheEntry = {
  cachedAt: number;
  value: EvaluationIssueViewModels;
};

const IDLE_STATE: EvaluationResultDetailsState = {
  analysisResults: [],
  errorMessage: null,
  issueResults: [],
  loadState: "idle",
  requestId: null
};

const DETAILS_REQUEST_TIMEOUT_MS = 15_000;
const DETAILS_REQUEST_TIMEOUT_MESSAGE =
  "검사 결과를 불러오는 데 시간이 오래 걸리고 있습니다. 다시 시도해 주세요.";
const DETAILS_CACHE_TTL_MS = 60_000;
const DETAILS_CACHE_MAX_ENTRIES = 8;
const detailsCache = new Map<number, DetailsCacheEntry>();
const sharedDetailsRequests = new Map<number, SharedDetailsRequest>();

registerDashboardSessionCache("evaluation-result-details", () => {
  detailsCache.clear();
  for (const request of sharedDetailsRequests.values()) {
    if (request.abortTimer !== null) {
      window.clearTimeout(request.abortTimer);
      request.abortTimer = null;
    }
    if (request.timeoutTimer !== null) {
      window.clearTimeout(request.timeoutTimer);
      request.timeoutTimer = null;
    }
    request.controller.abort();
  }
  sharedDetailsRequests.clear();
});

function readDetailsCache(
  requestId: number,
  now = Date.now()
): EvaluationIssueViewModels | null {
  const entry = detailsCache.get(requestId);
  if (!entry) {
    return null;
  }

  const ageMs = now - entry.cachedAt;
  if (ageMs < 0 || ageMs >= DETAILS_CACHE_TTL_MS) {
    detailsCache.delete(requestId);
    return null;
  }

  detailsCache.delete(requestId);
  detailsCache.set(requestId, entry);
  return entry.value;
}

function writeDetailsCache(requestId: number, value: EvaluationIssueViewModels): void {
  detailsCache.delete(requestId);
  detailsCache.set(requestId, { cachedAt: Date.now(), value });

  while (detailsCache.size > DETAILS_CACHE_MAX_ENTRIES) {
    const oldestRequestId = detailsCache.keys().next().value;
    if (typeof oldestRequestId !== "number") {
      break;
    }
    detailsCache.delete(oldestRequestId);
  }
}

function acquireDetailsRequest(request: EvaluationRequestModel): {
  promise: Promise<EvaluationIssueViewModels>;
  release: () => void;
} {
  let sharedRequest = sharedDetailsRequests.get(request.id);
  if (!sharedRequest) {
    const controller = new AbortController();
    let didTimeout = false;
    let timeoutTimer: number | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutTimer = window.setTimeout(() => {
        didTimeout = true;
        timeoutTimer = null;
        controller.abort();
        reject(new UserFacingError(DETAILS_REQUEST_TIMEOUT_MESSAGE));
      }, DETAILS_REQUEST_TIMEOUT_MS);
    });
    const promise = Promise.race([
      fetchEvaluationIssueViewModels(request, controller.signal),
      timeoutPromise
    ])
      .then((value) => {
        writeDetailsCache(request.id, value);
        return value;
      })
      .catch((error: unknown) => {
        if (didTimeout) {
          throw new UserFacingError(DETAILS_REQUEST_TIMEOUT_MESSAGE);
        }
        throw error;
      });
    const createdRequest: SharedDetailsRequest = {
      abortTimer: null,
      controller,
      consumers: 0,
      promise,
      timeoutTimer
    };
    sharedRequest = createdRequest;
    sharedDetailsRequests.set(request.id, createdRequest);
    const clearSettledRequest = () => {
      if (createdRequest.timeoutTimer !== null) {
        window.clearTimeout(createdRequest.timeoutTimer);
        createdRequest.timeoutTimer = null;
      }
      if (sharedDetailsRequests.get(request.id) === createdRequest) {
        sharedDetailsRequests.delete(request.id);
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

      // React StrictMode immediately remounts effects after cleanup. Deferring
      // the underlying abort by one task lets that remount reuse the same GET,
      // while a genuine unmount still cancels the request promptly.
      sharedRequest.abortTimer = window.setTimeout(() => {
        sharedRequest.abortTimer = null;
        if (sharedRequest.consumers === 0) {
          sharedRequest.controller.abort();
          if (sharedRequest.timeoutTimer !== null) {
            window.clearTimeout(sharedRequest.timeoutTimer);
            sharedRequest.timeoutTimer = null;
          }
          if (sharedDetailsRequests.get(request.id) === sharedRequest) {
            sharedDetailsRequests.delete(request.id);
          }
        }
      }, 0);
    }
  };
}

export function useEvaluationResultDetails(
  request: EvaluationRequestModel | null,
  fixture?: EvaluationResultDetailsFixture
) {
  const requestId = request?.id ?? null;
  const fixtureAnalysisResults = fixture?.analysisResults;
  const fixtureIssueResults = fixture?.issueResults;
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<EvaluationResultDetailsState>(IDLE_STATE);

  useEffect(() => {
    if (request === null) {
      setState(IDLE_STATE);
      return;
    }

    if (fixtureAnalysisResults && fixtureIssueResults) {
      setState({
        analysisResults: fixtureAnalysisResults,
        errorMessage: null,
        issueResults: fixtureIssueResults,
        loadState: "ready",
        requestId: request.id
      });
      return;
    }

    const cachedDetails = readDetailsCache(request.id);
    if (cachedDetails !== null) {
      setState({
        ...cachedDetails,
        errorMessage: null,
        loadState: "ready",
        requestId: request.id
      });
      return;
    }

    const controller = new AbortController();
    const sharedRequest = acquireDetailsRequest(request);
    setState({
      analysisResults: [],
      errorMessage: null,
      issueResults: [],
      loadState: "loading",
      requestId: request.id
    });

    void sharedRequest.promise
      .then(({ analysisResults, issueResults }) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          analysisResults,
          errorMessage: null,
          issueResults,
          loadState: "ready",
          requestId: request.id
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        setState({
          analysisResults: [],
          errorMessage: getApiErrorMessage(error, "페이지 검사 결과를 불러오지 못했어요."),
          issueResults: [],
          loadState: "error",
          requestId: request.id
        });
      });

    return () => {
      controller.abort();
      sharedRequest.release();
    };
  }, [fixtureAnalysisResults, fixtureIssueResults, requestId, retryRevision]);

  const retry = useCallback(() => {
    if (requestId !== null) {
      detailsCache.delete(requestId);
    }
    setRetryRevision((current) => current + 1);
  }, [requestId]);

  const visibleState =
    state.requestId === requestId
      ? state
      : requestId === null
        ? IDLE_STATE
        : {
            analysisResults: [],
            errorMessage: null,
            issueResults: [],
            loadState: "loading" as const,
            requestId
          };

  return {
    analysisResults: visibleState.analysisResults,
    errorMessage: visibleState.errorMessage,
    issueResults: visibleState.issueResults,
    loadState: visibleState.loadState,
    retry
  };
}
