import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { installApiRouteFixture } from "./fixtures/api-route-fixture.mjs";
import { createTestLiveReportExpiration } from "./fixtures/live-report-viewer-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const outDir = process.env.OUT_DIR ?? "artifacts/page-evidence";
const verificationScope = process.env.PAGE_EVIDENCE_SCOPE?.trim() || "full";
const capturedAt = "2026-08-11T03:30:00.000Z";
const FALLBACK_DETAIL_SELECTOR = ".site-page-evidence-fallback-detail";

assert.ok(
  verificationScope === "core" || verificationScope === "full" || verificationScope === "scale",
  `PAGE_EVIDENCE_SCOPE must be "core", "full", or "scale": ${verificationScope}`
);

const organization = {
  id: 1,
  name: "페이지 재현 검증 프로젝트",
  type: "ETC",
  homepageUrl: "https://example.com/",
  description: "",
  status: "ACTIVE",
  createdAt: capturedAt,
  updatedAt: capturedAt
};

const target = {
  id: 101,
  organizationId: 1,
  name: "예제 쇼핑몰",
  targetType: "WEB",
  accessUrl: "https://example.com/",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: capturedAt,
  updatedAt: capturedAt
};

const request = {
  id: 501,
  evaluationTargetId: 101,
  targetName: target.name,
  status: "COMPLETED",
  requestNote: "DOM 재현 검증",
  requestedAt: capturedAt,
  createdAt: capturedAt,
  updatedAt: capturedAt
};

const summary = {
  requestId: 501,
  targetName: target.name,
  status: "COMPLETED",
  totalScore: 72,
  totalIssueCount: 4,
  criticalIssueCount: 1,
  requestedAt: capturedAt
};

const scoreResult = {
  id: 1,
  evaluationRequestId: 501,
  totalScore: 72,
  ruleScore: 68,
  aiScore: 76,
  cvScore: 72,
  createdAt: capturedAt,
  updatedAt: capturedAt
};

const locator = (selector, htmlSnippet) => ({
  kind: "DOM_PATH",
  pathSteps: [{ context: "DOCUMENT", selector, frameUrl: null }],
  x: null,
  y: null,
  width: null,
  height: null,
  coordinateSpace: null,
  visible: true,
  htmlSnippet
});

const issues = [
  {
    id: 9001,
    requestId: 501,
    module: "rule_based",
    severity: "CRITICAL",
    title: "검색 버튼의 대체 이름이 없습니다",
    description: "버튼에 스크린리더가 읽을 수 있는 이름이 필요합니다. 좁은 화면에서도 상세 설명의 모든 한글 문장이 잘리지 않고 자연스럽게 줄바꿈되어야 합니다. 사용자는 문제의 원인과 개선 방법을 도중에 내부 스크롤 없이 확인할 수 있어야 합니다. ".repeat(6),
    recommendation: "aria-label 또는 화면에 보이는 텍스트를 제공하고, 의미가 명확한지 키보드와 스크린리더로 함께 확인하세요.",
    selector: "#search-button",
    locator: locator("#search-button", '<button id="search-button">검색</button>'),
    wcagCode: "5.1.1",
    createdAt: capturedAt
  },
  {
    id: 9002,
    requestId: 501,
    module: "rule_based",
    severity: "SERIOUS",
    title: "검색 영역의 명도 대비가 낮습니다",
    description: "텍스트와 배경의 명도 대비가 기준보다 낮습니다.",
    recommendation: "텍스트와 배경 색상 간 대비를 높이세요.",
    selector: "#search-copy",
    locator: locator("#search-copy", '<p id="search-copy">상품을 찾아보세요</p>'),
    wcagCode: "5.4.3",
    createdAt: capturedAt
  },
  {
    id: 9003,
    requestId: 501,
    module: "rule_based",
    severity: "MODERATE",
    title: "사라진 배너 제목 구조가 올바르지 않습니다",
    description: "현재 재현 DOM에는 이 요소가 없습니다.",
    recommendation: "제목 단계를 순서대로 구성하세요.",
    selector: "#missing-promotion-title",
    locator: {
      ...locator("#missing-promotion-title", '<h4 id="missing-promotion-title">오늘의 혜택</h4>'),
      x: 48, y: 960, width: 320, height: 44, coordinateSpace: "DOCUMENT_CSS_PX"
    },
    wcagCode: "2.4.6",
    createdAt: capturedAt
  },
  {
    id: 9004,
    requestId: 501,
    module: "text_difficulty",
    severity: "MINOR",
    title: "읽기 수준",
    description: [
      "text=건축학부 제70회 졸업 전시회 개최",
      'flags=["어려운 어휘 과다: 쉬운 단어 비율 40.0%"]',
      "suggestions=어려운 표현을 쉬운 단어로 바꾸세요.",
      'llm_revision={"revised_text":"건축학부 졸업 전시회가 열립니다.","reason":"짧고 쉬운 문장으로 바꿨습니다.","model":"internal-model"}'
    ].join("\n"),
    recommendation: null,
    selector: null,
    locator: null,
    wcagCode: "3.1.5",
    createdAt: capturedAt
  }
];

const captureMetadata = {
  id: 77,
  requestId: 501,
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  capturedAt,
  viewportWidthCssPx: 1280,
  viewportHeightCssPx: 720,
  deviceScaleFactor: 1,
  pageWidthCssPx: 1280,
  pageHeightCssPx: 1600
};

const viewerOrigin = `http://${"a".repeat(40)}.localhost:9090`;
const liveSession = {
  sessionId: "session_501",
  runtimeUrl: `${viewerOrigin}/api/live-reports/session_501/document/live_nonce_501`,
  viewerOrigin,
  nonce: "n".repeat(32),
  bridgeSecret: "s".repeat(43),
  expiresAt: createTestLiveReportExpiration()
};

