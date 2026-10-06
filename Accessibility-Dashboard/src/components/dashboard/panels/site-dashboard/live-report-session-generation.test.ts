import { describe, expect, it } from "vitest";

import { LiveReportSessionGenerationFence } from "./live-report-session-generation";

describe("live report session generation fence", () => {
  it("rejects a renewal result from before a forced fresh-session generation", () => {
    const fence = new LiveReportSessionGenerationFence();
    const renewingGeneration = fence.current(501);
    const freshGeneration = fence.advance(501);

    expect(fence.isCurrent(501, renewingGeneration)).toBe(false);
    expect(fence.isCurrent(501, freshGeneration)).toBe(true);
  });

  it("keeps generations independent per evaluation request", () => {
    const fence = new LiveReportSessionGenerationFence();
    fence.advance(501);

    expect(fence.current(501)).toBe(1);
    expect(fence.current(502)).toBe(0);
    expect(fence.isCurrent(502, 0)).toBe(true);
  });

  it("invalidates all prior generations without making generation zero current again", () => {
    const fence = new LiveReportSessionGenerationFence();
    const beforeCleanup = fence.current(501);
    fence.clear();

    expect(fence.isCurrent(501, beforeCleanup)).toBe(false);
    expect(fence.current(501)).toBe(1);
  });
});
