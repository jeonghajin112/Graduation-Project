import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLiveReportExpiration, createTestLiveReportSession } from "./live-report-viewer-fixture.mjs";

describe("live report fixture expiration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the fixture valid past a result-cache refresh without overflowing browser timers", () => {
    const now = Date.parse("2026-09-09T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const remaining = Date.parse(createTestLiveReportSession(501).expiresAt) - now;
    expect(remaining).toBeGreaterThan(61_000 + 30_000);
    expect(remaining).toBeLessThan(2 ** 31 - 1);
  });

  it("extends the previous expiration even when renewal happens before expiry", () => {
    const session = createTestLiveReportSession(501);
    const previous = Date.parse(session.expiresAt);
    const renewed = Date.parse(createTestLiveReportExpiration(previous));
    expect(renewed).toBeGreaterThan(previous);
    expect(renewed - Date.now()).toBeLessThan(2 ** 31 - 1);
  });
});
