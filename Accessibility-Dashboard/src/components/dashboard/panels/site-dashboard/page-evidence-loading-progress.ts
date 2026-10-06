import type { EvidenceFrameKind } from "./evidence-source";

export type PageEvidenceLoadingPhase =
  | "request-started"
  | "source-ready"
  | "frame-loaded"
  | "bridge-connected"
  | "document-ready"
  | "complete";

const PHASE_ORDER: readonly PageEvidenceLoadingPhase[] = [
  "request-started",
  "source-ready",
  "frame-loaded",
  "bridge-connected",
  "document-ready",
  "complete"
];

const PREVIEW_PHASES: readonly PageEvidenceLoadingPhase[] = [
  "request-started",
  "source-ready",
  "frame-loaded",
  "complete"
];

export function advancePageEvidenceLoadingPhase(
  current: PageEvidenceLoadingPhase,
  next: PageEvidenceLoadingPhase
): PageEvidenceLoadingPhase {
  return PHASE_ORDER.indexOf(next) > PHASE_ORDER.indexOf(current) ? next : current;
}

export function getPageEvidenceLoadingProgress(
  phase: PageEvidenceLoadingPhase,
  frameKind: Exclude<EvidenceFrameKind, null>
): {
  completedSteps: number;
  totalSteps: number;
  value: number;
} {
  const phases = frameKind === "live" ? PHASE_ORDER : PREVIEW_PHASES;
  const currentRank = PHASE_ORDER.indexOf(phase);
  const completedSteps = phases.reduce(
    (count, candidate) => count + Number(PHASE_ORDER.indexOf(candidate) <= currentRank),
    0
  );

  return {
    completedSteps,
    totalSteps: phases.length,
    value: completedSteps / phases.length
  };
}
