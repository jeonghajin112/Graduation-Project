import { describe, expect, it } from "vitest";

import type { LiveReportSession } from "@/types/accessibility-domain";

import {
  LIVE_REPORT_SESSION_EXPIRY_GUARD_MS,
  LIVE_REPORT_SESSION_REFRESH_LEAD_MS,
  getLiveReportSessionRefreshDelay,
  getLiveReportSessionRefreshRetryDelay,
  isSameLiveReportSessionRenewal,
  isLiveReportSessionSafelyUsable
} from "./live-report-session-policy";

const NOW = Date.parse("2026-09-02T00:00:00.000Z");
const DASHBOARD_ORIGIN = "https://dashboard.example.test";
const VIEWER_ORIGIN = `http://${"a1".repeat(20)}.localhost:9090`;

function createSession(expiresInMs: number): LiveReportSession {
  return {
    sessionId: "session_501",
    runtimeUrl: `${VIEWER_ORIGIN}/reports/session_501`,
    viewerOrigin: VIEWER_ORIGIN,
    nonce: "n".repeat(32),
    bridgeSecret: "s".repeat(43),
    expiresAt: new Date(NOW + expiresInMs).toISOString()
  };
}

describe("live report session refresh policy", () => {
  it("applies the five-second safety guard to sessions returned by the server", () => {
    expect(isLiveReportSessionSafelyUsable(
      createSession(LIVE_REPORT_SESSION_EXPIRY_GUARD_MS + 1),
      DASHBOARD_ORIGIN,
      NOW
    )).toBe(true);
    expect(isLiveReportSessionSafelyUsable(
      createSession(LIVE_REPORT_SESSION_EXPIRY_GUARD_MS),
      DASHBOARD_ORIGIN,
      NOW
    )).toBe(false);
  });

  it("starts a background refresh thirty seconds before expiration", () => {
    expect(getLiveReportSessionRefreshDelay(createSession(120_000), NOW)).toBe(
      120_000 - LIVE_REPORT_SESSION_REFRESH_LEAD_MS
    );
    expect(getLiveReportSessionRefreshDelay(createSession(20_000), NOW)).toBe(0);
    expect(getLiveReportSessionRefreshDelay({ expiresAt: "not-a-date" }, NOW)).toBeNull();
  });

  it("accepts only a same-identity renewal with a later expiration", () => {
    const previousSession = createSession(120_000);
    const renewedSession = {
      ...previousSession,
      expiresAt: new Date(NOW + 300_000).toISOString()
    };

    expect(isSameLiveReportSessionRenewal(previousSession, renewedSession)).toBe(true);
    expect(isSameLiveReportSessionRenewal(previousSession, {
      ...renewedSession,
      sessionId: "session_502"
    })).toBe(false);
    expect(isSameLiveReportSessionRenewal(previousSession, {
      ...renewedSession,
      bridgeSecret: "x".repeat(43)
    })).toBe(false);
    expect(isSameLiveReportSessionRenewal(previousSession, previousSession)).toBe(false);
  });

  it("bounds refresh retries and stops retrying once the old session is no longer safe", () => {
    expect(getLiveReportSessionRefreshRetryDelay(
      createSession(35_000),
      DASHBOARD_ORIGIN,
      NOW
    )).toBe(5_000);
    expect(getLiveReportSessionRefreshRetryDelay(
      createSession(6_500),
      DASHBOARD_ORIGIN,
      NOW
    )).toBe(1_000);
    expect(getLiveReportSessionRefreshRetryDelay(
      createSession(5_500),
      DASHBOARD_ORIGIN,
      NOW
    )).toBe(500);
    expect(getLiveReportSessionRefreshRetryDelay(
      createSession(5_000),
      DASHBOARD_ORIGIN,
      NOW
    )).toBeNull();
  });
});
