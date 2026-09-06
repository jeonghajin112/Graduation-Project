import { useCallback } from "react";

import { useCancellationScope } from "./use-cancellation-scope";
import {
  useExclusiveOperation,
  type ExclusiveOperationId
} from "./use-exclusive-operation";

export type MutationOperation = {
  id: ExclusiveOperationId;
  signal: AbortSignal;
};

/**
 * Gives every recoverable mutation one owner for its lock, AbortController,
 * and mounted/current-operation guard.
 */
export function useMutationOperation() {
  const { beginScope, cancelScope } = useCancellationScope();
  const {
    beginOperation,
    cancelOperation,
    finishOperation,
    isOperationCurrent,
    isOperationLocked
  } = useExclusiveOperation();

  const beginMutationOperation = useCallback(
    (label: string): MutationOperation | null => {
      const id = beginOperation(label);
      if (id === null) {
        return null;
      }
      return { id, signal: beginScope() };
    },
    [beginOperation, beginScope]
  );

  const cancelMutationOperation = useCallback(() => {
    cancelOperation();
    cancelScope();
  }, [cancelOperation, cancelScope]);

  const finishMutationOperation = useCallback(
    (operation: MutationOperation): boolean => {
      const didFinish = finishOperation(operation.id);
      if (didFinish) {
        cancelScope();
      }
      return didFinish;
    },
    [cancelScope, finishOperation]
  );

  const isMutationOperationCurrent = useCallback(
    (operation: MutationOperation): boolean => isOperationCurrent(operation.id),
    [isOperationCurrent]
  );

  return {
    beginMutationOperation,
    cancelMutationOperation,
    finishMutationOperation,
    isMutationOperationCurrent,
    isMutationOperationLocked: isOperationLocked
  };
}
