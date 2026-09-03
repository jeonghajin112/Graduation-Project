import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const workspaceDirectory = path.resolve(dashboardDirectory, "..");
const backendDirectory = path.join(workspaceDirectory, "ap-backend");
const sessionId = "6b2d884e-a7f4-4f09-9776-688d08fe8912";
const bridgeSecret = "test-bridge-secret";
const challenge = "live_marker_browser_challenge_00000001";

function runFixtureExporter(outputPath) {
  const args = ["exportLiveReportBrowserFixture", "--no-daemon", "--console=plain"];
  const executable = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : path.join(backendDirectory, "gradlew");
  const executableArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `gradlew.bat ${args.join(" ")}`]
    : args;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, executableArgs, {
      cwd: backendDirectory,
      env: {
        ...process.env,
        AP_LIVE_REPORT_FIXTURE_OUTPUT: outputPath
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Live report fixture export failed (${code}).\n${output}`));
    });
  });
}

function createParentHtml() {
  return `<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><title>Live marker harness</title></head>
      <body style="margin:0">
        <iframe id="viewer" title="Live report" src="/viewer" style="width:900px;height:760px;border:0"></iframe>
        <script>
          (() => {
            const iframe = document.getElementById("viewer");
            const events = [];
            let port = null;
            let documentToken = null;
            let nextSequence = 1;
            window.__liveEvents = events;
            window.__liveConnected = false;
            window.__sendLiveCommand = payload => {
              if (!port || !documentToken) throw new Error("Live bridge is not connected");
              port.postMessage({
                source: "accessibility-dashboard-live-report",
                type: "COMMAND",
                protocolVersion: 1,
                bridgeSecret: ${JSON.stringify(bridgeSecret)},
                challenge: ${JSON.stringify(challenge)},
                documentToken,
                sequence: nextSequence++,
                payload
              });
            };
            addEventListener("message", event => {
              const message = event.data;
              if (
                event.source !== iframe.contentWindow ||
                !message ||
                message.source !== "accessibility-page-live-report" ||
                message.type !== "AVAILABLE" ||
                message.protocolVersion !== 1 ||
                message.sessionId !== ${JSON.stringify(sessionId)} ||
                port
              ) return;

              const channel = new MessageChannel();
              port = channel.port1;
              port.onmessage = portEvent => {
                const incoming = portEvent.data;
                events.push(incoming);
                if (incoming?.type === "ACK") {
                  documentToken = incoming.documentToken;
                  window.__liveConnected = true;
                }
              };
              port.start();
              iframe.contentWindow.postMessage({
                source: "accessibility-dashboard-live-report",
                type: "CONNECT",
                protocolVersion: 1,
                bridgeSecret: ${JSON.stringify(bridgeSecret)},
                challenge: ${JSON.stringify(challenge)}
              }, location.origin, [channel.port2]);
            });
          })();
        <\/script>
      </body>
    </html>`;
}

function createIssue(id, selector, title, severity, category, code) {
  return {
    id,
    title,
    message: `분석 문장\n${title}\n\n개선 필요\n• 테스트 권고 사항`,
    code,
    severity,
    category,
    path: selector,
    pathSteps: [{ context: "DOCUMENT", selector }]
  };
}

function rectsOverlap(first, second) {
  return !(
    first.right <= second.left ||
    first.left >= second.right ||
    first.bottom <= second.top ||
    first.top >= second.bottom
  );
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ap-live-report-browser-"));
const fixturePath = path.join(temporaryDirectory, "live-report.html");
let browser = null;
let server = null;

try {
  await runFixtureExporter(fixturePath);
  const rewrittenHtml = await readFile(fixturePath, "utf8");
  assert.match(rewrittenHtml, /data-ap-live-bridge="true"/);

  const parentHtml = createParentHtml();
  server = createServer((request, response) => {
    if (request.url === "/viewer") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(rewrittenHtml);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(parentHtml);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__liveConnected === true);
  await page.waitForFunction(() =>
    window.__liveEvents.some(event => event?.type === "EVENT" && event.payload?.type === "READY")
  );

  const issues = [
    createIssue(101, "#group-target", "적절한 링크 텍스트", "LOW", "text", "KWACG 6.4.3"),
    createIssue(102, "#group-target", "레이블 제공", "HIGH", "form", "KWACG 7.3.2"),
    createIssue(103, "#group-target", "명확한 지시사항", "MEDIUM", "text", "KWACG 5.3.3"),
    createIssue(104, "#nearby-target", "키보드 접근", "CRITICAL", "keyboard", "KWACG 8.1.1")
  ];
  await page.evaluate((payload) => {
    window.__sendLiveCommand({
      source: "accessibility-dashboard",
      type: "SET_VIEW_SCALE",
      documentToken: window.__liveEvents.find(event => event?.type === "ACK").documentToken,
      scale: 1,
      visualWidth: 900
    });
    window.__sendLiveCommand({
      source: "accessibility-dashboard",
      type: "INIT_ISSUES",
      issues: payload,
      selectedIssueId: null,
      markersVisible: true
    });
  }, issues);

  const frame = page.locator("#viewer").contentFrame();
  const markers = frame.locator(".ap-live-marker");
  await assert.doesNotReject(() => markers.first().waitFor({ state: "visible" }));
  assert.equal(await markers.count(), 2, "three issues on one element must share one marker");

  const groupedMarker = markers.filter({ has: frame.locator(".ap-live-marker__count") });
  assert.equal(await groupedMarker.count(), 1);
  assert.equal(await groupedMarker.locator(".ap-live-marker__count").textContent(), "3");

  const geometry = await frame.locator("body").evaluate(() => {
    const fact = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const markerFacts = [...document.querySelectorAll(".ap-live-marker")].map(fact);
    return {
      markerFacts,
      targetFacts: [fact(document.querySelector("#group-target")), fact(document.querySelector("#nearby-target"))],
      highlightHidden: document.querySelector(".ap-live-highlight").hidden
    };
  });
  assert.equal(rectsOverlap(geometry.markerFacts[0], geometry.markerFacts[1]), false);
  for (const marker of geometry.markerFacts) {
    for (const target of geometry.targetFacts) {
      assert.equal(rectsOverlap(marker, target), false, "markers must not cover target text");
    }
  }
  assert.equal(geometry.highlightHidden, true, "highlight must stay hidden before marker hover");

  await groupedMarker.hover();
  const popover = frame.locator(".ap-live-popover");
  await popover.waitFor({ state: "visible" });
  assert.equal(await popover.locator('[role="tab"]').count(), 3);
  assert.equal(await groupedMarker.getAttribute("aria-expanded"), "true");
  assert.equal(await frame.locator(".ap-live-highlight").getAttribute("hidden"), null);
  const hiddenScrollbar = await popover.locator(".ap-live-popover__detail").evaluate((element) => ({
    scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    overflowY: getComputedStyle(element).overflowY
  }));
  assert.equal(hiddenScrollbar.scrollbarWidth, "none");
  assert.equal(hiddenScrollbar.overflowY, "auto");

  const countPlacement = await groupedMarker.evaluate((marker) => {
    const count = marker.querySelector(".ap-live-marker__count");
    const markerRect = marker.getBoundingClientRect();
    const countRect = count.getBoundingClientRect();
    return {
      countCenterX: (countRect.left + countRect.right) / 2,
      countCenterY: (countRect.top + countRect.bottom) / 2,
      markerCenterX: (markerRect.left + markerRect.right) / 2,
      markerCenterY: (markerRect.top + markerRect.bottom) / 2,
      countHeight: countRect.height
    };
  });
  assert.ok(countPlacement.countCenterX > countPlacement.markerCenterX);
  assert.ok(countPlacement.countCenterY < countPlacement.markerCenterY);
  assert.ok(countPlacement.countHeight <= 15);

  await frame.locator("#purchase").click();
  assert.equal(await frame.locator("body").evaluate(() => window.actionClicks), 0);
  await frame.locator("#next-slide").click();
  assert.equal(await frame.locator("body").evaluate(() => window.slideClicks), 1);

  const locatorEvents = await page.evaluate(() =>
    window.__liveEvents
      .filter(event => event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
      .map(event => event.payload)
  );
  assert.equal(locatorEvents.filter(event => event.status === "CONNECTED").length, 4);

  console.log(JSON.stringify({
    result: "PASS",
    bridge: "LiveReportDocumentRewriter",
    markerCount: geometry.markerFacts.length,
    groupedIssueCount: 3,
    connectedLocatorCount: locatorEvents.length,
    blockedActionClicks: 0,
    allowedCarouselClicks: 1
  }, null, 2));
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
