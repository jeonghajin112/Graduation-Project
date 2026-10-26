import type { LiveReportSession } from "@/types/accessibility-domain";
import {
  LIVE_REPORT_VIEWER_BASE_URL,
  isLiveReportViewerOriginAllowed
} from "@/config/live-report";

import {
  parsePageReplayMessage,
  type DashboardToPageReplayMessage,
  type PageReplayToDashboardMessage
} from "./page-replay-protocol";
import { hasExactOwnKeys, isDocumentToken, isPlainRecord } from "@/lib/guards";

export const LIVE_REPORT_PROTOCOL_VERSION = 1 as const;
export const LIVE_REPORT_DASHBOARD_SOURCE = "accessibility-dashboard-live-report" as const;
export const LIVE_REPORT_PAGE_SOURCE = "accessibility-page-live-report" as const;

const LIVE_REPORT_TOKEN_MAX_LENGTH = 256;
export type LiveReportConnectMessage = {
  source: typeof LIVE_REPORT_DASHBOARD_SOURCE;
  type: "CONNECT";
  protocolVersion: typeof LIVE_REPORT_PROTOCOL_VERSION;
  bridgeSecret: string;
  challenge: string;
};

export type LiveReportBridgeAvailableMessage = {
  source: typeof LIVE_REPORT_PAGE_SOURCE;
  type: "AVAILABLE";
  protocolVersion: typeof LIVE_REPORT_PROTOCOL_VERSION;
  sessionId: string;
  documentToken: string;
};

export type LiveReportSessionExhaustedMessage = {
  source: typeof LIVE_REPORT_PAGE_SOURCE;
  type: "SESSION_EXHAUSTED";
  protocolVersion: typeof LIVE_REPORT_PROTOCOL_VERSION;
  sessionId: string;
  bridgeSecret: string;
  reason: "budget-exceeded" | "expired";
};

export type LiveReportPortAckMessage = {
  type: "ACK";
  documentToken: string;
};

export type LiveReportPortEventMessage = {
  type: "EVENT";
  documentToken: string;
  /** Null for an event this dashboard does not understand. */
  payload: PageReplayToDashboardMessage | null;
};

export type LiveReportPortCommandMessage = {
  source: typeof LIVE_REPORT_DASHBOARD_SOURCE;
  type: "COMMAND";
  protocolVersion: typeof LIVE_REPORT_PROTOCOL_VERSION;
  bridgeSecret: string;
  challenge: string;
  documentToken: string;
  sequence: number;
  payload: DashboardToPageReplayMessage;
};

export type LiveReportPortMessage = LiveReportPortAckMessage | LiveReportPortEventMessage;

