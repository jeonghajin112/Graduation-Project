import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { extractBridgeNumber } from "./replay-marker-test-utils.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardDirectory = path.resolve(scriptDirectory, "..");
const workspaceDirectory = path.resolve(dashboardDirectory, "..");
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

const DISTRIBUTED_COUNTS = [100, 500, 1000, 2000, 5000];
const CLUSTERED_COUNTS = [100, 250, 500, 1000];
const MARKER_HALO = 6;
const MAX_DISTRIBUTED_5000_MS = 12_000;
const MAX_CLUSTERED_1000_MS = 12_000;
const MAX_NEAR_CLUSTERED_1000_MS = 12_000;
const MAX_CLUSTERED_5000_MS = 12_000;
const MAX_NEAR_CLUSTERED_5000_MS = 12_000;
const MAX_DISTRIBUTED_1000_TO_5000_RATIO = 14;
const MAX_CLUSTERED_250_TO_1000_RATIO = 12;
const MAX_NEAR_CLUSTERED_250_TO_1000_RATIO = 12;
const MAX_CLUSTERED_1000_TO_5000_RATIO = 14;
const MAX_NEAR_CLUSTERED_1000_TO_5000_RATIO = 14;
const SAMPLE_TIMEOUT_MS = 30_000;

function extractBridgeScript(source) {
  const joinedDeclaration = 'private static final String BRIDGE_SCRIPT = String.join("",';
  const joinedIndex = source.indexOf(joinedDeclaration);
  if (joinedIndex >= 0) {
    const joinedEnd = source.indexOf("\n    );", joinedIndex);
    assert.ok(joinedEnd > joinedIndex, "joined bridge script declaration must be complete");
    const blocks = [];
    const blockPattern = /"""\r?\n([\s\S]*?)\r?\n {12}"""/g;
    const declaration = source.slice(joinedIndex, joinedEnd);
    let match;
    while ((match = blockPattern.exec(declaration)) !== null) {
      blocks.push(match[1].split(/\r?\n/).map((line) => line.replace(/^ {12}/, "")).join("\n"));
    }
    assert.ok(blocks.length >= 2, "joined bridge script must contain every text block");
    return blocks.join("");
  }

  const declaration = 'private static final String BRIDGE_SCRIPT = """';
  const declarationIndex = source.indexOf(declaration);
  assert.ok(declarationIndex >= 0, "bridge script declaration must exist");
  const contentStart = source.indexOf("\n", declarationIndex) + 1;
  const contentEnd = source.indexOf('\n            """;', contentStart);
  assert.ok(contentStart > 0 && contentEnd > contentStart, "bridge script text block must be complete");
  return source
    .slice(contentStart, contentEnd)
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n");
}

function issue(id, selector, title = `Performance issue ${id}`) {
  return {
    id,
    severity: id % 3 === 0 ? "HIGH" : id % 3 === 1 ? "MEDIUM" : "LOW",
    severityLabel: id % 3 === 0 ? "High" : id % 3 === 1 ? "Medium" : "Low",
    code: `perf-${id}`,
    title,
    message: `Marker performance fixture ${id}`,
    path: selector,
    pathSteps: [{ context: "DOCUMENT", selector }]
  };
}

const browserHarnessScript = `
  (() => {
    let activeSample = null;
    window.__markerPerformanceHarness = {
      begin() {
        if (activeSample && activeSample.observer) activeSample.observer.disconnect();
        const startedAt = performance.now();
        const entries = [];
        let observer = null;
        const supported = Boolean(
          window.PerformanceObserver
          && Array.isArray(PerformanceObserver.supportedEntryTypes)
          && PerformanceObserver.supportedEntryTypes.includes('longtask')
        );
        if (supported) {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              entries.push({ startTime: entry.startTime, duration: entry.duration });
            }
          });
          observer.observe({ type: 'longtask', buffered: false });
        }
        activeSample = { startedAt, entries, observer, supported };
        return startedAt;
      },
      finish() {
        if (!activeSample) throw new Error('marker performance sample was not started');
        const finishedAt = performance.now();
        if (activeSample.observer) {
          for (const entry of activeSample.observer.takeRecords()) {
            activeSample.entries.push({ startTime: entry.startTime, duration: entry.duration });
          }
          activeSample.observer.disconnect();
        }
        const relevantEntries = activeSample.entries.filter((entry) =>
          entry.startTime + entry.duration >= activeSample.startedAt - 1
          && entry.startTime <= finishedAt + 1
        );
        const result = {
          nextFrameMs: finishedAt - activeSample.startedAt,
          longTaskSupported: activeSample.supported,
          longTaskCount: relevantEntries.length,
          longTaskTotalMs: relevantEntries.reduce((total, entry) => total + entry.duration, 0),
          longestTaskMs: relevantEntries.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0)
        };
        activeSample = null;
        return result;
      }
    };
  })();
`;

