export type ReportFocusDirection = "forward" | "backward";

// The viewer is cross-origin: its authenticated bridge requests an exit, and
// only the dashboard chooses which of its own controls receives focus.
export function focusOutsideLiveReport(frame: HTMLIFrameElement, direction: ReportFocusDirection) {
  const candidates = Array.from(frame.ownerDocument.querySelectorAll<HTMLElement>(
    'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]'
  )).filter(element => element !== frame && element.tabIndex >= 0 &&
    !element.matches(':disabled,[data-live-report-focus-guard]') &&
    !element.closest('[inert],[hidden]') && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden");
  if (direction === "backward") candidates.reverse();
  const relation = direction === "forward" ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
  const next = candidates.find(element => frame.compareDocumentPosition(element) & relation);
  if (next) {
    next.focus();
    return;
  }
  // At the end of the entire page, hand focus to the outer boundary so the
  // next native Tab can reach browser chrome instead of looping in the viewer.
  const boundary = frame.parentElement?.querySelector<HTMLElement>(
    `[data-live-report-focus-guard="${direction === "forward" ? "backward" : "forward"}"]`
  );
  if (boundary) {
    boundary.dataset.reportFocusExit = "true";
    boundary.focus();
    delete boundary.dataset.reportFocusExit;
  }
}
