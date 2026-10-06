import { useCallback, useEffect, useRef } from "react";

export type MutationOperation = {
  id: symbol;
  signal: AbortSignal;
};

/**
 * Gives every recoverable mutation one owner for its lock, AbortController,
 * and mounted/current-operation guard.
 */
export function useMutationOperation() {
  const isMountedRef = useRef(false);
  const activeOperationRef = useRef<{ id: symbol; controller: AbortController } | null>(null);

  const cancelMutationOperation = useCallback(() => {
    const active = activeOperationRef.current;
    activeOperationRef.current = null;
    active?.controller.abort();
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelMutationOperation();
    };
  }, [cancelMutationOperation]);

  const beginMutationOperation = useCallback(
    (label: string): MutationOperation | null => {
      if (activeOperationRef.current !== null) {
        return null;
      }
      const active = { id: Symbol(label), controller: new AbortController() };
      activeOperationRef.current = active;
      return { id: active.id, signal: active.controller.signal };
    },
    []
  );

  const finishMutationOperation = useCallback(
    (operation: MutationOperation): boolean => {
      // A cancelled operation may finish after its replacement has started.
      // Only the current owner may release the lock and abort its requests.
      if (activeOperationRef.current?.id !== operation.id) return false;
      cancelMutationOperation();
      return isMountedRef.current;
    },
    [cancelMutationOperation]
  );

  const isMutationOperationCurrent = useCallback(
    (operation: MutationOperation): boolean =>
      isMountedRef.current && activeOperationRef.current?.id === operation.id,
    []
  );

  const isMutationOperationLocked = useCallback(() => activeOperationRef.current !== null, []);

  return {
    beginMutationOperation,
    cancelMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent,
    isMutationOperationLocked
  };
}
