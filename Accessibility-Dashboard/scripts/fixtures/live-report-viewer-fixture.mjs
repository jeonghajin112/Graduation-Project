const VIEWER_LABEL = "b".repeat(40);

export const TEST_LIVE_REPORT_VIEWER_ORIGIN = `http://${VIEWER_LABEL}.localhost:9090`;

export function createTestLiveReportSession(requestId, sessionSuffix = String(requestId)) {
  const sessionId = `fixture_${sessionSuffix}`;
  return {
    sessionId,
    runtimeUrl: `${TEST_LIVE_REPORT_VIEWER_ORIGIN}/api/live-reports/${sessionId}/document/${"n".repeat(32)}`,
    viewerOrigin: TEST_LIVE_REPORT_VIEWER_ORIGIN,
    nonce: "n".repeat(32),
    bridgeSecret: "s".repeat(43),
    expiresAt: "2099-12-31T23:59:59Z"
  };
}

export function createTestLiveReportViewerHtml({
  body = "<main><h1>동적 페이지 fixture</h1><p>현재 페이지 내용을 표시합니다.</p></main>",
  documentToken = "fixture_live_document",
  session
}) {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body{margin:0;min-height:100%;font-family:Arial,sans-serif}body{min-width:680px;background:#f4f6f9}main{min-height:1200px;padding:32px}</style>
  </head>
  <body>
    ${body}
    <script>
      (() => {
        const dashboardSource = "accessibility-dashboard-live-report";
        const pageSource = "accessibility-page-live-report";
        const replaySource = "accessibility-page-replay";
        const protocolVersion = 1;
        const sessionId = ${JSON.stringify(session.sessionId)};
        const bridgeSecret = ${JSON.stringify(session.bridgeSecret)};
        const documentToken = ${JSON.stringify(documentToken)};
        let challenge = null;
        let inboundSequence = 0;
        let outboundSequence = 1;
        let port = null;

        const send = (payload) => {
          if (!port) return;
          port.postMessage({
            source: pageSource,
            type: "EVENT",
            protocolVersion,
            bridgeSecret,
            challenge,
            documentToken,
            sequence: ++outboundSequence,
            payload: { source: replaySource, documentToken, ...payload }
          });
        };
        const sendReady = () => {
          send({ type: "READY" });
          send({
            type: "DOCUMENT_HEALTH",
            status: "MEANINGFUL",
            consecutiveMeaningfulSamples: 1,
            visibleControlCount: 0,
            visibleElementCount: 4,
            visibleImageCount: 0,
            largestVisibleVisualArea: 24_000,
            visibleTextLength: 80
          });
        };
        const handleCommand = (message) => {
          if (message.type === "REQUEST_DOCUMENT_STATE") {
            send({ type: "DOCUMENT_LOADING" });
            sendReady();
          }
        };

        addEventListener("message", (event) => {
          const message = event.data;
          if (
            event.source !== parent ||
            !message ||
            message.source !== dashboardSource ||
            message.type !== "CONNECT" ||
            message.protocolVersion !== protocolVersion ||
            message.bridgeSecret !== bridgeSecret ||
            typeof message.challenge !== "string" ||
            message.challenge.length < 32 ||
            event.ports.length !== 1 ||
            port
          ) return;

          challenge = message.challenge;
          port = event.ports[0];
          port.onmessage = (portEvent) => {
            const command = portEvent.data;
            if (
              !command ||
              command.source !== dashboardSource ||
              command.type !== "COMMAND" ||
              command.protocolVersion !== protocolVersion ||
              command.bridgeSecret !== bridgeSecret ||
              command.challenge !== challenge ||
              command.documentToken !== documentToken ||
              command.sequence !== inboundSequence + 1
            ) return;
            inboundSequence = command.sequence;
            handleCommand(command.payload);
          };
          port.start();
          port.postMessage({
            source: pageSource,
            type: "ACK",
            protocolVersion,
            bridgeSecret,
            challenge,
            documentToken,
            sequence: outboundSequence
          });
          send({ type: "DOCUMENT_LOADING" });
          sendReady();
        });

        const announce = () => {
          if (port) return;
          parent.postMessage({
            source: pageSource,
            type: "AVAILABLE",
            protocolVersion,
            sessionId,
            documentToken
          }, "*");
          setTimeout(announce, 100);
        };
        announce();
      })();
    <\/script>
  </body>
</html>`;
}