async function createHarnessPage(browser, bridgeScript, { body, styles, captureMessages = false }) {
  const page = await browser.newPage({ viewport: { width: 1320, height: 780 } });
  await page.setContent(`<!doctype html>
    <html>
      <body style="margin:0">
        <iframe id="replay-fixture" title="Replay bridge performance fixture"
          style="display:block;width:1280px;height:720px;border:0"></iframe>
        <script>
          window.__replayMessages = [];
          ${captureMessages ? `window.addEventListener('message', (event) => {
            if (event.data && event.data.source === 'accessibility-page-replay') {
              window.__replayMessages.push(event.data);
            }
          });` : ""}
        </script>
      </body>
    </html>`);
  const frame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame());
  assert.ok(frame, "replay fixture iframe must exist");
  await frame.setContent(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <style>${styles}</style>
      </head>
      <body>
        ${body}
        <script>${bridgeScript}\n${browserHarnessScript}</script>
      </body>
    </html>`);
  await frame.waitForFunction(() =>
    document.getElementById("__uni_accessibility_replay_host")?.shadowRoot
    && window.__markerPerformanceHarness
  );
  return { page, frame };
}

async function runMeasuredInit(page, issues, expectedMarkerCount) {
  return page.evaluate(async ({ commandIssues, expectedCount, timeoutMs }) => {
    const iframe = document.getElementById("replay-fixture");
    const replayWindow = iframe.contentWindow;
    const replayDocument = iframe.contentDocument;
    const host = replayDocument.getElementById("__uni_accessibility_replay_host");
    const root = host.shadowRoot;
    replayWindow.__markerPerformanceHarness.begin();
    const parentStartedAt = performance.now();

    replayWindow.postMessage({
      source: "accessibility-dashboard",
      type: "INIT_ISSUES",
      markersVisible: true,
      selectedIssueId: null,
      issues: commandIssues
    }, "*");

    await new Promise((resolve, reject) => {
      const poll = () => {
        const markerCount = root.querySelectorAll(".marker").length;
        if (markerCount === expectedCount) {
          replayWindow.requestAnimationFrame(() => replayWindow.setTimeout(resolve, 0));
          return;
        }
        if (performance.now() - parentStartedAt > timeoutMs) {
          reject(new Error(`INIT_ISSUES timed out with ${markerCount}/${expectedCount} markers`));
          return;
        }
        replayWindow.requestAnimationFrame(poll);
      };
      replayWindow.requestAnimationFrame(poll);
    });

    const metrics = replayWindow.__markerPerformanceHarness.finish();
    const markers = [...root.querySelectorAll(".marker")];
    return {
      ...metrics,
      markerCount: markers.length,
      visibleMarkerCount: markers.filter((marker) => !marker.hidden).length
    };
  }, { commandIssues: issues, expectedCount: expectedMarkerCount, timeoutMs: SAMPLE_TIMEOUT_MS });
}

async function clearMarkers(page) {
  const result = await runMeasuredInit(page, [], 0);
  assert.equal(result.markerCount, 0);
}

async function runStableMeasuredInit(page, issues, expectedMarkerCount, repetitions = 3) {
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    await clearMarkers(page);
    runs.push(await runMeasuredInit(page, issues, expectedMarkerCount));
  }
  const sortedRuns = [...runs].sort((left, right) => left.nextFrameMs - right.nextFrameMs);
  const median = sortedRuns[Math.floor(sortedRuns.length / 2)];
  return {
    ...median,
    repetitions,
    minNextFrameMs: sortedRuns[0].nextFrameMs,
    maxNextFrameMs: sortedRuns.at(-1).nextFrameMs
  };
}

async function markerFacts(frame, limit = Number.POSITIVE_INFINITY) {
  return frame.evaluate((maximum) => {
    const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
    return [...root.querySelectorAll(".marker")].slice(0, maximum).map((marker) => {
      const rect = marker.getBoundingClientRect();
      return {
        hidden: marker.hidden,
        label: marker.textContent,
        ariaLabel: marker.getAttribute("aria-label"),
        ariaPressed: marker.getAttribute("aria-pressed"),
        selected: marker.dataset.selected,
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        right: rect.right + window.scrollX,
        bottom: rect.bottom + window.scrollY,
        width: rect.width,
        height: rect.height
      };
    });
  }, Number.isFinite(limit) ? limit : 2 ** 31 - 1);
}

function expandedRect(rect, halo = MARKER_HALO) {
  return {
    left: rect.left - halo,
    top: rect.top - halo,
    right: rect.right + halo,
    bottom: rect.bottom + halo
  };
}

function overlaps(left, right) {
  return !(
    left.right <= right.left
    || right.right <= left.left
    || left.bottom <= right.top
    || right.bottom <= left.top
  );
}

function assertNoHaloCollisions(markers, message) {
  const cellSize = MARKER_SIZE + MARKER_HALO * 2;
  const cells = new Map();
  markers.forEach((marker, markerIndex) => {
    assert.equal(marker.hidden, false, `${message}: marker ${markerIndex + 1} must be visible`);
    assert.equal(marker.width, MARKER_SIZE, `${message}: marker ${markerIndex + 1} width`);
    assert.equal(marker.height, MARKER_SIZE, `${message}: marker ${markerIndex + 1} height`);
    const rect = expandedRect(marker);
    const minColumn = Math.floor(rect.left / cellSize);
    const maxColumn = Math.floor((rect.right - 0.001) / cellSize);
    const minRow = Math.floor(rect.top / cellSize);
    const maxRow = Math.floor((rect.bottom - 0.001) / cellSize);
    const compared = new Set();
    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const key = `${column}:${row}`;
        for (const previousIndex of cells.get(key) ?? []) {
          if (compared.has(previousIndex)) continue;
          compared.add(previousIndex);
          assert.equal(
            overlaps(rect, expandedRect(markers[previousIndex])),
            false,
            `${message}: marker ${markerIndex + 1} halo overlaps marker ${previousIndex + 1}`
          );
        }
      }
    }
    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const key = `${column}:${row}`;
        const occupants = cells.get(key) ?? [];
        occupants.push(markerIndex);
        cells.set(key, occupants);
      }
    }
  });
}

function assertPositionsClose(actual, expected, message, tolerance = 0.25) {
  assert.equal(actual.length, expected.length, `${message}: marker count`);
  actual.forEach((marker, index) => {
    for (const property of ["left", "top", "right", "bottom", "width", "height"]) {
      assert.ok(
        Math.abs(marker[property] - expected[index][property]) <= tolerance,
        `${message}: marker ${index + 1} ${property} expected ${expected[index][property]}, received ${marker[property]}`
      );
    }
    assert.equal(marker.hidden, expected[index].hidden, `${message}: marker ${index + 1} visibility`);
  });
}

function expectedMarker(left, top) {
  return {
    hidden: false,
    left,
    top,
    right: left + MARKER_SIZE,
    bottom: top + MARKER_SIZE,
    width: MARKER_SIZE,
    height: MARKER_SIZE
  };
}

function distributedLegacyPositions(count) {
  return Array.from({ length: count }, (_, index) =>
    expectedMarker(80 - MARKER_SIZE - 8 + index * 80, 80)
  );
}

function exactClusterLegacyPositions(count) {
  return Array.from({ length: count }, (_, index) => {
    const legacyLeft = 1200 - MARKER_SIZE - 8;
    if (index === 0) return expectedMarker(legacyLeft, 102500);
    const slot = Math.ceil(index / 2);
    const direction = index % 2 === 1 ? 1 : -1;
    return expectedMarker(legacyLeft, 102500 + direction * slot * 40);
  });
}

function summarizedMetrics(count, metrics) {
  return {
    count,
    nextFrameMs: Number(metrics.nextFrameMs.toFixed(1)),
    repetitions: metrics.repetitions,
    minNextFrameMs: Number(metrics.minNextFrameMs.toFixed(1)),
    maxNextFrameMs: Number(metrics.maxNextFrameMs.toFixed(1)),
    longTaskSupported: metrics.longTaskSupported,
    longTaskCount: metrics.longTaskCount,
    longTaskTotalMs: Number(metrics.longTaskTotalMs.toFixed(1)),
    longestTaskMs: Number(metrics.longestTaskMs.toFixed(1)),
    visibleMarkerCount: metrics.visibleMarkerCount
  };
}

function ratio(numerator, denominator) {
  return numerator / Math.max(denominator, 1);
}

async function verifyDistributedPerformance(browser, bridgeScript) {
  const columns = 100;
  const horizontalStep = 80;
  const verticalStep = 80;
  const targets = Array.from({ length: 5000 }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return `<span id="distributed-${index + 1}" class="distributed-target"
      style="left:${80 + column * horizontalStep}px;top:${80 + row * verticalStep}px"></span>`;
  }).join("");
  const issues = Array.from({ length: 5000 }, (_, index) =>
    issue(index + 1, `#distributed-${index + 1}`)
  );
  const { page, frame } = await createHarnessPage(browser, bridgeScript, {
    styles: `
      html, body { margin:0; min-width:8160px; min-height:4160px; }
      #distributed-surface { position:relative; width:8160px; height:4160px; }
      .distributed-target { position:absolute; display:block; width:20px; height:20px; }
    `,
    body: `<main id="distributed-surface">${targets}</main>`
  });

  try {
    await runMeasuredInit(page, issues.slice(0, 20), 20);
    await clearMarkers(page);

    const samples = [];
    let baselinePositions = null;
    let repeatedBaselinePositions = null;
    let finalMarkers = null;
    for (const count of DISTRIBUTED_COUNTS) {
      const metrics = await runStableMeasuredInit(page, issues.slice(0, count), count);
      assert.equal(metrics.markerCount, count, `distributed ${count} INIT must complete`);
      assert.equal(metrics.visibleMarkerCount, count, `distributed ${count} markers must all be visible`);
      samples.push({ count, ...metrics });

      if (count === 100) {
        baselinePositions = await markerFacts(frame, 32);
        await clearMarkers(page);
        await runMeasuredInit(page, issues.slice(0, count), count);
        repeatedBaselinePositions = await markerFacts(frame, 32);
        assertPositionsClose(
          repeatedBaselinePositions,
          baselinePositions,
          "distributed 100-marker repeated initialization"
        );
      }
      if (count === 5000) finalMarkers = await markerFacts(frame);
    }

    assert.ok(baselinePositions && finalMarkers);
    assertPositionsClose(
      baselinePositions,
      distributedLegacyPositions(baselinePositions.length),
      "distributed positions must preserve the legacy first-available layout"
    );
    assertPositionsClose(
      finalMarkers.slice(0, baselinePositions.length),
      baselinePositions,
      "distributed first positions must not depend on later issues"
    );
    assertNoHaloCollisions(finalMarkers, "distributed 5000-marker layout");

    const byCount = new Map(samples.map((sample) => [sample.count, sample]));
    const thousand = byCount.get(1000);
    const fiveThousand = byCount.get(5000);
    const scalingRatio = ratio(fiveThousand.nextFrameMs, thousand.nextFrameMs);
    assert.ok(
      fiveThousand.nextFrameMs <= MAX_DISTRIBUTED_5000_MS,
      `distributed 5000 INIT exceeded the generous ${MAX_DISTRIBUTED_5000_MS}ms budget: ${fiveThousand.nextFrameMs.toFixed(1)}ms`
    );
    assert.ok(
      scalingRatio <= MAX_DISTRIBUTED_1000_TO_5000_RATIO,
      `distributed 1000->5000 scaling (${scalingRatio.toFixed(2)}x) indicates a quadratic occupied-marker scan`
    );

    return {
      samples: samples.map((sample) => summarizedMetrics(sample.count, sample)),
      scaling1000To5000: Number(scalingRatio.toFixed(2)),
      deterministicMarkersChecked: baselinePositions.length,
      legacyCoordinatesChecked: baselinePositions.length,
      haloCollisionMarkersChecked: finalMarkers.length
    };
  } finally {
    await page.close();
  }
}

