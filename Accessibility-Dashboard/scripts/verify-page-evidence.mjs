import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
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
  expiresAt: "2099-12-31T23:59:59Z"
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
      .replay-marker[data-issue-id="9002"] { left: 78px; top: 120px; background: #e77922; }
      .replay-marker-description { position: fixed; left: 32px; top: 164px; z-index: 10002; width: min(320px, calc(var(--replay-visual-width) - 24px)); padding: 10px; border: 1px solid #cbd3dc; border-radius: 8px; background: #fff; color: #18202b; font: 400 13px/13px Arial, sans-serif; transform: scale(var(--replay-overlay-inverse-scale)); transform-origin: top left; }
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
        const pendingEvents = [];
        const pendingLocatorStatuses = [];
        window.__releaseLocatorStatuses = (count = pendingLocatorStatuses.length) => {
          pendingLocatorStatuses.splice(0, count).forEach(send);
        };
        window.__replayMessages = messages;
        window.__replayOutboundMessages = outboundMessages;
        window.__replayDocumentToken = DOCUMENT_TOKEN;

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

function payloadFor(pathname) {
  if (pathname === "/api/requests") {
    dashboardRequestFetchCount += 1;
    return [request];
  }
  if (pathname === "/api/organizations") return [organization];
  if (pathname === "/api/organizations/1/evaluation-targets") return [target];
  if (pathname === "/api/results/requests/501/summary") return summary;
  if (pathname === "/api/results/requests/501/issues") {
    issueResponseFetchCount += 1;
    return issues;
  }
  if (pathname === "/api/results/requests/501/capture-metadata") return captureMetadata;
  if (pathname === "/api/targets/101") return target;
  return [];
}

async function installFixture(page) {
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const pathname = requestUrl.pathname;
    if (requestUrl.origin === viewerOrigin) {
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
      return;
    }
    if (route.request().method() === "GET" && pathname === "/api/dashboard/overview") {
      dashboardRequestFetchCount += 1;
      await fulfillJson(route, overview);
      return;
    }
    if (
      route.request().method() === "POST" &&
      pathname === "/api/results/requests/501/live-session"
    ) {
      await fulfillJson(route, liveSession);
      return;
    }

    if (pathname === "/api/results/requests/501/issues" && nextIssueResponseGate) {
      const gate = nextIssueResponseGate;
      nextIssueResponseGate = null;
      gate.markStarted();
      await gate.releasePromise;
    }

    await fulfillJson(route, payloadFor(pathname));
  });
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

async function waitForUnavailableLocatorCount(evidence, expectedCount, timeoutMs = 5_000) {
  const preview = evidence.locator(".site-page-evidence-preview");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await preview.getAttribute("data-unavailable-locator-count") === String(expectedCount)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for unavailable locator count ${expectedCount}`);
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
  await waitForUnavailableLocatorCount(evidence, 2);
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
  const unavailableIssueCards = unavailableLocatorPanel.locator(
    ".site-unavailable-locator-panel__issue"
  );
  const unavailablePosition = unavailableLocatorPanel.locator(
    ".site-unavailable-locator-panel__position"
  );
  const previousUnavailableIssue = unavailableLocatorPanel.getByRole("button", {
    name: "이전 문제"
  });
  const nextUnavailableIssue = unavailableLocatorPanel.getByRole("button", {
    name: "다음 문제"
  });
  assert.equal(await unavailableIssueCards.count(), 1);
  assert.deepEqual(
    await unavailableIssueCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-issue-id"))
    ),
    ["9003"],
    "the first unavailable issue must be shown on its own"
  );
  assert.match(await unavailablePosition.textContent(), /총 2건 중 1번째 문제/);
  assert.match(await unavailablePosition.getAttribute("class"), /\bsr-only\b/);
  const unavailablePositionBox = await unavailablePosition.boundingBox();
  assert.ok(
    unavailablePositionBox &&
      unavailablePositionBox.width <= 1 &&
      unavailablePositionBox.height <= 1,
    `the issue position status must be visually hidden: ${JSON.stringify(unavailablePositionBox)}`
  );
  assert.equal(await previousUnavailableIssue.isDisabled(), true);
  assert.equal(await nextUnavailableIssue.isDisabled(), false);
  assert.equal((await previousUnavailableIssue.textContent())?.trim(), "");
  assert.equal((await nextUnavailableIssue.textContent())?.trim(), "");
  assert.match(await previousUnavailableIssue.getAttribute("class"), /\bsr-only\b/, "arrow buttons stay for keyboard and screen readers only");
  assert.equal(
    await unavailableLocatorPanel.locator(".site-unavailable-locator-panel__dot").count(),
    2,
    "the pager must only offer pages that exist"
  );
  const pageDots = unavailableLocatorPanel.locator(".site-unavailable-locator-panel__dot");
  assert.equal(await pageDots.first().getAttribute("aria-current"), "true", "the first page indicator must be on the left");
  const missingBannerCard = unavailableLocatorPanel.locator('[data-issue-id="9003"]');
  assert.match(await missingBannerCard.textContent(), /중간/);
  assert.match(await missingBannerCard.textContent(), /KWCAG 2\.4\.6/);
  assert.match(await missingBannerCard.textContent(), /사라진 배너 제목 구조가 올바르지 않습니다/);
  assert.match(await missingBannerCard.textContent(), /현재 재현 DOM에는 이 요소가 없습니다/);
  assert.equal(await missingBannerCard.locator(".site-unavailable-locator-panel__reason").textContent(), "요소를 찾지 못함");
  const locationButton = missingBannerCard.getByRole("button", { name: "위치 정보", exact: true });
  await locationButton.click();
  const locationDialog = page.getByRole("dialog", { name: "문제 위치 정보" });
  await locationDialog.waitFor({ state: "visible" });
  assert.equal(await missingBannerCard.count(), 1, "opening location details must not paginate the issue card");
  assert.match(await locationDialog.getByRole("region", { name: "분석 당시 요소 경로" }).textContent(), /#missing-promotion-title/);
  assert.equal(await locationDialog.locator("pre code").textContent(), issues[2].locator.htmlSnippet);
  assert.equal(await locationDialog.locator("#missing-promotion-title").count(), 0, "recorded HTML must be displayed as text, not rendered");
  assert.deepEqual(await locationDialog.getByRole("region", { name: "분석 당시 좌표" }).locator("dl > div").evaluateAll(cells =>
    cells.map(cell => [cell.querySelector("dt").textContent, cell.querySelector("dd").textContent])),
    [["X", "48"], ["Y", "960"], ["너비", "320"], ["높이", "44"]]);
  assert.match(await locationDialog.textContent(), /문서 왼쪽 위 기준/);
  const closeLocation = locationDialog.getByRole("button", { name: "위치 정보 닫기" });
  assert.deepEqual(await locationDialog.getByRole("button").evaluateAll(buttons =>
    buttons.map(button => button.getAttribute("aria-label") ?? button.textContent.trim())), ["위치 정보 닫기"]);
  mkdirSync(outDir, { recursive: true });
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(dark => document.documentElement.classList.contains("dark") === dark, colorScheme === "dark");
    assert.equal(await locationDialog.evaluate(dialog => Array.from(dialog.querySelectorAll("section, pre, code, dl")).some(element =>
      element.scrollWidth > element.clientWidth + 1)), false, "saved evidence must wrap within the modal in both themes");
    await locationDialog.screenshot({ path: `${outDir}/desktop-issue-location-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  const locationBody = locationDialog.getByRole("region", { name: "저장된 위치 정보" });
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
    await locationDialog.getByRole("heading", { name: label, exact: true }).waitFor({ state: "visible" });
    assert.equal(await missingBannerCard.locator(".site-unavailable-locator-panel__reason").textContent(), label);
  }
  assert.doesNotMatch(await locationDialog.textContent(), /UNRECOGNIZED_REASON/);
  await page.keyboard.press("Escape");
  await locationDialog.waitFor({ state: "detached" });
  assert.equal(await locationButton.evaluate(button => document.activeElement === button), true);
  await locationButton.click();
  const beforeLocationClose = (await getReplayMessages(frame)).filter(message => message.type === "FOCUS_ISSUE").length;
  await closeLocation.click();
  await locationDialog.waitFor({ state: "detached" });
  assert.equal((await getReplayMessages(frame)).filter(message => message.type === "FOCUS_ISSUE").length, beforeLocationClose,
    "closing location information must not request another location search");
  await unavailableLocatorPanel.evaluate((panel) => {
    window.__pagerTransitions = [];
    panel.addEventListener("transitionrun", (event) => {
      if (event.target.closest(".site-unavailable-locator-panel__dot")) {
        window.__pagerTransitions.push(event.propertyName);
      }
    });
  });
  await pageDots.last().click();
  const readingLevelCard = unavailableLocatorPanel.locator('[data-issue-id="9004"]');
  await readingLevelCard.waitFor({ state: "visible" });
  await page.waitForFunction(() => window.__pagerTransitions.includes("width"), null, { timeout: 1000 });
  assert.ok(await page.evaluate(() => window.__pagerTransitions.includes("width")),
    `clicking a page dot must animate the dot-to-pill transition: ${JSON.stringify(await pageDots.evaluateAll(dots => ({
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      events: window.__pagerTransitions,
      dots: dots.map(dot => ({ active:dot.getAttribute("aria-current"), html:dot.innerHTML, transition:getComputedStyle(dot.firstElementChild || dot).transition }))
    })))}`);
  await unavailableLocatorPanel.evaluate(panel => Promise.all(
    panel.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))
  ));
  assert.equal(await unavailableIssueCards.count(), 1);
  assert.match(await unavailablePosition.textContent(), /총 2건 중 2번째 문제: 읽기 수준/);
  assert.equal(await pageDots.last().getAttribute("aria-current"), "true", "the last page indicator must be on the right");
  assert.equal(await previousUnavailableIssue.isDisabled(), false);
  assert.equal(await nextUnavailableIssue.isDisabled(), true);
  assert.match(await readingLevelCard.textContent(), /낮음/);
  assert.match(await readingLevelCard.textContent(), /KWCAG 3\.1\.5/);
  assert.match(await readingLevelCard.textContent(), /읽기 수준/);
  assert.match(await readingLevelCard.textContent(), /건축학부 제70회 졸업 전시회 개최/);
  await readingLevelCard.getByRole("button", { name: "위치 정보", exact: true }).click();
  await locationDialog.waitFor({ state: "visible" });
  assert.match(await locationDialog.textContent(), /저장된 요소 경로가 없습니다/);
  assert.match(await locationDialog.textContent(), /저장된 HTML이 없습니다/);
  assert.match(await locationDialog.textContent(), /저장된 좌표가 없습니다/);
  await closeLocation.click();
  await locationDialog.waitFor({ state: "detached" });
  const readingLevelBadgeLayout = await readingLevelCard.evaluate((card) => {
    const severityRect = card
      .querySelector(".site-unavailable-locator-panel__severity")
      ?.getBoundingClientRect();
    const codeRect = card
      .querySelector(".site-unavailable-locator-panel__code")
      ?.getBoundingClientRect();

    return {
      gap: severityRect && codeRect ? codeRect.left - severityRect.right : Number.NaN,
      rowDelta: severityRect && codeRect
        ? Math.abs((codeRect.top + codeRect.bottom) / 2 - (severityRect.top + severityRect.bottom) / 2)
        : Number.NaN
    };
  });
  assert.ok(
    readingLevelBadgeLayout.gap >= 4 && readingLevelBadgeLayout.rowDelta <= 2,
    `the WCAG code must share the severity badge's row, to its right: ${JSON.stringify(readingLevelBadgeLayout)}`
  );
  assert.equal(await unavailablePosition.getAttribute("role"), "status");
  assert.equal(await unavailablePosition.getAttribute("aria-live"), "polite");
  assert.equal(await unavailablePosition.getAttribute("aria-atomic"), "true");
  const unavailableNavigationLayout = await unavailableLocatorPanel.evaluate((panel) => {
    const issueRect = panel
      .querySelector(".site-unavailable-locator-panel__issue")
      ?.getBoundingClientRect();
    const previousRect = panel
      .querySelector(".site-unavailable-locator-panel__navigation--previous")
      ?.getBoundingClientRect();
    const nextRect = panel
      .querySelector(".site-unavailable-locator-panel__navigation--next")
      ?.getBoundingClientRect();
    const previousButton = panel.querySelector(
      ".site-unavailable-locator-panel__navigation--previous"
    );
    const nextButton = panel.querySelector(
      ".site-unavailable-locator-panel__navigation--next"
    );

    return {
      issue: issueRect && {
        bottom: issueRect.bottom,
        centerY: (issueRect.top + issueRect.bottom) / 2,
        left: issueRect.left,
        right: issueRect.right
      },
      next: nextRect && nextButton && {
        borderRadius: Number.parseFloat(getComputedStyle(nextButton).borderRadius),
        centerX: (nextRect.left + nextRect.right) / 2,
        centerY: (nextRect.top + nextRect.bottom) / 2,
        height: nextRect.height,
        left: nextRect.left,
        width: nextRect.width
      },
      previous: previousRect && previousButton && {
        borderRadius: Number.parseFloat(getComputedStyle(previousButton).borderRadius),
        centerX: (previousRect.left + previousRect.right) / 2,
        centerY: (previousRect.top + previousRect.bottom) / 2,
        height: previousRect.height,
        right: previousRect.right,
        width: previousRect.width
      }
    };
  });
  assert.ok(unavailableNavigationLayout.issue);
  assert.ok(unavailableNavigationLayout.previous);
  assert.ok(unavailableNavigationLayout.next);
  {
    const dotsLayout = await unavailableLocatorPanel.evaluate((panel) => {
      const issue = panel.querySelector(".site-unavailable-locator-panel__issue")?.getBoundingClientRect();
      const dots = panel.querySelector(".site-unavailable-locator-panel__dots")?.getBoundingClientRect();
      return issue && dots
        ? {
            issueCenterX: (issue.left + issue.right) / 2,
            issueBottom: issue.bottom,
            dotsCenterX: (dots.left + dots.right) / 2,
            dotsTop: dots.top
          }
        : null;
    });
    assert.ok(dotsLayout, "the page dots must be measurable");
    assert.ok(
      Math.abs(dotsLayout.dotsCenterX - dotsLayout.issueCenterX) <= 2 && dotsLayout.dotsTop > dotsLayout.issueBottom,
      `the page dots must be centered under the issue card: ${JSON.stringify(dotsLayout)}`
    );
  }
  const unavailablePanelOverflow = await unavailableLocatorPanel.evaluate((panel) => ({
    clientWidth: panel.clientWidth,
    scrollWidth: panel.scrollWidth,
    issueListClientWidth:
      panel.querySelector(".site-unavailable-locator-panel__issues")?.clientWidth ?? 0,
    issueListScrollWidth:
      panel.querySelector(".site-unavailable-locator-panel__issues")?.scrollWidth ?? 0,
    paginationClientWidth:
      panel.querySelector(".site-unavailable-locator-panel__pagination")?.clientWidth ?? 0,
    paginationScrollWidth:
      panel.querySelector(".site-unavailable-locator-panel__pagination")?.scrollWidth ?? 0
  }));
  assert.ok(
    unavailablePanelOverflow.scrollWidth <= unavailablePanelOverflow.clientWidth + 1 &&
      unavailablePanelOverflow.issueListScrollWidth <=
        unavailablePanelOverflow.issueListClientWidth + 1 &&
      unavailablePanelOverflow.paginationScrollWidth <=
        unavailablePanelOverflow.paginationClientWidth + 1,
    `unavailable issue cards must not create horizontal overflow: ${JSON.stringify(unavailablePanelOverflow)}`
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
  for (const [key, issueId] of [["ArrowLeft", "9003"], ["ArrowRight", "9004"]]) {
    await page.evaluate(() => { window.__pagerTransitions = []; });
    await pageDots.last().press(key);
    await unavailableLocatorPanel.locator(`[data-issue-id="${issueId}"]`).waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__pagerTransitions.includes("width"), null, { timeout: 1000 });
    assert.ok(await page.evaluate(() => window.__pagerTransitions.includes("width")),
      "keyboard page navigation must also animate the indicator");
    await unavailableLocatorPanel.evaluate(panel => Promise.all(
      panel.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))
    ));
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { window.__pagerTransitions = []; });
  for (const dot of [pageDots.first(), pageDots.last()]) {
    await dot.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  assert.deepEqual(await page.evaluate(() => window.__pagerTransitions), [],
    "reduced-motion users must be able to navigate without pager animation");
  assert.equal(await unavailableIssueCards.first().getAttribute("data-issue-id"), "9004");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Live pages can change locator visibility without any dashboard interaction.
  // Updating the page count must not replay a dot-to-pill animation under an idle pointer.
  await pageDots.last().hover();
  await unavailableLocatorPanel.evaluate((panel) => {
    window.__idlePagerTransitions = [];
    panel.addEventListener("transitionrun", (event) => {
      if (event.target.closest(".site-unavailable-locator-panel__dot")) {
        window.__idlePagerTransitions.push(event.propertyName);
      }
    });
  });
  for (const [status, count] of [["UNAVAILABLE", 3], ["CONNECTED", 2], ["UNAVAILABLE", 3], ["CONNECTED", 2]]) {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status });
    await waitForUnavailableLocatorCount(evidence, count);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await unavailableIssueCards.first().getAttribute("data-issue-id"), "9004",
      "background locator updates must preserve the issue the user is reading");
    assert.equal(await pageDots.last().getAttribute("aria-current"), "true",
      "the selected last-page indicator must remain on the right after a background update");
    assert.equal(await pageDots.nth(1).evaluate(dot => dot === document.activeElement), true,
      "background updates must preserve focus on the existing page button");
  }
  assert.deepEqual(await page.evaluate(() => window.__idlePagerTransitions), [],
    "background locator updates must not animate the pager");
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
  assert.deepEqual(
    await unavailableIssueCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-issue-id"))
    ),
    ["9004"],
    "unknown locator statuses must not replace the currently displayed issue"
  );
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9003, status: "CONNECTED" });
  await waitForUnavailableLocatorCount(evidence, 1);
  await page
    .locator('.site-unavailable-locator-panel[data-unavailable-locator-count="1"]')
    .waitFor({ state: "visible" });
  assert.deepEqual(
    await unavailableIssueCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-issue-id"))
    ),
    ["9004"],
    "reconnected issues must be removed without changing the remaining card"
  );
  assert.match(await unavailablePosition.textContent(), /총 1건 중 1번째 문제/);
  assert.equal(await previousUnavailableIssue.isDisabled(), true);
  assert.equal(await nextUnavailableIssue.isDisabled(), true);
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
  const hiddenStatePanel = page.locator(
    '.site-unavailable-locator-panel[data-locator-mode="recoverable"]'
  );
  await hiddenStatePanel.waitFor({ state: "visible" });
  assert.equal(
    await evidence.locator(".site-page-evidence-preview").getAttribute("data-hidden-state-locator-count"),
    "1"
  );
  assert.match(await hiddenStatePanel.textContent(), /다른 화면 상태의 문제/);
  const beforeHiddenFocusRequest = Number(await evidence.locator(".site-page-evidence-preview").getAttribute("data-focus-request-id"));
  await hiddenStatePanel.getByRole("button", { name: "해당 장면에서 보기" }).click();
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
  assert.deepEqual(
    await unavailableIssueCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-issue-id"))
    ),
    ["9003"]
  );
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
  assert.deepEqual(
    await unavailableIssueCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-issue-id"))
    ),
    ["9003"]
  );
  assert.match(await unavailablePosition.textContent(), /총 2건 중 1번째 문제/);
  assert.equal(await previousUnavailableIssue.isDisabled(), true);
  assert.equal(await nextUnavailableIssue.isDisabled(), false);
  await nextUnavailableIssue.dispatchEvent("click"); // 화면에서 숨긴 스크린리더용 버튼
  await unavailableLocatorPanel.locator('[data-issue-id="9004"]').waitFor({ state: "visible" });
  assert.deepEqual(
    await unavailableIssueCards.evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-issue-id"))
    ),
    ["9004"]
  );
  assert.match(await unavailablePosition.textContent(), /총 2건 중 2번째 문제/);
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

    return {
      cardCount: cards.length,
      // Trailing slack between the last card and the rail box.
      trailingSlack: lastRect ? Math.round(railRect.bottom - lastRect.bottom) : 0
    };
  });
  assert.ok(
    railLayout.cardCount >= 2,
    `the rail must stack the trend card with detail cards: ${JSON.stringify(railLayout)}`
  );
  assert.ok(
    railLayout.trailingSlack <= 4,
    `the rail must not end in dead space: ${JSON.stringify(railLayout)}`
  );

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
    const expectedVisibleUnavailableIssueCount = isFourK || viewport.height >= 1256 ? 2 : 1;
    const unavailableLocatorPanel = page.locator(
      `.site-unavailable-locator-panel[data-visible-issue-count="${expectedVisibleUnavailableIssueCount}"]`
    );
    await unavailableLocatorPanel.waitFor({ state: "visible", timeout: 5000 }).catch(async error => {
      const layout = await page.locator(".site-unavailable-locator-panel").evaluate(panel => {
        const list = panel.querySelector(".site-unavailable-locator-panel__issues");
        return { capacity: panel.dataset.unavailablePageSize, visible: panel.dataset.visibleIssueCount,
          panelHeight: panel.clientHeight, listHeight: list?.clientHeight,
          listMinimum: list && getComputedStyle(list).minHeight, listGap: list && getComputedStyle(list).rowGap };
      });
      throw new Error(`${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`, { cause: error });
    });
    if (isFourK) {
      assert.equal(
        await unavailableLocatorPanel.getAttribute("data-unavailable-page-size"),
        "4",
        "4K must expose the four-item unavailable-issue page capacity"
      );
    }
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
        ".site-unavailable-locator-panel__meta"
      );
      const unavailableSeverity = unavailableMeta?.querySelector(
        ".site-unavailable-locator-panel__severity"
      );
      const unavailableCode = unavailableMeta?.querySelector(
        ".site-unavailable-locator-panel__code"
      );
      const unavailablePagination = unavailablePanel?.querySelector(
        ".site-unavailable-locator-panel__pagination"
      );
      const cardRect = card?.getBoundingClientRect();
      const unavailablePanelRect = unavailablePanel?.getBoundingClientRect();
      const unavailableIssuesRect = unavailableIssues?.getBoundingClientRect();
      const unavailableSeverityRect = unavailableSeverity?.getBoundingClientRect();
      const unavailableCodeRect = unavailableCode?.getBoundingClientRect();
      const unavailableButtonRects = unavailablePagination
        ? [...unavailablePagination.querySelectorAll(".site-unavailable-locator-panel__navigation")].map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              centerY: (rect.top + rect.bottom) / 2,
              disabled: button.disabled,
              left: rect.left,
              right: rect.right
            };
          })
        : [];
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
        unavailablePageSize: unavailablePanel?.getAttribute("data-unavailable-page-size") ?? null,
        unavailableVisibleIssueCount:
          unavailablePanel?.getAttribute("data-visible-issue-count") ?? null,
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
        unavailablePaginationOverflow: unavailablePagination
          ? unavailablePagination.scrollWidth - unavailablePagination.clientWidth
          : Number.NaN,
        unavailableButtonsInsidePanel:
          unavailablePanelRect && unavailableButtonRects.length === 2
            ? unavailableButtonRects.every(
                (rect) =>
                  rect.left >= unavailablePanelRect.left - 1 &&
                  rect.right <= unavailablePanelRect.right + 1
              )
            : false,
        unavailableButtonCenters: unavailableButtonRects.map((rect) => rect.centerY),
        unavailableButtonsDisabled: unavailableButtonRects.map((rect) => rect.disabled),
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
        facts.unavailableMetaOverflow <= 1 &&
        facts.unavailablePaginationOverflow <= 1,
      `${viewport.width}px unavailable issue card must not overflow horizontally: ${JSON.stringify(facts)}`
    );
    assert.equal(
      facts.unavailableIssueCount,
      expectedVisibleUnavailableIssueCount,
      `${viewport.width}px must show the responsive number of unavailable issues`
    );
    assert.equal(
      facts.unavailableVisibleIssueCount,
      String(expectedVisibleUnavailableIssueCount),
      `${viewport.width}px visible-issue metadata must match the rendered cards`
    );
    assert.equal(
      facts.unavailableButtonsInsidePanel,
      true,
      `${viewport.width}px unavailable issue navigation must stay inside the panel`
    );
    assert.equal(facts.locationActionsInsideCards, true, `${viewport.width}px location actions must remain visible inside each issue card`);
    assert.ok(
      facts.unavailablePanelVerticalOverflow <= 1 && facts.unavailableIssuesVerticalOverflow <= 1 && facts.railVerticalOverflow <= 1,
      `${viewport.width}x${viewport.height} unavailable cards must fit their allocated height: ${JSON.stringify(facts)}`
    );
    assert.ok(
      facts.unavailableBadgeGap >= 4,
      `${viewport.width}px WCAG badge must remain beside severity: ${JSON.stringify(facts)}`
    );
    if (isFourK) {
      assert.equal(facts.unavailablePageSize, "4", "4K must retain the four-item page capacity");
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
      assert.equal(
        facts.unavailableButtonCenters.length,
        2,
        "4K unavailable issue navigation must retain both arrow buttons"
      );
      assert.ok(
        facts.unavailableButtonCenters.length === 2,
        `4K navigation arrows must share the full issue list's vertical center: ${JSON.stringify(facts)}`
      );
      assert.deepEqual(
        facts.unavailableButtonsDisabled,
        [true, true],
        "4K arrows must be disabled when all unavailable issues fit on one page"
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

async function verifyUnavailableCapacityResize(page) {
  await page.setViewportSize({ width: 2560, height: 1256 });
  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await waitForReplayReady(evidence);
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  for (const issue of issues) {
    await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: issue.id, status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" });
  }
  const panel = page.locator('.site-unavailable-locator-panel[data-locator-mode="unavailable"]');
  const waitForCapacity = async capacity => {
    await page.waitForFunction(capacity => document.querySelector('.site-unavailable-locator-panel[data-locator-mode="unavailable"]')
      ?.getAttribute("data-unavailable-page-size") === String(capacity), capacity);
    const geometry = await panel.evaluate(panel => {
      const list = panel.querySelector(".site-unavailable-locator-panel__issues");
      return { panelOverflow: panel.scrollHeight - panel.clientHeight, listOverflow: list.scrollHeight - list.clientHeight,
        cards: [...list.children].map(card => {
          const rect = card.getBoundingClientRect();
          const action = card.querySelector("button").getBoundingClientRect();
          return { height: rect.height, readableMessage: card.querySelector(".site-unavailable-locator-panel__message").getBoundingClientRect().height,
            actionInside: action.top >= rect.top && action.bottom <= rect.bottom && action.right <= rect.right };
        }) };
    });
    assert.ok(geometry.panelOverflow <= 1 && geometry.listOverflow <= 1, JSON.stringify(geometry));
    assert.ok(geometry.cards.every(card => card.height >= 239 && card.readableMessage >= 16 && card.actionInside), JSON.stringify(geometry));
  };
  await page.locator('.site-unavailable-locator-panel[data-unavailable-locator-count="4"]').waitFor();
  await waitForCapacity(2);
  await panel.getByRole("button", { name: "1번째 페이지", exact: true }).click();
  assert.deepEqual(await panel.locator("[data-issue-id]").evaluateAll(cards => cards.map(card => card.dataset.issueId)), ["9001", "9002"]);
  await panel.getByRole("button", { name: "2번째 페이지", exact: true }).click();
  assert.deepEqual(await panel.locator("[data-issue-id]").evaluateAll(cards => cards.map(card => card.dataset.issueId)), ["9003", "9004"]);

  // Resize the same page repeatedly: preserve the selected issue and avoid
  // content-driven growth or ResizeObserver feedback as the capacity changes.
  for (const viewport of [
    { width: 1440, height: 900, capacity: 1 },
    { width: 3840, height: 2021, capacity: 4 },
    { width: 2560, height: 1256, capacity: 2 },
    { width: 1440, height: 900, capacity: 1 },
    { width: 2560, height: 1256, capacity: 2 }
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await waitForCapacity(viewport.capacity);
    assert.equal(await panel.locator('[data-issue-id="9003"]').count(), 1, "resizing must keep the selected issue in view");
  }
  // A sibling issue panel consumes rail space without changing the viewport.
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status: "HIDDEN_STATE", recoverable: true });
  await page.locator('.site-unavailable-locator-panel[data-locator-mode="recoverable"]').waitFor();
  await waitForCapacity(1);
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9001, status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" });
  await waitForCapacity(2);
  await panel.getByRole("button", { name: "1번째 페이지", exact: true }).click();
  await panel.screenshot({ path: `${outDir}/unavailable-resize-two-cards.png` });
  return { resizedCapacities: [2, 1, 4, 2, 1, 2], selectedIssuePreserved: true, siblingPanelResize: "PASS" };
}

async function verifyMobile(page) {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.reload({ waitUntil: "domcontentloaded" });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await evidence.waitFor({ state: "visible" });
  await waitForReplayReady(evidence);
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  await verifyNoExternalReplayControls(evidence, frame);

  const mobileLocationButton = page.locator('[data-issue-id="9003"]').getByRole("button", { name: "위치 정보", exact: true });
  await mobileLocationButton.click();
  const mobileLocationDialog = page.getByRole("dialog", { name: "문제 위치 정보" });
  await mobileLocationDialog.waitFor({ state: "visible" });
  const locationGeometry = await mobileLocationDialog.evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    const close = dialog.querySelector('button[aria-label="위치 정보 닫기"]').getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      closeTop: close.top, closeBottom: close.bottom, overflow: dialog.scrollWidth - dialog.clientWidth };
  });
  assert.ok(locationGeometry.left >= 0 && locationGeometry.right <= 320 && locationGeometry.top >= 0 && locationGeometry.bottom <= 568);
  assert.ok(locationGeometry.closeTop >= 0 && locationGeometry.closeBottom <= 568 && locationGeometry.overflow <= 1);
  await mobileLocationDialog.screenshot({ path: `${outDir}/mobile-issue-location.png` });
  const mobileLocationBody = mobileLocationDialog.getByRole("region", { name: "저장된 위치 정보" });
  await mobileLocationBody.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const body = document.querySelector(".site-issue-location-dialog__body");
    return body && body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
  });
  await mobileLocationDialog.getByRole("button", { name: "위치 정보 닫기" }).click();
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
    metadataRequests += 1;
    if (metadataRequests === 1) {
      await fulfillJson(route, null, { status: 500 });
      return;
    }
    if (metadataRequests === 2) await metadataGate;
    await fulfillJson(route, captureMetadata);
  });
  await page.route("**/api/results/requests/501/live-session", async (route) => {
    sessionRequests += 1;
    await fulfillJson(route, failSession ? null : liveSession, { status: failSession ? 503 : 200 });
  });

  await page.goto(`${baseUrl}/projects/1/pages/101`, { waitUntil: "domcontentloaded" });
  const panel = page.locator('.site-unavailable-locator-panel[data-locator-mode="unavailable"]');
  const successNotice = page.getByText("모든 문제가 화면에 표시되고 있습니다.", { exact: true });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  const captureStatus = page.locator(".site-page-information__capture-status");
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
  await frame.locator("html").evaluate(() => window.__sendReplayReady());
  await waitForReplayConnectionState(evidence, "ready");
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
  await page.getByText("다른 화면 상태의 문제는 위 목록에서 확인할 수 있습니다.", { exact: true }).waitFor();
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
  if (verificationScope !== "scale") {
    await verifyMetadataBeforeResultDetails(page);
  }
  const desktop = verificationScope === "scale" ? null : await verifyDesktop(page);
  let responsive = null;
  let capacityResize = null;
  let mobile = null;
  if (verificationScope === "full") {
    responsive = await verifyResponsiveWidths(page);
    mobile = await verifyMobile(page);
  } else if (verificationScope === "scale") {
    responsive = await verifyResponsiveWidths(page);
  }
  if (verificationScope !== "core") {
    capacityResize = await verifyUnavailableCapacityResize(page);
  }
  let statusFeedback = null;
  if (verificationScope !== "scale") {
    const feedbackPage = await browser.newPage();
    feedbackPage.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      statusFeedback = await verifyEvidenceStatusFeedback(feedbackPage);
    } finally {
      await feedbackPage.close();
    }
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(chartDimensionWarnings, [], "charts must not render with negative initial dimensions");
  console.log(JSON.stringify({ result: "PASS", scope: verificationScope, desktop, responsive, capacityResize, mobile, statusFeedback }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
