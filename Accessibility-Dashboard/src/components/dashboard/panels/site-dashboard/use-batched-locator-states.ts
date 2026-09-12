import { useCallback, useEffect, useState } from "react";

import { LocatorStateBatch } from "./locator-state-batch";
import type { LocatorIssueState } from "./types";

function scheduleLocatorFlush(flush: () => void): () => void {
  const frame = window.requestAnimationFrame(flush);
  // Background tabs can suspend animation frames. Keep a bounded pending map
  // and a timer fallback, and flush immediately when the user returns.
  const timer = window.setTimeout(flush, 100);
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

export function useBatchedLocatorStates() {
  const [locatorStates, setLocatorStates] = useState<Map<number, LocatorIssueState>>(() => new Map());
  const [batch] = useState(() => new LocatorStateBatch(setLocatorStates, scheduleLocatorFlush));

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") batch.flush();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      batch.cancelPending();
    };
  }, [batch]);

  const enqueueLocatorState = useCallback((issueId: number, state: LocatorIssueState) => {
    batch.enqueue(issueId, state);
  }, [batch]);
  const resetLocatorStates = useCallback(() => batch.reset(), [batch]);
  const cancelPendingLocatorStates = useCallback(() => batch.cancelPending(), [batch]);

  return { locatorStates, enqueueLocatorState, resetLocatorStates, cancelPendingLocatorStates };
}