async function verifyClusteredPerformance(browser, bridgeScript) {
  const issues = Array.from({ length: 5000 }, (_, index) =>
    issue(10_001 + index, "#cluster-target", `Clustered performance issue ${index + 1}`)
  );
  const { page, frame } = await createHarnessPage(browser, bridgeScript, {
    styles: `
      html, body { margin:0; min-width:2400px; min-height:205000px; }
      #cluster-surface { position:relative; width:2400px; height:205000px; }
      #cluster-target { position:absolute; left:1200px; top:102500px; width:24px; height:24px; }
    `,
    body: `<main id="cluster-surface"><span id="cluster-target"></span></main>`
  });

  try {
    await runMeasuredInit(page, issues.slice(0, 20), 20);
    await clearMarkers(page);

    const samples = [];
    let baselinePositions = null;
    let repeatedBaselinePositions = null;
    let finalMarkers = null;
    for (const count of CLUSTERED_COUNTS) {
      const metrics = await runStableMeasuredInit(page, issues.slice(0, count), count);
      assert.equal(metrics.markerCount, count, `clustered ${count} INIT must complete`);
      assert.equal(metrics.visibleMarkerCount, count, `clustered ${count} markers must all be visible`);
      samples.push({ count, ...metrics });

      if (count === 250) {
        baselinePositions = await markerFacts(frame, 64);
        await clearMarkers(page);
        await runMeasuredInit(page, issues.slice(0, count), count);
        repeatedBaselinePositions = await markerFacts(frame, 64);
        assertPositionsClose(
          repeatedBaselinePositions,
          baselinePositions,
          "clustered 250-marker repeated initialization"
        );
      }
      if (count === 1000) finalMarkers = await markerFacts(frame);
    }

    const maximumMetrics = await runStableMeasuredInit(page, issues, 5000);
    assert.equal(maximumMetrics.markerCount, 5000, "clustered MAX_ISSUES INIT must complete");
    assert.equal(maximumMetrics.visibleMarkerCount, 5000, "clustered MAX_ISSUES markers must all be visible");
    const maximumMarkers = await markerFacts(frame);
    assert.ok(baselinePositions && finalMarkers);
    assertPositionsClose(
      baselinePositions,
      exactClusterLegacyPositions(baselinePositions.length),
      "clustered positions must preserve the legacy alternating-slot layout"
    );
    assertPositionsClose(
      finalMarkers.slice(0, baselinePositions.length),
      baselinePositions,
      "clustered first positions must not depend on later issues"
    );
    assertPositionsClose(
      maximumMarkers.slice(0, baselinePositions.length),
      baselinePositions,
      "clustered MAX_ISSUES first positions must remain deterministic"
    );
    assertNoHaloCollisions(maximumMarkers, "clustered MAX_ISSUES layout");

    const byCount = new Map(samples.map((sample) => [sample.count, sample]));
    const twoHundredFifty = byCount.get(250);
    const thousand = byCount.get(1000);
    const scalingRatio = ratio(thousand.nextFrameMs, twoHundredFifty.nextFrameMs);
    const maximumScalingRatio = ratio(maximumMetrics.nextFrameMs, thousand.nextFrameMs);
    assert.ok(
      thousand.nextFrameMs <= MAX_CLUSTERED_1000_MS,
      `clustered 1000 INIT exceeded the generous ${MAX_CLUSTERED_1000_MS}ms budget: ${thousand.nextFrameMs.toFixed(1)}ms`
    );
    assert.ok(
      scalingRatio <= MAX_CLUSTERED_250_TO_1000_RATIO,
      `clustered 250->1000 scaling (${scalingRatio.toFixed(2)}x) indicates repeated slot rescanning`
    );
    assert.ok(
      maximumMetrics.nextFrameMs <= MAX_CLUSTERED_5000_MS,
      `clustered MAX_ISSUES INIT exceeded the generous ${MAX_CLUSTERED_5000_MS}ms budget: ${maximumMetrics.nextFrameMs.toFixed(1)}ms`
    );
    assert.ok(
      maximumScalingRatio <= MAX_CLUSTERED_1000_TO_5000_RATIO,
      `clustered 1000->5000 scaling (${maximumScalingRatio.toFixed(2)}x) indicates quadratic slot rescanning`
    );

    return {
      samples: samples.map((sample) => summarizedMetrics(sample.count, sample)),
      maximumIssuesSample: summarizedMetrics(5000, maximumMetrics),
      scaling250To1000: Number(scalingRatio.toFixed(2)),
      scaling1000To5000: Number(maximumScalingRatio.toFixed(2)),
      deterministicMarkersChecked: baselinePositions.length,
      legacyCoordinatesChecked: baselinePositions.length,
      haloCollisionMarkersChecked: maximumMarkers.length
    };
  } finally {
    await page.close();
  }
}