const replayHtml = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>예제 쇼핑몰 재현</title>
    <style>
      * { box-sizing: border-box; }
      html { scrollbar-gutter: auto; }
      @supports not selector(::-webkit-scrollbar) {
        html { scrollbar-width: thin; scrollbar-color: rgba(99,99,102,.78) transparent; }
        @media (forced-colors: active) { html { scrollbar-width: auto; scrollbar-color: auto; } }
      }
      @supports selector(::-webkit-scrollbar) {
        html::-webkit-scrollbar { width: 10px; height: 10px; }
        html::-webkit-scrollbar-track, html::-webkit-scrollbar-corner { background: transparent; }
        html::-webkit-scrollbar-thumb { min-height: 48px; border: 1px solid transparent; border-radius: 999px; background: rgba(99,99,102,.78); background-clip: padding-box; }
        html::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
      }
      body { margin: 0; min-height: 900px; background: #f4f6f9; color: #18202b; font-family: Arial, sans-serif; }
      header { padding: 22px 28px; background: #fff; border-bottom: 1px solid #dfe4ea; font-weight: 800; }
      main { display: grid; gap: 22px; padding: 28px; }
      section { border-radius: 18px; padding: 28px; background: #fff; box-shadow: 0 10px 28px rgba(22, 32, 45, .08); }
      #search-copy { color: #a7acb2; }
      #search-button { min-height: 44px; padding: 0 20px; border: 0; border-radius: 8px; background: #f1644a; color: #fff; }
      a { color: #174ea6; }
      :root { --replay-overlay-inverse-scale: 1; --replay-visual-width: 100vw; }
      #replay-markers { position: fixed; inset: 0; z-index: 10000; pointer-events: none; }
      .replay-marker { position: fixed; z-index: 10001; width: 24px; height: 24px; border: 2px solid #fff; border-radius: 999px; background: #d73535; color: #fff; font-weight: 800; pointer-events: auto; box-shadow: 0 4px 12px rgba(0,0,0,.3); transform: scale(var(--replay-overlay-inverse-scale)); transform-origin: top left; }
      .replay-marker[data-issue-id="9001"] { left: 34px; top: 120px; }
      .replay-marker[data-issue-id="9002"] { left: calc(34px + 44px * var(--replay-overlay-inverse-scale)); top: 120px; background: #e77922; }
      /* Keep the fixture tooltip below the marker at every outer iframe scale.
         Its full border box must fit the reported visual viewport. */
      .replay-marker-description { box-sizing: border-box; position: fixed; left: 32px; top: calc(120px + 32px * var(--replay-overlay-inverse-scale)); z-index: 10002; width: min(320px, calc(var(--replay-visual-width) - 24px)); padding: 10px; border: 1px solid #cbd3dc; border-radius: 8px; background: #fff; color: #18202b; font: 400 13px/13px Arial, sans-serif; transform: scale(var(--replay-overlay-inverse-scale)); transform-origin: top left; }
      .replay-marker-description__text { display: block; height: 13px; overflow: hidden; white-space: nowrap; }
      [data-replay-selected="true"] { outline: 4px solid #1378d1 !important; outline-offset: 4px; }
    </style>
  </head>
  <body>
    <header>EXAMPLE STORE</header>
    <main>
      <section>
        <h1>새로운 상품을 만나보세요</h1>
        <p id="search-copy">상품을 찾아보세요</p>
        <button id="search-button" type="button">검색</button>
      </section>
      <section>
        <h2>인기 상품</h2>
        <p>재현된 DOM 안의 버튼과 링크를 직접 조작할 수 있습니다.</p>
        <a id="blocked-link" href="https://example.com/next">다음 상품 보기</a>
      </section>
    </main>
    <div id="replay-markers" aria-label="접근성 문제 위치"></div>
    <script>
      (() => {
        const DASHBOARD_SOURCE = "accessibility-dashboard";
        const VIEWER_SOURCE = "accessibility-page-replay";
        const LIVE_DASHBOARD_SOURCE = "accessibility-dashboard-live-report";
        const LIVE_VIEWER_SOURCE = "accessibility-page-live-report";
        const SESSION_ID = "session_501";
        const BRIDGE_SECRET = "${"s".repeat(43)}";
        const PROTOCOL_VERSION = 1;
        const HOLD_READY = __HOLD_READY__;
        const HOLD_LOCATOR_STATUS = __HOLD_LOCATOR_STATUS__;
        const DROP_INITIAL_LOADING = __DROP_INITIAL_LOADING__;
        const DOCUMENT_TOKEN = "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
        const messages = [];
        const outboundMessages = [];
        const state = {
          issues: [],
          selectedIssueId: null,
          markersVisible: true,
          viewScale: 1,
          visualWidth: window.innerWidth
        };
        let activeMarkerPreview = null;
        let markerPreviewClearFrame = 0;
        let documentUnloadingSent = false;
        let readySent = false;
        let activeChallenge = null;
        let inboundSequence = 0;
        let outboundSequence = 1;
        let livePort = null;
        let holdNextConnectAck = false;
        const pendingEvents = [];
        const pendingLocatorStatuses = [];
        window.__releaseLocatorStatuses = (count = pendingLocatorStatuses.length) => {
          pendingLocatorStatuses.splice(0, count).forEach(send);
        };
        window.__replayMessages = messages;
        window.__replayOutboundMessages = outboundMessages;
        window.__replayDocumentToken = DOCUMENT_TOKEN;
        // Any script in the proxied page can post this without the secret.
        window.__postForgedAvailable = () => parent.postMessage({
          source: LIVE_VIEWER_SOURCE, type: "AVAILABLE", protocolVersion: PROTOCOL_VERSION,
          sessionId: SESSION_ID, documentToken: DOCUMENT_TOKEN + "_forged"
        }, "*");
        window.__reconnectWithoutAck = () => {
          livePort?.close();
          livePort = null;
          holdNextConnectAck = true;
          parent.postMessage({
            source: LIVE_VIEWER_SOURCE, type: "AVAILABLE", protocolVersion: PROTOCOL_VERSION,
            sessionId: SESSION_ID, documentToken: DOCUMENT_TOKEN + "_replacement"
          }, "*");
        };

        function send(message) {
          const outbound = { ...message, documentToken: DOCUMENT_TOKEN };
          outboundMessages.push(JSON.parse(JSON.stringify(outbound)));
          if (!livePort) {
            pendingEvents.push(outbound);
            return;
          }
          livePort.postMessage({
            source: LIVE_VIEWER_SOURCE,
            type: "EVENT",
            protocolVersion: PROTOCOL_VERSION,
            bridgeSecret: BRIDGE_SECRET,
            challenge: activeChallenge,
            documentToken: DOCUMENT_TOKEN,
            sequence: ++outboundSequence,
            payload: { source: VIEWER_SOURCE, ...outbound }
          });
        }
        window.__sendReplayTestMessage = (message) => send(message);
        window.__sendRawReplayTestMessage = (message) => {
          outboundMessages.push(JSON.parse(JSON.stringify(message)));
          if (!livePort) return;
          livePort.postMessage({
            source: LIVE_VIEWER_SOURCE,
            type: "EVENT",
            protocolVersion: PROTOCOL_VERSION,
            bridgeSecret: BRIDGE_SECRET,
            challenge: activeChallenge,
            documentToken: DOCUMENT_TOKEN,
            sequence: ++outboundSequence,
            payload: { source: VIEWER_SOURCE, ...message }
          });
        };

        function sendDocumentLoading() {
          send({ type: "DOCUMENT_LOADING", documentToken: DOCUMENT_TOKEN });
        }

        function sendDocumentUnloading() {
          if (documentUnloadingSent) return;
          documentUnloadingSent = true;
          send({ type: "DOCUMENT_UNLOADING", documentToken: DOCUMENT_TOKEN });
        }

        function sendReady() {
          if (readySent) return;
          readySent = true;
          send({ type: "READY", documentToken: DOCUMENT_TOKEN });
          send({
            type: "DOCUMENT_HEALTH",
            status: "MEANINGFUL",
            consecutiveMeaningfulSamples: 1,
            visibleControlCount: 2,
            visibleElementCount: 12,
            visibleImageCount: 0,
            largestVisibleVisualArea: 24_000,
            visibleTextLength: 120
          });
        }

        window.__sendReplayReady = sendReady;
        if (!DROP_INITIAL_LOADING) sendDocumentLoading();
        addEventListener("pagehide", sendDocumentUnloading, { once: true });

        function resolveIssue(issue) {
          if (!Array.isArray(issue.pathSteps) || issue.pathSteps.length === 0) return null;
          let current = document;
          try {
            for (const step of issue.pathSteps) {
              if (step.context !== "DOCUMENT" || typeof step.selector !== "string") return null;
              current = current.querySelector(step.selector);
              if (!current) return null;
            }
            return current instanceof Element ? current : null;
          } catch {
            return null;
          }
        }

        function focusIssue(issueId, moveFocus = false) {
          document.querySelectorAll("[data-replay-selected]").forEach((element) => element.removeAttribute("data-replay-selected"));
          document.querySelectorAll(".replay-marker").forEach((marker) => {
            marker.setAttribute("aria-pressed", marker.dataset.issueId === String(issueId) ? "true" : "false");
          });
          const issue = state.issues.find((candidate) => candidate.id === issueId);
          if (!issue) return;
          const target = resolveIssue(issue);
          if (target) {
            target.setAttribute("data-replay-selected", "true");
            if (moveFocus) target.scrollIntoView({ block: "center" });
          }
        }

        function selectIssue(issueId) {
          if (state.selectedIssueId === issueId) return;
          state.selectedIssueId = issueId;
          focusIssue(issueId, false);
          send({ type: "ISSUE_SELECTED", issueId });
        }

        function previewIssue(marker, issueId, pointerType = "") {
          if (pointerType === "touch" || marker.hidden || !marker.isConnected) return;
          if (markerPreviewClearFrame) cancelAnimationFrame(markerPreviewClearFrame);
          markerPreviewClearFrame = 0;
          activeMarkerPreview = issueId;
          selectIssue(issueId);
        }

        function endPreview(issueId, pointerType = "") {
          if (pointerType === "touch" || activeMarkerPreview !== issueId || markerPreviewClearFrame) return;
          markerPreviewClearFrame = requestAnimationFrame(() => {
            markerPreviewClearFrame = 0;
            if (activeMarkerPreview !== issueId || state.selectedIssueId !== issueId) return;
            activeMarkerPreview = null;
            selectIssue(null);
          });
        }

        function clearMarkerDescription(marker) {
          const descriptionId = marker.getAttribute("aria-describedby");
          marker.removeAttribute("aria-describedby");
          if (descriptionId) document.getElementById(descriptionId)?.remove();
        }

        function showMarkerDescription(marker, issue) {
          document.querySelectorAll(".replay-marker[aria-describedby]").forEach((candidate) => {
            clearMarkerDescription(candidate);
          });
          document.querySelectorAll("[data-replay-marker-description]").forEach((description) => description.remove());
          const description = document.createElement("div");
          description.id = "replay-marker-description-" + issue.id;
          description.className = "replay-marker-description";
          description.dataset.replayMarkerDescription = "true";
          const text = document.createElement("span");
          text.className = "replay-marker-description__text";
          text.textContent = issue.message;
          description.append(text);
          document.body.append(description);
          marker.setAttribute("aria-describedby", description.id);
        }

        function applyViewScale(message) {
          const scale = message.scale;
          const visualWidth = message.visualWidth;
          if (
            !Number.isFinite(scale)
            || scale < 0.01
            || scale > 1
            || !Number.isFinite(visualWidth)
            || visualWidth <= 0
            || visualWidth > 16384
          ) return;
          state.viewScale = scale;
          state.visualWidth = visualWidth;
          document.documentElement.style.setProperty("--replay-overlay-inverse-scale", String(1 / scale));
          document.documentElement.style.setProperty("--replay-visual-width", visualWidth + "px");
        }

        function renderMarkers() {
          if (markerPreviewClearFrame) cancelAnimationFrame(markerPreviewClearFrame);
          markerPreviewClearFrame = 0;
          activeMarkerPreview = null;
          document.querySelectorAll("[data-replay-marker-description]").forEach((description) => description.remove());
          const layer = document.getElementById("replay-markers");
          layer.replaceChildren();
          for (const issue of state.issues) {
            const target = resolveIssue(issue);
            const locatorStatus = { type: "LOCATOR_STATUS", issueId: issue.id, status: target ? "CONNECTED" : "UNAVAILABLE",
              ...(!target ? { reason: issue.path ? "SELECTOR_NOT_FOUND" : "EMPTY_PATH" } : {}) };
            if (HOLD_LOCATOR_STATUS) pendingLocatorStatuses.push(locatorStatus);
            else send(locatorStatus);
            if (!target || !state.markersVisible) continue;
            const marker = document.createElement("button");
            marker.type = "button";
            marker.className = "replay-marker";
            marker.dataset.issueId = String(issue.id);
            marker.setAttribute("aria-label", issue.title + " 문제 위치");
            marker.setAttribute("aria-pressed", "false");
            marker.textContent = String(issue.id).slice(-1);
            marker.addEventListener("pointerenter", (event) => {
              previewIssue(marker, issue.id, event.pointerType);
              if (event.pointerType !== "touch") showMarkerDescription(marker, issue);
            });
            marker.addEventListener("pointerleave", (event) => {
              endPreview(issue.id, event.pointerType);
              clearMarkerDescription(marker);
            });
            marker.addEventListener("pointercancel", (event) => {
              endPreview(issue.id, event.pointerType);
            });
            marker.addEventListener("focus", () => {
              if (marker.matches(":focus-visible")) {
                previewIssue(marker, issue.id);
                showMarkerDescription(marker, issue);
              }
            });
            marker.addEventListener("blur", () => {
              endPreview(issue.id);
              clearMarkerDescription(marker);
            });
            marker.addEventListener("click", () => selectIssue(issue.id));
            layer.append(marker);
          }
          if (state.selectedIssueId !== null) focusIssue(state.selectedIssueId, false);
        }

        function handleDashboardCommand(message) {
          messages.push(JSON.parse(JSON.stringify(message)));
          if (message.type === "INIT_ISSUES" && Array.isArray(message.issues)) {
            state.issues = message.issues;
            state.selectedIssueId = Number.isSafeInteger(message.selectedIssueId) ? message.selectedIssueId : null;
            state.markersVisible = message.markersVisible !== false;
            renderMarkers();
          } else if (message.type === "REQUEST_DOCUMENT_STATE") {
            sendDocumentLoading();
            if (!HOLD_READY) sendReady();
          } else if (message.type === "FOCUS_ISSUE") {
            state.selectedIssueId = Number.isSafeInteger(message.issueId) ? message.issueId : null;
            focusIssue(state.selectedIssueId, false);
          } else if (message.type === "SET_MARKERS_VISIBLE" && typeof message.markersVisible === "boolean") {
            state.markersVisible = message.markersVisible;
            renderMarkers();
          } else if (message.type === "SET_VIEW_SCALE" && message.documentToken === DOCUMENT_TOKEN) {
            applyViewScale(message);
          }
        }

        addEventListener("message", (event) => {
          const message = event.data;
          if (event.source === parent && message?.type === "CONNECT") {
            window.__connectAttempts = (window.__connectAttempts ?? 0) + 1;
          }
          if (
            event.source !== parent ||
            !message ||
            message.source !== LIVE_DASHBOARD_SOURCE ||
            message.type !== "CONNECT" ||
            message.protocolVersion !== PROTOCOL_VERSION ||
            message.bridgeSecret !== BRIDGE_SECRET ||
            typeof message.challenge !== "string" ||
            message.challenge.length < 32 ||
            event.ports.length !== 1 ||
            livePort
          ) return;
          if (holdNextConnectAck) {
            holdNextConnectAck = false;
            window.__heldReplayConnect = { challenge: message.challenge, port: event.ports[0] };
            return;
          }
          activeChallenge = message.challenge;
          livePort = event.ports[0];
          livePort.onmessage = (portEvent) => {
            const command = portEvent.data;
            if (
              !command ||
              command.source !== LIVE_DASHBOARD_SOURCE ||
              command.type !== "COMMAND" ||
              command.protocolVersion !== PROTOCOL_VERSION ||
              command.bridgeSecret !== BRIDGE_SECRET ||
              command.challenge !== activeChallenge ||
              command.documentToken !== DOCUMENT_TOKEN ||
              command.sequence !== inboundSequence + 1
            ) return;
            inboundSequence = command.sequence;
            handleDashboardCommand(command.payload);
          };
          livePort.start();
          livePort.postMessage({
            source: LIVE_VIEWER_SOURCE,
            type: "ACK",
            protocolVersion: PROTOCOL_VERSION,
            bridgeSecret: BRIDGE_SECRET,
            challenge: activeChallenge,
            documentToken: DOCUMENT_TOKEN,
            sequence: outboundSequence
          });
          while (pendingEvents.length > 0) send(pendingEvents.shift());
        });

        const announceAvailability = () => {
          if (livePort) return;
          parent.postMessage({
            source: LIVE_VIEWER_SOURCE,
            type: "AVAILABLE",
            protocolVersion: PROTOCOL_VERSION,
            sessionId: SESSION_ID,
            documentToken: DOCUMENT_TOKEN
          }, "*");
          setTimeout(announceAvailability, 100);
        };
        announceAvailability();

        document.addEventListener("click", (event) => {
          const link = event.target.closest("a[href]");
          if (!link) return;
          event.preventDefault();
          send({ type: "LINK_BLOCKED", href: link.href });
        });

        if (!HOLD_READY && !DROP_INITIAL_LOADING) setTimeout(sendReady, 0);
      })();
    <\/script>
  </body>
</html>`;

let holdNextReplayReady = false;
let holdNextLocatorStatuses = false;
let dropNextReplayInitialLoading = false;
let nextIssueResponseGate = null;
let dashboardRequestFetchCount = 0;
let issueResponseFetchCount = 0;
const overview = createDashboardOverview({
  organizations: [organization],
  evaluationTargets: [target],
  evaluationRequests: [request],
  resultSummaries: [summary],
  scoreResults: [scoreResult],
  latestIssueCounts: [{
    evaluationTargetId: target.id,
    requestId: request.id,
    totalIssueCount: issues.length,
    criticalIssueCount: 1,
    highIssueCount: 1,
    mediumIssueCount: 1,
    lowIssueCount: 1,
    groups: issues.map((issue) => ({
      issueCode: issue.wcagCode,
      issueTitle: issue.title,
      severity: issue.severity === "SERIOUS"
        ? "HIGH"
        : issue.severity === "MODERATE"
          ? "MEDIUM"
          : issue.severity === "MINOR"
            ? "LOW"
            : "CRITICAL",
      count: 1
    }))
  }]
});

const apiFixtures = [];

async function installFixture(page) {
  let fixtureSession = liveSession;
  const fixture = await installApiRouteFixture(page, [
    ...[
      ["/api/organizations", () => [organization]],
      ["/api/organizations/1/evaluation-targets", () => [target]],
      ["/api/results/requests/501/summary", () => summary],
      ["/api/results/requests/501/capture-metadata", () => captureMetadata],
      ["/api/targets/101", () => target]
    ].map(([pathname, payload]) => ({ method: "GET", pathname, handle: (route) => fulfillJson(route, payload()) })),
    ...[
      ["/api/dashboard/overview", () => overview],
      ["/api/requests", () => [request]]
    ].map(([pathname, payload]) => ({ method: "GET", pathname, handle: (route) => {
      dashboardRequestFetchCount += 1;
      return fulfillJson(route, payload());
    } })),
    { method: "POST", pathname: "/api/results/requests/501/live-session", handle: (route) => fulfillJson(route, fixtureSession) },
    { method: "POST", pathname: `/api/results/requests/501/live-session/${liveSession.sessionId}/renew`, handle: (route) => {
      fixtureSession = { ...fixtureSession, expiresAt: createTestLiveReportExpiration(Date.parse(fixtureSession.expiresAt)) };
      return fulfillJson(route, fixtureSession);
    } },
    { method: "GET", pathname: "/api/results/requests/501/issues", handle: async (route) => {
      if (nextIssueResponseGate) {
        const gate = nextIssueResponseGate;
        nextIssueResponseGate = null;
        gate.markStarted();
        await gate.releasePromise;
      }
      issueResponseFetchCount += 1;
      await fulfillJson(route, issues);
    } },
    { method: "GET", pathname: new URL(liveSession.runtimeUrl).pathname, origin: viewerOrigin, handle: async (route) => {
      const holdReady = holdNextReplayReady;
      const holdLocatorStatuses = holdNextLocatorStatuses;
      const dropInitialLoading = dropNextReplayInitialLoading;
      holdNextReplayReady = false;
      holdNextLocatorStatuses = false;
      dropNextReplayInitialLoading = false;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: replayHtml
          .replace("__HOLD_READY__", holdReady ? "true" : "false")
          .replace("__HOLD_LOCATOR_STATUS__", holdLocatorStatuses ? "true" : "false")
          .replace("__DROP_INITIAL_LOADING__", dropInitialLoading ? "true" : "false")
      });
    } }
  ]);
  apiFixtures.push(fixture);
}

async function getReplayMessages(frame) {
  return frame.locator("html").evaluate(() => window.__replayMessages ?? []);
}

async function advanceBrowserClockPastResultCache(page) {
  await page.evaluate(() => {
    const nativeNow = Date.now.bind(Date);
    Date.now = () => nativeNow() + 61_000;
  });
}

async function waitForReplayMessage(frame, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await getReplayMessages(frame);
    const match = [...messages].reverse().find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for replay message");
}

async function waitForReplayReady(evidence) {
  await evidence
    .locator("iframe.site-page-evidence-replay-frame")
    .contentFrame()
    .locator(".replay-marker")
    .first()
    .waitFor({ state: "visible" });
}

async function waitForReplayConnectionState(evidence, expectedState, timeoutMs = 5_000) {
  const preview = evidence.locator(".site-page-evidence-preview");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await preview.getAttribute("data-connection-state") === expectedState) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for replay connection state ${expectedState}`);
}

async function waitForUnavailableLocatorCount(evidence, expectedCount, timeoutMs = 5_000, { open = true } = {}) {
  const preview = evidence.locator(".site-page-evidence-preview");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await preview.getAttribute("data-unavailable-locator-count") === String(expectedCount)) {
      if (open && expectedCount > 0) await openUnavailableGroups(evidence.page());
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for unavailable locator count ${expectedCount}`);
}

/** Groups in the off-screen list start folded; opens each so its findings can be read. */
async function openUnavailableGroups(page) {
  const folded = page.locator('.site-unavailable-locator-panel__group-toggle[aria-expanded="false"]');
  if (await folded.count() === 0) return;
  // Opening is setup, not part of what is checked: leave scroll and focus as they were.
  const scrollY = await page.evaluate(() => window.scrollY);
  while (await folded.count() > 0) await folded.first().evaluate(toggle => toggle.click());
  await page.waitForFunction(() => !document.querySelector('.site-unavailable-locator-panel__group-body[data-state="closing"]:not([hidden])'));
  await page.evaluate(y => window.scrollTo(0, y), scrollY);
}

async function waitForNewReplayDocumentToken(frame, previousToken, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = await frame.locator("html").evaluate(() => window.__replayDocumentToken ?? null);
      if (typeof token === "string" && token.length > 0 && token !== previousToken) return token;
    } catch {
      // The old execution context is expected to disappear while the iframe navigates.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a fresh replay document token");
}

async function waitForMarkerPressed(frame, issueId, expected = "true", timeoutMs = 5_000) {
  const marker = frame.locator(`[data-issue-id="${issueId}"]`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await marker.getAttribute("aria-pressed") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for marker ${issueId} aria-pressed=${expected}`);
}

async function sendReplayTestMessage(frame, message) {
  await frame.locator("html").evaluate((_, outbound) => {
    window.__sendReplayTestMessage(outbound);
  }, message);
}

async function sendRawReplayTestMessage(frame, message) {
  await frame.locator("html").evaluate((_, outbound) => {
    window.__sendRawReplayTestMessage(outbound);
  }, message);
}

async function verifyIframeReloadRecovery(page, evidence, frame, initialMessage) {
  const preview = evidence.locator(".site-page-evidence-preview");
  const initialDocumentToken = await frame.locator("html").evaluate(() => window.__replayDocumentToken);
  assert.match(initialDocumentToken, /^[A-Za-z0-9_-]{1,128}$/);

  const initialInitCount = (await getReplayMessages(frame)).filter(
    (message) => message.type === "INIT_ISSUES"
  ).length;
  assert.equal(initialInitCount, 1);

  // Invalid events on the authenticated live MessagePort deliberately fail the
  // connection closed. Protocol parser unit tests cover those cases; this
  // browser flow verifies that harmless duplicate lifecycle events from the
  // active live document do not reinitialize the marker layer.
  for (const duplicateMessage of [
    { type: "DOCUMENT_LOADING", documentToken: initialDocumentToken },
    { type: "READY", documentToken: initialDocumentToken }
  ]) {
    await sendRawReplayTestMessage(frame, duplicateMessage);
  }
  await page.waitForTimeout(80);
  assert.equal(
    await preview.getAttribute("data-connection-state"),
    "ready",
    "duplicate lifecycle messages must not change a ready connection"
  );
  assert.equal(
    (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES").length,
    initialInitCount,
    "duplicate lifecycle messages must not reinitialize markers"
  );

  await frame.locator("html").evaluate(() => {
    dispatchEvent(new Event("beforeunload", { cancelable: true }));
  });
  await page.waitForTimeout(50);
  assert.equal(
    await preview.getAttribute("data-connection-state"),
    "ready",
    "a cancellable beforeunload signal must not disconnect the active replay document"
  );

  await preview.evaluate((element) => {
    window.__replayReloadConnectionStates = [element.getAttribute("data-connection-state")];
    window.__replayReloadConnectionObserver?.disconnect();
    window.__replayReloadConnectionObserver = new MutationObserver(() => {
      window.__replayReloadConnectionStates.push(element.getAttribute("data-connection-state"));
    });
    window.__replayReloadConnectionObserver.observe(element, {
      attributes: true,
      attributeFilter: ["data-connection-state"]
    });
  });

  const requestFetchCountBeforeReload = dashboardRequestFetchCount;
  const issueFetchCountBeforeReload = issueResponseFetchCount;
  holdNextReplayReady = true;
  await frame.locator("html").evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });

  await waitForReplayConnectionState(evidence, "loading");
  await waitForUnavailableLocatorCount(evidence, 0);
  await page.locator('[data-locator-check-state="loading"]').waitFor({ state: "visible" });
  assert.equal(await page.getByText("모든 문제가 화면에 표시되고 있습니다.", { exact: true }).count(), 0);
  assert.equal(await preview.getAttribute("aria-busy"), "true");
  const freshDocumentToken = await waitForNewReplayDocumentToken(frame, initialDocumentToken);
  assert.match(freshDocumentToken, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(await frame.locator(".replay-marker").count(), 0, "markers must not survive into an unready document");
  assert.equal(
    (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES").length,
    0,
    "the replacement document must not receive INIT before its own READY"
  );
  const freshLoadingMessages = (
    await frame.locator("html").evaluate(() => window.__replayOutboundMessages)
  ).filter((message) => message.type === "DOCUMENT_LOADING");
  assert.ok(freshLoadingMessages.length >= 1, "the replacement document must announce its token before READY");
  assert.equal(
    freshLoadingMessages.every((message) => message.documentToken === freshDocumentToken),
    true,
    "all loading announcements must identify the replacement document"
  );

  // A stale document cannot emit over the replacement document's authenticated
  // port: the live envelope and payload tokens must match, otherwise the
  // connection fails closed. Keep the replacement intentionally unready here
  // and verify that the dashboard does not create a false-ready gap on its own.
  await page.waitForTimeout(80);
  assert.equal(
    await preview.getAttribute("data-connection-state"),
    "loading",
    "the replacement document must not create a false-ready gap"
  );
  assert.equal(
    (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES").length,
    0,
    "the replacement document must not initialize before READY"
  );
  const statesBeforeFreshReady = await page.evaluate(() => window.__replayReloadConnectionStates);
  const loadingIndex = statesBeforeFreshReady.indexOf("loading");
  assert.ok(loadingIndex >= 1, "the forced iframe reload must leave the initial ready state");
  assert.equal(
    statesBeforeFreshReady.slice(loadingIndex + 1).includes("ready"),
    false,
    "the connection must remain non-ready until the fresh document announces READY"
  );

  await frame.locator("html").evaluate(() => window.__sendReplayReady());
  await waitForReplayConnectionState(evidence, "ready");
  await waitForReplayReady(evidence);
  const freshMessages = await getReplayMessages(frame);
  const freshInitMessages = freshMessages.filter((message) => message.type === "INIT_ISSUES");
  const documentStateRequests = freshMessages.filter(
    (message) => message.type === "REQUEST_DOCUMENT_STATE"
  );
  assert.ok(documentStateRequests.length >= 1, "iframe onLoad must request the current document state");
  assert.deepEqual(
    documentStateRequests.at(-1),
    { source: "accessibility-dashboard", type: "REQUEST_DOCUMENT_STATE" },
    "the state request must carry no attacker-controlled payload"
  );
  assert.equal(freshInitMessages.length, 1, "a fresh document generation must receive exactly one INIT");
  assert.deepEqual(freshInitMessages[0], initialMessage, "reload recovery must replay the same dashboard state");
  assert.equal(await frame.locator(".replay-marker").count(), 2, "all connected markers must recover after reload");
  assert.equal(await frame.locator('[data-issue-id="9001"]').getAttribute("aria-pressed"), "false");
  assert.equal(await frame.locator('[data-issue-id="9002"]').getAttribute("aria-pressed"), "false");
  await waitForUnavailableLocatorCount(evidence, 2);
  assert.equal(await evidence.locator(FALLBACK_DETAIL_SELECTOR).count(), 0);
  assert.equal(
    dashboardRequestFetchCount,
    requestFetchCountBeforeReload,
    "iframe recovery must not depend on dashboard request polling"
  );
  assert.equal(
    issueResponseFetchCount,
    issueFetchCountBeforeReload,
    "iframe recovery must not depend on issue polling"
  );

  await sendReplayTestMessage(frame, { type: "READY", documentToken: freshDocumentToken });
  await page.waitForTimeout(80);
  assert.equal(
    (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES").length,
    1,
    "duplicate READY for the active document must not churn INIT"
  );
  assert.equal(await frame.locator('[data-issue-id="9001"]').getAttribute("aria-pressed"), "false");
  assert.equal(await frame.locator('[data-issue-id="9002"]').getAttribute("aria-pressed"), "false");
  assert.equal(
    await preview.getAttribute("data-unavailable-locator-count"),
    "2",
    "the recovered document must retain its locator status"
  );
  assert.equal(await evidence.locator(FALLBACK_DETAIL_SELECTOR).count(), 0);
  assert.equal(
    (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES").length,
    1,
    "duplicate READY must not mutate or reinitialize the active document"
  );
  const finalStates = await page.evaluate(() => window.__replayReloadConnectionStates);
  assert.equal(finalStates.at(-1), "ready");
  assert.equal(finalStates.includes("error"), false);
  await preview.evaluate(() => {
    window.__replayReloadConnectionObserver?.disconnect();
    delete window.__replayReloadConnectionObserver;
  });
}

async function verifyMissedInitialLoadingRecovery(page, evidence, frame, initialMessage) {
  const previousDocumentToken = await frame.locator("html").evaluate(() => window.__replayDocumentToken);
  const requestFetchCountBeforeReload = dashboardRequestFetchCount;
  const issueFetchCountBeforeReload = issueResponseFetchCount;
  dropNextReplayInitialLoading = true;

  await frame.locator("html").evaluate(() => {
    setTimeout(() => window.location.reload(), 0);
  });

  const recoveredDocumentToken = await waitForNewReplayDocumentToken(frame, previousDocumentToken);
  await waitForReplayConnectionState(evidence, "ready");
  await waitForReplayReady(evidence);

  const messages = await getReplayMessages(frame);
  const stateRequests = messages.filter((message) => message.type === "REQUEST_DOCUMENT_STATE");
  const initMessages = messages.filter((message) => message.type === "INIT_ISSUES");
  const outbound = await frame.locator("html").evaluate(() => window.__replayOutboundMessages);
  const loadingMessages = outbound.filter((message) => message.type === "DOCUMENT_LOADING");
  const readyMessages = outbound.filter((message) => message.type === "READY");

  assert.ok(stateRequests.length >= 1, "iframe onLoad must recover a missed initial loading announcement");
  assert.deepEqual(
    stateRequests.at(-1),
    { source: "accessibility-dashboard", type: "REQUEST_DOCUMENT_STATE" }
  );
  assert.deepEqual(
    loadingMessages,
    [{ type: "DOCUMENT_LOADING", documentToken: recoveredDocumentToken }],
    "the state request must recover the missing DOCUMENT_LOADING with the current token"
  );
  assert.deepEqual(
    readyMessages,
    [{ type: "READY", documentToken: recoveredDocumentToken }],
    "the state request must pair the recovered loading state with current-token READY"
  );
  assert.equal(initMessages.length, 1, "missed-loading recovery must initialize the fresh document once");
  assert.deepEqual(initMessages[0], initialMessage);
  assert.equal(await frame.locator(".replay-marker").count(), 2);
  assert.equal(dashboardRequestFetchCount, requestFetchCountBeforeReload);
  assert.equal(issueResponseFetchCount, issueFetchCountBeforeReload);
}

async function waitForNoFallbackDetail(evidence) {
  await evidence.locator(FALLBACK_DETAIL_SELECTOR).waitFor({ state: "detached" });
  assert.equal(await evidence.locator(FALLBACK_DETAIL_SELECTOR).count(), 0);
}

async function fallbackDetailFact(page, evidence) {
  const detail = evidence.locator(FALLBACK_DETAIL_SELECTOR);
  await detail.waitFor({ state: "visible" });
  return detail.evaluate((element) => {
    const rectFact = (rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    });
    const textBlock = (selector) => {
      const block = element.querySelector(selector);
      if (!block) return null;
      const style = getComputedStyle(block);
      return {
        text: block.textContent ?? "",
        clientWidth: block.clientWidth,
        clientHeight: block.clientHeight,
        scrollWidth: block.scrollWidth,
        scrollHeight: block.scrollHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        textOverflow: style.textOverflow,
        webkitLineClamp: style.getPropertyValue("-webkit-line-clamp")
      };
    };
    const preview = element.parentElement?.querySelector(".site-page-evidence-preview");
    const card = element.closest(".site-page-evidence-card");
    const column = element.closest(".site-page-evidence-replay-column");
    const detailRect = element.getBoundingClientRect();
    const previewRect = preview?.getBoundingClientRect();
    const style = getComputedStyle(element);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let finalTextNode = null;
    let finalCharacterIndex = -1;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let index = node.data.length - 1; index >= 0; index -= 1) {
        if (/\S/u.test(node.data[index])) {
          finalTextNode = node;
          finalCharacterIndex = index;
          break;
        }
      }
    }
    let finalCharacterRect = null;
    if (finalTextNode) {
      const range = document.createRange();
      range.setStart(finalTextNode, finalCharacterIndex);
      range.setEnd(finalTextNode, finalCharacterIndex + 1);
      finalCharacterRect = rectFact(range.getBoundingClientRect());
    }
    return {
      text: element.textContent ?? "",
      ariaHidden: element.getAttribute("aria-hidden"),
      role: element.getAttribute("role"),
      ariaLive: element.getAttribute("aria-live"),
      focusableCount: element.querySelectorAll(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
      ).length,
      rect: rectFact(detailRect),
      previewRect: previewRect ? rectFact(previewRect) : null,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      cardClientHeight: card?.clientHeight ?? 0,
      cardScrollHeight: card?.scrollHeight ?? 0,
      columnClientHeight: column?.clientHeight ?? 0,
      columnScrollHeight: column?.scrollHeight ?? 0,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      finalCharacterRect,
      blocks: {
        title: textBlock(".site-page-evidence-fallback-detail__title"),
        message: textBlock(".site-page-evidence-fallback-detail__message"),
        path: textBlock(".site-page-evidence-fallback-detail__path")
      }
    };
  });
}

async function assertFallbackDetail(page, evidence, issue, viewportWidth) {
  const fact = await fallbackDetailFact(page, evidence);
  assert.equal(fact.ariaHidden, "true", `${viewportWidth}px visual fallback must be hidden from AT`);
  assert.equal(fact.role, null, `${viewportWidth}px visual fallback must not duplicate tooltip semantics`);
  assert.equal(fact.ariaLive, null, `${viewportWidth}px visual fallback must not duplicate announcements`);
  assert.equal(fact.focusableCount, 0, `${viewportWidth}px visual fallback must have no focus target`);
  assert.ok(fact.previewRect, `${viewportWidth}px preview geometry must exist`);
  assert.ok(Math.abs(fact.rect.left - fact.previewRect.left) <= 1, `${viewportWidth}px fallback left alignment`);
  assert.ok(Math.abs(fact.rect.right - fact.previewRect.right) <= 1, `${viewportWidth}px fallback right alignment`);
  assert.ok(fact.rect.top >= fact.previewRect.bottom + 10, `${viewportWidth}px fallback must sit below the iframe`);
  assert.equal(fact.overflowX, "visible", `${viewportWidth}px fallback may not clip horizontally`);
  assert.equal(fact.overflowY, "visible", `${viewportWidth}px fallback may not clip vertically`);
  assert.equal(fact.maxHeight, "none", `${viewportWidth}px fallback must use natural height`);
  assert.ok(fact.scrollWidth <= fact.clientWidth + 1, `${viewportWidth}px fallback has horizontal scroll`);
  assert.ok(fact.scrollHeight <= fact.clientHeight + 1, `${viewportWidth}px fallback has vertical scroll`);
  assert.ok(fact.cardScrollHeight <= fact.cardClientHeight + 1, `${viewportWidth}px card clips the fallback`);
  assert.ok(fact.columnScrollHeight <= fact.columnClientHeight + 1, `${viewportWidth}px replay column clips the fallback`);
  assert.ok(fact.documentScrollWidth <= fact.documentClientWidth + 1, `${viewportWidth}px fallback causes page overflow`);
  assert.ok(fact.text.includes(issue.severityLabel));
  const codeLabel = /^(?:KWCAG|WCAG)\s+/i.test(issue.code)
    ? issue.code
    : (/^[0-9]+(?:[.][0-9]+)+$/.test(issue.code) ? `KWCAG ${issue.code}` : issue.code);
  assert.ok(fact.text.includes(codeLabel));
  for (const [name, expected] of [
    ["title", issue.title],
    ["message", issue.message],
    ["path", issue.path]
  ]) {
    const block = fact.blocks[name];
    if (!expected) {
      assert.equal(block, null, `${viewportWidth}px empty ${name} must not leave a block`);
      continue;
    }
    assert.ok(block, `${viewportWidth}px ${name} block must exist`);
    assert.equal(block.text, expected, `${viewportWidth}px ${name} must retain all bounded text`);
    assert.ok(block.scrollWidth <= block.clientWidth + 1, `${viewportWidth}px ${name} clips horizontally`);
    assert.ok(block.scrollHeight <= block.clientHeight + 1, `${viewportWidth}px ${name} clips vertically`);
    assert.ok(!["hidden", "clip", "auto", "scroll"].includes(block.overflowY));
    assert.notEqual(block.textOverflow, "ellipsis");
    assert.ok(block.webkitLineClamp === "none" || block.webkitLineClamp === "");
  }
  assert.ok(fact.finalCharacterRect, `${viewportWidth}px final character must have geometry`);
  assert.ok(fact.finalCharacterRect.left >= fact.rect.left - 1);
  assert.ok(fact.finalCharacterRect.right <= fact.rect.right + 1);
  assert.ok(fact.finalCharacterRect.top >= fact.rect.top - 1);
  assert.ok(fact.finalCharacterRect.bottom <= fact.rect.bottom + 1);
  return fact;
}

async function verifyNoExternalReplayControls(evidence, frame) {
  assert.equal(await evidence.getByRole("button", { name: "팝업 숨기기", exact: true }).count(), 0);
  assert.equal(await evidence.getByText("되돌리기", { exact: true }).count(), 0);
  assert.equal(await evidence.getByText("전체 복원", { exact: true }).count(), 0);
  assert.equal(await evidence.getByRole("button", { name: /애니메이션/ }).count(), 0);
  assert.equal(
    await evidence.locator(
      ".site-page-evidence-slider-controls, .site-page-evidence-slider-status, .site-page-evidence-slider-button"
    ).count(),
    0,
    "the external replay pager DOM must not exist"
  );
  assert.equal(await evidence.locator('[aria-label="슬라이드 제어"]').count(), 0);
  assert.equal(await evidence.getByRole("button", { name: "이전 슬라이드" }).count(), 0);
  assert.equal(await evidence.getByRole("button", { name: "다음 슬라이드" }).count(), 0);

  const forbiddenReplayControlMessages = (await getReplayMessages(frame)).filter((message) =>
    [
      "SET_DISMISS_MODE",
      "UNDO_HIDDEN_ELEMENT",
      "RESET_HIDDEN_ELEMENTS",
      "SLIDER_PREVIOUS",
      "SLIDER_NEXT"
    ].includes(message.type)
  );
  assert.deepEqual(
    forbiddenReplayControlMessages,
    [],
    "the dashboard must never emit popup manipulation or external carousel pager messages"
  );
}

async function verifyMetadataBeforeResultDetails(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  let markIssueResponseStarted;
  let releaseIssueResponse;
  const issueResponseStarted = new Promise((resolve) => {
    markIssueResponseStarted = resolve;
  });
  const releasePromise = new Promise((resolve) => {
    releaseIssueResponse = resolve;
  });
  nextIssueResponseGate = {
    markStarted: markIssueResponseStarted,
    releasePromise
  };
  const metadataResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/results/requests/501/capture-metadata")
  );

  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  await metadataResponse;
  await issueResponseStarted;

  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await evidence.waitFor({ state: "visible" });
  try {
    assert.equal(
      await evidence.locator("iframe.site-page-evidence-replay-frame").count(),
      0,
      "capture metadata may resolve before result details while the live viewer is not mounted"
    );
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  } finally {
    releaseIssueResponse();
  }

  await waitForReplayReady(evidence);
  const iframe = evidence.locator("iframe.site-page-evidence-replay-frame");
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  const messages = await getReplayMessages(frame);
  const scaleIndex = messages.findIndex((message) => message.type === "SET_VIEW_SCALE");
  const initMessages = messages.filter((message) => message.type === "INIT_ISSUES");
  const initIndex = messages.findIndex((message) => message.type === "INIT_ISSUES");

  assert.ok(scaleIndex >= 0, "the late-mounted replay must receive viewport metrics");
  assert.ok(initIndex > scaleIndex, "the late-mounted replay must receive scale before issues");
  assert.equal(initMessages.length, 1, "the late-mounted replay must initialize its issues exactly once");
  assert.ok(messages[scaleIndex].visualWidth > 0, "the late-mounted replay visual width must be measurable");
  assert.equal(messages[initIndex].issues.length, issues.length);
  assert.ok(
    Number.parseFloat(await iframe.getAttribute("data-replay-visual-width")) > 0,
    "the iframe must not retain the pre-mount visualWidth=0 state"
  );
  const expectedSourceWidth = Math.max(
    captureMetadata.viewportWidthCssPx,
    captureMetadata.pageWidthCssPx
  ) + 10;
  const frameFit = await evidence.evaluate((element) => {
    const preview = element.querySelector(".site-page-evidence-preview");
    const replayFrame = element.querySelector("iframe.site-page-evidence-replay-frame");
    return {
      logicalWidth: replayFrame?.clientWidth ?? 0,
      previewWidth: preview?.clientWidth ?? 0,
      visualWidth: replayFrame?.getBoundingClientRect().width ?? 0,
      scale: Number.parseFloat(replayFrame?.dataset.replayScale ?? "0")
    };
  });
  assert.equal(frameFit.logicalWidth, expectedSourceWidth);
  assert.ok(frameFit.scale > 0 && frameFit.scale < 1, "the late-mounted replay must be scaled to fit");
  assert.ok(
    Math.abs(frameFit.previewWidth - frameFit.visualWidth) <= 2,
    "the late-mounted replay must fit the preview without horizontal clipping"
  );
  assert.equal(await frame.locator(".replay-marker:not([hidden])").count(), 2);
}

async function verifyUnavailableIssueDescription(page) {
  // This 165-character message matches the backend: description is the stored
  // message and recommendation is null without a legacy suggestions= marker.
  const description = "화면에서 배너 제목이 이전보다 낮은 단계로 표시됩니다. 스크린리더 사용자는 제목 목록으로 페이지를 탐색하므로 중간 단계를 건너뛰면 문서의 구조를 파악하기 어렵습니다. 관련 내용을 확인하고 페이지의 제목 계층을 순서대로 구성해 주세요. 권장사항: 제목은 h1 다음에 h2, h3 순서로 사용하세요.";
  const detailPage = await page.context().browser().newPage();
  const results = [];
  try {
    await installFixture(detailPage);
    await detailPage.route("**/api/results/requests/501/issues", route =>
      fulfillJson(route, issues.map(issue => issue.id === 9003
        ? { ...issue, description, recommendation: null }
        : issue)));
    await detailPage.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
    const evidence = detailPage.getByRole("article", { name: "페이지 검사 화면" });
    await waitForReplayReady(evidence);
    await waitForUnavailableLocatorCount(evidence, 2);
    for (const viewport of [{ width: 390, height: 668 }, { width: 1280, height: 720 }]) {
      await detailPage.setViewportSize(viewport);
      const card = detailPage.locator('.site-unavailable-locator-panel__issue[data-issue-id="9003"]');
      // Each finding is one line; the line itself opens its details.
      const open = card.locator(".site-unavailable-locator-panel__line");
      const before = await card.evaluate(card => ({ height: card.getBoundingClientRect().height,
        ids: [...card.parentElement.children].map(issue => issue.getAttribute("data-issue-id")) }));
      await open.focus();
      await detailPage.keyboard.press("Enter");
      const dialog = detailPage.getByRole("dialog", { name: "문제 상세", exact: true });
      await dialog.waitFor({ state: "visible" });
      const explanation = dialog.getByRole("region", { name: "문제 설명", exact: true });
      assert.equal(await explanation.count(), 1, "unavailable issues must offer their full explanation in the details dialog");
      // The details split the description into labelled rows; every sentence,
      // the final remediation included, must still be there in full.
      const explanationText = (await explanation.textContent()).replace(/\s+/g, " ");
      for (const sentence of description.split(/(?<=[다요]\.)\s+/)) {
        assert.ok(explanationText.includes(sentence.replace(/^권장사항:\s*/, "")),
          `the details must keep every sentence of the description: ${sentence}`);
      }
      const body = dialog.getByRole("region", { name: "문제 상세 내용", exact: true });
      await body.focus();
      await detailPage.keyboard.press("Home");
      const geometry = await explanation.evaluate(region => {
        const blocks = [...region.querySelectorAll("dd, p")];
        return { horizontalOverflow: Math.max(...blocks.map(block => block.scrollWidth - block.clientWidth)),
          verticalOverflow: Math.max(...blocks.map(block => block.scrollHeight - block.clientHeight)),
          clipped: blocks.filter(block => {
            const style = getComputedStyle(block);
            return ["hidden", "clip"].includes(style.overflowY) || !["none", "unset"].includes(style.webkitLineClamp);
          }).map(block => block.className) };
      });
      assert.ok(geometry.horizontalOverflow <= 1 && geometry.verticalOverflow <= 1,
        `${viewport.width}px full issue description must wrap without clipping: ${JSON.stringify(geometry)}`);
      assert.deepEqual(geometry.clipped, [], "no description row may clamp its text");
      mkdirSync(outDir, { recursive: true });
      await dialog.screenshot({ path: `${outDir}/issue-description-${viewport.width}x${viewport.height}.png` });
      await detailPage.keyboard.press("End");
      await detailPage.waitForFunction(() => {
        const body = document.querySelector(".site-issue-location-dialog__body");
        return body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
      });
      assert.match(await dialog.getByRole("region", { name: "분석 당시 요소 경로" }).textContent(), /#missing-promotion-title/);
      await detailPage.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await open.evaluate(button => document.activeElement === button), true);
      const after = await card.evaluate(card => ({ height: card.getBoundingClientRect().height,
        ids: [...card.parentElement.children].map(issue => issue.getAttribute("data-issue-id")) }));
      assert.deepEqual(after, before, "reading the explanation must preserve card size and the visible issue page");
      results.push({ ...viewport, fullDescription: "PASS", keyboardScrollAndFocus: "PASS" });
    }
    const longDescription = `${description.repeat(12)}\n\n마지막 개선 안내: 제목 순서와 스크린리더 탐색을 확인하세요.`;
    assert.ok(longDescription.length > 1600);
    await detailPage.route("**/api/results/requests/501/issues", route =>
      fulfillJson(route, issues.map(issue => issue.id === 9003
        ? { ...issue, description: longDescription, recommendation: null }
        : issue)));
    await detailPage.setViewportSize({ width: 390, height: 668 });
    await detailPage.reload({ waitUntil: "domcontentloaded" });
    await waitForReplayReady(evidence);
    await waitForUnavailableLocatorCount(evidence, 2);
    const scrollCard = detailPage.locator('.site-unavailable-locator-panel__issue[data-issue-id="9003"]');
    for (const layout of [
      { width: 390, height: 668, zoom: 1 },
      { width: 1920, height: 1080, zoom: 1.5 },
      { width: 1280, height: 720, zoom: 2 }
    ]) {
      await detailPage.setViewportSize({ width: layout.width, height: layout.height });
      await detailPage.evaluate(zoom => { document.body.style.zoom = String(zoom); }, layout.zoom);
      // The rail line stays short: the finding's own words and why it is not
      // on screen. A long explanation lives in the details dialog and the report.
      assert.doesNotMatch(await scrollCard.textContent(), /마지막 개선 안내/);
      assert.equal(await scrollCard.locator('.site-unavailable-locator-panel__reason').textContent(), "요소를 찾지 못함");
      const cardFacts = await scrollCard.evaluate(card => {
        const line = card.querySelector('.site-unavailable-locator-panel__line');
        const title = card.querySelector('.site-unavailable-locator-panel__line-title');
        const bounds = line.getBoundingClientRect();
        return { overflow: line.scrollWidth - line.clientWidth, titleInside: title.getBoundingClientRect().right <= bounds.right + 1,
          id: card.dataset.issueId };
      });
      assert.ok(cardFacts.overflow <= 1 && cardFacts.titleInside,
        `the issue line must stay inside the card at ${JSON.stringify(layout)}: ${JSON.stringify(cardFacts)}`);
      assert.equal(cardFacts.id, "9003");
      await scrollCard.screenshot({ path: `${outDir}/issue-card-compact-${layout.width}-${layout.zoom}.png` });
    }
    await detailPage.evaluate(() => { document.body.style.zoom = ""; });
    await detailPage.setViewportSize({ width: 390, height: 668 });
    await detailPage.locator('[data-issue-id="9003"] .site-unavailable-locator-panel__line').click();
    const dialog = detailPage.getByRole("dialog", { name: "문제 상세", exact: true });
    const message = dialog.getByRole("region", { name: "문제 설명", exact: true });
    const messageText = (await message.textContent()).replace(/\s+/g, " ");
    assert.equal(messageText.split("화면에서 배너 제목이").length - 1, 12, "full details must not reuse the replay's 1600-character preview");
    assert.ok(messageText.includes("마지막 개선 안내: 제목 순서와 스크린리더 탐색을 확인하세요."));
    assert.equal(await message.evaluate(region => [...region.querySelectorAll("dd, p")]
      .some(block => block.scrollHeight > block.clientHeight + 1)), false);
    const body = dialog.getByRole("region", { name: "문제 상세 내용", exact: true });
    await body.focus();
    await detailPage.keyboard.press("End");
    await detailPage.waitForFunction(() => {
      const body = document.querySelector(".site-issue-location-dialog__body");
      return body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    });
    await detailPage.keyboard.press("Escape");
    results.push({ longDescriptionLength: longDescription.length, fullDescription: "PASS", keyboardScrollAndFocus: "PASS" });
    const suggestion = `${"쉬운 표현을 사용하고 문장을 짧게 나누세요. ".repeat(40)}개선 제안의 마지막 안내도 확인하세요.`;
    assert.ok(suggestion.length > 600);
    const aiDescription = ["text=어려운 안내 문장", 'flags=["어려운 어휘"]', `suggestions=${suggestion}`,
      'llm_revision={"revised_text":"쉬운 안내 문장","reason":"읽기 쉽게 바꿨습니다.","model":"internal-model"}'].join("\n");
    await detailPage.route("**/api/results/requests/501/issues", route =>
      fulfillJson(route, issues.map(issue => issue.id === 9003
        ? { ...issue, module: "text_difficulty", description: aiDescription,
            recommendation: aiDescription.slice(aiDescription.indexOf("suggestions=") + "suggestions=".length) }
        : issue)));
    await detailPage.reload({ waitUntil: "domcontentloaded" });
    await waitForReplayReady(evidence);
    await waitForUnavailableLocatorCount(evidence, 2);
    await detailPage.locator('[data-issue-id="9003"] .site-unavailable-locator-panel__line').click();
    const aiMessage = await dialog.getByRole("region", { name: "문제 설명", exact: true }).textContent();
    assert.ok(aiMessage.replace(/\s+/g, " ").includes(suggestion.replace(/\s+/g, " ").trim()),
      "local AI details must retain suggestions beyond the replay's 600-character field limit");
    assert.match(aiMessage, /이렇게 바꿔 보세요\s*쉬운 안내 문장/);
    assert.doesNotMatch(aiMessage, /(?:text|flags|suggestions|llm_revision)=|internal-model/);
    await detailPage.keyboard.press("Escape");
    results.push({ aiSuggestionLength: suggestion.length, fullDescription: "PASS" });
    const rawRuleMessage = "Links must have discernible text\nFix any of the following: Element has no accessible name <img src=x onerror=alert(1)>";
    await detailPage.route("**/api/results/requests/501/issues", route =>
      fulfillJson(route, issues.map(issue => issue.id === 9003
        ? { ...issue, ruleId: "link-name", description: rawRuleMessage, recommendation: null }
        : issue)));
    await detailPage.reload({ waitUntil: "domcontentloaded" });
    await waitForReplayReady(evidence);
    await waitForUnavailableLocatorCount(evidence, 2);
    const localizedCard = detailPage.locator('[data-issue-id="9003"]');
    // The card never shows raw engine text; the dialog carries the localized guidance.
    assert.doesNotMatch(await localizedCard.textContent(), /Links must have|Fix any/);
    await localizedCard.locator(".site-unavailable-locator-panel__line").click();
    const ruleExplanation = dialog.getByRole("region", { name: "문제 설명", exact: true });
    assert.match(await ruleExplanation.locator("dl").textContent(), /이렇게 고치세요/);
    // The details speak only the localized guidance; the engine's English
    // original is not offered, and nothing from it is rendered as markup.
    assert.equal(await dialog.locator("details").count(), 0);
    assert.doesNotMatch(await dialog.textContent(), /Links must have|Fix any|검사 엔진 원문/);
    assert.equal(await dialog.locator("img").count(), 0, "engine evidence must never render as markup");
    await detailPage.keyboard.press("Escape");
    results.push({ localizedRuleOnly: "PASS" });
    return results;
  } finally {
    await detailPage.close();
  }
}

async function verifyLocatorBatchReconnect(page) {
  await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  await waitForReplayReady(evidence);
  await waitForUnavailableLocatorCount(evidence, 2);
  const preview = evidence.locator(".site-page-evidence-preview");
  await page.evaluate(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window);
    const nativeCancelFrame = window.cancelAnimationFrame.bind(window);
    const nativeTimer = window.setTimeout.bind(window);
    const nativeCancelTimer = window.clearTimeout.bind(window);
    const frames = new Map();
    const timers = new Map();
    const allFrames = [];
    const allTimers = [];
    let nextId = -1;
    const facts = { framesCancelled: 0, timersCancelled: 0, counts: [] };
    window.__locatorReconnectFacts = facts;
    const target = document.querySelector(".site-page-evidence-preview");
    const observer = new MutationObserver(() => facts.counts.push(target.dataset.unavailableLocatorCount));
    observer.observe(target, { attributes: true, attributeFilter: ["data-unavailable-locator-count"] });
    window.requestAnimationFrame = callback => {
      const id = nextId--;
      frames.set(id, callback);
      allFrames.push(callback);
      return id;
    };
    window.cancelAnimationFrame = id => {
      if (frames.delete(id)) facts.framesCancelled++;
      else nativeCancelFrame(id);
    };
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 100) return nativeTimer(callback, delay, ...args);
      const id = nextId--;
      const invoke = () => callback(...args);
      timers.set(id, invoke);
      allTimers.push(invoke);
      return id;
    };
    window.clearTimeout = id => {
      if (timers.delete(id)) facts.timersCancelled++;
      else nativeCancelTimer(id);
    };
    window.__locatorBatchScheduled = () => allFrames.length > 0 && allTimers.length > 0;
    window.__fireStaleLocatorBatch = async () => {
      // Retain callbacks even after cancellation to model a callback already queued
      // by the browser. These are the actual hook callbacks, not copied batch logic.
      allFrames.forEach(callback => callback(performance.now()));
      allTimers.forEach(callback => callback());
      await new Promise(resolve => nativeTimer(resolve, 30));
    };
    window.__restoreLocatorScheduler = () => {
      window.requestAnimationFrame = nativeFrame;
      window.cancelAnimationFrame = nativeCancelFrame;
      window.setTimeout = nativeTimer;
      window.clearTimeout = nativeCancelTimer;
      observer.disconnect();
    };
  });
  try {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status: "UNAVAILABLE" });
    await page.waitForFunction(() => window.__locatorBatchScheduled());
    assert.equal(await preview.getAttribute("data-unavailable-locator-count"), "2",
      "the old port status must still be queued before reconnect");
    const connectsBeforeForgery = await frame.locator("html").evaluate(() => window.__connectAttempts ?? 0);
    await frame.locator("html").evaluate(() => window.__postForgedAvailable());
    await page.waitForTimeout(300);
    assert.equal(await frame.locator("html").evaluate(() => window.__connectAttempts ?? 0), connectsBeforeForgery,
      "an AVAILABLE posted by the loaded document must not replace its connected bridge");
    // Only once the iframe has loaded another document may its bridge replace the port.
    await page.evaluate(() => document.querySelector("iframe.site-page-evidence-replay-frame")
      .dispatchEvent(new Event("load")));
    await frame.locator("html").evaluate(() => window.__reconnectWithoutAck());
    await frame.locator("html").evaluate(() => new Promise((resolve, reject) => {
      const deadline = performance.now() + 2000;
      const poll = () => {
        if (window.__heldReplayConnect) resolve();
        else if (performance.now() >= deadline) reject(new Error("replacement CONNECT was not received"));
        else setTimeout(poll, 0);
      };
      poll();
    }));
    // No ACK or DOCUMENT_LOADING has arrived: cancellation must happen when the
    // real component replaces the port, before any later lifecycle reset.
    await page.evaluate(() => window.__fireStaleLocatorBatch());
    assert.equal(await preview.getAttribute("data-unavailable-locator-count"), "2",
      "reconnecting must discard queued old-port status while preserving the published snapshot");
    const facts = await page.evaluate(() => window.__locatorReconnectFacts);
    assert.ok(facts.framesCancelled >= 1, "port replacement must cancel the pending animation frame");
    assert.ok(facts.timersCancelled >= 1, "port replacement must cancel the pending fallback timer");
    assert.ok(!facts.counts.includes("3"), "the stale locator snapshot must never publish during reconnect");
    return { retainedUnavailableCount: 2, staleUnavailableCountPublished: false,
      cancelledFrame: facts.framesCancelled > 0, cancelledTimer: facts.timersCancelled > 0 };
  } finally {
    await page.evaluate(() => window.__restoreLocatorScheduler());
  }
}

