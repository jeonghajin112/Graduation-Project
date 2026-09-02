import { describe, expect, it } from "vitest";

import {
  REPLAY_SCROLLBAR_GUTTER_PX,
  getReplaySourceWidth,
  resolveEvidenceSource
} from "./evidence-source";

describe("page evidence source selection", () => {
  it("uses the full analyzed width for live pages and artifacts", () => {
    const artifact = { viewportWidthCssPx: 1280, pageWidthCssPx: 1920 };

    expect(getReplaySourceWidth(artifact, "live")).toBe(
      1920 + REPLAY_SCROLLBAR_GUTTER_PX
    );
    expect(getReplaySourceWidth(artifact, "artifact")).toBe(
      1920 + REPLAY_SCROLLBAR_GUTTER_PX
    );
    expect(getReplaySourceWidth(null, "live")).toBe(0);
    expect(getReplaySourceWidth(artifact, null)).toBe(0);
  });

  it("keeps the viewport width when the recorded page is not wider", () => {
    const artifact = { viewportWidthCssPx: 1280, pageWidthCssPx: 1200 };

    expect(getReplaySourceWidth(artifact, "live")).toBe(
      1280 + REPLAY_SCROLLBAR_GUTTER_PX
    );
    expect(getReplaySourceWidth(artifact, "artifact")).toBe(
      1280 + REPLAY_SCROLLBAR_GUTTER_PX
    );
  });

  it("waits for the preferred live session even when an artifact is already cached", () => {
    expect(resolveEvidenceSource({
      artifactLoadState: "ready",
      hasArtifact: true,
      hasLiveSession: false,
      liveSessionFailed: false,
      liveSessionLoadState: "loading"
    })).toEqual({
      frameKind: null,
      loadState: "loading",
      usesLiveSession: false,
      waitsForLiveSession: true
    });
  });

  it("uses a ready live session before the stored artifact", () => {
    expect(resolveEvidenceSource({
      artifactLoadState: "ready",
      hasArtifact: true,
      hasLiveSession: true,
      liveSessionFailed: false,
      liveSessionLoadState: "ready"
    }).frameKind).toBe("live");
  });

  it.each(["unavailable", "error"] as const)(
    "falls back to the artifact when live session creation is %s",
    (liveSessionLoadState) => {
      expect(resolveEvidenceSource({
        artifactLoadState: "ready",
        hasArtifact: true,
        hasLiveSession: false,
        liveSessionFailed: false,
        liveSessionLoadState
      }).frameKind).toBe("artifact");
    }
  );

  it("falls back after a live iframe handshake failure without hiding artifact loading", () => {
    expect(resolveEvidenceSource({
      artifactLoadState: "loading",
      hasArtifact: false,
      hasLiveSession: true,
      liveSessionFailed: true,
      liveSessionLoadState: "ready"
    })).toMatchObject({ frameKind: null, loadState: "loading" });

    expect(resolveEvidenceSource({
      artifactLoadState: "ready",
      hasArtifact: true,
      hasLiveSession: true,
      liveSessionFailed: true,
      liveSessionLoadState: "ready"
    }).frameKind).toBe("artifact");
  });

  it("shows an error when both a failed live frame and an artifact fallback are unavailable", () => {
    expect(resolveEvidenceSource({
      artifactLoadState: "empty",
      hasArtifact: false,
      hasLiveSession: true,
      liveSessionFailed: true,
      liveSessionLoadState: "ready"
    }).loadState).toBe("error");
  });
});
