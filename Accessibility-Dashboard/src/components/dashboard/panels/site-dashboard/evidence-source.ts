import type { EvaluationArtifact } from "@/types/accessibility-domain";

import type { EvaluationArtifactLoadState } from "./use-evaluation-artifact";
import type { LiveReportSessionLoadState } from "./use-live-report-session";

export type EvidenceFrameKind = "artifact" | "live" | null;

// Keep this in sync with the replay document's root scrollbar width. It is
// part of the logical iframe width before the dashboard applies its fit scale.
export const REPLAY_SCROLLBAR_GUTTER_PX = 10;

export function getReplaySourceWidth(
  artifact: Pick<EvaluationArtifact, "pageWidthCssPx" | "viewportWidthCssPx"> | null,
  frameKind: EvidenceFrameKind
): number {
  if (artifact === null || frameKind === null) {
    return 0;
  }

  // Preserve the complete analyzed canvas for both sources. Some pages render
  // content wider than the nominal viewport; fitting only the viewport hides
  // that right-hand content once the replay's horizontal scrollbar is removed.
  const pageWidth = Math.max(
    artifact.viewportWidthCssPx,
    artifact.pageWidthCssPx
  );
  return pageWidth + REPLAY_SCROLLBAR_GUTTER_PX;
}

export function resolveEvidenceSource({
  artifactLoadState,
  hasArtifact,
  hasLiveSession,
  liveSessionFailed,
  liveSessionLoadState
}: {
  artifactLoadState: EvaluationArtifactLoadState;
  hasArtifact: boolean;
  hasLiveSession: boolean;
  liveSessionFailed: boolean;
  liveSessionLoadState: LiveReportSessionLoadState;
}): {
  frameKind: EvidenceFrameKind;
  loadState: EvaluationArtifactLoadState;
  usesLiveSession: boolean;
  waitsForLiveSession: boolean;
} {
  const usesLiveSession =
    liveSessionLoadState === "ready" && hasLiveSession && !liveSessionFailed;
  const waitsForLiveSession = liveSessionLoadState === "loading";
  const liveFailureHasNoFallback =
    (liveSessionLoadState === "error" || liveSessionFailed) &&
    !hasArtifact &&
    (artifactLoadState === "idle" || artifactLoadState === "empty");
  const loadState: EvaluationArtifactLoadState = usesLiveSession
    ? "ready"
    : waitsForLiveSession
      ? "loading"
      : liveFailureHasNoFallback
        ? "error"
        : artifactLoadState;
  const frameKind = loadState === "ready"
    ? usesLiveSession
      ? "live"
      : hasArtifact
        ? "artifact"
        : null
    : null;

  return { frameKind, loadState, usesLiveSession, waitsForLiveSession };
}
