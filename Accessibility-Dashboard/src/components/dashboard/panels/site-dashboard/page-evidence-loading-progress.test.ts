import { describe, expect, it } from "vitest";

import {
  advancePageEvidenceLoadingPhase,
  getPageEvidenceLoadingProgress
} from "./page-evidence-loading-progress";

describe("page evidence loading progress", () => {
  it("maps live loading milestones to the completed real workflow stages", () => {
    expect(getPageEvidenceLoadingProgress("request-started", "live")).toEqual({
      completedSteps: 1,
      totalSteps: 6,
      value: 1 / 6
    });
    expect(getPageEvidenceLoadingProgress("bridge-connected", "live")).toEqual({
      completedSteps: 4,
      totalSteps: 6,
      value: 4 / 6
    });
    expect(getPageEvidenceLoadingProgress("complete", "live")).toEqual({
      completedSteps: 6,
      totalSteps: 6,
      value: 1
    });
  });

  it("skips secure live-only stages for the isolated landing preview fixture", () => {
    expect(getPageEvidenceLoadingProgress("request-started", "preview")).toEqual({
      completedSteps: 1,
      totalSteps: 4,
      value: 1 / 4
    });
    expect(getPageEvidenceLoadingProgress("frame-loaded", "preview")).toEqual({
      completedSteps: 3,
      totalSteps: 4,
      value: 3 / 4
    });
    expect(getPageEvidenceLoadingProgress("complete", "preview")).toEqual({
      completedSteps: 4,
      totalSteps: 4,
      value: 1
    });
  });

  it("never moves backward for late messages from the same document", () => {
    expect(advancePageEvidenceLoadingPhase("document-ready", "frame-loaded"))
      .toBe("document-ready");
    expect(advancePageEvidenceLoadingPhase("frame-loaded", "bridge-connected"))
      .toBe("bridge-connected");
  });
});