async function verifyNearClusteredPerformance(browser, bridgeScript) {
  const targets = Array.from({ length: 5000 }, (_, index) => {
    const xOffset = index % 71;
    const yOffset = Math.floor(index / 71);
    return `<span id="near-cluster-${index + 1}" class="near-cluster-target"
      style="left:${1200 + xOffset}px;top:${102500 + yOffset}px"></span>`;
  }).join("");
  const issues = Array.from({ length: 5000 }, (_, index) =>
    issue(30_001 + index, `#near-cluster-${index + 1}`, `Near-clustered performance issue ${index + 1}`)
  );
  const { page, frame } = await createHarnessPage(browser, bridgeScript, {
    styles: `
      html, body { margin:0; min-width:2400px; min-height:205000px; }
      #near-cluster-surface { position:relative; width:2400px; height:205000px; }
      .near-cluster-target { position:absolute; display:block; width:24px; height:24px; }
    `,
    body: `<main id="near-cluster-surface">${targets}</main>`
  });

  try {
    await runMeasuredInit(page, issues.slice(0, 20), 20);
    await clearMarkers(page);

    const samples = [];
    let baselinePositions = null;
    let repeatedBaselinePositions = null;
    let finalMarkers = null;
    for (const count of CLUSTERED_COUNTS) {
      const metrics = await runStableMeasuredInit(page, issues.slice(0, count), count);
      assert.equal(metrics.markerCount, count, `near-clustered ${count} INIT must complete`);
      assert.equal(metrics.visibleMarkerCount, count, `near-clustered ${count} markers must all be visible`);
      samples.push({ count, ...metrics });

      if (count === 250) {
        baselinePositions = await markerFacts(frame, 64);
        await clearMarkers(page);
        await runMeasuredInit(page, issues.slice(0, count), count);
        repeatedBaselinePositions = await markerFacts(frame, 64);
        assertPositionsClose(
          repeatedBaselinePositions,
          baselinePositions,
          "near-clustered 250-marker repeated initialization"
        );
      }
      if (count === 1000) finalMarkers = await markerFacts(frame);
    }

    const maximumMetrics = await runStableMeasuredInit(page, issues, 5000);
    assert.equal(maximumMetrics.markerCount, 5000, "near-clustered MAX_ISSUES INIT must complete");
    assert.equal(maximumMetrics.visibleMarkerCount, 5000, "near-clustered MAX_ISSUES markers must all be visible");
    const maximumMarkers = await markerFacts(frame);
    assert.ok(baselinePositions && finalMarkers);
    assertPositionsClose(
      finalMarkers.slice(0, baselinePositions.length),
      baselinePositions,
      "near-clustered first positions must not depend on later issues"
    );
    assertPositionsClose(
      maximumMarkers.slice(0, baselinePositions.length),
      baselinePositions,
      "near-clustered MAX_ISSUES first positions must remain deterministic"
    );
    assertNoHaloCollisions(maximumMarkers, "near-clustered MAX_ISSUES layout");

    const byCount = new Map(samples.map((sample) => [sample.count, sample]));
    const twoHundredFifty = byCount.get(250);
    const thousand = byCount.get(1000);
    const scalingRatio = ratio(thousand.nextFrameMs, twoHundredFifty.nextFrameMs);
    const maximumScalingRatio = ratio(maximumMetrics.nextFrameMs, thousand.nextFrameMs);
    assert.ok(
      thousand.nextFrameMs <= MAX_NEAR_CLUSTERED_1000_MS,
      `near-clustered 1000 INIT exceeded the generous ${MAX_NEAR_CLUSTERED_1000_MS}ms budget: ${thousand.nextFrameMs.toFixed(1)}ms`
    );
    assert.ok(
      scalingRatio <= MAX_NEAR_CLUSTERED_250_TO_1000_RATIO,
      `near-clustered 250->1000 scaling (${scalingRatio.toFixed(2)}x) indicates target-key-specific slot rescanning`
    );
    assert.ok(
      maximumMetrics.nextFrameMs <= MAX_NEAR_CLUSTERED_5000_MS,
      `near-clustered MAX_ISSUES INIT exceeded the generous ${MAX_NEAR_CLUSTERED_5000_MS}ms budget: ${maximumMetrics.nextFrameMs.toFixed(1)}ms`
    );
    assert.ok(
      maximumScalingRatio <= MAX_NEAR_CLUSTERED_1000_TO_5000_RATIO,
      `near-clustered 1000->5000 scaling (${maximumScalingRatio.toFixed(2)}x) indicates quadratic target-key-specific rescanning`
    );

    return {
      samples: samples.map((sample) => summarizedMetrics(sample.count, sample)),
      maximumIssuesSample: summarizedMetrics(5000, maximumMetrics),
      scaling250To1000: Number(scalingRatio.toFixed(2)),
      scaling1000To5000: Number(maximumScalingRatio.toFixed(2)),
      deterministicMarkersChecked: baselinePositions.length,
      haloCollisionMarkersChecked: maximumMarkers.length
    };
  } finally {
    await page.close();
  }
}

