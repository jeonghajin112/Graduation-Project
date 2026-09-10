import { describe, expect, it } from "vitest";

import type { LiveReportSession } from "@/types/accessibility-domain";

import {
  LIVE_REPORT_DASHBOARD_SOURCE,
  LIVE_REPORT_PAGE_SOURCE,
  createLiveReportChallenge,
  createLiveReportConnectMessage,
  createLiveReportPortCommand,
  getLiveReportConnectTargetOrigin,
  isLiveReportSessionSafe,
  parseLiveReportBridgeAvailableMessage,
  parseLiveReportSessionExhaustedEvent,
  parseLiveReportSessionExhaustedMessage,
  parseLiveReportPortMessage
} from "./live-report-protocol";
import { DASHBOARD_REPLAY_SOURCE, PAGE_REPLAY_SOURCE } from "./page-replay-protocol";

const ROUTE_LABEL = "a1".repeat(20);
const VIEWER_BASE_URL = "https://replay.example.test";
const VIEWER_ORIGIN = `https://${ROUTE_LABEL}.replay.example.test`;
const session: LiveReportSession = {
  sessionId: "session_501",
  runtimeUrl: `${VIEWER_ORIGIN}/reports/session_501`,
  viewerOrigin: VIEWER_ORIGIN,
  nonce: "n".repeat(32),
  bridgeSecret: "s".repeat(43),
  expiresAt: "2099-01-01T00:00:00Z"
};
const challenge = "c".repeat(64);
const documentToken = "document_501";

function createAck(overrides: Record<string, unknown> = {}) {
  return {
    source: LIVE_REPORT_PAGE_SOURCE,
    type: "ACK",
    protocolVersion: 1,
    bridgeSecret: session.bridgeSecret,
    challenge,
    documentToken,
    sequence: 1,
    ...overrides
  };
}

function createReadyEvent(overrides: Record<string, unknown> = {}) {
  return {
    source: LIVE_REPORT_PAGE_SOURCE,
    type: "EVENT",
    protocolVersion: 1,
    bridgeSecret: session.bridgeSecret,
    challenge,
    documentToken,
    sequence: 2,
    payload: {
      source: PAGE_REPLAY_SOURCE,
      type: "READY",
      documentToken
    },
    ...overrides
  };
}

describe("blocked form port boundary", () => {
  const event = createReadyEvent({ payload: {
    source: PAGE_REPLAY_SOURCE, type: "FORM_BLOCKED", documentToken, method: "POST"
  } });
  const options = { session, challenge, expectedSequence: 2, expectedDocumentToken: documentToken };

  it("consumes a valid notification while preserving the next event's sequence", () => {
    expect(parseLiveReportPortMessage(event, options)?.type).toBe("EVENT");
    expect(parseLiveReportPortMessage(createReadyEvent({ sequence: 3 }), {
      ...options, expectedSequence: 3
    })?.type).toBe("EVENT");
  });

  it.each([
    { sequence: 1 }, { sequence: 3 }, { challenge: "other" }, { bridgeSecret: "other" },
    { documentToken: "other" }, { protocolVersion: 2 }, { extra: true }
  ])("does not relax authentication, identity, or ordering: %j", (override) => {
    expect(parseLiveReportPortMessage({ ...event, ...override }, options)).toBeNull();
  });
});