async function verifyDesktop(page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });

  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await evidence.waitFor({ state: "visible" });
  await waitForReplayReady(evidence);

  const iframe = evidence.locator("iframe.site-page-evidence-replay-frame");
  assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms");
  assert.equal(await iframe.getAttribute("referrerpolicy"), "no-referrer");
  assert.match(await iframe.getAttribute("title"), /예제 쇼핑몰.*동적 보기/);
  assert.equal(await iframe.getAttribute("src"), liveSession.runtimeUrl);
  assert.equal(await evidence.locator(".site-page-evidence-canvas, .site-page-evidence-outline, .site-page-evidence-marker").count(), 0);
  assert.equal(await evidence.locator('img[src$=".png"], img[src*="image/png"]').count(), 0);

  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  const initialMessage = await waitForReplayMessage(frame, (message) => message.type === "INIT_ISSUES");
  // The scrolled bar overlaps real content and sends its measured height to
  // the bridge, which keeps source-site fixed navigation below the opaque title bar.
  const chromeMediaSession = await page.context().newCDPSession(page);
  await chromeMediaSession.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }]
  });
  assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches), true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await sendReplayTestMessage(frame, { type: "DOCUMENT_SCROLL", isScrolled: false });
    await page.waitForFunction(() => document.querySelector('.site-page-evidence-card')?.dataset.documentScrolled === 'false');
    const readChrome = () => evidence.evaluate(card => {
      const bar = card.querySelector('.site-page-evidence-chrome');
      const viewer = card.querySelector('iframe');
      return { height: card.getBoundingClientRect().height,
        barBottom: bar.getBoundingClientRect().bottom, viewerTop: viewer.getBoundingClientRect().top,
        viewerHeight: viewer.getBoundingClientRect().height,
        blur: getComputedStyle(bar).backdropFilter,
        background: getComputedStyle(bar).backgroundColor };
    });
    const initialChrome = await readChrome();
    assert.equal(initialChrome.blur, 'none');
    assert.ok(initialChrome.viewerTop >= initialChrome.barBottom - 1, 'initial source navigation must remain exposed');
    await frame.locator("html").evaluate(() => parent.postMessage({
      source: "accessibility-page-replay", type: "DOCUMENT_SCROLL",
      documentToken: window.__replayDocumentToken, isScrolled: true
    }, "*"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await evidence.getAttribute('data-document-scrolled'), 'false', 'scroll state must only arrive through the authenticated live port');
    await sendReplayTestMessage(frame, { type: "DOCUMENT_SCROLL", isScrolled: true });
    await page.waitForFunction(() => document.querySelector('.site-page-evidence-card')?.dataset.documentScrolled === 'true');
    const scrolledChrome = await readChrome();
    assert.equal(scrolledChrome.blur, 'none');
    assert.equal(scrolledChrome.background, initialChrome.background, 'scrolling must keep the opaque header surface');
    assert.match(scrolledChrome.background, /^rgb\(/, 'header background must be fully opaque');
    assert.ok(scrolledChrome.viewerTop < scrolledChrome.barBottom - 20, 'scrolled content must stay behind the title bar');
    const insetMessage = await waitForReplayMessage(frame, message => message.type === 'SET_VIEW_SCALE' && message.topInset > 0);
    assert.ok(Math.abs(insetMessage.topInset - (scrolledChrome.barBottom - scrolledChrome.viewerTop)) < 1,
      'the bridge must receive the actual covered height');
    assert.ok(Math.abs(scrolledChrome.height - initialChrome.height) <= 1, `${width}px: title transition changed card height`);
    await evidence.screenshot({ path: `${outDir}/opaque-header-${width}.png` });
    await sendReplayTestMessage(frame, { type: "DOCUMENT_SCROLL", isScrolled: false });
    await page.waitForFunction(() => document.querySelector('.site-page-evidence-card')?.dataset.documentScrolled === 'false');
    assert.equal((await readChrome()).blur, 'none');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await chromeMediaSession.send("Emulation.setEmulatedMedia", { features: [] });
  await chromeMediaSession.detach();
  const documentHeading = evidence.locator(".site-page-evidence-chrome h2");
  assert.equal(await documentHeading.innerText(), "", "the title stays empty until the real document title arrives");
  for (const title of ["NAVER", "공식 웹사이트 | 온라인 스토어", "상품 상세 · 공식 웹사이트", "", "공식 웹사이트 | 온라인 스토어"]) {
    await sendReplayTestMessage(frame, { type: "DOCUMENT_TITLE", title });
    await page.waitForFunction(expected => document.querySelector(".site-page-evidence-chrome h2")?.textContent === expected,
      title || "제목 없음");
  }
  assert.equal(initialMessage.source, "accessibility-dashboard");
  assert.equal(initialMessage.issues.length, 4);
  assert.deepEqual(initialMessage.issues[0].pathSteps, [{ context: "DOCUMENT", selector: "#search-button" }]);
  assert.equal(initialMessage.issues[0].severityLabel, "심각");
  assert.equal(initialMessage.issues[0].category, "media");
  assert.equal(initialMessage.issues[0].code, "5.1.1");
  assert.equal(initialMessage.issues[1].category, "visual");
  assert.equal(initialMessage.issues[3].category, "text");
  assert.deepEqual(initialMessage.issues[3].textAnalysis, {
    kind: "text-analysis",
    sourceText: "건축학부 제70회 졸업 전시회 개최",
    flags: ["어려운 어휘 과다: 쉬운 단어 비율 40.0%"],
    suggestions: ["어려운 표현을 쉬운 단어로 바꾸세요."],
    revision: {
      text: "건축학부 졸업 전시회가 열립니다.",
      reason: "짧고 쉬운 문장으로 바꿨습니다."
    }
  });
  assert.match(initialMessage.issues[3].message, /분석 문장\n건축학부/);
  assert.match(initialMessage.issues[3].message, /개선 필요\n• 어려운 어휘 과다/);
  assert.doesNotMatch(initialMessage.issues[3].message, /(?:text|flags|suggestions|llm_revision)=/);
  assert.doesNotMatch(initialMessage.issues[3].message, /internal-model/);
  assert.equal(initialMessage.issues[0].title, issues[0].title);
  assert.ok(initialMessage.issues[0].message.includes(issues[0].description.slice(0, 300)));
  assert.ok(initialMessage.issues[0].message.includes(issues[0].recommendation));
  assert.equal(initialMessage.issues[0].path, "#search-button");
  assert.equal(initialMessage.selectedIssueId, null);
  assert.equal(initialMessage.markersVisible, true);
  assert.equal(await frame.locator(".replay-marker").count(), 2);
  await waitForUnavailableLocatorCount(evidence, 2, 5_000, { open: false });
  const unavailableLocatorPanel = page.locator(".site-unavailable-locator-panel");
  await page
    .locator('.site-unavailable-locator-panel[data-unavailable-locator-count="2"]')
    .waitFor({ state: "visible" });
  assert.match(await unavailableLocatorPanel.textContent(), /화면에 표시되지 않은 문제/);
  assert.match(await unavailableLocatorPanel.textContent(), /2건/);
  assert.doesNotMatch(
    await unavailableLocatorPanel.textContent(),
    /현재 동적 페이지에서 요소 위치를 찾지 못한 분석 결과입니다/
  );
  assert.equal(
    await unavailableLocatorPanel.locator(".site-unavailable-locator-panel__summary").count(),
    0,
    "the rail must render issue cards instead of the old count-only summary"
  );
  const unavailableIssueCards = unavailableLocatorPanel.locator(".site-unavailable-locator-panel__issue");
  const unavailableIds = () => unavailableIssueCards.evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-issue-id")));
  await page.setViewportSize({ width: 1440, height: 860 });
  // Findings are grouped by criterion like the final report, the more severe
  // group first; every group starts folded until the user opens it.
  const groupToggles = unavailableLocatorPanel.locator(".site-unavailable-locator-panel__group-toggle");
  assert.equal(await groupToggles.count(), 2);
  assert.deepEqual(await groupToggles.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-expanded"))), ["false", "false"]);
  await openUnavailableGroups(page);
  assert.match(await groupToggles.first().locator(".site-unavailable-locator-panel__code").textContent(), /2\.4\.6/);
  assert.match(await groupToggles.last().locator(".site-unavailable-locator-panel__code").textContent(), /3\.1\.5/);
  assert.deepEqual(await unavailableIds(), ["9003", "9004"], "every hidden finding is listed as its own line");
  assert.equal(
    await unavailableLocatorPanel.locator(".site-unavailable-locator-panel__dot, .site-unavailable-locator-panel__navigation").count(),
    0,
    "the grouped list replaces the one-card pager"
  );
  const lastGroupBody = unavailableLocatorPanel.locator(".site-unavailable-locator-panel__group-body").last();
  await groupToggles.last().click();
  assert.equal(await groupToggles.last().getAttribute("aria-expanded"), "false");
  // Closing folds the rows from their height to nothing before they leave,
  // ending flush with the header; while folding they take no focus.
  const closingFacts = await lastGroupBody.evaluate(body => {
    const [animation] = body.getAnimations();
    const frames = animation?.effect?.getKeyframes() ?? [];
    return { state: body.dataset.state, inert: body.inert, overflow: body.style.overflow,
      from: parseFloat(frames[0]?.height), to: frames.at(-1)?.height };
  });
  assert.ok(closingFacts.state === "closing" && closingFacts.inert && closingFacts.overflow === "clip"
    && closingFacts.from > 20 && closingFacts.to === "0px", JSON.stringify(closingFacts));
  const group = unavailableLocatorPanel.locator(".site-unavailable-locator-panel__group").last();
  const toggleHeight = await groupToggles.last().evaluate(button => button.getBoundingClientRect().height);
  await unavailableLocatorPanel.locator('[data-issue-id="9004"]').waitFor({ state: "detached" });
  assert.ok(Math.abs(await group.evaluate(section => section.getBoundingClientRect().height) - toggleHeight) <= 1,
    "a closed group is exactly its header, with nothing left to snap away");
  assert.deepEqual(await unavailableIds(), ["9003"], "closing a group hides its lines");
  await groupToggles.last().click();
  assert.equal(await lastGroupBody.evaluate(body => body.getAnimations()[0]?.effect?.getKeyframes()[0]?.height), "0px",
    "opening a group slides its rows down from the header");
  assert.deepEqual(await unavailableIds(), ["9003", "9004"]);
  await lastGroupBody.evaluate(body => Promise.all(body.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const missingBannerCard = unavailableLocatorPanel.locator('[data-issue-id="9003"]');
  assert.match(await missingBannerCard.locator(".site-unavailable-locator-panel__severity").textContent(), /중간/);
  assert.equal(await missingBannerCard.locator(".site-unavailable-locator-panel__reason").textContent(), "요소를 찾지 못함");
  assert.match(await missingBannerCard.locator(".site-unavailable-locator-panel__action").textContent(), /상세/);
  const locationButton = missingBannerCard.locator(".site-unavailable-locator-panel__line");
  await locationButton.click();
  const locationDialog = page.getByRole("dialog", { name: "문제 상세" });
  await locationDialog.waitFor({ state: "visible" });
  assert.equal(await missingBannerCard.count(), 1, "opening details must keep the line in place");
  assert.match(await locationDialog.getByRole("region", { name: "분석 당시 요소 경로" }).textContent(), /#missing-promotion-title/);
  assert.equal(await locationDialog.locator("pre code").textContent(), issues[2].locator.htmlSnippet);
  assert.equal(await locationDialog.locator("#missing-promotion-title").count(), 0, "recorded HTML must be displayed as text, not rendered");
  assert.deepEqual(await locationDialog.getByRole("region", { name: "분석 당시 좌표" }).locator("dl > div").evaluateAll(cells =>
    cells.map(cell => [cell.querySelector("dt").textContent, cell.querySelector("dd").textContent])),
    [["X", "48"], ["Y", "960"], ["너비", "320"], ["높이", "44"]]);
  assert.match(await locationDialog.textContent(), /문서 왼쪽 위 기준/);
  const closeLocation = locationDialog.getByRole("button", { name: "문제 상세 닫기" });
  assert.deepEqual(await locationDialog.getByRole("button").evaluateAll(buttons =>
    buttons.map(button => button.getAttribute("aria-label") ?? button.textContent.trim())), ["문제 상세 닫기"]);
  mkdirSync(outDir, { recursive: true });
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, colorScheme === "dark");
    assert.equal(await locationDialog.evaluate(dialog => Array.from(dialog.querySelectorAll("section, pre, code, dl")).some(element =>
      element.scrollWidth > element.clientWidth + 1)), false, "saved evidence must wrap within the modal in both themes");
    await locationDialog.screenshot({ path: `${outDir}/desktop-issue-location-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  const locationBody = locationDialog.getByRole("region", { name: "문제 상세 내용" });
  await closeLocation.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await locationBody.evaluate(body => document.activeElement === body), true);
  await page.keyboard.press("Tab");
  assert.equal(await closeLocation.evaluate(button => document.activeElement === button), true);
  await page.keyboard.press("Tab");
  assert.equal(await locationBody.evaluate(body => document.activeElement === body), true);
  for (const [status, reason, label] of [
    ["UNAVAILABLE", "ELEMENT_CONTENT_CHANGED", "분석 이후 내용이 바뀜"],
    ["UNAVAILABLE", "FRAME_UNSUPPORTED", "내부 프레임의 요소"],
    ["HIDDEN_STATE", "ARIA_HIDDEN_STATE", "접근성 숨김으로 분류됨"],
    ["UNAVAILABLE", "UNRECOGNIZED_REASON", "위치를 확인하지 못함"],
    ["UNAVAILABLE", "SELECTOR_NOT_FOUND", "요소를 찾지 못함"]
  ]) {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9003, status, reason });
    // Why a finding is not on screen is its rail line's reason; the open
    // details do not repeat it.
    await page.waitForFunction(text => document.querySelector(
      '[data-issue-id="9003"] .site-unavailable-locator-panel__reason')?.textContent === text, label);
    assert.equal(await locationDialog.getByRole("region", { name: "현재 표시 상태" }).count(), 0);
  }
  assert.doesNotMatch(await locationDialog.textContent(), /UNRECOGNIZED_REASON|요소를 찾지 못함/);
  await page.keyboard.press("Escape");
  await locationDialog.waitFor({ state: "detached" });
  assert.equal(await locationButton.evaluate(button => document.activeElement === button), true);
  await locationButton.click();
  const beforeLocationClose = (await getReplayMessages(frame)).filter(message => message.type === "FOCUS_ISSUE").length;
  await closeLocation.click();
  await locationDialog.waitFor({ state: "detached" });
  assert.equal((await getReplayMessages(frame)).filter(message => message.type === "FOCUS_ISSUE").length, beforeLocationClose,
    "closing location information must not request another location search");
  const readingLevelCard = unavailableLocatorPanel.locator('[data-issue-id="9004"]');
  assert.match(await readingLevelCard.locator(".site-unavailable-locator-panel__severity").textContent(), /낮음/);
  assert.match(await readingLevelCard.textContent(), /건축학부 제70회 졸업 전시회 개최/);
  await readingLevelCard.locator(".site-unavailable-locator-panel__line").click();
  await locationDialog.waitFor({ state: "visible" });
  const textAnalysisDescription = await locationDialog.getByRole("region", { name: "문제 설명", exact: true }).textContent();
  assert.match(textAnalysisDescription, /원래 문장\s*건축학부 제70회 졸업 전시회 개최/);
  assert.match(textAnalysisDescription, /건축학부 졸업 전시회가 열립니다/);
  assert.doesNotMatch(textAnalysisDescription, /(?:text|flags|suggestions|llm_revision)=|internal-model/);
  assert.match(await locationDialog.textContent(), /저장된 요소 경로가 없습니다/);
  assert.match(await locationDialog.textContent(), /저장된 HTML이 없습니다/);
  assert.match(await locationDialog.textContent(), /저장된 좌표가 없습니다/);
  await closeLocation.click();
  await locationDialog.waitFor({ state: "detached" });
  const readingLevelLineLayout = await readingLevelCard.evaluate((card) => {
    const severity = card.querySelector(".site-unavailable-locator-panel__severity")?.getBoundingClientRect();
    const main = card.querySelector(".site-unavailable-locator-panel__line-main")?.getBoundingClientRect();
    const action = card.querySelector(".site-unavailable-locator-panel__action")?.getBoundingClientRect();
    const center = (rect) => (rect.top + rect.bottom) / 2;
    return severity && main && action
      ? { gap: main.left - severity.right, actionGap: action.left - main.right,
          rowDelta: Math.max(Math.abs(center(main) - center(severity)), Math.abs(center(action) - center(severity))) }
      : null;
  });
  assert.ok(
    readingLevelLineLayout && readingLevelLineLayout.gap >= 4 && readingLevelLineLayout.actionGap >= 0 &&
      readingLevelLineLayout.rowDelta <= 2,
    `the severity badge, the finding and its action must share one row: ${JSON.stringify(readingLevelLineLayout)}`
  );
  const unavailablePanelOverflow = await unavailableLocatorPanel.evaluate((panel) => ({
    clientWidth: panel.clientWidth,
    scrollWidth: panel.scrollWidth,
    lines: Array.from(panel.querySelectorAll(".site-unavailable-locator-panel__line"),
      (line) => line.scrollWidth - line.clientWidth)
  }));
  assert.ok(
    unavailablePanelOverflow.scrollWidth <= unavailablePanelOverflow.clientWidth + 1 &&
      unavailablePanelOverflow.lines.every((overflow) => overflow <= 1),
    `unavailable issue lines must not create horizontal overflow: ${JSON.stringify(unavailablePanelOverflow)}`
  );
  assert.equal(
    await evidence.locator(".site-page-evidence-locator-status").count(),
    0,
    "the unavailable-locator notice must move out of the replay card"
  );
  const railCardOrder = await page.locator(".site-dashboard-rail > .site-rail-card").allTextContents();
  const severityCardIndex = railCardOrder.findIndex((text) => text.includes("심각도 분포"));
  const unavailableCardIndex = railCardOrder.findIndex((text) => text.includes("화면에 표시되지 않은 문제"));
  assert.equal(
    unavailableCardIndex,
    severityCardIndex + 1,
    "the unavailable-locator card must follow the severity distribution"
  );

  // Live pages can change locator visibility without any dashboard interaction.
  // A new, more severe group arrives folded: it must not close the group being
  // read, open itself, or move focus.
  const readingLevelLine = readingLevelCard.locator(".site-unavailable-locator-panel__line");
  await readingLevelLine.focus();
  for (const [status, count, ids] of [
    ["UNAVAILABLE", 3, ["9003", "9004"]],
    ["CONNECTED", 2, ["9003", "9004"]],
    ["UNAVAILABLE", 3, ["9003", "9004"]],
    ["CONNECTED", 2, ["9003", "9004"]]
  ]) {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status });
    await waitForUnavailableLocatorCount(evidence, count, 5_000, { open: false });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await unavailableIds(), ids, "background locator updates must keep open groups open");
    assert.equal(await readingLevelLine.evaluate(line => line === document.activeElement), true,
      "background updates must preserve focus on the line being read");
  }
  await sendReplayTestMessage(frame, {
    type: "LOCATOR_STATUS",
    issueId: 999999,
    status: "UNAVAILABLE",
    reason: "UNTRUSTED_REASON"
  });
  await page.waitForTimeout(50);
  assert.equal(
    await evidence.locator(".site-page-evidence-preview").getAttribute("data-unavailable-locator-count"),
    "2",
    "unknown locator statuses must not affect the dashboard"
  );
  assert.deepEqual(await unavailableIds(), ["9003", "9004"], "unknown locator statuses must not change the list");
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9003, status: "CONNECTED" });
  await waitForUnavailableLocatorCount(evidence, 1);
  await page
    .locator('.site-unavailable-locator-panel[data-unavailable-locator-count="1"]')
    .waitFor({ state: "visible" });
  assert.deepEqual(await unavailableIds(), ["9004"], "reconnected issues must be removed without changing the rest");
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9004, status: "CONNECTED" });
  await waitForUnavailableLocatorCount(evidence, 0);
  await page
    .locator('.site-unavailable-locator-panel[data-unavailable-locator-count="0"] .site-unavailable-locator-panel__empty')
    .waitFor({ state: "visible" });
  assert.match(
    await unavailableLocatorPanel.textContent(),
    /모든 문제가 화면에 표시되고 있습니다/,
    "the empty unavailable card must say there is nothing left instead of disappearing"
  );
  const focusMessageCountBeforeHiddenReveal = await frame.locator("html").evaluate(() =>
    window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE").length
  );
  await sendReplayTestMessage(frame, {
    type: "LOCATOR_STATUS",
    issueId: 9003,
    status: "HIDDEN_STATE",
    reason: "CAROUSEL_STATE_AVAILABLE",
    recoverable: true
  });
  // Findings in another screen state join the hidden list instead of a panel of their own.
  const hiddenStatePanel = page.locator(
    '.site-unavailable-locator-panel[data-locator-mode="unavailable"][data-hidden-state-locator-count="1"]'
  );
  await hiddenStatePanel.waitFor({ state: "visible" });
  assert.equal(await page.locator('.site-unavailable-locator-panel[data-locator-mode="recoverable"]').count(), 0);
  assert.equal(
    await evidence.locator(".site-page-evidence-preview").getAttribute("data-hidden-state-locator-count"),
    "1"
  );
  const hiddenStateLine = hiddenStatePanel.locator('[data-issue-id="9003"] .site-unavailable-locator-panel__line');
  assert.match(await hiddenStateLine.locator(".site-unavailable-locator-panel__action").textContent(), /위치로 이동/);
  const beforeHiddenFocusRequest = Number(await evidence.locator(".site-page-evidence-preview").getAttribute("data-focus-request-id"));
  await hiddenStateLine.click();
  assert.equal(
    await evidence.locator(".site-page-evidence-preview").getAttribute("data-focus-request-id"),
    String(beforeHiddenFocusRequest + 1),
    "the hidden-state reveal action must create an explicit focus request"
  );
  await frame.locator("html").evaluate((_html, initialCount) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const inspect = () => {
      const focusMessages = window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE");
      if (focusMessages.length > initialCount && focusMessages.at(-1)?.issueId === 9003) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(
          "hidden-state issue did not request replay focus: "
            + JSON.stringify({ initialCount, issueIds: focusMessages.map((message) => message.issueId) })
        ));
        return;
      }
      setTimeout(inspect, 25);
    };
    inspect();
  }), focusMessageCountBeforeHiddenReveal);
  // With a second reason on the list, chips filter by why a finding is not on screen.
  await sendReplayTestMessage(frame, {
    type: "LOCATOR_STATUS",
    issueId: 9004,
    status: "UNAVAILABLE",
    reason: "LOCATOR_MISSING"
  });
  await waitForUnavailableLocatorCount(evidence, 1);
  const reasonFilters = hiddenStatePanel.locator(".site-unavailable-locator-panel__filter");
  await reasonFilters.first().waitFor({ state: "visible" });
  const filterLabels = await reasonFilters.evaluateAll((chips) => chips.map((chip) => chip.textContent.replace(/\s+\d+$/, "").trim()));
  assert.equal(filterLabels[0], "전체");
  assert.equal(filterLabels[1], "다른 화면 상태", "the other-screen-state chip follows 전체");
  assert.equal(filterLabels.length, 3);
  await reasonFilters.nth(1).click();
  assert.equal(await reasonFilters.nth(1).getAttribute("aria-pressed"), "true");
  assert.deepEqual(await unavailableIds(), ["9003"]);
  await reasonFilters.nth(2).click();
  assert.deepEqual(await unavailableIds(), ["9004"]);
  await reasonFilters.first().click();
  assert.deepEqual(await unavailableIds(), ["9003", "9004"]);
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9004, status: "CONNECTED" });
  await waitForUnavailableLocatorCount(evidence, 0);
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9003, status: "VISIBLE" });
  await hiddenStatePanel.waitFor({ state: "detached" });
  await sendReplayTestMessage(frame, {
    type: "LOCATOR_STATUS",
    issueId: 9003,
    status: "UNAVAILABLE",
    reason: "SELECTOR_NOT_FOUND"
  });
  await waitForUnavailableLocatorCount(evidence, 1);
  await page
    .locator('.site-unavailable-locator-panel[data-unavailable-locator-count="1"]')
    .waitFor({ state: "visible" });
  assert.deepEqual(await unavailableIds(), ["9003"]);
  await sendReplayTestMessage(frame, {
    type: "LOCATOR_STATUS",
    issueId: 9004,
    status: "UNAVAILABLE",
    reason: "LOCATOR_MISSING"
  });
  await waitForUnavailableLocatorCount(evidence, 2);
  await page
    .locator('.site-unavailable-locator-panel[data-unavailable-locator-count="2"]')
    .waitFor({ state: "visible" });
  assert.deepEqual(await unavailableIds(), ["9003", "9004"]);
  mkdirSync(outDir, { recursive: true });
  await page.locator(".site-dashboard-rail").screenshot({
    path: `${outDir}/desktop-right-rail-unavailable-issues.png`
  });
  await verifyNoExternalReplayControls(evidence, frame);
  await page.waitForTimeout(100);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "INIT_ISSUES").length
    ),
    1,
    "the replay must be initialized exactly once"
  );
  const recoveryMessage = { ...initialMessage, selectedIssueId: 9003 };
  await verifyIframeReloadRecovery(page, evidence, frame, recoveryMessage);
  await verifyMissedInitialLoadingRecovery(page, evidence, frame, recoveryMessage);
  assert.equal(await evidence.locator(FALLBACK_DETAIL_SELECTOR).count(), 0);
  await page.evaluate(() => {
    window.postMessage(
      { source: "accessibility-page-replay", type: "ISSUE_DETAIL_FALLBACK", issueId: 9001 },
      "*"
    );
  });
  await sendReplayTestMessage(frame, {
    type: "ISSUE_DETAIL_FALLBACK",
    issueId: 999999
  });
  await page.waitForTimeout(100);
  assert.equal(
    await evidence.locator(FALLBACK_DETAIL_SELECTOR).count(),
    0,
    "forged and unknown fallback messages must not render content"
  );
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "INIT_ISSUES").length
    ),
    1,
    "fallback-message validation must not reinitialize the replay"
  );
  const initialFocusMessageCount = await frame.locator("html").evaluate(() =>
    window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE").length
  );
  assert.ok(initialFocusMessageCount >= 1, "the initial dashboard selection must still be focused in the replay");

  assert.equal(await page.locator(".site-score-trend-card, .site-recent-issues-card").count(), 0);
  assert.equal(
    await page.locator(".dashboard-site-header-content, #dashboard-site-page-title, .dashboard-site-header-url").count(),
    0,
    "the deferred page-detail title and URL must not overlap the replay surface"
  );
  assert.equal(
    await page.locator("#dashboard-main-content > .dashboard-content-zone > h1.sr-only").count(),
    1,
    "page detail must retain a non-visual level-one heading"
  );
  assert.equal(await page.locator(".dashboard-site-scan-action").count(), 0);
  assert.equal(await page.locator(".dashboard-site-content-zone .dashboard-card").count(), 1);
  assert.equal(
    await evidence.locator(".site-page-evidence-inspector, [class*='site-page-evidence-selection-']").count(),
    0,
    "the removed right inspector must contribute no page-view DOM"
  );

  const trendLayout = await page.locator(".site-page-evidence-trend-panel").evaluate((panel) => {
    const chart = panel.querySelector(".site-page-evidence-trend-chart");
    const panelRect = panel.getBoundingClientRect();
    const chartRect = chart?.getBoundingClientRect();

    return {
      chartHeight: chartRect?.height ?? 0,
      panelHeight: panelRect.height,
      // The legend was removed: a single score series needs no key, so the chart
      // is now the last element in the card.
      legendCount: panel.querySelectorAll(".site-page-evidence-trend-legend").length,
      barCount: chart ? chart.querySelectorAll(".recharts-bar-rectangle").length : 0,
      restingDotCount: chart ? chart.querySelectorAll(".recharts-area-dot").length : 0,
      // A single-point series has no curve to draw, so recharts renders the dot
      // regardless of dot={false}. Track the curve count to tell the two cases
      // apart instead of asserting a bare zero.
      curveCount: chart ? chart.querySelectorAll(".recharts-area-curve").length : 0,
      reservedHeight: chartRect ? panelRect.bottom - chartRect.bottom : 0
    };
  });
  assert.ok(
    trendLayout.chartHeight >= 98 && trendLayout.chartHeight <= 112,
    `desktop trend chart must stay compact: ${JSON.stringify(trendLayout)}`
  );
  assert.ok(
    trendLayout.panelHeight <= 290,
    `desktop trend card height must be reduced: ${JSON.stringify(trendLayout)}`
  );
  assert.equal(
    trendLayout.legendCount,
    0,
    `single-series trend chart must not render a legend: ${JSON.stringify(trendLayout)}`
  );
  assert.equal(
    trendLayout.barCount,
    0,
    `trend chart plots score only, with no issue-count bars: ${JSON.stringify(trendLayout)}`
  );
  // Points appear on hover through activeDot, so a multi-point line paints no
  // dots at rest. With only one analysis there is no line, and recharts draws
  // that lone point so the value stays visible at all.
  if (trendLayout.curveCount > 0) {
    assert.equal(
      trendLayout.restingDotCount,
      0,
      `multi-point trend line must not paint resting dots: ${JSON.stringify(trendLayout)}`
    );
  } else {
    assert.equal(
      trendLayout.restingDotCount,
      1,
      `single-analysis trend must still show its one point: ${JSON.stringify(trendLayout)}`
    );
  }
  // The trend card no longer reserves empty space for future detail content:
  // the rail carries that content in sibling cards, so the card closes up right
  // after the chart.
  assert.ok(
    trendLayout.reservedHeight >= 8 && trendLayout.reservedHeight <= 40,
    `trend card must close up right after its chart: ${JSON.stringify(trendLayout)}`
  );
  const railLayout = await page.locator(".site-dashboard-rail").evaluate((rail) => {
    const cards = Array.from(rail.children);
    const railRect = rail.getBoundingClientRect();
    const lastRect = cards.at(-1)?.getBoundingClientRect();
    const listStyle = getComputedStyle(rail.querySelector(".site-unavailable-locator-panel__issues"));

    return {
      cardCount: cards.length,
      cardSlotHeight: parseFloat(listStyle.minHeight) + parseFloat(listStyle.rowGap),
      // Trailing slack between the last card and the rail box.
      trailingSlack: lastRect ? Math.round(railRect.bottom - lastRect.bottom) : 0
    };
  });
  assert.ok(
    railLayout.cardCount >= 2,
    `the rail must stack the trend card with detail cards: ${JSON.stringify(railLayout)}`
  );
  assert.ok(
    railLayout.trailingSlack >= -1 && railLayout.trailingSlack < railLayout.cardSlotHeight,
    `the rail may leave space below a compact panel, but must not waste a full card slot: ${JSON.stringify(railLayout)}`
  );
  await assertCompactUnavailablePanel(unavailableLocatorPanel, "desktop rail");

  const markerA = frame.locator('[data-issue-id="9001"]');
  const markerB = frame.locator('[data-issue-id="9002"]');
  await markerA.evaluate((marker) => {
    window.__stableReplayMarkerA = marker;
  });
  await markerB.evaluate((marker) => {
    window.__stableReplayMarkerB = marker;
  });
  const initialLocatorStatusCount = await frame.locator("html").evaluate(() =>
    window.__replayOutboundMessages.filter((message) => message.type === "LOCATOR_STATUS").length
  );

  await page.mouse.move(0, 0);
  await markerB.hover();
  await waitForMarkerPressed(frame, 9002);
  await page.waitForTimeout(100);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE").length
    ),
    initialFocusMessageCount,
    "iframe-origin hover selection must not echo FOCUS_ISSUE back into the replay"
  );
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "INIT_ISSUES").length
    ),
    1,
    "hover selection must not reinitialize all replay markers"
  );
  assert.equal(
    await markerB.evaluate((marker) => marker === window.__stableReplayMarkerB),
    true,
    "hover selection must preserve marker DOM identity"
  );
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages.filter((message) => message.type === "LOCATOR_STATUS").length
    ),
    initialLocatorStatusCount,
    "hover selection must not reconnect every locator"
  );

  const hoverMessageCount = await frame.locator("html").evaluate(() =>
    window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").length
  );
  await markerB.dispatchEvent("pointerenter", { pointerType: "mouse", isPrimary: true });
  await page.waitForTimeout(50);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").length
    ),
    hoverMessageCount,
    "repeated pointerenter must not emit a duplicate selection"
  );

  await page.mouse.move(0, 0);
  await frame.locator("[data-replay-selected]").waitFor({ state: "detached" });
  await page.waitForTimeout(50);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE").length
    ),
    initialFocusMessageCount,
    "iframe-origin hover clear must not echo FOCUS_ISSUE(null) back into the replay"
  );
  assert.equal(await evidence.locator(".site-page-evidence-inspector, [class*='site-page-evidence-selection-']").count(), 0);
  assert.equal(await markerA.getAttribute("aria-pressed"), "false");
  assert.equal(await markerB.getAttribute("aria-pressed"), "false");
  assert.equal(await frame.locator("[data-replay-selected]").count(), 0);
  const clearMessageCount = await frame.locator("html").evaluate(() =>
    window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").length
  );
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").at(-1)?.issueId
    ),
    null,
    "pointerleave must send an explicit null selection"
  );
  await markerB.dispatchEvent("pointerleave", { pointerType: "mouse", isPrimary: true });
  await page.waitForTimeout(50);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").length
    ),
    clearMessageCount,
    "repeated pointerleave must not emit a duplicate null selection"
  );

  await frame.locator("html").evaluate(() => {
    const markerA = document.querySelector('[data-issue-id="9001"]');
    const markerB = document.querySelector('[data-issue-id="9002"]');
    const pointer = (type, relatedTarget = null) => new PointerEvent(type, {
      bubbles: false,
      pointerType: "mouse",
      isPrimary: true,
      relatedTarget
    });
    markerA.dispatchEvent(pointer("pointerenter"));
    markerA.dispatchEvent(pointer("pointerleave", markerB));
    markerB.dispatchEvent(pointer("pointerenter", markerA));
  });
  await waitForMarkerPressed(frame, 9002);
  await page.waitForTimeout(50);
  assert.deepEqual(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages
        .filter((message) => message.type === "ISSUE_SELECTED")
        .slice(-2)
        .map((message) => message.issueId)
    ),
    [9001, 9002],
    "quick marker transitions must cancel the pending clear and finish on B"
  );

  await frame.locator("html").evaluate(() => {
    const markerA = document.querySelector('[data-issue-id="9001"]');
    const markerB = document.querySelector('[data-issue-id="9002"]');
    const pointer = (type) => new PointerEvent(type, {
      bubbles: false,
      pointerType: "mouse",
      isPrimary: true
    });
    markerA.dispatchEvent(pointer("pointerenter"));
    markerB.dispatchEvent(pointer("pointerenter"));
    markerA.dispatchEvent(pointer("pointerleave"));
  });
  await page.waitForTimeout(50);
  await waitForMarkerPressed(frame, 9002);
  assert.equal(await markerB.getAttribute("aria-pressed"), "true");
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").at(-1)?.issueId
    ),
    9002,
    "a stale leave from A must not clear the newer B preview"
  );

  const touchBoundaryMessageCount = await frame.locator("html").evaluate(() =>
    window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").length
  );
  await markerA.dispatchEvent("pointerenter", { pointerType: "touch", isPrimary: true });
  await markerB.dispatchEvent("pointerleave", { pointerType: "touch", isPrimary: true });
  await page.waitForTimeout(50);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages.filter((message) => message.type === "ISSUE_SELECTED").length
    ),
    touchBoundaryMessageCount,
    "touch pointer boundaries must not preview or clear an issue"
  );
  await waitForMarkerPressed(frame, 9002);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE").length
    ),
    initialFocusMessageCount,
    `iframe-origin quick, stale, and touch interactions must not echo FOCUS_ISSUE: ${JSON.stringify(await frame.locator("html").evaluate(() => ({
      focus: window.__replayMessages.filter(message => message.type === "FOCUS_ISSUE"),
      selections: window.__replayOutboundMessages.filter(message => message.type === "ISSUE_SELECTED").slice(-10)
    })))}`
  );

  await markerA.focus();
  await waitForMarkerPressed(frame, 9001);
  await page.waitForTimeout(100);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE").length
    ),
    initialFocusMessageCount,
    "iframe-origin keyboard selection must not echo FOCUS_ISSUE"
  );
  assert.equal(await markerA.evaluate((marker) => document.activeElement === marker), true);
  assert.equal(
    await markerA.evaluate((marker) => marker === window.__stableReplayMarkerA),
    true,
    "keyboard selection must preserve marker DOM identity"
  );
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "INIT_ISSUES").length
    ),
    1,
    "keyboard selection must not reinitialize all replay markers"
  );
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayOutboundMessages.filter((message) => message.type === "LOCATOR_STATUS").length
    ),
    initialLocatorStatusCount,
    "keyboard selection must not reconnect every locator"
  );

  const keyboardDescriptionId = await markerA.getAttribute("aria-describedby");
  assert.ok(keyboardDescriptionId, "keyboard focus must expose the marker description through aria-describedby");
  assert.equal(
    await frame.locator(`[id="${keyboardDescriptionId}"]`).count(),
    1,
    "aria-describedby must reference a live marker description"
  );

  if (verificationScope === "full") {
    const requestFetchCountBeforeStabilityWindow = dashboardRequestFetchCount;
    const issueFetchCountBeforeStabilityWindow = issueResponseFetchCount;
    await advanceBrowserClockPastResultCache(page);
    await page.waitForTimeout(5_500);
    assert.equal(
      dashboardRequestFetchCount,
      requestFetchCountBeforeStabilityWindow,
      "a terminal result must not restart dashboard overview polling after cache expiry"
    );
    assert.equal(
      issueResponseFetchCount,
      issueFetchCountBeforeStabilityWindow,
      "a terminal result must keep its detail payload instead of refetching unchanged issues"
    );
    assert.equal(
      await frame.locator("html").evaluate(() =>
        window.__replayMessages.filter((message) => message.type === "INIT_ISSUES").length
      ),
      1,
      "a terminal result stability window must not reinitialize the replay"
    );
    assert.equal(
      await markerA.evaluate((marker) => marker === window.__stableReplayMarkerA),
      true,
      "a terminal result stability window must preserve marker DOM identity"
    );
    assert.equal(
      await markerA.evaluate((marker) => document.activeElement === marker),
      true,
      "a terminal result stability window must preserve keyboard focus"
    );
    assert.equal(
      await markerA.getAttribute("aria-describedby"),
      keyboardDescriptionId,
      "a terminal result stability window must preserve the marker tooltip relationship"
    );
    assert.equal(
      await frame.locator(`[id="${keyboardDescriptionId}"]`).count(),
      1,
      "a terminal result stability window must keep the described tooltip mounted"
    );
    assert.equal(
      await frame.locator("html").evaluate(() =>
        window.__replayOutboundMessages.filter((message) => message.type === "LOCATOR_STATUS").length
      ),
      initialLocatorStatusCount,
      "a terminal result stability window must not reconnect every locator"
    );
  }

  await page.mouse.move(0, 0);
  await markerB.hover();
  await waitForMarkerPressed(frame, 9002);

  await frame.getByRole("button", { name: `${issues[1].title} 문제 위치` }).click();
  await waitForMarkerPressed(frame, 9002);
  assert.equal(await evidence.getByText("페이지 요소와 연결됐어요", { exact: true }).count(), 0);
  assert.equal(await evidence.getByText("재현 페이지 연결됨", { exact: true }).count(), 0);
  await page.waitForTimeout(50);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "FOCUS_ISSUE").length
    ),
    initialFocusMessageCount,
    "iframe-origin click selection must not echo FOCUS_ISSUE"
  );

  await page.evaluate(() => {
    window.postMessage({ source: "accessibility-page-replay", type: "ISSUE_SELECTED", issueId: 9001 }, "*");
  });
  await frame.locator("html").evaluate(() => {
    parent.postMessage({ source: "accessibility-page-replay", type: "ISSUE_SELECTED", issueId: "9001" }, "*");
  });
  await page.waitForTimeout(100);
  await waitForMarkerPressed(frame, 9002);

  await frame.locator("#blocked-link").click();
  await page.waitForTimeout(100);
  assert.equal(page.url(), `${baseUrl}/projects/1/pages/101`);
  assert.equal(await evidence.getByText(/검사 화면 안의 링크 이동은 차단했어요/).count(), 0);

  await frame.locator('[data-issue-id="9002"]').evaluate((marker) => marker.click());
  await waitForMarkerPressed(frame, 9002);

  assert.equal(await evidence.locator(".site-page-evidence-toolbar").count(), 0);
  assert.equal(await evidence.locator(".site-page-evidence-code-view").count(), 0);
  assert.equal(
    (await getReplayMessages(frame)).filter((message) => message.type === "SET_MARKERS_VISIBLE").length,
    0,
    "the dashboard must not send the removed marker-visibility command"
  );
  await verifyNoExternalReplayControls(evidence, frame);

  if (verificationScope === "core") {
    mkdirSync(outDir, { recursive: true });
    await evidence.screenshot({ path: `${outDir}/core.png` });
    return {
      scope: verificationScope,
      issueCount: initialMessage.issues.length,
      markerCount: await frame.locator(".replay-marker").count()
    };
  }

  const dimensions = await evidence.evaluate((element) => {
    const preview = element.querySelector(".site-page-evidence-preview");
    const frameElement = element.querySelector(".site-page-evidence-replay-frame");
    const contentZone = element.closest(".dashboard-site-content-zone");
    const cardRect = element.getBoundingClientRect();
    const contentRect = contentZone?.getBoundingClientRect();
    const contentStyle = contentZone ? getComputedStyle(contentZone) : null;
    const contentInnerTop = contentRect
      ? contentRect.top + Number.parseFloat(contentStyle?.paddingTop || "0")
      : cardRect.top;
    const contentInnerBottom = contentRect
      ? contentRect.bottom - Number.parseFloat(contentStyle?.paddingBottom || "0")
      : cardRect.bottom;
    const contentInnerHeight = Math.max(1, contentInnerBottom - contentInnerTop);
    const contentInnerWidth = contentRect
      ? Math.max(
          1,
          contentRect.width -
            Number.parseFloat(contentStyle?.paddingLeft || "0") -
            Number.parseFloat(contentStyle?.paddingRight || "0")
        )
      : cardRect.width;
    return {
      cardWidth: cardRect.width,
      cardHeight: cardRect.height,
      cardFillRatio: cardRect.height / contentInnerHeight,
      contentInnerWidth,
      unusedBottom: Math.max(0, contentInnerBottom - cardRect.bottom),
      viewportHeight: window.innerHeight,
      previewWidth: preview?.clientWidth ?? 0,
      previewHeight: preview?.clientHeight ?? 0,
      frameWidth: frameElement?.getBoundingClientRect().width ?? 0,
      frameHeight: frameElement?.getBoundingClientRect().height ?? 0,
      inspectorCount: element.querySelectorAll(".site-page-evidence-inspector").length,
      gridColumnCount: element.querySelector(".site-page-evidence-grid")
        ? getComputedStyle(element.querySelector(".site-page-evidence-grid")).gridTemplateColumns.split(" ").length
        : 0
    };
  });
  assert.ok(
    dimensions.cardWidth >= dimensions.contentInnerWidth * 0.65,
    `desktop evidence dimensions: ${JSON.stringify(dimensions)}`
  );
  assert.ok(dimensions.cardFillRatio >= 0.9);
  assert.ok(dimensions.unusedBottom <= Math.max(4, dimensions.viewportHeight * 0.01));
  assert.ok(dimensions.previewHeight >= dimensions.viewportHeight * 0.75);
  assert.ok(dimensions.previewWidth >= dimensions.cardWidth * 0.95, "replay must reclaim the inspector width");
  assert.equal(dimensions.inspectorCount, 0);
  assert.equal(dimensions.gridColumnCount, 1);
  assert.ok(
    Math.abs(dimensions.previewWidth - dimensions.frameWidth) <= 2,
    `replay width must fit the preview: ${JSON.stringify(dimensions)}`
  );
  assert.ok(
    Math.abs(dimensions.previewHeight - dimensions.frameHeight) <= 2,
    `replay height must fit the preview: ${JSON.stringify(dimensions)}`
  );

  mkdirSync(outDir, { recursive: true });
  await evidence.screenshot({ path: `${outDir}/desktop.png` });

  return dimensions;
}


async function verifyScaledReplayOverlays(page, evidence, frame) {
  const messages = await getReplayMessages(frame);
  const initIndex = messages.findIndex((message) => message.type === "INIT_ISSUES");
  const scaleIndex = messages.findIndex((message) => message.type === "SET_VIEW_SCALE");
  assert.ok(scaleIndex >= 0, "the parent must send replay viewport metrics");
  assert.ok(initIndex >= 0, "the replay must receive its initial issues");
  assert.ok(scaleIndex < initIndex, "SET_VIEW_SCALE must arrive before INIT_ISSUES");

  const scaleMessage = messages[scaleIndex];
  assert.equal(scaleMessage.documentToken, await frame.locator("html").evaluate(() => window.__replayDocumentToken));
  assert.ok(scaleMessage.scale >= 0.01 && scaleMessage.scale <= 1);
  assert.ok(scaleMessage.visualWidth > 0 && scaleMessage.visualWidth <= 16_384);

  const frameElement = evidence.locator("iframe.site-page-evidence-replay-frame");
  const frameMetrics = await frameElement.evaluate((element) => ({
    scale: Number.parseFloat(element.dataset.replayScale ?? ""),
    visualWidth: Number.parseFloat(element.dataset.replayVisualWidth ?? "")
  }));
  assert.ok(Math.abs(scaleMessage.scale - frameMetrics.scale) <= 0.001);
  assert.ok(Math.abs(scaleMessage.visualWidth - frameMetrics.visualWidth) <= 0.5);

  const marker = frame.locator('.replay-marker[data-issue-id="9001"]');
  const markerBox = await marker.boundingBox();
  assert.ok(markerBox, "the scaled replay marker must remain visible");
  assert.ok(Math.abs(markerBox.width - 24) <= 0.75, `scaled marker width: ${markerBox.width}`);
  assert.ok(Math.abs(markerBox.height - 24) <= 0.75, `scaled marker height: ${markerBox.height}`);

  await marker.hover();
  const tooltip = frame.locator(".replay-marker-description");
  await tooltip.waitFor({ state: "visible" });
  const tooltipTextBox = await tooltip.locator(".replay-marker-description__text").boundingBox();
  const tooltipBox = await tooltip.boundingBox();
  const previewBox = await evidence.locator(".site-page-evidence-preview").boundingBox();
  assert.ok(tooltipTextBox, "the scaled tooltip text must be measurable");
  assert.ok(tooltipBox && previewBox, "the scaled tooltip must remain in the replay preview");
  assert.ok(
    Math.abs(tooltipTextBox.height - 13) <= 0.75,
    `scaled tooltip 13px text probe: ${tooltipTextBox.height}`
  );
  assert.ok(tooltipBox.width <= previewBox.width - 20, "the scaled tooltip must fit the visual viewport");
  await page.mouse.move(0, 0);
}

/** Waits until every group has finished sliding open or folding away. */
async function settleGroupAnimations(panel) {
  await panel.evaluate(panel => Promise.all(panel.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
  await panel.page().waitForFunction(() => !document.querySelector('.site-unavailable-locator-panel__group-body[data-state="closing"]:not([hidden])'));
}

async function assertCompactUnavailablePanel(panel, context) {
  const geometry = await panel.evaluate(panel => {
    const rect = panel.getBoundingClientRect();
    const lines = [...panel.querySelectorAll(".site-unavailable-locator-panel__line")].map(line => {
      const bounds = line.getBoundingClientRect();
      const title = line.querySelector(".site-unavailable-locator-panel__line-title").getBoundingClientRect();
      const action = line.querySelector(".site-unavailable-locator-panel__action").getBoundingClientRect();
      return { overflow: line.scrollWidth - line.clientWidth,
        inside: bounds.left >= rect.left - 1 && bounds.right <= rect.right + 1,
        titleBeforeAction: title.right <= action.left + 1, actionInside: action.right <= bounds.right + 1,
        height: Math.round(bounds.height) };
    });
    return { panelOverflow: panel.scrollHeight - panel.clientHeight,
      horizontalOverflow: panel.scrollWidth - panel.clientWidth, lines };
  });
  assert.ok(geometry.panelOverflow <= 1 && geometry.horizontalOverflow <= 1,
    `${context}: the grouped list must grow with its findings instead of scrolling: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.lines.length > 0 && geometry.lines.every(line =>
    line.overflow <= 1 && line.inside && line.titleBeforeAction && line.actionInside),
    `${context}: each finding must stay one tidy line inside the card: ${JSON.stringify(geometry)}`);
  const heights = geometry.lines.map(line => line.height);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 1,
    `${context}: finding lines must share one height: ${JSON.stringify(geometry)}`);
}

async function verifyResponsiveWidths(page) {
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  const viewports = [
    { width: 3840, height: 2021 },
    { width: 2560, height: 1256 },
    { width: 2560, height: 1440 },
    { width: 1920, height: 1440 },
    { width: 3440, height: 1100 },
    { width: 2560, height: 900 },
    { width: 1920, height: 1080 },
    { width: 1024, height: 900 },
    { width: 768, height: 860 },
    { width: 390, height: 760 }
  ];
  const results = [];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.reload({ waitUntil: "domcontentloaded" });
    const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
    await evidence.waitFor({ state: "visible" });
    await waitForReplayReady(evidence);
    await waitForUnavailableLocatorCount(evidence, 2);
    const isFourK = viewport.width === 3840;
    // The grouped list grows with its findings instead of paging them; both
    // fixture groups start open, so every finding is listed at every size.
    const unavailableLocatorPanel = page.locator('.site-unavailable-locator-panel[data-locator-mode="unavailable"]');
    await unavailableLocatorPanel.locator(".site-unavailable-locator-panel__issue").first()
      .waitFor({ state: "visible", timeout: 5000 });
    const expectedVisibleUnavailableIssueCount = 2;
    const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
    await verifyNoExternalReplayControls(evidence, frame);

    const facts = await page.evaluate(() => {
      const card = document.querySelector(".site-page-evidence-card");
      const preview = document.querySelector(".site-page-evidence-preview");
      const frameElement = document.querySelector(".site-page-evidence-replay-frame");
      const rail = document.querySelector(".site-dashboard-rail");
      const unavailablePanel = document.querySelector(".site-unavailable-locator-panel");
      const unavailableIssues = unavailablePanel?.querySelector(
        ".site-unavailable-locator-panel__issues"
      );
      const unavailableIssue = unavailablePanel?.querySelector(
        ".site-unavailable-locator-panel__issue"
      );
      const unavailableMeta = unavailableIssue?.querySelector(
        ".site-unavailable-locator-panel__line"
      );
      const unavailableSeverity = unavailableMeta?.querySelector(
        ".site-unavailable-locator-panel__severity"
      );
      const unavailableCode = unavailableMeta?.querySelector(
        ".site-unavailable-locator-panel__line-main"
      );
      const cardRect = card?.getBoundingClientRect();
      const unavailablePanelRect = unavailablePanel?.getBoundingClientRect();
      const unavailableIssuesRect = unavailableIssues?.getBoundingClientRect();
      const unavailableSeverityRect = unavailableSeverity?.getBoundingClientRect();
      const unavailableCodeRect = unavailableCode?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        documentVerticalOverflow:
          document.documentElement.scrollHeight - document.documentElement.clientHeight,
        cardLeft: cardRect?.left ?? 0,
        cardRight: cardRect?.right ?? 0,
        removedToolbarFeatureCount: document.querySelectorAll(
          ".site-page-evidence-toolbar, .site-page-evidence-view-switch, .site-page-evidence-filter, .site-page-evidence-marker-toggle, .site-page-evidence-code-view"
        ).length,
        externalPagerCount: document.querySelectorAll(
          ".site-page-evidence-slider-controls, .site-page-evidence-slider-status, .site-page-evidence-slider-button"
        ).length,
        inspectorCount: document.querySelectorAll(".site-page-evidence-inspector").length,
        gridColumnCount: document.querySelector(".site-page-evidence-grid")
          ? getComputedStyle(document.querySelector(".site-page-evidence-grid")).gridTemplateColumns.split(" ").length
          : 0,
        previewFrameDelta: Math.abs(
          (preview?.getBoundingClientRect().width ?? 0) -
          (frameElement?.getBoundingClientRect().width ?? 0)
        ),
        unavailablePanelOverflow: unavailablePanel
          ? unavailablePanel.scrollWidth - unavailablePanel.clientWidth
          : Number.NaN,
        unavailablePanelVerticalOverflow: unavailablePanel
          ? unavailablePanel.scrollHeight - unavailablePanel.clientHeight
          : Number.NaN,
        unavailablePanelOverflowY: unavailablePanel
          ? getComputedStyle(unavailablePanel).overflowY
          : null,
        unavailableIssueCount:
          unavailablePanel?.querySelectorAll(".site-unavailable-locator-panel__issue").length ?? 0,
        unavailableIssueIds: unavailablePanel
          ? [...unavailablePanel.querySelectorAll(".site-unavailable-locator-panel__issue")].map(
              (issue) => issue.getAttribute("data-issue-id")
            )
          : [],
        unavailableIssuesVerticalOverflow: unavailableIssues
          ? unavailableIssues.scrollHeight - unavailableIssues.clientHeight
          : Number.NaN,
        unavailableIssuesOverflowY: unavailableIssues
          ? getComputedStyle(unavailableIssues).overflowY
          : null,
        unavailableIssuesCenterY: unavailableIssuesRect
          ? (unavailableIssuesRect.top + unavailableIssuesRect.bottom) / 2
          : Number.NaN,
        unavailableMetaOverflow: unavailableMeta
          ? unavailableMeta.scrollWidth - unavailableMeta.clientWidth
          : Number.NaN,
        locationActionsInsideCards: [...unavailablePanel.querySelectorAll(".site-unavailable-locator-panel__issue button")].every(button => {
          const rect = button.getBoundingClientRect();
          const card = button.closest(".site-unavailable-locator-panel__issue").getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= card.left && rect.right <= card.right + 1 && rect.top >= card.top && rect.bottom <= card.bottom + 1;
        }),
        unavailableBadgeGap:
          unavailableSeverityRect && unavailableCodeRect
            ? unavailableCodeRect.left - unavailableSeverityRect.right
            : Number.NaN,
        railVerticalOverflow: rail ? rail.scrollHeight - rail.clientHeight : Number.NaN,
        railOverflowY: rail ? getComputedStyle(rail).overflowY : null
      };
    });

    assert.ok(facts.documentOverflow <= 1, `${viewport.width}px viewport has document overflow`);
    assert.ok(facts.cardLeft >= -1 && facts.cardRight <= facts.viewportWidth + 1);
    assert.equal(facts.removedToolbarFeatureCount, 0, `${viewport.width}px must not render removed toolbar features`);
    assert.equal(facts.externalPagerCount, 0, `${viewport.width}px must not render an external replay pager`);
    assert.equal(facts.inspectorCount, 0, `${viewport.width}px must not render the removed inspector`);
    assert.equal(facts.gridColumnCount, 1, `${viewport.width}px replay layout must remain single-column`);
    assert.ok(facts.previewFrameDelta <= 2);
    assert.ok(
      facts.unavailablePanelOverflow <= 1 &&
        facts.unavailableMetaOverflow <= 1,
      `${viewport.width}px unavailable issue line must not overflow horizontally: ${JSON.stringify(facts)}`
    );
    assert.equal(
      facts.unavailableIssueCount,
      expectedVisibleUnavailableIssueCount,
      `${viewport.width}px must list every unavailable issue`
    );
    assert.equal(facts.locationActionsInsideCards, true, `${viewport.width}px location actions must remain visible inside each issue card`);
    await assertCompactUnavailablePanel(unavailableLocatorPanel, `${viewport.width}x${viewport.height}`);
    assert.ok(
      facts.unavailablePanelVerticalOverflow <= 1 && facts.unavailableIssuesVerticalOverflow <= 1 && facts.railVerticalOverflow <= 1,
      `${viewport.width}x${viewport.height} unavailable cards must fit their allocated height: ${JSON.stringify(facts)}`
    );
    assert.ok(
      facts.unavailableBadgeGap >= 4,
      `${viewport.width}px the finding must remain beside its severity badge: ${JSON.stringify(facts)}`
    );
    if (isFourK) {
      assert.deepEqual(
        facts.unavailableIssueIds,
        ["9003", "9004"],
        "4K must show every unavailable fixture issue together in source order"
      );
      assert.ok(
        facts.unavailablePanelVerticalOverflow <= 1 &&
          facts.unavailableIssuesVerticalOverflow <= 1 &&
          facts.railVerticalOverflow <= 1,
        `4K unavailable issues and rail must not overflow vertically: ${JSON.stringify(facts)}`
      );
      for (const [name, overflowY] of [
        ["panel", facts.unavailablePanelOverflowY],
        ["issues", facts.unavailableIssuesOverflowY],
        ["rail", facts.railOverflowY]
      ]) {
        assert.ok(
          overflowY !== "auto" && overflowY !== "scroll",
          `4K ${name} must not create a vertical scrollbar: ${JSON.stringify(facts)}`
        );
      }
      assert.ok(
        facts.documentVerticalOverflow <= 1,
        `4K dashboard must fit without outer vertical scrolling: ${JSON.stringify(facts)}`
      );
      mkdirSync(outDir, { recursive: true });
      await page.screenshot({
        path: path.join(outDir, "responsive-4k-unavailable-issues.png"),
        fullPage: false
      });
    }
    if (viewport.width === 2560 && viewport.height >= 1256) {
      await unavailableLocatorPanel.screenshot({ path: `${outDir}/unavailable-${viewport.width}x${viewport.height}.png` });
    }
    if ((viewport.width === 1920 && viewport.height === 1080) || isFourK) {
      await unavailableLocatorPanel.screenshot({ path: `${outDir}/unavailable-compact-${viewport.width}x${viewport.height}.png` });
    }
    if (viewport.width === 390) {
      await verifyScaledReplayOverlays(page, evidence, frame);
    }
    let fallback = null;
    if (viewport.width <= 768) {
      const initMessages = (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES");
      const initCount = initMessages.length;
      const fallbackIssue = initMessages.at(-1)?.issues.find((issue) => issue.id === 9001);
      assert.ok(fallbackIssue, `${viewport.width}px fixture must expose issue 9001`);
      await sendReplayTestMessage(frame, { type: "ISSUE_DETAIL_FALLBACK", issueId: 9001 });
      const detail = await assertFallbackDetail(page, evidence, fallbackIssue, viewport.width);
      assert.equal(
        (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES").length,
        initCount,
        `${viewport.width}px fallback rendering must not churn INIT_ISSUES`
      );

      if (viewport.width === 390) {
        await page.emulateMedia({ forcedColors: "active" });
        const forcedColorFacts = await evidence.locator(FALLBACK_DETAIL_SELECTOR).evaluate((element) =>
          [
            element,
            element.querySelector(".site-page-evidence-fallback-detail__tag"),
            element.querySelector(".site-page-evidence-fallback-detail__path")
          ].map((candidate) => {
            const style = getComputedStyle(candidate);
            return {
              borderStyle: style.borderStyle,
              borderWidth: Number.parseFloat(style.borderWidth),
              backgroundColor: style.backgroundColor,
              color: style.color,
              boxShadow: style.boxShadow
            };
          })
        );
        assert.ok(
          forcedColorFacts.every((fact) =>
            fact.borderStyle === "solid"
            && fact.borderWidth >= 1
            && fact.backgroundColor !== "rgba(0, 0, 0, 0)"
            && fact.color !== "rgba(0, 0, 0, 0)"
          ),
          "forced-colors fallback content must retain explicit visible boundaries"
        );
        assert.equal(forcedColorFacts[0].boxShadow, "none");
        await page.emulateMedia({ forcedColors: "none" });
      }

      await sendReplayTestMessage(frame, { type: "ISSUE_DETAIL_FALLBACK", issueId: null });
      await waitForNoFallbackDetail(evidence);
      fallback = {
        width: detail.rect.width,
        height: detail.rect.height,
        previewWidth: detail.previewRect.width,
        documentOverflow: detail.documentScrollWidth - detail.documentClientWidth
      };
    } else {
      assert.equal(
        await evidence.locator(FALLBACK_DETAIL_SELECTOR).count(),
        0,
        `${viewport.width}px ordinary desktop replay must not render an external detail card`
      );
    }
    results.push({ ...facts, fallback });
  }

  return results;
}

async function verifyUnavailableZoomResize(page) {
  await page.setViewportSize({ width: 1920, height: 980 });
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await waitForReplayReady(evidence);
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  for (const issue of issues) {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: issue.id, status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" });
  }
  const panel = page.locator('.site-unavailable-locator-panel[data-locator-mode="unavailable"]');
  await page.locator('.site-unavailable-locator-panel[data-unavailable-locator-count="4"]').waitFor();
  const toggles = panel.locator(".site-unavailable-locator-panel__group-toggle");
  const openStates = () => toggles.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-expanded")));
  // Groups already open stay open when more groups arrive; the user then
  // closes one, and that choice must survive every resize.
  await toggles.first().click();
  await settleGroupAnimations(panel);
  const chosen = await openStates();
  assert.ok(chosen.includes("true") && chosen.includes("false"), JSON.stringify(chosen));
  // Browser zoom changes the CSS viewport. Keep this document mounted while
  // crossing the compact padding breakpoint, then return to the original size.
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const [width, height] of [[1920, 980], [1536, 784], [1280, 653], [1920, 980]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await assertCompactUnavailablePanel(panel, `zoom round trip ${cycle}: ${width}x${height}`);
      assert.deepEqual(await openStates(), chosen, "zoom round trips must keep each group open or closed");
    }
  }
  await panel.screenshot({ path: `${outDir}/unavailable-zoom-restored.png` });
  return { cycles: 2, groupStatePreserved: true };
}

async function verifyUnavailableGroupResize(page) {
  await page.setViewportSize({ width: 2560, height: 1256 });
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await waitForReplayReady(evidence);
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  for (const issue of issues) {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: issue.id, status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" });
  }
  const panel = page.locator('.site-unavailable-locator-panel[data-locator-mode="unavailable"]');
  await page.locator('.site-unavailable-locator-panel[data-unavailable-locator-count="4"]').waitFor();
  const idsShown = () => panel.locator("[data-issue-id]").evaluateAll(cards => cards.map(card => card.dataset.issueId));
  const toggles = panel.locator(".site-unavailable-locator-panel__group-toggle");
  // Groups run from the most severe; open them all to list every finding.
  assert.deepEqual(await toggles.evaluateAll(buttons => buttons.map(button =>
    button.querySelector(".site-unavailable-locator-panel__code")?.textContent ?? "")).then(codes => codes.map(code => code.replace(/^\D+/, ""))),
  ["5.1.1", "5.4.3", "2.4.6", "3.1.5"]);
  for (let index = 0; index < await toggles.count(); index++) {
    if (await toggles.nth(index).getAttribute("aria-expanded") === "false") await toggles.nth(index).click();
  }
  await settleGroupAnimations(panel);
  assert.deepEqual(await idsShown(), ["9001", "9002", "9003", "9004"]);
  const heights = {};
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 3840, height: 2021 },
    { width: 2560, height: 1256 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1256 }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const key = `${viewport.width}x${viewport.height}`;
    await assertCompactUnavailablePanel(panel, key);
    assert.deepEqual(await idsShown(), ["9001", "9002", "9003", "9004"], `${key} must keep every finding listed`);
    const height = Math.round(await panel.evaluate(panel => panel.getBoundingClientRect().height));
    if (key in heights) assert.ok(Math.abs(height - heights[key]) <= 1, `${key} must return to its height without feedback growth`);
    heights[key] = height;
  }
  // Findings in another screen state join this list under their own chip.
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status: "HIDDEN_STATE", reason: "CAROUSEL_STATE_AVAILABLE", recoverable: true });
  await page.locator('.site-unavailable-locator-panel[data-hidden-state-locator-count="1"]').waitFor();
  assert.equal(await page.locator('.site-unavailable-locator-panel[data-locator-mode="recoverable"]').count(), 0);
  const stateChip = panel.locator(".site-unavailable-locator-panel__filter", { hasText: "다른 화면 상태" });
  await stateChip.click();
  assert.deepEqual(await idsShown(), ["9001"]);
  assert.match(await panel.locator('[data-issue-id="9001"] .site-unavailable-locator-panel__action').textContent(), /위치로 이동/);
  await assertCompactUnavailablePanel(panel, "other screen state filter");
  await panel.locator(".site-unavailable-locator-panel__filter", { hasText: "전체" }).click();
  assert.deepEqual(await idsShown(), ["9001", "9002", "9003", "9004"]);
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" });
  await page.locator('.site-unavailable-locator-panel[data-hidden-state-locator-count="1"]').waitFor({ state: "detached" });
  assert.equal(await panel.locator(".site-unavailable-locator-panel__filter").count(), 0,
    "one reason alone needs no chips");
  await panel.screenshot({ path: `${outDir}/unavailable-resize-grouped.png` });
  return { heights, otherScreenStateChip: "PASS" };
}

