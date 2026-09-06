import { useCallback, useEffect, useState } from "react";

import {
  fetchEvaluationIssueViewModels,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import { registerDashboardSessionCache } from "@/services/dashboard-session-cache";
import { SharedRequestPool, TimedLruCache } from "@/services/request-cache";
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
const detailsCache = new TimedLruCache<number, EvaluationIssueViewModels>(DETAILS_CACHE_MAX_ENTRIES);
const sharedDetailsRequests = new SharedRequestPool<number, EvaluationIssueViewModels>(
  DETAILS_REQUEST_TIMEOUT_MS,
  DETAILS_REQUEST_TIMEOUT_MESSAGE
);

registerDashboardSessionCache("evaluation-result-details", () => {
  detailsCache.clear();
  sharedDetailsRequests.clear();
});

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

    const cachedDetails = detailsCache.get(request.id);
    if (cachedDetails !== undefined) {
      setState({
        ...cachedDetails,
        errorMessage: null,
        loadState: "ready",
        requestId: request.id
      });
      return;
    }

    const controller = new AbortController();
    const sharedRequest = sharedDetailsRequests.acquire(request.id, async (signal) => {
      const value = await fetchEvaluationIssueViewModels(request, signal);
      signal.throwIfAborted();
      detailsCache.set(request.id, value, DETAILS_CACHE_TTL_MS);
      return value;
    });
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