describe("live report session boundary", () => {
  it("requires the configured route origin, separate secrets, and an unexpired session", () => {
    const dashboardOrigin = "https://dashboard.example.test";
    expect(isLiveReportSessionSafe(session, dashboardOrigin, 0, VIEWER_BASE_URL)).toBe(true);
    expect(isLiveReportSessionSafe(session, session.viewerOrigin, 0, VIEWER_BASE_URL)).toBe(false);
    expect(isLiveReportSessionSafe(
      { ...session, viewerOrigin: "null" },
      dashboardOrigin,
      0,
      VIEWER_BASE_URL
    )).toBe(false);
    expect(isLiveReportSessionSafe(
      { ...session, bridgeSecret: session.nonce },
      dashboardOrigin,
      0,
      VIEWER_BASE_URL
    )).toBe(false);
    expect(isLiveReportSessionSafe(
      session,
      dashboardOrigin,
      Date.parse(session.expiresAt),
      VIEWER_BASE_URL
    )).toBe(false);
  });

  it("rejects route-label, credential, protocol, and runtime-origin pivots", () => {
    const dashboardOrigin = "https://dashboard.example.test";
    for (const candidate of [
      {
        ...session,
        viewerOrigin: "https://replay.example.test",
        runtimeUrl: "https://replay.example.test/report"
      },
      {
        ...session,
        runtimeUrl: `https://user:password@${ROUTE_LABEL}.replay.example.test/report`
      },
      {
        ...session,
        viewerOrigin: `http://${ROUTE_LABEL}.replay.example.test`,
        runtimeUrl: `http://${ROUTE_LABEL}.replay.example.test/report`
      },
      {
        ...session,
        runtimeUrl: `https://${"b2".repeat(20)}.replay.example.test/report`
      }
    ]) {
      expect(isLiveReportSessionSafe(candidate, dashboardOrigin, 0, VIEWER_BASE_URL)).toBe(false);
    }
  });

  it("creates a cryptographically sourced, URL-safe challenge", () => {
    let requestedBytes = 0;
    const result = createLiveReportChallenge({
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as Uint8Array;
        requestedBytes = bytes.length;
        bytes.fill(0xab);
        return array;
      }
    });

    expect(requestedBytes).toBe(32);
    expect(result).toBe("ab".repeat(32));
  });

  it("builds the exact CONNECT envelope", () => {
    expect(createLiveReportConnectMessage(session, challenge)).toEqual({
      source: LIVE_REPORT_DASHBOARD_SOURCE,
      type: "CONNECT",
      protocolVersion: 1,
      bridgeSecret: session.bridgeSecret,
      challenge
    });
  });

  it("accepts only an exact bridge-availability signal for the active session", () => {
    const available = {
      source: LIVE_REPORT_PAGE_SOURCE,
      type: "AVAILABLE",
      protocolVersion: 1,
      sessionId: session.sessionId,
      documentToken
    };
    expect(parseLiveReportBridgeAvailableMessage(available, session.sessionId)).toEqual(available);
    expect(parseLiveReportBridgeAvailableMessage(
      { ...available, sessionId: "other-session" },
      session.sessionId
    )).toBeNull();
    expect(parseLiveReportBridgeAvailableMessage(
      { ...available, unexpected: true },
      session.sessionId
    )).toBeNull();
    expect(parseLiveReportBridgeAvailableMessage(
      { ...available, documentToken: "contains whitespace" },
      session.sessionId
    )).toBeNull();
  });

  it("accepts only an authenticated exhaustion signal for the active session", () => {
    const exhausted = {
      source: LIVE_REPORT_PAGE_SOURCE,
      type: "SESSION_EXHAUSTED",
      protocolVersion: 1,
      sessionId: session.sessionId,
      bridgeSecret: session.bridgeSecret,
      reason: "budget-exceeded"
    };
    expect(parseLiveReportSessionExhaustedMessage(exhausted, session)).toEqual(exhausted);
    expect(parseLiveReportSessionExhaustedMessage(
      { ...exhausted, reason: "expired" },
      session
    )).toMatchObject({ reason: "expired" });

    for (const value of [
      { ...exhausted, sessionId: "other-session" },
      { ...exhausted, bridgeSecret: "x".repeat(43) },
      { ...exhausted, reason: "unknown" },
      { ...exhausted, protocolVersion: 2 },
      { ...exhausted, unexpected: true }
    ]) {
      expect(parseLiveReportSessionExhaustedMessage(value, session)).toBeNull();
    }
  });

  it("accepts exhaustion from a redirected isolated viewer origin without trusting other origins", () => {
    const redirectedOrigin = `https://${"b2".repeat(20)}.replay.example.test`;
    const exhausted = {
      source: LIVE_REPORT_PAGE_SOURCE,
      type: "SESSION_EXHAUSTED",
      protocolVersion: 1,
      sessionId: session.sessionId,
      bridgeSecret: session.bridgeSecret,
      reason: "budget-exceeded"
    };

    expect(parseLiveReportSessionExhaustedEvent(
      exhausted,
      session,
      redirectedOrigin,
      VIEWER_BASE_URL
    )).toEqual(exhausted);
    expect(parseLiveReportSessionExhaustedEvent(
      exhausted,
      session,
      "https://attacker.example.test",
      VIEWER_BASE_URL
    )).toBeNull();
    expect(parseLiveReportSessionExhaustedEvent(
      { ...exhausted, bridgeSecret: "x".repeat(43) },
      session,
      redirectedOrigin,
      VIEWER_BASE_URL
    )).toBeNull();
  });

  it("uses only the exact isolated viewer origin", () => {
    expect(getLiveReportConnectTargetOrigin(session, undefined, VIEWER_BASE_URL)).toBe(
      session.viewerOrigin
    );
    expect(() => getLiveReportConnectTargetOrigin({ ...session, viewerOrigin: "null" }))
      .toThrow("dedicated, non-opaque viewer origin");
  });

  it("allows a same-session navigation to another isolated viewer route", () => {
    const navigatedOrigin = `https://${"b2".repeat(20)}.replay.example.test`;
    expect(getLiveReportConnectTargetOrigin(
      session,
      navigatedOrigin,
      VIEWER_BASE_URL
    )).toBe(navigatedOrigin);

    for (const candidateOrigin of [
      "https://replay.example.test",
      "https://attacker.example.test",
      `http://${"b2".repeat(20)}.replay.example.test`,
      "null"
    ]) {
      expect(() => getLiveReportConnectTargetOrigin(
        session,
        candidateOrigin,
        VIEWER_BASE_URL
      )).toThrow("dedicated, non-opaque viewer origin");
    }
  });

  it("accepts ACK sequence 1 only when every authentication field and key matches", () => {
    expect(parseLiveReportPortMessage(createAck(), {
      session,
      challenge,
      expectedSequence: 1,
      expectedDocumentToken: null
    })).toEqual(createAck());

    for (const value of [
      createAck({ bridgeSecret: "x".repeat(43) }),
      createAck({ challenge: "x".repeat(64) }),
      createAck({ sequence: 2 }),
      createAck({ protocolVersion: 2 }),
      createAck({ documentToken: "contains whitespace" }),
      createAck({ unexpected: true })
    ]) {
      expect(parseLiveReportPortMessage(value, {
        session,
        challenge,
        expectedSequence: 1,
        expectedDocumentToken: null
      })).toBeNull();
    }
  });

  it("unwraps only the next EVENT for the acknowledged document token", () => {
    expect(parseLiveReportPortMessage(createReadyEvent(), {
      session,
      challenge,
      expectedSequence: 2,
      expectedDocumentToken: documentToken
    })).toEqual(createReadyEvent());

    for (const value of [
      createReadyEvent({ sequence: 3 }),
      createReadyEvent({ documentToken: "other_document" }),
      createReadyEvent({
        payload: { source: PAGE_REPLAY_SOURCE, type: "READY", documentToken: "other_document" }
      }),
      createReadyEvent({
        payload: { source: PAGE_REPLAY_SOURCE, type: "READY", documentToken, extra: true }
      }),
      createReadyEvent({ unexpected: true })
    ]) {
      expect(parseLiveReportPortMessage(value, {
        session,
        challenge,
        expectedSequence: 2,
        expectedDocumentToken: documentToken
      })).toBeNull();
    }
  });

  it("wraps commands with an independent parent sequence", () => {
    const payload = {
      source: DASHBOARD_REPLAY_SOURCE,
      type: "FOCUS_ISSUE" as const,
      issueId: 42
    };
    expect(createLiveReportPortCommand(payload, {
      session,
      challenge,
      documentToken,
      sequence: 1
    })).toEqual({
      source: LIVE_REPORT_DASHBOARD_SOURCE,
      type: "COMMAND",
      protocolVersion: 1,
      bridgeSecret: session.bridgeSecret,
      challenge,
      documentToken,
      sequence: 1,
      payload
    });
  });
});