async function sendReplayCommand(page, command) {
  await page.evaluate((message) => {
    document.getElementById("replay-fixture").contentWindow.postMessage({
      source: "accessibility-dashboard",
      ...message
    }, "*");
  }, command);
}

async function verifyVisibilityAndInteractions(browser, bridgeScript) {
  const visibleIssues = [
    issue(20_001, "#visible-one", "Visible marker one"),
    issue(20_002, "#visible-two", "Visible marker two")
  ];
  const hiddenIssues = [
    issue(20_003, "#hidden-target", "Display-none marker"),
    issue(20_004, "#clipped-target", "Clipped off-canvas marker")
  ];
  const { page, frame } = await createHarnessPage(browser, bridgeScript, {
    captureMessages: true,
    styles: `
      html, body { margin:0; min-width:1200px; min-height:1000px; }
      #functional-surface { position:relative; width:1200px; height:1000px; }
      #visible-one, #visible-two { position:absolute; display:block; width:120px; height:36px; }
      #visible-one { left:240px; top:180px; }
      #visible-two { left:520px; top:300px; }
      #hidden-target { display:none; }
      #clip-shell { position:absolute; left:700px; top:160px; width:40px; height:40px; overflow:hidden; }
      #clipped-target { position:absolute; left:200px; top:0; width:30px; height:30px; }
    `,
    body: `<main id="functional-surface">
      <button id="visible-one">Visible target one</button>
      <button id="visible-two">Visible target two</button>
      <span id="hidden-target">Hidden target</span>
      <div id="clip-shell"><span id="clipped-target">Off canvas</span></div>
    </main>`
  });

  try {
    await runMeasuredInit(page, visibleIssues, visibleIssues.length);
    const visibleOnlyPositions = await markerFacts(frame);
    assertNoHaloCollisions(visibleOnlyPositions, "functional visible-only baseline");

    const allIssues = [...hiddenIssues, ...visibleIssues];
    await runMeasuredInit(page, allIssues, allIssues.length);
    const allMarkers = await markerFacts(frame);
    assert.equal(allMarkers.length, 4);
    assert.equal(allMarkers[0].hidden, true, "display:none target marker must be excluded");
    assert.equal(allMarkers[1].hidden, true, "fully clipped off-canvas target marker must be excluded");
    assert.equal(allMarkers[0].width, 0);
    assert.equal(allMarkers[1].height, 0);
    assertPositionsClose(
      allMarkers.slice(2),
      visibleOnlyPositions,
      "hidden targets must not consume occupied marker slots"
    );
    assertNoHaloCollisions(allMarkers.slice(2), "functional visible markers");

    const visibleMarkers = frame.locator("#__uni_accessibility_replay_host .marker:not([hidden])");
    assert.equal(await visibleMarkers.count(), 2);
    await visibleMarkers.nth(0).hover();
    await frame.waitForFunction(() => {
      const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
      return !root.querySelector(".issue-popover").hidden
        && root.querySelector(".issue-popover__title").textContent === "Visible marker one";
    });
    let interactionState = await frame.evaluate(() => {
      const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
      const marker = root.querySelectorAll(".marker")[2];
      const popover = root.querySelector(".issue-popover");
      return {
        selected: marker.dataset.selected,
        pressed: marker.getAttribute("aria-pressed"),
        popoverHidden: popover.hidden,
        popoverRole: popover.getAttribute("role"),
        describedBy: marker.getAttribute("aria-describedby")
      };
    });
    assert.deepEqual(interactionState, {
      selected: "true",
      pressed: "true",
      popoverHidden: false,
      popoverRole: "tooltip",
      describedBy: "__uni_accessibility_replay_issue_popover"
    });

    await page.mouse.move(1310, 770);
    await page.waitForTimeout(180);
    await visibleMarkers.nth(1).click();
    await frame.waitForFunction(() => {
      const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
      return root.querySelectorAll(".marker")[3].dataset.selected === "true"
        && !root.querySelector(".issue-popover").hidden;
    });
    await page.waitForFunction(() => window.__replayMessages.some((message) =>
      message.type === "ISSUE_SELECTED" && message.issueId === 20_002
    ));
    assert.ok(
      (await page.evaluate(() => window.__replayMessages)).some((message) =>
        message.type === "ISSUE_SELECTED" && message.issueId === 20_002
      ),
      "click selection must notify the dashboard parent"
    );

    await page.keyboard.press("Escape");
    await page.mouse.move(1310, 770);
    await page.waitForTimeout(180);
    await sendReplayCommand(page, { type: "FOCUS_ISSUE", issueId: 20_001 });
    await frame.waitForFunction(() => {
      const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
      return root.querySelectorAll(".marker")[2].dataset.selected === "true"
        && root.querySelectorAll(".selection-fragment").length > 0;
    });

    await page.keyboard.press("Tab");
    await visibleMarkers.nth(1).focus();
    await frame.waitForFunction(() => {
      const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
      const marker = root.querySelectorAll(".marker")[3];
      return root.activeElement === marker && marker.matches(":focus-visible");
    });
    await visibleMarkers.nth(1).press("Enter");
    await frame.waitForFunction(() => {
      const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
      const marker = root.querySelectorAll(".marker")[3];
      return marker.dataset.selected === "true" && !root.querySelector(".issue-popover").hidden;
    });
    interactionState = await frame.evaluate(() => {
      const root = document.getElementById("__uni_accessibility_replay_host").shadowRoot;
      const marker = root.querySelectorAll(".marker")[3];
      const style = getComputedStyle(marker);
      return {
        active: root.activeElement === marker,
        focusVisible: marker.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        popoverHidden: root.querySelector(".issue-popover").hidden,
        selectionFragments: root.querySelectorAll(".selection-fragment").length
      };
    });
    assert.equal(interactionState.active, true);
    assert.equal(interactionState.focusVisible, true);
    assert.equal(interactionState.outlineStyle, "solid");
    assert.equal(interactionState.outlineWidth, "3px");
    assert.equal(interactionState.popoverHidden, false);
    assert.ok(interactionState.selectionFragments > 0);

    return {
      totalMarkers: allMarkers.length,
      visibleMarkers: allMarkers.filter((marker) => !marker.hidden).length,
      excludedMarkers: allMarkers.filter((marker) => marker.hidden).length,
      hover: "PASS",
      clickSelection: "PASS",
      parentFocusCommand: "PASS",
      keyboardFocusAndPopover: "PASS"
    };
  } finally {
    await page.close();
  }
}

