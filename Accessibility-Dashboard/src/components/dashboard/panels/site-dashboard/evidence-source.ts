import type { EvaluationCaptureMetadata } from "@/types/accessibility-domain";

import type { LiveReportSessionLoadState } from "./use-live-report-session";

export type EvidenceFrameKind = "live" | "preview" | null;
export type PageEvidenceLoadState = "idle" | "loading" | "ready" | "error";

export function getEvidenceFrameIdentity({
  frameKind,
  liveSessionId,
  previewRuntimeUrl
}: {
  frameKind: EvidenceFrameKind;
  liveSessionId: string | null;
  previewRuntimeUrl: string | null;
}): string | null {
  if (frameKind === "live") {
    return liveSessionId === null ? null : `live:${liveSessionId}`;
  }
  if (frameKind === "preview") {
    return previewRuntimeUrl === null ? null : `preview:${previewRuntimeUrl}`;
  }
  return null;
}

export function shouldAwaitLiveDocumentHealthAfterFrameLoad({
  confirmedDocumentToken,
  documentToken
}: {
  confirmedDocumentToken: string | null;
  documentToken: string | null;
}): boolean {
  return documentToken !== null && documentToken !== confirmedDocumentToken;
}

// Keep this in sync with the viewer document's root scrollbar width. It is
// part of the logical iframe width before the dashboard applies its fit scale.
export const REPLAY_SCROLLBAR_GUTTER_PX = 10;

export function getReplaySourceWidth(
  captureMetadata: Pick<
    EvaluationCaptureMetadata,
    "pageWidthCssPx" | "viewportWidthCssPx"
  > | null,
  frameKind: EvidenceFrameKind
): number {
  if (captureMetadata === null || frameKind === null) {
    return 0;
  }

  const pageWidth = Math.max(
    captureMetadata.viewportWidthCssPx,
    captureMetadata.pageWidthCssPx
  );
  return pageWidth + REPLAY_SCROLLBAR_GUTTER_PX;
}

export function resolveEvidenceSource({
  hasLiveSession,
  hasPreviewRuntime,
  liveSessionFailed,
  liveSessionLoadState
}: {
  hasLiveSession: boolean;
  hasPreviewRuntime: boolean;
  liveSessionFailed: boolean;
  liveSessionLoadState: LiveReportSessionLoadState;
}): {
  frameKind: EvidenceFrameKind;
  loadState: PageEvidenceLoadState;
} {
  if (hasPreviewRuntime) {
    return { frameKind: "preview", loadState: "ready" };
  }
  if (liveSessionLoadState === "ready" && hasLiveSession && !liveSessionFailed) {
    return { frameKind: "live", loadState: "ready" };
  }
  if (liveSessionLoadState === "idle") {
    return { frameKind: null, loadState: "idle" };
  }
  if (liveSessionLoadState === "loading") {
    return { frameKind: null, loadState: "loading" };
  }
  return { frameKind: null, loadState: "error" };
}
