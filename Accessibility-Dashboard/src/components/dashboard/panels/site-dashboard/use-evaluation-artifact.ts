import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchEvaluationArtifact,
  getApiErrorMessage,
  isAbortError
} from "@/services/backend-api";
import { wait } from "@/services/async-cancellation";
import type { EvaluationArtifact } from "@/types/accessibility-domain";

export type EvaluationArtifactLoadState = "idle" | "loading" | "ready" | "empty" | "error";

type EvaluationArtifactState = {
  artifact: EvaluationArtifact | null;
  errorMessage: string | null;
  loadState: EvaluationArtifactLoadState;
  requestId: number | null;
};

const IDLE_STATE: EvaluationArtifactState = {
  artifact: null,
  errorMessage: null,
  loadState: "idle",
  requestId: null
};

const ARTIFACT_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000] as const;

export function useEvaluationArtifact(requestId: number | null) {
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<EvaluationArtifactState>(IDLE_STATE);
  const activeControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (requestId === null) {
      setState(IDLE_STATE);
      return;
    }

    const controller = new AbortController();
    activeControllerRef.current = controller;
    setState({ artifact: null, errorMessage: null, loadState: "loading", requestId });

    const loadArtifact = async () => {
      try {
        for (const [attemptIndex, delayMs] of ARTIFACT_RETRY_DELAYS_MS.entries()) {
          await wait(delayMs, controller.signal);
          const artifact = await fetchEvaluationArtifact(requestId, controller.signal);

          if (controller.signal.aborted) {
            return;
          }

          if (artifact !== null) {
            setState({ artifact, errorMessage: null, loadState: "ready", requestId });
            return;
          }

          if (attemptIndex === ARTIFACT_RETRY_DELAYS_MS.length - 1) {
            setState({ artifact: null, errorMessage: null, loadState: "empty", requestId });
          }
        }
      } catch (error: unknown) {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }

        setState({
          artifact: null,
          errorMessage: getApiErrorMessage(error, "페이지 재현 화면을 불러오지 못했어요."),
          loadState: "error",
          requestId
        });
      } finally {
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      }
    };

    void loadArtifact();

    return () => {
      controller.abort();
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    };
  }, [requestId, retryRevision]);

  const retry = useCallback(() => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
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
