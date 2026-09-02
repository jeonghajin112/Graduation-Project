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

export const LIVE_REPORT_PROTOCOL_VERSION = 1 as const;
export const LIVE_REPORT_DASHBOARD_SOURCE = "accessibility-dashboard-live-report" as const;
export const LIVE_REPORT_PAGE_SOURCE = "accessibility-page-live-report" as const;

const LIVE_REPORT_TOKEN_MAX_LENGTH = 256;
const LIVE_REPORT_DOCUMENT_TOKEN_MAX_LENGTH = 128;

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
  source: typeof LIVE_REPORT_PAGE_SOURCE;
  type: "ACK";
  protocolVersion: typeof LIVE_REPORT_PROTOCOL_VERSION;
  bridgeSecret: string;
  challenge: string;
  documentToken: string;
  sequence: number;
};

export type LiveReportPortEventMessage = {
  source: typeof LIVE_REPORT_PAGE_SOURCE;
  type: "EVENT";
  protocolVersion: typeof LIVE_REPORT_PROTOCOL_VERSION;
  bridgeSecret: string;
  challenge: string;
  documentToken: string;
  sequence: number;
  payload: PageReplayToDashboardMessage;
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

type ParseLiveReportPortMessageOptions = {
  session: Pick<LiveReportSession, "bridgeSecret">;
  challenge: string;
  expectedSequence: number;
  expectedDocumentToken: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isUrlSafeToken(value: unknown, maximumLength = LIVE_REPORT_TOKEN_MAX_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isDocumentToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LIVE_REPORT_DOCUMENT_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseLiveReportBridgeAvailableMessage(
  value: unknown,
  expectedSessionId: string
): LiveReportBridgeAvailableMessage | null {
  if (
    !isRecord(value) ||
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

export function parseLiveReportSessionExhaustedMessage(
  value: unknown,
  session: Pick<LiveReportSession, "sessionId" | "bridgeSecret">
): LiveReportSessionExhaustedMessage | null {
  if (
    !isRecord(value) ||
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
    const expiresAt = Date.parse(session.expiresAt);
    return (
      runtimeUrl.username.length === 0 &&
      runtimeUrl.password.length === 0 &&
      runtimeUrl.origin === session.viewerOrigin &&
      isLiveReportViewerOriginAllowed(session.viewerOrigin, viewerBaseUrl) &&
      session.viewerOrigin !== dashboardOrigin &&
      isUrlSafeToken(session.nonce) &&
      isUrlSafeToken(session.bridgeSecret) &&
      session.bridgeSecret !== session.nonce &&
      Number.isFinite(expiresAt) &&
      expiresAt > now
    );
  } catch {
    return false;
  }
}

export function createLiveReportChallenge(
  cryptoSource: Pick<Crypto, "getRandomValues"> = globalThis.crypto
): string {
  if (!cryptoSource || typeof cryptoSource.getRandomValues !== "function") {
    throw new Error("A cryptographically secure random source is required for live reports.");
  }
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

export function parseLiveReportPortMessage(
  value: unknown,
  {
    session,
    challenge,
    expectedSequence,
    expectedDocumentToken
  }: ParseLiveReportPortMessageOptions
): LiveReportPortMessage | null {
  if (
    !isRecord(value) ||
    value.source !== LIVE_REPORT_PAGE_SOURCE ||
    value.protocolVersion !== LIVE_REPORT_PROTOCOL_VERSION ||
    value.bridgeSecret !== session.bridgeSecret ||
    value.challenge !== challenge ||
    !isSequence(value.sequence) ||
    value.sequence !== expectedSequence ||
    !isDocumentToken(value.documentToken)
  ) {
    return null;
  }

  if (
    value.type === "ACK" &&
    expectedDocumentToken === null &&
    hasExactOwnKeys(value, [
      "source",
      "type",
      "protocolVersion",
      "bridgeSecret",
      "challenge",
      "documentToken",
      "sequence"
    ])
  ) {
    return {
      source: LIVE_REPORT_PAGE_SOURCE,
      type: "ACK",
      protocolVersion: LIVE_REPORT_PROTOCOL_VERSION,
      bridgeSecret: session.bridgeSecret,
      challenge,
      documentToken: value.documentToken,
      sequence: value.sequence
    };
  }

  if (
    value.type !== "EVENT" ||
    expectedDocumentToken === null ||
    value.documentToken !== expectedDocumentToken ||
    !hasExactOwnKeys(value, [
      "source",
      "type",
      "protocolVersion",
      "bridgeSecret",
      "challenge",
      "documentToken",
      "sequence",
      "payload"
    ])
  ) {
    return null;
  }

  const payload = parsePageReplayMessage(value.payload);
  if (!payload || payload.documentToken !== value.documentToken) {
    return null;
  }

  return {
    source: LIVE_REPORT_PAGE_SOURCE,
    type: "EVENT",
    protocolVersion: LIVE_REPORT_PROTOCOL_VERSION,
    bridgeSecret: session.bridgeSecret,
    challenge,
    documentToken: value.documentToken,
    sequence: value.sequence,
    payload
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
