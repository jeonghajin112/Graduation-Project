import { describe, expect, it } from "vitest";

import {
  REPLAY_SCROLLBAR_GUTTER_PX,
  getEvidenceFrameIdentity,
  getReplaySourceWidth,
  resolveEvidenceSource,
  shouldAwaitLiveDocumentHealthAfterFrameLoad
} from "./evidence-source";

describe("page evidence source selection", () => {
  it("uses only the active live session identity in the product flow", () => {
    expect(getEvidenceFrameIdentity({
      frameKind: "live",
      liveSessionId: "session-1",
      previewRuntimeUrl: null
    })).toBe("live:session-1");
    expect(getEvidenceFrameIdentity({
      frameKind: null,
      liveSessionId: "session-1",
      previewRuntimeUrl: null
    })).toBeNull();
  });

  it("keeps the landing preview adapter separate from product live sessions", () => {
    expect(getEvidenceFrameIdentity({
      frameKind: "preview",
      liveSessionId: null,
      previewRuntimeUrl: "/preview/product-replay.html"
    })).toBe("preview:/preview/product-replay.html");
  });

  it("does not restart the live health watchdog after a confirmed document loads", () => {
    expect(shouldAwaitLiveDocumentHealthAfterFrameLoad({
      confirmedDocumentToken: "document-1",
      documentToken: "document-1"
    })).toBe(false);
    expect(shouldAwaitLiveDocumentHealthAfterFrameLoad({
      confirmedDocumentToken: null,
      documentToken: "document-1"
    })).toBe(true);
    expect(shouldAwaitLiveDocumentHealthAfterFrameLoad({
      confirmedDocumentToken: null,
      documentToken: null
    })).toBe(false);
  });

  it("uses the full analyzed width for live pages", () => {
    const captureMetadata = { viewportWidthCssPx: 1280, pageWidthCssPx: 1920 };
    expect(getReplaySourceWidth(captureMetadata, "live")).toBe(
      1920 + REPLAY_SCROLLBAR_GUTTER_PX
    );
    expect(getReplaySourceWidth(null, "live")).toBe(0);
    expect(getReplaySourceWidth(captureMetadata, null)).toBe(0);
  });

  it("keeps the viewport width when the recorded page is not wider", () => {
    const captureMetadata = { viewportWidthCssPx: 1280, pageWidthCssPx: 1200 };
    expect(getReplaySourceWidth(captureMetadata, "live")).toBe(
      1280 + REPLAY_SCROLLBAR_GUTTER_PX
    );
  });

  it("waits for the live session and never selects a stored fallback", () => {
    expect(resolveEvidenceSource({
      hasLiveSession: false,
      hasPreviewRuntime: false,
      liveSessionFailed: false,
      liveSessionLoadState: "loading"
    })).toEqual({ frameKind: null, loadState: "loading" });
  });

  it("uses a ready live session", () => {
    expect(resolveEvidenceSource({
      hasLiveSession: true,
      hasPreviewRuntime: false,
      liveSessionFailed: false,
      liveSessionLoadState: "ready"
    })).toEqual({ frameKind: "live", loadState: "ready" });
  });

  it.each(["unavailable", "error"] as const)(
    "shows a live-only error when session creation is %s",
    (liveSessionLoadState) => {
      expect(resolveEvidenceSource({
        hasLiveSession: false,
        hasPreviewRuntime: false,
        liveSessionFailed: false,
        liveSessionLoadState
      })).toEqual({ frameKind: null, loadState: "error" });
    }
  );

  it("shows a live-only error after the iframe handshake fails", () => {
    expect(resolveEvidenceSource({
      hasLiveSession: true,
      hasPreviewRuntime: false,
      liveSessionFailed: true,
      liveSessionLoadState: "ready"
    })).toEqual({ frameKind: null, loadState: "error" });
  });
});
