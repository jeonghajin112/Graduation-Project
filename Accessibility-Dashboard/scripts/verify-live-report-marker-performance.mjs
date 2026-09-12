import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { exportLiveReportBrowserFixture } from "./fixtures/live-report-browser-fixture.mjs";

const parentUrl = "http://localhost/live-marker-performance";
const viewerUrl = "http://localhost/live-marker-performance-viewer";
const sessionId = "6b2d884e-a7f4-4f09-9776-688d08fe8912";
const bridgeSecret = "test-bridge-secret";
const challenge = "marker_performance_challenge_00000001";
const viewportDimension = (name, fallback) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  assert.ok(/^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0 && value <= 16384,
    `${name} must be an integer from 1 to 16384`);
  return value;
};
const viewport = {
  width: viewportDimension("AP_LIVE_REPORT_VIEWPORT_WIDTH", 1000),
  height: viewportDimension("AP_LIVE_REPORT_VIEWPORT_HEIGHT", 820)
};
const parentHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;overflow:hidden"><iframe id="viewer" title="Live report" src="${viewerUrl}"
style="display:block;width:100vw;height:100vh;border:0"></iframe><script>
(() => {
  const iframe = document.getElementById("viewer");
  const events = window.__liveEvents = [];
  let port, documentToken, sequence = 0;
  window.__sendLiveCommand = payload => port.postMessage({
    source:"accessibility-dashboard-live-report", type:"COMMAND", protocolVersion:1,
    bridgeSecret:${JSON.stringify(bridgeSecret)}, challenge:${JSON.stringify(challenge)},
    documentToken, sequence:++sequence, payload
  });
  addEventListener("message", event => {
    const message = event.data;
    if (event.source !== iframe.contentWindow || port || !message
      || message.source !== "accessibility-page-live-report" || message.type !== "AVAILABLE"
      || message.protocolVersion !== 1 || message.sessionId !== ${JSON.stringify(sessionId)}) return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = ({data}) => {
      events.push(data);
      if (data?.type === "ACK") documentToken = data.documentToken;
    };
    port.start();
    iframe.contentWindow.postMessage({source:"accessibility-dashboard-live-report", type:"CONNECT",
      protocolVersion:1, bridgeSecret:${JSON.stringify(bridgeSecret)},
      challenge:${JSON.stringify(challenge)}}, location.origin, [channel.port2]);
  });
})();
</script></body></html>`;

const issue = (id, selector, pathSteps = [{ context: "DOCUMENT", selector }]) => ({
  id, title: `Performance issue ${id}`, message: "Fixture recommendation", code: "4.1.2",
  severity: "MEDIUM", severityLabel: "중간", category: "structure", analyzer: "RULE_BASED",
  path: selector, pathSteps
});
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ap-live-marker-performance-"));
const results = [];
const failures = [];
let browser;

try {
  const fixturePath = process.env.AP_LIVE_REPORT_FIXTURE_PATH?.trim()
    || path.join(temporaryDirectory, "viewer.html");
  if (!process.env.AP_LIVE_REPORT_FIXTURE_PATH?.trim()) await exportLiveReportBrowserFixture(fixturePath);
  const fixture = await readFile(fixturePath, "utf8");
  assert.match(fixture, /data-ap-live-bridge="true"/);
  browser = await chromium.launch({ headless: true });

  const runCase = async (name, verify) => {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Even rewritten asset requests are fulfilled locally; no backend or
    // upstream service is contacted during this generated-bridge regression.
    await context.route("**/*", route => route.fulfill({
      status: [parentUrl, viewerUrl].includes(route.request().url()) ? 200 : 204,
      contentType: "text/html; charset=utf-8",
      body: route.request().url() === parentUrl ? parentHtml
        : route.request().url() === viewerUrl ? fixture : ""
    }));
    await page.addInitScript(() => {
      const nativeQuery = Document.prototype.querySelector;
      const nativeQueryAll = Document.prototype.querySelectorAll;
      const watchedRoots = new WeakMap();
      let queries = {}, filterVisits = 0, membershipAdds = 0, membershipDeletes = 0;
      const isMarkerGroup = value => value?.element instanceof Element
        && value?.marker instanceof Element && value.marker.classList.contains("ap-live-marker");
      // Install before bridge injection. These probes measure browser calls and
      // collection operations without extracting or matching private functions.
      for (const prototype of [Document.prototype, ShadowRoot.prototype]) {
        const original = prototype.querySelector;
        prototype.querySelector = function (selector) {
          const watch = watchedRoots.get(this);
          if (watch?.selectors.has(selector)) {
            const key = `${watch.label}: ${selector}`;
            queries[key] = (queries[key] || 0) + 1;
          }
          return original.call(this, selector);
        };
      }
      const nativeFilter = Array.prototype.filter;
      Array.prototype.filter = function (callback, thisArg) {
        if (typeof callback !== "function") return nativeFilter.call(this, callback, thisArg);
        return nativeFilter.call(this, (value, index, array) => {
          if (isMarkerGroup(value)) filterVisits += 1;
          return callback.call(thisArg, value, index, array);
        });
      };
      for (const [method, increment] of [
        ["add", () => { membershipAdds += 1; }],
        ["delete", () => { membershipDeletes += 1; }]
      ]) {
        const original = Set.prototype[method];
        Set.prototype[method] = function (value) {
          if (isMarkerGroup(value)) increment();
          return original.call(this, value);
        };
      }
      window.__markerPerformanceProbe = {
        watch(root, label, selectors) { watchedRoots.set(root, { label, selectors: new Set(selectors) }); },
        query(selector) { return nativeQuery.call(document, selector); },
        markers() { return Array.from(nativeQueryAll.call(document, ".ap-live-marker")); },
        reset() { queries = {}; filterVisits = membershipAdds = membershipDeletes = 0; },
        snapshot() { return { queries: { ...queries }, filterVisits, membershipAdds, membershipDeletes }; },
        async flush() {
          // MutationObserver, MessageChannel and scheduled layout callbacks
          // cross task/frame boundaries. No elapsed-time performance budget.
          for (let index = 0; index < 4; index += 1) {
            await new Promise(resolve => setTimeout(resolve, 0));
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
        }
      };
    });
    try {
      await page.goto(parentUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__liveEvents.some(event => event.type === "ACK")
        && window.__liveEvents.some(event => event.type === "EVENT" && event.payload?.type === "READY"));
      const frame = page.frames().find(candidate => candidate.url() === viewerUrl);
      assert.ok(frame, "authenticated viewer frame must load");
      assert.deepEqual(await frame.evaluate(() => ({ width: innerWidth, height: innerHeight })), viewport,
        "the responsive viewer frame must use the requested viewport");
      const flush = () => frame.evaluate(() => window.__markerPerformanceProbe.flush());
      const init = async issues => {
        await page.evaluate(payload => window.__sendLiveCommand({
          source: "accessibility-dashboard", type: "INIT_ISSUES", issues: payload,
          selectedIssueId: null, markersVisible: true
        }), issues);
        await page.waitForFunction(count => new Set(window.__liveEvents
          .filter(event => event.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
          .map(event => event.payload.issueId)).size === count, issues.length);
        await flush();
      };
      const measurements = await verify({ page, frame, flush, init });
      assert.deepEqual(errors, [], "generated bridge must not throw");
      results.push({ name, ...measurements });
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    } finally {
      await context.close();
    }
  };

  for (const count of [100, 1000]) {
    await runCase(`${count} clustered targets have bounded membership work`, async ({ frame, flush, init }) => {
      await frame.evaluate(count => {
        const main = document.querySelector("main");
        main.replaceChildren();
        for (let index = 0; index < count; index += 1) {
          const target = document.createElement("div");
          target.id = `perf-cluster-${index}`;
          target.style.cssText = "position:fixed;left:260px;top:160px;width:300px;height:64px";
          target.textContent = "Overlapping fixture target";
          main.append(target);
        }
      }, count);
      await flush();
      await init(Array.from({ length: count }, (_, index) => issue(index + 1, `#perf-cluster-${index}`)));
      const cluster = frame.locator(".ap-live-marker--cluster:visible");
      assert.equal(await cluster.count(), 1, "all overlapping targets must form one cluster");
      assert.equal(await cluster.locator(".ap-live-marker__count").textContent(), String(count));
      await frame.evaluate(() => window.__markerPerformanceProbe.reset());
      for (let pass = 0; pass < 3; pass += 1) {
        await frame.evaluate(() => dispatchEvent(new Event("resize")));
        await flush();
      }
      const measurements = await frame.evaluate(() => window.__markerPerformanceProbe.snapshot());
      assert.ok(measurements.filterVisits <= 12 * count,
        `cluster membership filtering must stay linear: ${measurements.filterVisits} visits for ${count} targets`);
      assert.ok(measurements.membershipAdds + measurements.membershipDeletes <= 24 * count,
        "repeated placement must use bounded membership operations");
      assert.equal(await cluster.locator(".ap-live-marker__count").textContent(), String(count));
      return { targets: count, filterVisits: measurements.filterVisits,
        membershipAdds: measurements.membershipAdds, membershipDeletes: measurements.membershipDeletes };
    });
  }

  await runCase("root scrolling and style animation do not re-query locators", async ({ frame, flush, init }) => {
    const count = 20;
    const animationFrames = 12;
    await frame.evaluate(count => {
      const main = document.querySelector("main");
      main.innerHTML = '<div id="perf-animation-host" style="position:fixed;left:260px;top:160px;width:300px;height:64px"></div>';
      document.body.style.minHeight = `${innerHeight * 3}px`;
      const host = document.getElementById("perf-animation-host");
      const selectors = [];
      for (let index = 0; index < count; index += 1) {
        const target = document.createElement("div");
        target.id = `perf-animated-${index}`;
        target.style.cssText = "position:absolute;inset:0";
        target.textContent = "Moving clustered target";
        host.append(target);
        selectors.push(`#${target.id}`);
      }
      window.__markerPerformanceProbe.watch(document, "document", selectors);
    }, count);
    await flush();
    await init(Array.from({ length: count }, (_, index) => issue(index + 1, `#perf-animated-${index}`)));
    const cluster = frame.locator(".ap-live-marker--cluster:visible");
    assert.equal(await cluster.count(), 1);
    const beforeLeft = await cluster.evaluate(marker => marker.getBoundingClientRect().left);
    await frame.evaluate(() => window.__markerPerformanceProbe.reset());
    for (const top of [80, 160]) {
      await frame.evaluate(top => scrollTo(0, top), top);
      await flush();
    }
    await frame.evaluate(async frames => {
      const host = document.getElementById("perf-animation-host");
      for (let index = 1; index <= frames; index += 1) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        host.style.transform = `translateX(${index * 2}px)`;
      }
    }, animationFrames);
    await flush();
    const measurements = await frame.evaluate(() => ({
      ...window.__markerPerformanceProbe.snapshot(), scrollY,
      markerLeft: window.__markerPerformanceProbe.query(".ap-live-marker--cluster").getBoundingClientRect().left
    }));
    assert.equal(measurements.scrollY, 160, "the viewer's document must actually scroll");
    assert.deepEqual(measurements.queries, {}, "scroll and transform animation must not re-query recognized locators");
    assert.equal(measurements.filterVisits, 0, "animated clusters must not filter their membership arrays");
    assert.ok(measurements.membershipAdds + measurements.membershipDeletes <= count * (animationFrames + 6) * 4,
      "scroll and animation must keep membership operations bounded by targets and frames");
    assert.ok(Math.abs(measurements.markerLeft - beforeLeft - animationFrames * 2) < 1,
      "the cluster marker must follow the final animated position");
    return { targets: count, animationFrames, scrollY: measurements.scrollY, queries: measurements.queries,
      filterVisits: measurements.filterVisits, membershipAdds: measurements.membershipAdds,
      membershipDeletes: measurements.membershipDeletes };
  });

  await runCase("path fallback and invalid paths report their actual locator results", async ({ page, frame, flush, init }) => {
    await frame.evaluate(() => {
      document.querySelector("main").innerHTML = '<div id="perf-path-only" style="width:300px;height:60px">Legacy path target</div>';
    });
    await flush();
    // The authenticated protocol requires an array, even for the legacy path
    // fallback. An empty array exercises that fallback without bypassing it.
    await init([
      issue(501, "#perf-path-only", []),
      issue(502, "#perf-path-only", [{ context: "DOCUMENT", selector: " " }]),
      issue(503, "", [])
    ]);
    const statuses = await page.evaluate(() => Object.fromEntries(window.__liveEvents
      .filter(event => event.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
      .map(({ payload }) => [payload.issueId, { status: payload.status, reason: payload.reason ?? null }])));
    assert.equal(statuses[501].status, "VISIBLE", "path-only fallback must resolve a real target");
    assert.deepEqual(statuses[502], { status: "UNAVAILABLE", reason: "INVALID_PATH_STEP" });
    assert.deepEqual(statuses[503], { status: "UNAVAILABLE", reason: "EMPTY_PATH" });
    assert.equal(await frame.locator(".ap-live-marker").count(), 1);
    assert.equal(await frame.locator('.ap-live-marker[data-issue-id="501"]').count(), 1);
    return { statuses };
  });

  await runCase("shared paths query each actual root and selector once", async ({ frame, flush, init }) => {
    const sharedSelector = "main > section#perf-shared:nth-of-type(1)";
    await frame.evaluate(sharedSelector => {
      const probe = window.__markerPerformanceProbe;
      document.querySelector("main").innerHTML = '<section id="perf-shared">Shared document target</section>'
        + '<div id="perf-shadow-one"></div><div id="perf-shadow-two"></div><aside id="perf-unrelated"></aside>';
      probe.watch(document, "document", [sharedSelector, "#perf-shadow-one", "#perf-shadow-two"]);
      for (const suffix of ["one", "two"]) {
        const host = document.getElementById(`perf-shadow-${suffix}`);
        host.style.cssText = "display:block;margin-top:120px";
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = '<div id="perf-child" style="width:300px;height:60px">Shared shadow target</div>';
        probe.watch(root, `shadow-${suffix}`, ["#perf-child"]);
      }
    }, sharedSelector);
    await flush();
    await frame.evaluate(() => window.__markerPerformanceProbe.reset());
    const issues = Array.from({ length: 120 }, (_, index) => {
      if (index < 40) return issue(index + 1, sharedSelector);
      const host = index < 80 ? "#perf-shadow-one" : "#perf-shadow-two";
      return issue(index + 1, "#perf-child", [
        { context: "DOCUMENT", selector: host }, { context: "SHADOW_ROOT", selector: "#perf-child" }
      ]);
    });
    await init(issues);
    const expected = {
      [`document: ${sharedSelector}`]: 1, "document: #perf-shadow-one": 1,
      "document: #perf-shadow-two": 1, "shadow-one: #perf-child": 1, "shadow-two: #perf-child": 1
    };
    const initial = await frame.evaluate(() => window.__markerPerformanceProbe.snapshot().queries);
    assert.deepEqual(initial, expected, "initial resolution must cache repeated paths separately for each root");
    await frame.evaluate(() => {
      window.__markerPerformanceProbe.reset();
      document.getElementById("perf-unrelated").append(document.createElement("strong"));
    });
    await flush();
    const reconciled = await frame.evaluate(() => window.__markerPerformanceProbe.snapshot().queries);
    assert.deepEqual(reconciled, expected, "structural mutation must resolve each distinct root/selector once");
    assert.equal(await frame.locator(".ap-live-marker").count(), 3, "identical shadow selectors must retain distinct targets");
    return { issues: issues.length, initialQueries: initial, reconciliationQueries: reconciled };
  });

  await runCase("unrelated classes skip locators and replacement preserves unaffected markers", async ({ page, frame, flush, init }) => {
    const stableSelector = "main > section#perf-stable:nth-of-type(1)";
    await frame.evaluate(stableSelector => {
      document.querySelector("main").innerHTML = '<div id="perf-change" style="position:absolute;left:250px;top:100px;width:300px;height:60px">Selected target</div>'
        + '<section id="perf-stable" style="position:absolute;left:250px;top:450px;width:300px;height:60px">Stable target</section>'
        + '<aside id="perf-unrelated"></aside>';
      window.__markerPerformanceProbe.watch(document, "document", ["#perf-change", stableSelector]);
    }, stableSelector);
    await flush();
    await init([issue(201, "#perf-change"), issue(202, stableSelector)]);
    await frame.evaluate(() => {
      const probe = window.__markerPerformanceProbe;
      window.__originalMarkers = probe.markers();
      probe.reset();
      document.getElementById("perf-unrelated").className = "unrelated-decoration";
    });
    await flush();
    const unrelated = await frame.evaluate(() => ({
      ...window.__markerPerformanceProbe.snapshot(),
      reused: window.__originalMarkers.every(marker => marker.isConnected
        && window.__markerPerformanceProbe.markers().includes(marker))
    }));
    assert.deepEqual(unrelated.queries, {}, "unrelated class changes cannot affect recognized generated paths");
    assert.equal(unrelated.reused, true, "unrelated mutation must retain both marker nodes");
    await page.evaluate(() => window.__sendLiveCommand({
      source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 201
    }));
    await frame.locator(".ap-live-popover").waitFor({ state: "visible" });
    await flush();
    await frame.evaluate(() => {
      const target = document.getElementById("perf-change");
      const replacement = target.cloneNode(true);
      replacement.style.top = "260px";
      replacement.textContent = "Replacement of selected target";
      target.replaceWith(replacement);
    });
    await frame.waitForFunction(() => {
      const probe = window.__markerPerformanceProbe;
      const fragment = probe.query(".ap-live-highlight__fragment");
      const target = document.getElementById("perf-change");
      return fragment && Math.abs(fragment.getBoundingClientRect().top - (target.getBoundingClientRect().top - 4)) < 1;
    });
    await flush();
    const replacement = await frame.evaluate(() => {
      const probe = window.__markerPerformanceProbe;
      const stable = window.__originalMarkers.find(marker => marker.dataset.issueId === "202");
      const rect = element => {
        const bounds = element.getBoundingClientRect();
        return [bounds.left, bounds.top, bounds.right, bounds.bottom].map(Math.round);
      };
      return {
        stableReused: stable.isConnected && probe.markers().includes(stable),
        markerCount: probe.markers().length,
        title: probe.query(".ap-live-popover__title").textContent,
        highlight: rect(probe.query(".ap-live-highlight__fragment")),
        target: rect(document.getElementById("perf-change"))
      };
    });
    assert.equal(replacement.stableReused, true, "replacing one target must retain the other marker's DOM identity");
    assert.equal(replacement.markerCount, 2);
    assert.equal(replacement.title, "Performance issue 201", "selected issue detail must stay open");
    assert.deepEqual(replacement.highlight, replacement.target.map((coordinate, index) => coordinate + (index < 2 ? -4 : 4)),
      "selected issue highlight must bind to the new target without another focus command");
    const removalEventStart = await page.evaluate(() => window.__liveEvents.length);
    await frame.evaluate(() => {
      const target = document.getElementById("perf-change");
      window.__restorableTarget = target.cloneNode(true);
      target.remove();
    });
    await page.waitForFunction(start => window.__liveEvents.slice(start).some(event =>
      event.type === "EVENT" && event.payload?.type === "ISSUE_DETAIL_FALLBACK" && event.payload.issueId === 201
    ), removalEventStart);
    await frame.locator(".ap-live-popover").waitFor({ state: "hidden" });
    assert.equal(await frame.locator(".ap-live-marker").count(), 1, "removing the selected target must remove only its marker");
    await frame.evaluate(() => {
      window.__restorableTarget.style.top = "330px";
      document.querySelector("main").append(window.__restorableTarget);
    });
    await frame.locator(".ap-live-popover").waitFor({ state: "visible" });
    await flush();
    const restored = await frame.evaluate(() => {
      const probe = window.__markerPerformanceProbe;
      const stable = window.__originalMarkers.find(marker => marker.dataset.issueId === "202");
      return {
        stableReused: stable.isConnected && probe.markers().includes(stable),
        title: probe.query(".ap-live-popover__title").textContent,
        highlightTop: probe.query(".ap-live-highlight__fragment").getBoundingClientRect().top,
        targetTop: document.getElementById("perf-change").getBoundingClientRect().top
      };
    });
    assert.equal(restored.stableReused, true, "unaffected marker identity must survive removal and restoration");
    assert.equal(restored.title, "Performance issue 201", "returning target must restore the selected detail without another focus command");
    assert.ok(Math.abs(restored.highlightTop - (restored.targetTop - 4)) < 1,
      "returning target must restore the selected highlight at its new position");
    return { unrelatedClassQueries: unrelated.queries, unaffectedMarkerReused: replacement.stableReused,
      restoredSelectedIssue: restored.title };
  });

  await runCase("unrelated replacement preserves the selected cluster member", async ({ page, frame, flush, init }) => {
    await frame.evaluate(() => {
      document.querySelector("main").innerHTML = '<div id="perf-cluster-host" style="position:absolute;left:250px;top:120px;width:300px;height:60px">First clustered target</div>'
        + '<div id="perf-cluster-member" style="position:absolute;left:250px;top:120px;width:300px;height:90px">Selected clustered target</div>'
        + '<div id="perf-other" style="position:absolute;left:250px;top:450px;width:300px;height:60px">Other target</div>';
    });
    await flush();
    await init([issue(401, "#perf-cluster-host"), issue(402, "#perf-cluster-member"), issue(403, "#perf-other")]);
    assert.equal(await frame.locator(".ap-live-marker--cluster:visible").count(), 1);
    await page.evaluate(() => window.__sendLiveCommand({
      source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 402
    }));
    await frame.locator(".ap-live-popover__title").filter({ hasText: "Performance issue 402" }).waitFor({ state: "visible" });
    await frame.evaluate(() => {
      const probe = window.__markerPerformanceProbe;
      window.__selectedClusterMarker = probe.query(".ap-live-marker--cluster");
      const target = document.getElementById("perf-other");
      target.replaceWith(target.cloneNode(true));
    });
    await flush();
    const state = await frame.evaluate(() => {
      const probe = window.__markerPerformanceProbe;
      const marker = probe.query(".ap-live-marker--cluster");
      return {
        markerReused: marker === window.__selectedClusterMarker && marker.isConnected,
        title: probe.query(".ap-live-popover__title").textContent,
        page: probe.query(".ap-live-popover__position").textContent,
        highlightBottom: probe.query(".ap-live-highlight__fragment").getBoundingClientRect().bottom,
        memberBottom: document.getElementById("perf-cluster-member").getBoundingClientRect().bottom
      };
    });
    assert.equal(state.markerReused, true, "an unrelated replacement must retain the open cluster marker");
    assert.equal(state.title, "Performance issue 402", "cluster selection must remain on its second issue");
    assert.match(state.page, /총 2개 중 2번째 문제/);
    assert.ok(Math.abs(state.highlightBottom - (state.memberBottom + 4)) < 1,
      "cluster highlight must retain the selected member's distinct geometry");
    return { selectedTitle: state.title, clusterMarkerReused: state.markerReused };
  });

  await runCase("complex selectors retain conservative mutation fallback", async ({ frame, flush, init }) => {
    const selector = ".perf-candidate.is-current";
    await frame.evaluate(selector => {
      document.querySelector("main").innerHTML = '<section id="perf-first" class="perf-candidate is-current" style="height:60px">First target</section>'
        + '<section id="perf-second" class="perf-candidate" style="margin-top:160px;height:60px">Next target</section>';
      window.__markerPerformanceProbe.watch(document, "document", [selector]);
    }, selector);
    await flush();
    await init([issue(301, selector)]);
    await frame.evaluate(() => {
      const probe = window.__markerPerformanceProbe;
      probe.reset();
      document.getElementById("perf-first").classList.remove("is-current");
      document.getElementById("perf-second").classList.add("is-current");
    });
    await flush();
    const measurements = await frame.evaluate(() => ({
      queries: window.__markerPerformanceProbe.snapshot().queries,
      markerCount: window.__markerPerformanceProbe.markers().length,
      markerTop: window.__markerPerformanceProbe.markers()[0].getBoundingClientRect().top,
      targetTop: document.getElementById("perf-second").getBoundingClientRect().top
    }));
    assert.equal(measurements.queries[`document: ${selector}`], 1, "class-dependent fallback must resolve through one snapshot");
    assert.equal(measurements.markerCount, 1, "complex selector must retain one marker after a class change");
    assert.ok(Math.abs(measurements.markerTop - measurements.targetTop) < 80, "marker must follow the newly matching target");
    return { queries: measurements.queries, markerCount: measurements.markerCount };
  });

  console.log(JSON.stringify({ viewport, results, failures }, null, 2));
  assert.deepEqual(failures, [], "live marker performance regressions failed");
} finally {
  await browser?.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
