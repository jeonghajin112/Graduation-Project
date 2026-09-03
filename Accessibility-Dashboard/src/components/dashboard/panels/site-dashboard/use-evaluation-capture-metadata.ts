import { useCallback, useEffect, useState } from "react";

import {
  fetchEvaluationCaptureMetadata,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import { registerDashboardSessionCache } from "@/services/dashboard-session-cache";
import { UserFacingError } from "@/services/user-facing-error";
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

type CaptureMetadataCacheEntry = {
  cachedAt: number;
  captureMetadata: EvaluationCaptureMetadata | null;
};

type SharedCaptureMetadataRequest = {
  controller: AbortController;
  promise: Promise<EvaluationCaptureMetadata | null>;
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

const captureMetadataCache = new Map<number, CaptureMetadataCacheEntry>();
const sharedCaptureMetadataRequests = new Map<number, SharedCaptureMetadataRequest>();

registerDashboardSessionCache("evaluation-capture-metadata", () => {
  captureMetadataCache.clear();
  for (const request of sharedCaptureMetadataRequests.values()) {
    request.controller.abort();
  }
  sharedCaptureMetadataRequests.clear();
});

function readCaptureMetadataCache(requestId: number): EvaluationCaptureMetadata | null | undefined {
  const entry = captureMetadataCache.get(requestId);
  if (!entry) {
    return undefined;
  }

  const ttlMs = entry.captureMetadata === null
    ? CAPTURE_METADATA_EMPTY_CACHE_TTL_MS
    : CAPTURE_METADATA_CACHE_TTL_MS;
  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs < 0 || ageMs >= ttlMs) {
    captureMetadataCache.delete(requestId);
    return undefined;
  }

  captureMetadataCache.delete(requestId);
  captureMetadataCache.set(requestId, entry);
  return entry.captureMetadata;
}

function writeCaptureMetadataCache(
  requestId: number,
  captureMetadata: EvaluationCaptureMetadata | null
): void {
  captureMetadataCache.delete(requestId);
  captureMetadataCache.set(requestId, { cachedAt: Date.now(), captureMetadata });
  while (captureMetadataCache.size > CAPTURE_METADATA_CACHE_MAX_ENTRIES) {
    const oldestRequestId = captureMetadataCache.keys().next().value;
    if (typeof oldestRequestId !== "number") {
      return;
    }
    captureMetadataCache.delete(oldestRequestId);
  }
}

function acquireCaptureMetadata(requestId: number): Promise<EvaluationCaptureMetadata | null> {
  const pending = sharedCaptureMetadataRequests.get(requestId);
  if (pending) {
    return pending.promise;
  }

  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = window.setTimeout(
    () => {
      didTimeout = true;
      controller.abort();
    },
    CAPTURE_METADATA_REQUEST_TIMEOUT_MS
  );
  const promise = fetchEvaluationCaptureMetadata(requestId, controller.signal)
    .then((captureMetadata) => {
      writeCaptureMetadataCache(requestId, captureMetadata);
      return captureMetadata;
    })
    .catch((error: unknown) => {
      throw normalizeCaptureMetadataRequestError(error, didTimeout);
    })
    .finally(() => {
      window.clearTimeout(timeoutId);
      if (sharedCaptureMetadataRequests.get(requestId)?.controller === controller) {
        sharedCaptureMetadataRequests.delete(requestId);
      }
    });

  sharedCaptureMetadataRequests.set(requestId, { controller, promise });
  return promise;
}

export function normalizeCaptureMetadataRequestError(
  error: unknown,
  didTimeout: boolean
): unknown {
  return didTimeout ? new UserFacingError(CAPTURE_METADATA_TIMEOUT_MESSAGE) : error;
}

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

    const cached = readCaptureMetadataCache(requestId);
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
    setState({ captureMetadata: null, errorMessage: null, loadState: "loading", requestId });
    void acquireCaptureMetadata(requestId)
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
