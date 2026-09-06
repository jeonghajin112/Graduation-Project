import type { LiveReportSession } from "@/types/accessibility-domain";

import { isLiveReportSessionSafe } from "./live-report-protocol";

export const LIVE_REPORT_SESSION_EXPIRY_GUARD_MS = 5_000;
export const LIVE_REPORT_SESSION_REFRESH_LEAD_MS = 30_000;

const LIVE_REPORT_SESSION_REFRESH_RETRY_MIN_MS = 1_000;
const LIVE_REPORT_SESSION_REFRESH_RETRY_MAX_MS = 5_000;

function getSessionExpirationTime(session: Pick<LiveReportSession, "expiresAt">): number | null {
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

export function isLiveReportSessionSafelyUsable(
  session: LiveReportSession,
  dashboardOrigin: string,
  now = Date.now()
): boolean {
  return isLiveReportSessionSafe(
    session,
    dashboardOrigin,
    now + LIVE_REPORT_SESSION_EXPIRY_GUARD_MS
  );
}

export function isSameLiveReportSessionRenewal(
  previousSession: LiveReportSession,
  renewedSession: LiveReportSession
): boolean {
  const previousExpiresAt = getSessionExpirationTime(previousSession);
  const renewedExpiresAt = getSessionExpirationTime(renewedSession);
  return (
    previousSession.sessionId === renewedSession.sessionId &&
    previousSession.runtimeUrl === renewedSession.runtimeUrl &&
    previousSession.viewerOrigin === renewedSession.viewerOrigin &&
    previousSession.nonce === renewedSession.nonce &&
    previousSession.bridgeSecret === renewedSession.bridgeSecret &&
    previousExpiresAt !== null &&
    renewedExpiresAt !== null &&
    renewedExpiresAt > previousExpiresAt
  );
}

export function getLiveReportSessionRefreshDelay(
  session: Pick<LiveReportSession, "expiresAt">,
  now = Date.now()
): number | null {
  const expiresAt = getSessionExpirationTime(session);
  if (expiresAt === null) {
    return null;
  }
  return Math.max(0, expiresAt - LIVE_REPORT_SESSION_REFRESH_LEAD_MS - now);
}

export function getLiveReportSessionRefreshRetryDelay(
  session: LiveReportSession,
  dashboardOrigin: string,
  now = Date.now()
): number | null {
  if (!isLiveReportSessionSafelyUsable(session, dashboardOrigin, now)) {
    return null;
  }

  const expiresAt = getSessionExpirationTime(session);
  if (expiresAt === null) {
    return null;
  }
  const safelyUsableFor = expiresAt - LIVE_REPORT_SESSION_EXPIRY_GUARD_MS - now;
  if (safelyUsableFor <= 0) {
    return null;
  }
  if (safelyUsableFor <= LIVE_REPORT_SESSION_REFRESH_RETRY_MIN_MS) {
    return safelyUsableFor;
  }

  return Math.min(
    LIVE_REPORT_SESSION_REFRESH_RETRY_MAX_MS,
    Math.max(
      LIVE_REPORT_SESSION_REFRESH_RETRY_MIN_MS,
      Math.floor(safelyUsableFor / 2)
    )
  );
}
