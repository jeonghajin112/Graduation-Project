import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const baseUrl = resolveTestBaseUrl();
const outDir = process.env.OUT_DIR ?? "artifacts/page-evidence";
const verificationScope = process.env.PAGE_EVIDENCE_SCOPE?.trim() || "full";
const capturedAt = "2026-08-11T03:30:00.000Z";
const FALLBACK_DETAIL_SELECTOR = ".site-page-evidence-fallback-detail";
const removedReplayControlPattern = /SET_DISMISS_MODE|UNDO_HIDDEN_ELEMENT|RESET_HIDDEN_ELEMENTS|dismissMode|hiddenCount|REPLAY_UI_STATE|SLIDER_PREVIOUS|SLIDER_NEXT|sliderAvailable|sliderIndex|sliderCount/;

assert.ok(
  verificationScope === "core" || verificationScope === "full" || verificationScope === "scale",
  `PAGE_EVIDENCE_SCOPE must be "core", "full", or "scale": ${verificationScope}`
);

const [liveProtocolSource, protocolSource, evidenceCardSource] = await Promise.all([
  readFile(path.join(
    dashboardDirectory,
    "src/components/dashboard/panels/site-dashboard/live-report-protocol.ts"
  ), "utf8"),
  readFile(path.join(
    dashboardDirectory,
    "src/components/dashboard/panels/site-dashboard/page-replay-protocol.ts"
  ), "utf8"),
  readFile(path.join(
    dashboardDirectory,
    "src/components/dashboard/panels/site-dashboard/rendered-page-evidence-card.tsx"
  ), "utf8")
]);
assert.doesNotMatch(
  protocolSource,
  removedReplayControlPattern,
  "popup manipulation and the external carousel pager must not remain in the replay protocol"
);
assert.doesNotMatch(
  evidenceCardSource,
  /SET_DISMISS_MODE|UNDO_HIDDEN_ELEMENT|RESET_HIDDEN_ELEMENTS|팝업 숨기기|SLIDER_PREVIOUS|SLIDER_NEXT|site-page-evidence-slider-|이전 슬라이드|다음 슬라이드/,
  "the page evidence toolbar must retain neither popup controls nor the external carousel pager"
);
assert.doesNotMatch(
  evidenceCardSource,
  /site-page-evidence-(?:toolbar|view-switch|filter|marker-toggle|code-view|code-heading|code-empty)|SET_MARKERS_VISIBLE|severityFilter|EvidenceView/,
  "removed page/code, severity-filter, and marker-toggle controls must not remain hidden in the component"
);
assert.match(
  protocolSource,
  /type: "ISSUE_SELECTED";[\s\S]*?documentToken: string;[\s\S]*?issueId: number \| null/,
  "the replay selection protocol must carry an explicit null hover clear"
);
assert.match(
  protocolSource,
  /value\.issueId === null \|\| isIssueId\(value\.issueId\)/,
  "the replay parser must accept only null or a valid positive issue id"
);
assert.match(protocolSource, /severityLabel: string/, "replay issues must carry a localized severity label");
assert.match(protocolSource, /category: ReplayIssueCategory/, "replay issues must carry a validated marker category");
assert.match(protocolSource, /row\.analyzerType === "AI_TEXT"[\s\S]*?return "text"/);
assert.match(protocolSource, /row\.analyzerType === "CV_VISION"[\s\S]*?return "visual"/);
assert.match(protocolSource, /code: string/, "replay issues must carry the KWCAG code");
assert.match(protocolSource, /message: string/, "replay issues must carry the issue description");
assert.match(protocolSource, /path: string \| null/, "replay issues must carry the bounded DOM path");
assert.match(
  protocolSource,
  /type: "ISSUE_DETAIL_FALLBACK";[\s\S]*?issueId: number \| null/,
  "the replay protocol must expose the id-only external detail fallback"
);
assert.match(
  protocolSource,
  /value\.type === "ISSUE_DETAIL_FALLBACK"[\s\S]*?documentToken[\s\S]*?value\.issueId === null \|\| isIssueId\(value\.issueId\)/,
  "fallback messages must require a document token and reject invalid issue ids"
);
assert.match(
  protocolSource,
  /type: "DOCUMENT_LOADING" \| "DOCUMENT_UNLOADING" \| "READY";[\s\S]*?documentToken: string/,
  "document lifecycle messages must identify their iframe document generation"
);
assert.match(
  protocolSource,
  /type: "REQUEST_DOCUMENT_STATE"/,
  "the parent must be able to recover a document-state message missed before its listener attached"
);
assert.match(
  protocolSource,
  /type: "SET_VIEW_SCALE";[\s\S]*?documentToken: string;[\s\S]*?scale: number;[\s\S]*?visualWidth: number;/,
  "the replay protocol must carry bounded visual viewport metrics"
);
assert.match(
  evidenceCardSource,
  /sendReplayViewScale\(\);[\s\S]*?type: "INIT_ISSUES"/,
  "the replay must receive its view scale before initial marker creation"
);
assert.match(
  protocolSource,
  /hasExactOwnKeys\(value, \["source", "type", "documentToken"\]\)[\s\S]*?isDocumentToken\(value\.documentToken\)/,
  "document lifecycle messages must enforce an exact, bounded token-only contract"
);
assert.match(
  evidenceCardSource,
  /replayIssues\.find\(\(issue\) => issue\.id === fallbackIssueId\)/,
  "the parent card must derive fallback content from the trusted replay issue list"
);
assert.match(
  evidenceCardSource,
  /className="site-page-evidence-fallback-detail"[\s\S]*?data-issue-id=\{fallbackIssue\.id\}[\s\S]*?aria-hidden="true"/,
  "the visual duplicate must stay hidden from assistive technology"
);
assert.doesNotMatch(
  evidenceCardSource,
  /site-page-evidence-fallback-detail[^>]*(?:role=|aria-live=|tabIndex=)/,
  "the visual duplicate must not create a second announcement or focus target"
);
assert.doesNotMatch(
  evidenceCardSource,
  /site-page-evidence-inspector|site-page-evidence-selection-(?:tags|title|message|path|status)/,
  "the fixed right-side issue inspector must be removed from the page view"
);
assert.match(
  liveProtocolSource,
  /type: "CONNECT";[\s\S]*?protocolVersion:[\s\S]*?bridgeSecret: string;[\s\S]*?challenge: string;/,
  "live reports must authenticate a versioned MessageChannel connection"
);
assert.match(
  liveProtocolSource,
  /value\.sequence !== expectedSequence[\s\S]*?payload = parsePageReplayMessage\(value\.payload\)[\s\S]*?payload\.documentToken !== value\.documentToken/,
  "live port events must be ordered and reuse the strict replay payload parser"
);
assert.match(
  liveProtocolSource,
  /isLiveReportViewerOriginAllowed\(session\.viewerOrigin, viewerBaseUrl\)[\s\S]*?!isLiveReportViewerOriginAllowed\(candidateOrigin, viewerBaseUrl\)[\s\S]*?throw new Error[\s\S]*?return candidateOrigin;/,
  "live reports must connect only to an isolated route under the configured viewer origin"
);
assert.match(
  evidenceCardSource,
  /new MessageChannel\(\)[\s\S]*?createLiveReportConnectMessage[\s\S]*?\[channel\.port2\]/,
  "each live document must receive a transferred private message port"
);
assert.match(
  evidenceCardSource,
  /connection\.port\.postMessage\(createLiveReportPortCommand/,
  "all live viewer commands must use the authenticated private port"
);
assert.match(
  evidenceCardSource,
  /activeFrameKindRef\.current !== "preview"[\s\S]*?parsePageReplayMessage\(event\.data\)/,
  "only the isolated landing preview adapter may use the legacy window listener"
);
assert.match(
  evidenceCardSource,
  /function closeLiveReportPort\(\)[\s\S]*?connection\.port\.close\(\)/,
  "live ports must be explicitly retired on navigation and reconnect"
);
assert.match(
  evidenceCardSource,
  /activeFrameKind === "live"[\s\S]*?"allow-scripts allow-same-origin allow-forms"[\s\S]*?: "allow-scripts"/,
  "only the isolated live viewer may run same-origin child frames and safe replay forms"
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
    locator: locator("#missing-promotion-title", '<h4 id="missing-promotion-title">오늘의 혜택</h4>'),
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
            send({ type: "LOCATOR_STATUS", issueId: issue.id, status: target ? "CONNECTED" : "UNAVAILABLE" });
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
      const dropInitialLoading = dropNextReplayInitialLoading;
      holdNextReplayReady = false;
      dropNextReplayInitialLoading = false;
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: replayHtml
          .replace("__HOLD_READY__", holdReady ? "true" : "false")
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
  const locatorStatus = evidence.locator(".site-page-evidence-locator-status");
  assert.match(await locatorStatus.textContent(), /문제 2개의 위치를 현재 동적 화면에 표시하지 못했습니다/);
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
  await sendReplayTestMessage(frame, { type: "LOCATOR_STATUS", issueId: 9003, status: "CONNECTED" });
  await waitForUnavailableLocatorCount(evidence, 1);
  await sendReplayTestMessage(frame, {
    type: "LOCATOR_STATUS",
    issueId: 9003,
    status: "UNAVAILABLE",
    reason: "SELECTOR_NOT_FOUND"
  });
  await waitForUnavailableLocatorCount(evidence, 2);
  await verifyNoExternalReplayControls(evidence, frame);
  await page.waitForTimeout(100);
  assert.equal(
    await frame.locator("html").evaluate(() =>
      window.__replayMessages.filter((message) => message.type === "INIT_ISSUES").length
    ),
    1,
    "the replay must be initialized exactly once"
  );
  await verifyIframeReloadRecovery(page, evidence, frame, initialMessage);
  await verifyMissedInitialLoadingRecovery(page, evidence, frame, initialMessage);
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
    trendLayout.chartHeight >= 136 && trendLayout.chartHeight <= 144,
    `desktop trend chart must stay compact: ${JSON.stringify(trendLayout)}`
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
    "iframe-origin quick, stale, and touch interactions must not echo FOCUS_ISSUE"
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
    const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
    await verifyNoExternalReplayControls(evidence, frame);

    const facts = await page.evaluate(() => {
      const card = document.querySelector(".site-page-evidence-card");
      const preview = document.querySelector(".site-page-evidence-preview");
      const frameElement = document.querySelector(".site-page-evidence-replay-frame");
      const cardRect = card?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
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
        )
      };
    });

    assert.ok(facts.documentOverflow <= 1, `${viewport.width}px viewport has document overflow`);
    assert.ok(facts.cardLeft >= -1 && facts.cardRight <= facts.viewportWidth + 1);
    assert.equal(facts.removedToolbarFeatureCount, 0, `${viewport.width}px must not render removed toolbar features`);
    assert.equal(facts.externalPagerCount, 0, `${viewport.width}px must not render an external replay pager`);
    assert.equal(facts.inspectorCount, 0, `${viewport.width}px must not render the removed inspector`);
    assert.equal(facts.gridColumnCount, 1, `${viewport.width}px replay layout must remain single-column`);
    assert.ok(facts.previewFrameDelta <= 2);
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

async function verifyMobile(page) {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.reload({ waitUntil: "domcontentloaded" });
  const evidence = page.getByRole("article", { name: "페이지 검사 화면" });
  await evidence.waitFor({ state: "visible" });
  await waitForReplayReady(evidence);
  const frame = page.frameLocator("iframe.site-page-evidence-replay-frame");
  await verifyNoExternalReplayControls(evidence, frame);

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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const chartDimensionWarnings = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
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
  let mobile = null;
  if (verificationScope === "full") {
    responsive = await verifyResponsiveWidths(page);
    mobile = await verifyMobile(page);
  } else if (verificationScope === "scale") {
    responsive = await verifyResponsiveWidths(page);
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(chartDimensionWarnings, [], "charts must not render with negative initial dimensions");
  console.log(JSON.stringify({ result: "PASS", scope: verificationScope, desktop, responsive, mobile }, null, 2));
} finally {
  await page.close();
  await browser.close();
}