async function verifyMobile(page) {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.reload({ waitUntil: "domcontentloaded" });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await evidence.waitFor({ state: "visible" });
  await waitForReplayReady(evidence);
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  await verifyNoExternalReplayControls(evidence, frame);

  await page.locator(".site-unavailable-locator-panel__group-toggle").first().waitFor();
  await openUnavailableGroups(page);
  const mobileLocationButton = page.locator('[data-issue-id="9003"] .site-unavailable-locator-panel__line');
  await mobileLocationButton.click();
  const mobileLocationDialog = page.getByRole("dialog", { name: "문제 상세" });
  await mobileLocationDialog.waitFor({ state: "visible" });
  const locationGeometry = await mobileLocationDialog.evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    const close = dialog.querySelector('button[aria-label="문제 상세 닫기"]').getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      closeTop: close.top, closeBottom: close.bottom, overflow: dialog.scrollWidth - dialog.clientWidth };
  });
  assert.ok(locationGeometry.left >= 0 && locationGeometry.right <= 320 && locationGeometry.top >= 0 && locationGeometry.bottom <= 568);
  assert.ok(locationGeometry.closeTop >= 0 && locationGeometry.closeBottom <= 568 && locationGeometry.overflow <= 1);
  await mobileLocationDialog.screenshot({ path: `${outDir}/mobile-issue-location.png` });
  const mobileLocationBody = mobileLocationDialog.getByRole("region", { name: "문제 상세 내용" });
  await mobileLocationBody.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const body = document.querySelector(".site-issue-location-dialog__body");
    return body && body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
  });
  await mobileLocationDialog.getByRole("button", { name: "문제 상세 닫기" }).click();
  await mobileLocationDialog.waitFor({ state: "detached" });

  const facts = await page.evaluate(() => {
    const evidenceElement = document.querySelector(".site-page-evidence-card");
    const preview = document.querySelector(".site-page-evidence-preview");
    const frameElement = document.querySelector(".site-page-evidence-replay-frame");
    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      evidenceWidth: evidenceElement?.getBoundingClientRect().width ?? 0,
      previewWidth: preview?.getBoundingClientRect().width ?? 0,
      frameWidth: frameElement?.getBoundingClientRect().width ?? 0,
      removedToolbarFeatureCount: document.querySelectorAll(
        ".site-page-evidence-toolbar, .site-page-evidence-view-switch, .site-page-evidence-filter, .site-page-evidence-marker-toggle, .site-page-evidence-code-view"
      ).length,
      externalPagerCount: document.querySelectorAll(
        ".site-page-evidence-slider-controls, .site-page-evidence-slider-status, .site-page-evidence-slider-button"
      ).length
    };
  });
  assert.ok(facts.documentOverflow <= 1);
  assert.ok(facts.evidenceWidth <= 320);
  assert.ok(Math.abs(facts.previewWidth - facts.frameWidth) <= 2);
  assert.equal(facts.externalPagerCount, 0, "mobile must not render an external replay pager");
  assert.equal(facts.removedToolbarFeatureCount, 0, "mobile must not render removed toolbar features");

  const initialMessages = (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES");
  const initialInitCount = initialMessages.length;
  const mobileFallbackIssue = initialMessages.at(-1)?.issues.find((issue) => issue.id === 9001);
  assert.ok(mobileFallbackIssue, "mobile fixture must expose issue 9001");
  await sendReplayTestMessage(frame, { type: "ISSUE_DETAIL_FALLBACK", issueId: 9001 });
  const fallback = await assertFallbackDetail(page, evidence, mobileFallbackIssue, 320);
  assert.equal(
    (await getReplayMessages(frame)).filter((message) => message.type === "INIT_ISSUES").length,
    initialInitCount,
    "showing the mobile fallback must not reinitialize marker DOM"
  );
  await evidence.screenshot({ path: `${outDir}/mobile-fallback.png` });

  await sendReplayTestMessage(frame, { type: "ISSUE_DETAIL_FALLBACK", issueId: null });
  await waitForNoFallbackDetail(evidence);
  const scrollBeforeSelection = await page.evaluate(() => {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.min(240, Math.floor(maxScroll / 2)));
    return window.scrollY;
  });
  assert.ok(scrollBeforeSelection > 0, "mobile fixture must have an outer scroll range");
  await frame.locator('[data-issue-id="9002"]').evaluate((marker) => marker.click());
  await waitForMarkerPressed(frame, 9002);
  await page.waitForTimeout(150);
  const scrollAfterSelection = await page.evaluate(() => window.scrollY);
  assert.ok(
    Math.abs(scrollAfterSelection - scrollBeforeSelection) <= 1,
    `issue synchronization moved the outer page: ${scrollBeforeSelection} -> ${scrollAfterSelection}`
  );
  assert.equal(
    await evidence.locator(FALLBACK_DETAIL_SELECTOR).count(),
    0,
    "issue synchronization must not resurrect stale fallback details"
  );

  let reloadedFrame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  await sendReplayTestMessage(reloadedFrame, { type: "ISSUE_DETAIL_FALLBACK", issueId: 9001 });
  await evidence.locator(FALLBACK_DETAIL_SELECTOR).waitFor({ state: "visible" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await evidence.waitFor({ state: "visible" });
  await waitForNoFallbackDetail(evidence);
  await waitForReplayReady(evidence);
  reloadedFrame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  assert.equal(
    (await getReplayMessages(reloadedFrame)).filter((message) => message.type === "INIT_ISSUES").length,
    1,
    "a dashboard reload must initialize the replacement replay exactly once and keep stale fallback details cleared"
  );

  await evidence.screenshot({ path: `${outDir}/mobile.png` });
  return {
    ...facts,
    fallback: {
      width: fallback.rect.width,
      height: fallback.rect.height,
      previewWidth: fallback.previewRect.width,
      documentOverflow: fallback.documentScrollWidth - fallback.documentClientWidth
    }
  };
}

async function verifyEvidenceStatusFeedback(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page);
  let metadataRequests = 0;
  let sessionRequests = 0;
  let failSession = true;
  let releaseMetadata;
  const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
  await page.route("**/api/results/requests/501/capture-metadata", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    metadataRequests += 1;
    if (metadataRequests === 1) {
      await fulfillJson(route, null, { status: 500 });
      return;
    }
    if (metadataRequests === 2) await metadataGate;
    await fulfillJson(route, captureMetadata);
  });
  await page.route("**/api/results/requests/501/live-session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sessionRequests += 1;
    await fulfillJson(route, failSession ? null : liveSession, { status: failSession ? 503 : 200 });
  });

  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  const panel = page.locator('.site-unavailable-locator-panel[data-locator-mode="unavailable"]');
  const successNotice = page.getByText("모든 문제가 화면에 표시되고 있습니다.", { exact: true });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  const captureStatus = page.locator(".site-capture-metadata-status");
  await panel.locator('[role="status"]').filter({ hasText: "문제 위치를 확인할 수 없습니다" }).waitFor();
  assert.equal(await panel.getAttribute("data-locator-check-state"), "error");
  assert.equal(await panel.getAttribute("data-unavailable-locator-count"), null);
  assert.equal(await successNotice.count(), 0);
  await captureStatus.filter({ hasText: "분석 당시 화면 정보를 불러오지 못했습니다" }).waitFor();
  assert.equal(await captureStatus.getAttribute("role"), "alert");
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: `${outDir}/status-feedback-error.png` });

  const sessionRequestsBeforeMetadataRetry = sessionRequests;
  await page.getByRole("button", { name: "화면 정보 다시 불러오기", exact: true }).click();
  await captureStatus.filter({ hasText: "화면 정보를 불러오는 중" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "화면 정보 다시 불러오기", exact: true }).count(), 0);
  releaseMetadata();
  await captureStatus.waitFor({ state: "detached" });
  assert.equal(metadataRequests, 2, "retry must issue exactly one fresh metadata request");
  assert.equal(sessionRequests, sessionRequestsBeforeMetadataRetry, "metadata retry must not recreate the live session");

  failSession = false;
  holdNextReplayReady = true;
  holdNextLocatorStatuses = true;
  await evidence.getByRole("button", { name: "다시 시도", exact: true }).click();
  await panel.locator('[role="status"]').filter({ hasText: "문제 위치를 확인하고 있습니다" }).waitFor();
  assert.equal(await successNotice.count(), 0);
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  await frame.locator("header").waitFor();
  const identity = evidence.locator(".site-page-evidence-chrome__identity");
  assert.equal(await identity.isVisible(), false, "favicon and title stay hidden while the page loads");
  assert.equal(await evidence.getByText("제목 불러오는 중", { exact: true }).count(), 0);
  await frame.locator("html").evaluate(() => window.__sendReplayReady());
  await waitForReplayConnectionState(evidence, "ready");
  await sendReplayTestMessage(frame, { type: "DOCUMENT_TITLE", title: "로딩을 마친 웹페이지" });
  await identity.getByRole("heading", { name: "로딩을 마친 웹페이지", exact: true }).waitFor();
  await waitForReplayMessage(frame, (message) => message.type === "INIT_ISSUES");
  assert.equal(await panel.getAttribute("data-locator-check-state"), "loading", "ready document must still wait for locator results");
  assert.equal(await successNotice.count(), 0);
  await frame.locator("html").evaluate(() => window.__releaseLocatorStatuses(1));
  await page.waitForTimeout(80);
  assert.equal(await panel.getAttribute("data-locator-check-state"), "loading", "partial locator results must not count as complete");
  assert.equal(await successNotice.count(), 0);
  await frame.locator("html").evaluate(() => window.__releaseLocatorStatuses());
  await page.locator('[data-locator-check-state="ready"][data-unavailable-locator-count="2"]').waitFor();
  assert.ok(Number(await evidence.locator("iframe").getAttribute("data-replay-scale")) < 1,
    "successful metadata retry must restore the captured-width fit scale");
  for (const issue of issues) {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: issue.id, status: "CONNECTED" });
  }
  await successNotice.waitFor();
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status: "HIDDEN_STATE", recoverable: true });
  // A finding in another screen state is listed here rather than in a separate panel.
  await page.locator('.site-unavailable-locator-panel[data-hidden-state-locator-count="1"]').waitFor();
  await openUnavailableGroups(page);
  await page.locator('.site-unavailable-locator-panel[data-hidden-state-locator-count="1"] [data-issue-id="9001"]').waitFor();
  assert.equal(await successNotice.count(), 0, "recoverable hidden issues must not be described as already visible");

  // A fresh document must discard previously complete locator results.
  holdNextReplayReady = true;
  await frame.locator("html").evaluate(() => window.location.reload());
  await panel.locator('[role="status"]').filter({ hasText: "문제 위치를 확인하고 있습니다" }).waitFor();
  assert.equal(await successNotice.count(), 0);
  await page.screenshot({ path: `${outDir}/status-feedback-loading.png` });
  return { locatorStates: ["error", "loading", "ready"], metadataRetry: "PASS" };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const chartDimensionWarnings = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && message.text().includes("error boundary")) {
    pageErrors.push(message.text());
    console.error(message.text());
  }
  if (message.type() === "warning" && /width\(-1\).*height\(-1\).*chart/.test(message.text())) {
    chartDimensionWarnings.push(message.text());
  }
});

