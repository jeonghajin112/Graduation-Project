import { describe, expect, it } from "vitest";

import {
  isLiveReportViewerOriginAllowed,
  parseLiveReportViewerBase,
  resolveLiveReportViewerBaseUrl
} from "./live-report";

const ROUTE_LABEL = "a1".repeat(20);

describe("live report viewer configuration", () => {
  it("defaults to the local replay gateway", () => {
    expect(resolveLiveReportViewerBaseUrl(undefined)).toBe("http://localhost:9090");
    expect(resolveLiveReportViewerBaseUrl("   ")).toBe("http://localhost:9090");
    expect(resolveLiveReportViewerBaseUrl(" https://replay.example.test ")).toBe(
      "https://replay.example.test"
    );
    expect(parseLiveReportViewerBase("http://localhost:9090")).toEqual({
      hostname: "localhost",
      port: "9090",
      protocol: "http:"
    });
  });

  it("accepts HTTPS viewer bases and the explicit localhost HTTP exception", () => {
    expect(parseLiveReportViewerBase("https://replay.example.test")).toEqual({
      hostname: "replay.example.test",
      port: "",
      protocol: "https:"
    });
    expect(parseLiveReportViewerBase("http://localhost:9090")).not.toBeNull();
  });

  it.each([
    "http://replay.example.test",
    "http://127.0.0.1:9090",
    "https://user@replay.example.test",
    "https://replay.example.test/path",
    "https://replay.example.test?mode=live",
    "https://replay.example.test#viewer",
    "not a URL"
  ])("rejects an unsafe viewer base: %s", (value) => {
    expect(parseLiveReportViewerBase(value)).toBeNull();
  });

  it("requires exactly one 40-hex route label before the configured hostname", () => {
    const baseUrl = "https://replay.example.test";
    expect(isLiveReportViewerOriginAllowed(
      `https://${ROUTE_LABEL}.replay.example.test`,
      baseUrl
    )).toBe(true);

    for (const origin of [
      "https://replay.example.test",
      `https://nested.${ROUTE_LABEL}.replay.example.test`,
      `https://${ROUTE_LABEL.slice(1)}.replay.example.test`,
      `https://${ROUTE_LABEL}0.replay.example.test`,
      `https://${"g".repeat(40)}.replay.example.test`,
      `https://${ROUTE_LABEL}.replay.example.test.attacker.test`
    ]) {
      expect(isLiveReportViewerOriginAllowed(origin, baseUrl)).toBe(false);
    }
  });

  it("requires the configured protocol and port and an origin-only credential-free URL", () => {
    const baseUrl = "https://replay.example.test:8443";
    for (const origin of [
      `http://${ROUTE_LABEL}.replay.example.test:8443`,
      `https://${ROUTE_LABEL}.replay.example.test`,
      `https://user@${ROUTE_LABEL}.replay.example.test:8443`,
      `https://${ROUTE_LABEL}.replay.example.test:8443/path`,
      `https://${ROUTE_LABEL}.replay.example.test:8443?query=1`,
      `https://${ROUTE_LABEL}.replay.example.test:8443#fragment`
    ]) {
      expect(isLiveReportViewerOriginAllowed(origin, baseUrl)).toBe(false);
    }
  });
});