const sanitizerSource = await readFile(sanitizerPath, "utf8");
const bridgeScriptSource = extractBridgeScript(sanitizerSource);
const MARKER_SIZE = extractBridgeNumber(bridgeScriptSource, "MARKER_SIZE");
const bridgeScript = bridgeScriptSource.replace(
  "host.attachShadow({ mode: 'closed' })",
  "host.attachShadow({ mode: 'open' })"
);
assert.equal(MARKER_SIZE, 24, "the compact replay marker contract is 24px");
assert.match(bridgeScript, /const MAX_ISSUES = 5000/);
assert.match(bridgeScript, /const MARKER_HALO = 6/);
assert.match(bridgeScript, /const MARKER_SLOT_STEP = 40/);
assert.match(bridgeScript, /const CAROUSEL_CONTROL_SELECTOR =/);

const browser = await chromium.launch({ headless: true });
try {
  const requestedSuites = new Set(process.argv.slice(2));
  const runEverySuite = requestedSuites.size === 0;
  const functional = runEverySuite || requestedSuites.has("--functional")
    ? await verifyVisibilityAndInteractions(browser, bridgeScript)
    : undefined;
  const distributed = runEverySuite || requestedSuites.has("--distributed")
    ? await verifyDistributedPerformance(browser, bridgeScript)
    : undefined;
  const clustered = runEverySuite || requestedSuites.has("--clustered")
    ? await verifyClusteredPerformance(browser, bridgeScript)
    : undefined;
  const nearClustered = runEverySuite || requestedSuites.has("--near-clustered")
    ? await verifyNearClusteredPerformance(browser, bridgeScript)
    : undefined;
  assert.ok(
    runEverySuite || [functional, distributed, clustered, nearClustered].some(Boolean),
    "select --functional, --distributed, --clustered, or --near-clustered"
  );
  console.log(JSON.stringify({
    result: "PASS",
    budgets: {
      distributed5000Ms: MAX_DISTRIBUTED_5000_MS,
      distributed1000To5000Ratio: MAX_DISTRIBUTED_1000_TO_5000_RATIO,
      clustered1000Ms: MAX_CLUSTERED_1000_MS,
      clustered250To1000Ratio: MAX_CLUSTERED_250_TO_1000_RATIO,
      nearClustered1000Ms: MAX_NEAR_CLUSTERED_1000_MS,
      nearClustered250To1000Ratio: MAX_NEAR_CLUSTERED_250_TO_1000_RATIO,
      clustered5000Ms: MAX_CLUSTERED_5000_MS,
      clustered1000To5000Ratio: MAX_CLUSTERED_1000_TO_5000_RATIO,
      nearClustered5000Ms: MAX_NEAR_CLUSTERED_5000_MS,
      nearClustered1000To5000Ratio: MAX_NEAR_CLUSTERED_1000_TO_5000_RATIO
    },
    functional,
    distributed,
    clustered,
    nearClustered
  }, null, 2));
} finally {
  await browser.close();
}