function isUrlSafeToken(value: unknown, maximumLength = LIVE_REPORT_TOKEN_MAX_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function parseLiveReportBridgeAvailableMessage(
  value: unknown,
  expectedSessionId: string
): LiveReportBridgeAvailableMessage | null {
  if (
    !isPlainRecord(value) ||
    !hasExactOwnKeys(value, [
      "source",
      "type",
      "protocolVersion",
      "sessionId",
      "documentToken"
    ]) ||
    value.source !== LIVE_REPORT_PAGE_SOURCE ||
    value.type !== "AVAILABLE" ||
    value.protocolVersion !== LIVE_REPORT_PROTOCOL_VERSION ||
    value.sessionId !== expectedSessionId ||
    !isDocumentToken(value.documentToken)
  ) {
    return null;
  }

  return {
    source: LIVE_REPORT_PAGE_SOURCE,
    type: "AVAILABLE",
    protocolVersion: LIVE_REPORT_PROTOCOL_VERSION,
    sessionId: expectedSessionId,
    documentToken: value.documentToken
  };
}

// AVAILABLE carries no secret, so any script in the proxied page can post
// it. It starts a connection when none exists, but replaces an acknowledged
// bridge only after the iframe loaded another document (the old document's
// unload already closes the port).
export function shouldConnectAnnouncedLiveBridge({
  connection,
  sessionId,
  viewerOrigin,
  documentToken,
  reconnectAllowed
}: {
  connection: { sessionId: string; viewerOrigin: string; documentToken: string | null } | null;
  sessionId: string;
  viewerOrigin: string;
  documentToken: string;
  reconnectAllowed: boolean;
}): boolean {
  if (connection?.sessionId !== sessionId) {
    return true;
  }
  if (
    connection.viewerOrigin === viewerOrigin &&
    (connection.documentToken === null || connection.documentToken === documentToken)
  ) {
    return false;
  }
  return connection.documentToken === null || reconnectAllowed;
}

export function parseLiveReportSessionExhaustedMessage(
  value: unknown,
  session: Pick<LiveReportSession, "sessionId" | "bridgeSecret">
): LiveReportSessionExhaustedMessage | null {
  if (
    !isPlainRecord(value) ||
    !hasExactOwnKeys(value, [
      "source",
      "type",
      "protocolVersion",
      "sessionId",
      "bridgeSecret",
      "reason"
    ]) ||
    value.source !== LIVE_REPORT_PAGE_SOURCE ||
    value.type !== "SESSION_EXHAUSTED" ||
    value.protocolVersion !== LIVE_REPORT_PROTOCOL_VERSION ||
    value.sessionId !== session.sessionId ||
    value.bridgeSecret !== session.bridgeSecret ||
    (value.reason !== "budget-exceeded" && value.reason !== "expired")
  ) {
    return null;
  }

  return {
    source: LIVE_REPORT_PAGE_SOURCE,
    type: "SESSION_EXHAUSTED",
    protocolVersion: LIVE_REPORT_PROTOCOL_VERSION,
    sessionId: session.sessionId,
    bridgeSecret: session.bridgeSecret,
    reason: value.reason
  };
}

export function parseLiveReportSessionExhaustedEvent(
  value: unknown,
  session: Pick<LiveReportSession, "sessionId" | "bridgeSecret" | "runtimeUrl" | "viewerOrigin">,
  candidateOrigin: string,
  viewerBaseUrl = LIVE_REPORT_VIEWER_BASE_URL
): LiveReportSessionExhaustedMessage | null {
  const message = parseLiveReportSessionExhaustedMessage(value, session);
  if (message === null) {
    return null;
  }

  try {
    getLiveReportConnectTargetOrigin(session, candidateOrigin, viewerBaseUrl);
    return message;
  } catch {
    return null;
  }
}

export function isLiveReportSessionSafe(
  session: LiveReportSession,
  dashboardOrigin: string,
  now = Date.now(),
  viewerBaseUrl = LIVE_REPORT_VIEWER_BASE_URL
): boolean {
  try {
    const runtimeUrl = new URL(session.runtimeUrl);
    return (
      runtimeUrl.username.length === 0 &&
      runtimeUrl.password.length === 0 &&
      runtimeUrl.origin === session.viewerOrigin &&
      isLiveReportViewerOriginAllowed(session.viewerOrigin, viewerBaseUrl) &&
      session.viewerOrigin !== dashboardOrigin &&
      hasDistinctLiveReportTokens(session) &&
      isLiveReportSessionUnexpired(session, now)
    );
  } catch {
    return false;
  }
}

function hasDistinctLiveReportTokens(session: Pick<LiveReportSession, "nonce" | "bridgeSecret">): boolean {
  return (
    isUrlSafeToken(session.nonce) &&
    isUrlSafeToken(session.bridgeSecret) &&
    session.bridgeSecret !== session.nonce
  );
}

function isLiveReportSessionUnexpired(session: Pick<LiveReportSession, "expiresAt">, now: number): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function createLiveReportChallenge(
  cryptoSource: Pick<Crypto, "getRandomValues"> = globalThis.crypto
): string {
  const bytes = new Uint8Array(32);
  cryptoSource.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createLiveReportConnectMessage(
  session: Pick<LiveReportSession, "bridgeSecret">,
  challenge: string
): LiveReportConnectMessage {
  return {
    source: LIVE_REPORT_DASHBOARD_SOURCE,
    type: "CONNECT",
    protocolVersion: LIVE_REPORT_PROTOCOL_VERSION,
    bridgeSecret: session.bridgeSecret,
    challenge
  };
}

export function getLiveReportConnectTargetOrigin(
  session: Pick<LiveReportSession, "runtimeUrl" | "viewerOrigin">,
  candidateOrigin = session.viewerOrigin,
  viewerBaseUrl = LIVE_REPORT_VIEWER_BASE_URL
): string {
  if (
    session.viewerOrigin === "null" ||
    !isLiveReportViewerOriginAllowed(session.viewerOrigin, viewerBaseUrl) ||
    !isLiveReportViewerOriginAllowed(candidateOrigin, viewerBaseUrl)
  ) {
    throw new Error("Live reports require a dedicated, non-opaque viewer origin.");
  }
  return candidateOrigin;
}

/**
 * Reads a message from the private port. Only the bridge holds the other end
 * and a port delivers in order, so the secret, challenge and sequence the
 * bridge repeats on every message need no second check here; the message must
 * only belong to the acknowledged document. `expectedDocumentToken` is null
 * until the bridge's ACK names it.
 */
export function parseLiveReportPortMessage(
  value: unknown,
  expectedDocumentToken: string | null
): LiveReportPortMessage | null {
  if (
    !isPlainRecord(value) ||
    value.source !== LIVE_REPORT_PAGE_SOURCE ||
    !isDocumentToken(value.documentToken)
  ) {
    return null;
  }
  if (value.type === "ACK") {
    return expectedDocumentToken === null ? { type: "ACK", documentToken: value.documentToken } : null;
  }
  if (value.type !== "EVENT" || value.documentToken !== expectedDocumentToken) {
    return null;
  }
  // An event this dashboard does not understand is skipped, not fatal.
  const payload = parsePageReplayMessage(value.payload);
  return {
    type: "EVENT",
    documentToken: value.documentToken,
    payload: payload?.documentToken === value.documentToken ? payload : null
  };
}

export function createLiveReportPortCommand(
  message: DashboardToPageReplayMessage,
  {
    session,
    challenge,
    documentToken,
    sequence
  }: {
    session: Pick<LiveReportSession, "bridgeSecret">;
    challenge: string;
    documentToken: string;
    sequence: number;
  }
): LiveReportPortCommandMessage {
  return {
    source: LIVE_REPORT_DASHBOARD_SOURCE,
    type: "COMMAND",
    protocolVersion: LIVE_REPORT_PROTOCOL_VERSION,
    bridgeSecret: session.bridgeSecret,
    challenge,
    documentToken,
    sequence,
    payload: message
  };
}