try {
  await installFixture(page);
  const issueDescription = verificationScope === "scale" ? null : await verifyUnavailableIssueDescription(page);
  if (verificationScope !== "scale") {
    await verifyMetadataBeforeResultDetails(page);
  }
  const desktop = verificationScope === "scale" ? null : await verifyDesktop(page);
  const zoomResize = await verifyUnavailableZoomResize(page);
  let responsive = null;
  let groupResize = null;
  let mobile = null;
  if (verificationScope === "full") {
    responsive = await verifyResponsiveWidths(page);
    mobile = await verifyMobile(page);
  } else if (verificationScope === "scale") {
    responsive = await verifyResponsiveWidths(page);
  }
  if (verificationScope !== "core") {
    groupResize = await verifyUnavailableGroupResize(page);
  }
  let statusFeedback = null;
  let locatorBatchReconnect = null;
  if (verificationScope !== "scale") {
    const feedbackPage = await browser.newPage();
    feedbackPage.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      statusFeedback = await verifyEvidenceStatusFeedback(feedbackPage);
    } finally {
      await feedbackPage.close();
    }
    const reconnectPage = await browser.newPage();
    reconnectPage.on("pageerror", error => pageErrors.push(error.message));
    try {
      locatorBatchReconnect = await verifyLocatorBatchReconnect(reconnectPage);
    } finally {
      await reconnectPage.close();
    }
  }
  assert.deepEqual(pageErrors, []);
  apiFixtures.forEach((fixture) => fixture.assertIsolated());
  assert.deepEqual(chartDimensionWarnings, [], "charts must not render with negative initial dimensions");
  console.log(JSON.stringify({ result: "PASS", scope: verificationScope, issueDescription, desktop, zoomResize, responsive, groupResize, mobile, statusFeedback, locatorBatchReconnect }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
