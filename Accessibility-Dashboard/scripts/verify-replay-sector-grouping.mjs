import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(scriptDirectory, "..", "..");
const sanitizerPath = path.join(
  workspaceDirectory,
  "ap-backend",
  "src",
  "main",
  "java",
  "com",
  "accessibility",
  "platform",
  "artifact",
  "service",
  "ReplayDocumentSanitizer.java"
);

function extractBridgeScript(source) {
  const declaration = 'private static final String BRIDGE_SCRIPT = String.join("",';
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, "joined replay bridge declaration must exist");
  const end = source.indexOf("\n    );", start);
  assert.ok(end > start, "joined replay bridge declaration must be complete");
  const blocks = [];
  const pattern = /"""\r?\n([\s\S]*?)\r?\n {12}"""/g;
  let match;
  const body = source.slice(start, end);
  while ((match = pattern.exec(body)) !== null) {
    blocks.push(match[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^ {12}/, ""))
      .join("\n"));
  }
  assert.ok(blocks.length >= 2, "every replay bridge text block must be extracted");
  return blocks.join("");
}

async function sendCommand(page, command) {
  await page.evaluate((message) => {
    window.postMessage({ source: "accessibility-dashboard", ...message }, "*");
  }, command);
}

const source = await readFile(sanitizerPath, "utf8");
let bridgeScript = extractBridgeScript(source);
assert.match(bridgeScript, /const buildMarkerGroupPlans = \(resolvedIssues\) =>/);
assert.match(bridgeScript, /members\.size >= MIN_SECTOR_GROUP_TARGETS/);
assert.match(bridgeScript, /entry\.groupScope === 'sector' \? '같은 영역' : '같은 요소'/);
bridgeScript = bridgeScript.replace(
  "host.attachShadow({ mode: 'closed' })",
  "host.attachShadow({ mode: 'open' })"
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.setContent(`<!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { width: 960px; min-height: 1400px; margin: 0; }
          body { padding: 40px; font-family: system-ui, sans-serif; }
          table { width: 820px; height: 180px; border: 1px solid #d0d5dd; border-radius: 12px; }
          td { text-align: center; }
          #outside-target { display: block; width: 240px; margin-top: 160px; padding: 16px; }
        </style>
      </head>
      <body>
        <table id="calendar-sector" aria-label="달력">
          <tbody>
            <tr>
              <td id="day-a">1일</td>
              <td id="day-b">2일</td>
              <td id="day-c">3일 <span id="hidden-day" hidden>숨김 날짜</span></td>
            </tr>
          </tbody>
        </table>
        <p id="outside-target">영역 밖의 별도 문제</p>
      </body>
    </html>`);
  await page.evaluate(() => {
    window.__replayOutbound = [];
    window.addEventListener("message", (event) => {
      if (event.data?.source === "accessibility-page-replay") {
        window.__replayOutbound.push(JSON.parse(JSON.stringify(event.data)));
      }
    });
  });
  await page.addScriptTag({ content: bridgeScript });
  await page.waitForFunction(() =>
    (window.__replayOutbound ?? []).some((message) => message.type === "READY")
  );

  const issues = [
    {
      id: 501,
      severity: "HIGH",
      severityLabel: "높음",
      category: "visual",
      code: "KWCAG 5.4.3",
      title: "첫 번째 날짜 대비",
      pathSteps: [{ context: "DOCUMENT", selector: "#day-a" }]
    },
    {
      id: 502,
      severity: "MEDIUM",
      severityLabel: "보통",
      category: "visual",
      code: "KWCAG 5.4.3",
      title: "두 번째 날짜 대비",
      pathSteps: [{ context: "DOCUMENT", selector: "#day-b" }]
    },
    {
      id: 503,
      severity: "LOW",
      severityLabel: "낮음",
      category: "keyboard",
      code: "KWCAG 6.4.2",
      title: "첫 번째 날짜 키보드 접근",
      pathSteps: [{ context: "DOCUMENT", selector: "#day-a" }]
    },
    {
      id: 506,
      severity: "LOW",
      severityLabel: "낮음",
      category: "text",
      code: "KWCAG 3.1.5",
      title: "세 번째 날짜 읽기 수준",
      pathSteps: [{ context: "DOCUMENT", selector: "#day-c" }]
    },
    {
      id: 507,
      severity: "MEDIUM",
      severityLabel: "보통",
      category: "structure",
      code: "KWCAG 2.4.2",
      title: "두 번째 날짜의 구조와 관계를 설명하는 긴 문제 제목",
      detailMessage: "달력 셀의 관계를 보조기술이 이해할 수 있도록 구조 정보를 보완해야 합니다.",
      pathSteps: [{ context: "DOCUMENT", selector: "#day-b" }]
    },
    {
      id: 504,
      severity: "LOW",
      severityLabel: "낮음",
      category: "text",
      code: "KWCAG 3.1.5",
      title: "영역 밖 문제",
      pathSteps: [{ context: "DOCUMENT", selector: "#outside-target" }]
    },
    {
      id: 505,
      severity: "HIGH",
      severityLabel: "높음",
      category: "visual",
      code: "KWCAG 5.4.3",
      title: "숨겨진 날짜 문제",
      pathSteps: [{ context: "DOCUMENT", selector: "#hidden-day" }]
    }
  ];

  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const markers = [...(root?.querySelectorAll(".marker") ?? [])];
    return markers.length === 3
      && !markers[0].hidden
      && !markers[1].hidden
      && markers[2].hidden;
  });

  const initial = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    return [...root.querySelectorAll(".marker")].map((marker) => ({
      scope: marker.dataset.groupScope,
      groupSize: marker.dataset.groupSize,
      targetCount: marker.dataset.targetCount,
      category: marker.dataset.markerCategory,
      issueIds: marker.dataset.issueIds,
      ariaLabel: marker.getAttribute("aria-label")
    }));
  });
  assert.deepEqual(initial.map(({ scope, groupSize, targetCount, category, issueIds }) => ({
    scope,
    groupSize,
    targetCount,
    category,
    issueIds
  })), [
    {
      scope: "sector",
      groupSize: "5",
      targetCount: "3",
      category: "multiple",
      issueIds: "501,502,503,506,507"
    },
    {
      scope: "element",
      groupSize: "1",
      targetCount: "1",
      category: "text",
      issueIds: "504"
    },
    {
      scope: "element",
      groupSize: "1",
      targetCount: "1",
      category: "visual",
      issueIds: "505"
    }
  ]);
  assert.match(initial[0].ariaLabel, /같은 영역에서 발견된 접근성 문제 5개/);
  assert.match(initial[0].ariaLabel, /대상 요소 3개/);

  const sectorMarker = page.locator("#__uni_accessibility_replay_host").locator(".marker").first();
  await sectorMarker.dispatchEvent("pointerenter", { pointerType: "mouse", isPrimary: true });
  await page.waitForFunction(() => {
    const popover = document.getElementById("__uni_accessibility_replay_host")
      ?.shadowRoot?.querySelector(".issue-popover:not([hidden])");
    return popover?.dataset.grouped === "true"
      && popover.querySelectorAll(".issue-popover__issue").length === 4
      && popover.querySelector(".issue-popover__page-status")?.textContent === "1 / 2";
  });
  await page.waitForTimeout(100);
  const groupedPopover = await page.evaluate(() => {
    const popover = document.getElementById("__uni_accessibility_replay_host")
      .shadowRoot.querySelector(".issue-popover:not([hidden])");
    const rect = popover.getBoundingClientRect();
    return {
      group: popover.querySelector(".issue-popover__group").textContent,
      ariaLabel: popover.getAttribute("aria-label"),
      issueIds: [...popover.querySelectorAll(".issue-popover__issue")]
        .map((button) => button.dataset.issueId),
      rect: [rect.left, rect.top, rect.width, rect.height]
    };
  });
  assert.equal(groupedPopover.group, "같은 영역에서 발견된 문제 5개");
  assert.equal(groupedPopover.ariaLabel, "같은 영역의 접근성 문제 5개");
  assert.deepEqual(
    groupedPopover.issueIds,
    ["501", "502", "503", "506"],
    "sector grouping must preserve the incoming issue order across repeated targets"
  );
  assert.equal(
    await page.evaluate(() => document.getElementById("__uni_accessibility_replay_host")
      .shadowRoot.querySelector(".issue-dock")),
    null,
    "sector hover must reuse the established grouped popover rather than revive the retired dock"
  );

  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    root.querySelector('.issue-popover__issue[data-issue-id="502"]').click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelector(".issue-popover")?.dataset.issueId === "502"
      && root.querySelectorAll(".selection-fragment").length === 1;
  });
  const selectedTarget = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    const selection = root.querySelector(".selection-fragment").getBoundingClientRect();
    const target = document.getElementById("day-b").getBoundingClientRect();
    const popover = root.querySelector(".issue-popover:not([hidden])").getBoundingClientRect();
    return {
      selectedIssueId: root.querySelector(".issue-popover").dataset.issueId,
      selectionCenter: [selection.left + selection.width / 2, selection.top + selection.height / 2],
      targetCenter: [target.left + target.width / 2, target.top + target.height / 2],
      popoverRect: [popover.left, popover.top, popover.width, popover.height]
    };
  });
  assert.equal(selectedTarget.selectedIssueId, "502");
  assert.ok(Math.abs(selectedTarget.selectionCenter[0] - selectedTarget.targetCenter[0]) <= 1);
  assert.ok(Math.abs(selectedTarget.selectionCenter[1] - selectedTarget.targetCenter[1]) <= 1);
  selectedTarget.popoverRect.forEach((value, index) => {
    assert.ok(
      Math.abs(value - groupedPopover.rect[index]) <= 1,
      `sector issue selection must preserve the popover footprint: before=${groupedPopover.rect} after=${selectedTarget.popoverRect}`
    );
  });

  await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    root.querySelector('.issue-popover__page-button[data-direction="next"]').click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    const popover = root?.querySelector(".issue-popover:not([hidden])");
    return popover?.querySelector(".issue-popover__page-status")?.textContent === "2 / 2"
      && popover.querySelectorAll(".issue-popover__issue").length === 1
      && popover.querySelector('.issue-popover__issue[data-issue-id="507"]');
  });
  const secondPageRect = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    const issue = root.querySelector('.issue-popover__issue[data-issue-id="507"]');
    issue.click();
    issue.focus({ preventScroll: true });
    const rect = root.querySelector(".issue-popover:not([hidden])").getBoundingClientRect();
    return [rect.left, rect.top, rect.width, rect.height];
  });
  secondPageRect.forEach((value, index) => {
    assert.ok(
      Math.abs(value - groupedPopover.rect[index]) <= 1,
      `every grouped page must preserve the popover footprint: before=${groupedPopover.rect} after=${secondPageRect}`
    );
  });

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => document.getElementById("__uni_accessibility_replay_host")
    ?.shadowRoot?.querySelector(".issue-popover")?.hidden === true);
  assert.equal(
    await page.evaluate(() => document.getElementById("__uni_accessibility_replay_host")
      .shadowRoot.querySelector(".issue-popover").hidden),
    true,
    "a grouped popover must close after its marker and anchor leave the viewport"
  );
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.activeElement?.classList.contains("marker") === true;
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sectorMarker.dispatchEvent("pointerenter", { pointerType: "mouse", isPrimary: true });
  await page.waitForFunction(() => document.getElementById("__uni_accessibility_replay_host")
    ?.shadowRoot?.querySelector(".issue-popover:not([hidden])") !== null);

  await sendCommand(page, {
    type: "INIT_ISSUES",
    markersVisible: true,
    selectedIssueId: null,
    issues: issues.slice(0, 2)
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("__uni_accessibility_replay_host")?.shadowRoot;
    return root?.querySelectorAll(".marker").length === 2;
  });
  const belowThresholdScopes = await page.evaluate(() => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    return [...root.querySelectorAll(".marker")].map((marker) => marker.dataset.groupScope);
  });
  assert.deepEqual(
    belowThresholdScopes,
    ["element", "element"],
    "two targets in one region must stay separate so small groups are not over-clustered"
  );

  assert.deepEqual(pageErrors, [], `replay sector grouping must not throw: ${pageErrors.join(" | ")}`);
  console.log("Replay sector grouping verified");
} finally {
  await browser.close();
}
