import { useCallback, useEffect, useState } from "react";

import {
  fetchEvaluationCaptureMetadata,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import { registerDashboardSessionCache } from "@/services/dashboard-session-cache";
import { SharedRequestPool, TimedLruCache } from "@/services/request-cache";
import type {
  EvaluationCaptureMetadata,
  EvaluationRequestModel
} from "@/types/accessibility-domain";

export type EvaluationCaptureMetadataLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "error";

type CaptureMetadataState = {
  captureMetadata: EvaluationCaptureMetadata | null;
  errorMessage: string | null;
  loadState: EvaluationCaptureMetadataLoadState;
  requestId: number | null;
};

export type EvaluationCaptureMetadataFixture = {
  captureMetadata: EvaluationCaptureMetadata | null;
};

const IDLE_STATE: CaptureMetadataState = {
  captureMetadata: null,
  errorMessage: null,
  loadState: "idle",
  requestId: null
};

const CAPTURE_METADATA_CACHE_TTL_MS = 60_000;
const CAPTURE_METADATA_EMPTY_CACHE_TTL_MS = 10_000;
const CAPTURE_METADATA_REQUEST_TIMEOUT_MS = 10_000;
const CAPTURE_METADATA_CACHE_MAX_ENTRIES = 30;
const CAPTURE_METADATA_TIMEOUT_MESSAGE =
  "분석 당시 화면 정보를 불러오는 데 시간이 오래 걸리고 있습니다.";

const captureMetadataCache = new TimedLruCache<number, EvaluationCaptureMetadata | null>(
  CAPTURE_METADATA_CACHE_MAX_ENTRIES
);
const sharedCaptureMetadataRequests = new SharedRequestPool<number, EvaluationCaptureMetadata | null>(
  CAPTURE_METADATA_REQUEST_TIMEOUT_MS,
  CAPTURE_METADATA_TIMEOUT_MESSAGE
);

registerDashboardSessionCache("evaluation-capture-metadata", () => {
  captureMetadataCache.clear();
  sharedCaptureMetadataRequests.clear();
});

export function useEvaluationCaptureMetadata(
  request: Pick<EvaluationRequestModel, "id"> | null,
  fixture?: EvaluationCaptureMetadataFixture
) {
  const requestId = request?.id ?? null;
  const hasFixture = fixture !== undefined;
  const fixtureMetadata = fixture?.captureMetadata ?? null;
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<CaptureMetadataState>(IDLE_STATE);

  useEffect(() => {
    if (requestId === null) {
      setState(IDLE_STATE);
      return;
    }

    if (hasFixture) {
      setState({
        captureMetadata: fixtureMetadata,
        errorMessage: null,
        loadState: fixtureMetadata === null ? "empty" : "ready",
        requestId
      });
      return;
    }

    const cached = captureMetadataCache.get(requestId);
    if (cached !== undefined) {
      setState({
        captureMetadata: cached,
        errorMessage: null,
        loadState: cached === null ? "empty" : "ready",
        requestId
      });
      return;
    }

    let cancelled = false;
    const sharedRequest = sharedCaptureMetadataRequests.acquire(requestId, async (signal) => {
      const metadata = await fetchEvaluationCaptureMetadata(requestId, signal);
      signal.throwIfAborted();
      captureMetadataCache.set(requestId, metadata, metadata === null
        ? CAPTURE_METADATA_EMPTY_CACHE_TTL_MS
        : CAPTURE_METADATA_CACHE_TTL_MS);
      return metadata;
    });
    setState({ captureMetadata: null, errorMessage: null, loadState: "loading", requestId });
    void sharedRequest.promise
      .then((captureMetadata) => {
        if (!cancelled) {
          setState({
            captureMetadata,
            errorMessage: null,
            loadState: captureMetadata === null ? "empty" : "ready",
            requestId
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && !isAbortError(error)) {
          setState({
            captureMetadata: null,
            errorMessage: getApiErrorMessage(
              error,
              "분석 당시 화면 정보를 불러오지 못했습니다."
            ),
            loadState: "error",
            requestId
          });
        }
      });

    return () => {
      cancelled = true;
      sharedRequest.release();
    };
  }, [fixtureMetadata, hasFixture, requestId, retryRevision]);

  const retry = useCallback(() => {
    if (requestId !== null) {
      captureMetadataCache.delete(requestId);
    }
    setRetryRevision((current) => current + 1);
  }, [requestId]);

  const visibleState = state.requestId === requestId
    ? state
    : requestId === null
      ? IDLE_STATE
      : { captureMetadata: null, errorMessage: null, loadState: "loading" as const, requestId };

  return {
    captureMetadata: visibleState.captureMetadata,
    errorMessage: visibleState.errorMessage,
    loadState: visibleState.loadState,
    retry
  };
}
