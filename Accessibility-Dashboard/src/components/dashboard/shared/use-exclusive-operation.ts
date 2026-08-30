import { useCallback, useEffect, useRef } from "react";

export type ExclusiveOperationId = symbol;

export function useExclusiveOperation() {
  const isMountedRef = useRef(false);
  const activeOperationIdRef = useRef<ExclusiveOperationId | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeOperationIdRef.current = null;
    };
  }, []);

  const isOperationLocked = useCallback(
    () => activeOperationIdRef.current !== null,
    []
  );

  const beginOperation = useCallback(
    (label: string): ExclusiveOperationId | null => {
      if (activeOperationIdRef.current !== null) {
        return null;
      }

      const operationId = Symbol(label);
      activeOperationIdRef.current = operationId;
      return operationId;
    },
    []
  );

  const isOperationCurrent = useCallback(
    (operationId: ExclusiveOperationId) =>
      isMountedRef.current && activeOperationIdRef.current === operationId,
    []
  );

  const finishOperation = useCallback((operationId: ExclusiveOperationId) => {
    if (activeOperationIdRef.current !== operationId) {
      return false;
    }

    activeOperationIdRef.current = null;
    return isMountedRef.current;
  }, []);

  const cancelOperation = useCallback(() => {
    activeOperationIdRef.current = null;
  }, []);

  return {
    beginOperation,
    cancelOperation,
    finishOperation,
    isOperationCurrent,
    isOperationLocked
  };
}
