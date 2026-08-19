import { useCallback, useEffect, useRef } from "react";

/**
 * Ties async work to the lifetime of the calling component.
 *
 * `beginScope()` returns a fresh AbortSignal and cancels any previous scope, so
 * a second submit never races the first one. The signal is aborted on unmount,
 * which stops in-flight fetches and the polling sleeps between them.
 */
export function useCancellationScope() {
  const controllerRef = useRef<AbortController | null>(null);

  const beginScope = useCallback((): AbortSignal => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  }, []);

  const cancelScope = useCallback((): void => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    []
  );

  return { beginScope, cancelScope };
}
