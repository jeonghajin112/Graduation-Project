import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";
import { exportLiveReportBrowserFixture } from "./fixtures/live-report-browser-fixture.mjs";
import { verifyLiveReportKeyboardNavigation } from "./fixtures/live-report-keyboard-checks.mjs";

const sessionId = "6b2d884e-a7f4-4f09-9776-688d08fe8912";
const bridgeSecret = "test-bridge-secret";
const challenge = "live_marker_browser_challenge_00000001";

function createParentHtml(viewerUrl = "/viewer") {
  return `<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><title>Live marker harness</title></head>
      <body style="margin:0">
        <iframe id="viewer" title="Live report" src="${viewerUrl}" style="width:900px;height:760px;border:0"></iframe>
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
                if (incoming?.type === "EVENT" && incoming.documentToken === documentToken &&
                    incoming.payload?.type === "REPORT_FOCUS_EXIT") {
                  document.getElementById(incoming.payload.direction === "backward"
                    ? "before-viewer" : "after-viewer")?.focus();
                }
              };
              port.start();
              iframe.contentWindow.postMessage({
                source: "accessibility-dashboard-live-report",
                type: "CONNECT",
                protocolVersion: 1,
                bridgeSecret: ${JSON.stringify(bridgeSecret)},
                challenge: ${JSON.stringify(challenge)}
              }, new URL(iframe.src).origin, [channel.port2]);
            });
          })();
        <\/script>
      </body>
    </html>`;
}

function createIssue(id, selector, title, severity, category, code, carouselContext) {
  const severityLabels = {
    LOW: "낮음",
    MEDIUM: "중간",
    MODERATE: "중간",
    HIGH: "높음",
    SERIOUS: "높음",
    CRITICAL: "심각"
  };
  return {
    id,
    title,
    message: `분석 문장\n${title}\n\n개선 필요\n• 테스트 권고 사항`,
    code,
    severity,
    severityLabel: severityLabels[severity] ?? severity,
    category,
    analyzer: category === "visual" ? "CV_VISION" : String(code).startsWith("3.1") ? "AI_TEXT" : "RULE_BASED",
    path: selector,
    pathSteps: [{ context: "DOCUMENT", selector }],
    ...(carouselContext ? { carouselContext } : {})
  };
}

// Page-script animation frames are held while a marker is hovered or keyboard
// focused, so waits inside the report document use the document timeline.
function waitForReportFrames(locator) {
  return locator.evaluate(() => document.documentElement.animate([], 34).finished.then(() => undefined));
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
  const prebuiltFixture = process.env.AP_LIVE_REPORT_FIXTURE_PATH?.trim();
  const rewrittenHtml = prebuiltFixture
    ? await readFile(prebuiltFixture, "utf8")
    : (await exportLiveReportBrowserFixture(fixturePath), await readFile(fixturePath, "utf8"));
  assert.match(rewrittenHtml, /data-ap-live-bridge="true"/);

  const parentHtml = createParentHtml();
  server = createServer((request, response) => {
    if (request.url === "/viewer") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(rewrittenHtml);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/keyboard"
      ? createParentHtml(`http://localhost:${server.address().port}/viewer`)
      : parentHtml);
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

  const titleFrame = page.frameLocator("#viewer");
  await titleFrame.locator('body').evaluate(body => {
    const host = document.createElement('div');
    host.id = 'inset-fixture'; host.style.display = 'contents';
    host.innerHTML = `<header id="inset-fixed" style="position:fixed;top:0;left:0;width:100%;height:48px;background:white;z-index:9999"><span id="inset-nested" style="position:sticky;top:0;display:block">Fixed navigation</span></header>
      <header id="inset-sticky" style="position:sticky;top:-1px;height:0;z-index:9998"><div style="position:absolute;top:0;left:0;width:100%;height:48px;background:white">Sticky navigation</div></header>
      <div id="inset-bottom" style="position:fixed;bottom:0;left:0;height:24px;width:100px">Bottom</div>`;
    body.prepend(host);
    window.scrollTo(0, 120);
  });
  const setTopInset = async (topInset, scale = 1) => page.evaluate(({topInset, scale}) => {
    window.__sendLiveCommand({source:'accessibility-dashboard', type:'SET_VIEW_SCALE',
      documentToken:window.__liveEvents.find(event => event?.type === 'ACK').documentToken,
      scale, visualWidth:900, topInset});
  }, {topInset, scale});
  for (const scale of [1, 0.6419, 0.25]) {
    await setTopInset(40, scale);
    await titleFrame.locator('#inset-fixed').evaluate((element, top) => new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const check = () => {
        if (Math.abs(element.getBoundingClientRect().top - top) < 1) resolve();
        else if (performance.now() > deadline) reject(new Error(`fixed header did not clear inset: ${element.getBoundingClientRect().top}`));
        else requestAnimationFrame(check);
      }; check();
    }), 40 / scale);
    const navigation = await titleFrame.locator('body').evaluate(() => ({
      fixed:document.getElementById('inset-fixed').getBoundingClientRect().top,
      sticky:document.getElementById('inset-sticky').getBoundingClientRect().top,
      nested:document.getElementById('inset-nested').getBoundingClientRect().top,
      bottom:document.getElementById('inset-bottom').getBoundingClientRect().bottom
    }));
    assert.ok(Math.abs(navigation.sticky - (40 / scale - 1)) < 1, 'zero-height sticky wrappers with a negative pinning offset must clear the glass');
    assert.ok(Math.abs(navigation.nested - navigation.fixed) < 1, 'nested navigation must not receive the inset twice');
    assert.ok(Math.abs(navigation.bottom - 760) < 1, 'bottom controls must not move');
  }
  await setTopInset(0);
  await titleFrame.locator('#inset-fixed').evaluate(element => new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const check = () => {
      if (element.style.top === '0px') resolve();
      else if (performance.now() > deadline) reject(new Error('fixed header original position was not restored'));
      else requestAnimationFrame(check);
    }; check();
  }));
  assert.equal(await titleFrame.locator('#inset-sticky').evaluate(el => el.style.top), '-1px');
  await titleFrame.locator('#inset-fixture').evaluate(el => { el.remove(); window.scrollTo(0, 0); });
  await titleFrame.locator('body').evaluate(body => {
    const host = document.createElement('div');
    host.id = 'inset-variants'; host.style.display = 'contents';
    host.innerHTML = `<style>#inset-dynamic.is-fixed {position:fixed;top:8px;left:150px;width:80px;height:20px}
      @media(max-width:600px){#inset-responsive{position:fixed;top:0;left:300px;width:80px;height:20px}}</style>
      <nav id="inset-floating" style="position:fixed;top:12px!important;left:70px;width:20px;height:16px">Float</nav>
      <nav id="inset-row1" style="position:fixed;top:0;left:280px;width:350px;height:48px">First row</nav>
      <nav id="inset-row2" style="position:fixed;top:48px;left:280px;width:350px;height:32px">Second row</nav>
      <nav id="inset-dynamic">Dynamic</nav><nav id="inset-responsive">Responsive</nav><nav id="inset-stylesheet-nav">Stylesheet</nav>
      <nav id="inset-hidden" style="display:none;position:fixed;top:0;left:650px;width:80px;height:20px">Hidden</nav>`;
    const shadowHost = document.createElement('div');
    const innerHost = document.createElement('div');
    shadowHost.attachShadow({mode:'open'}).append(innerHost);
    innerHost.attachShadow({mode:'open'}).innerHTML = '<nav id="inset-shadow-header" style="position:fixed;top:0;left:0;width:40px;height:16px">Shadow</nav>';
    host.append(shadowHost);
    body.prepend(host);
    window.scrollTo(0,120);
  });
  const expectInsetTop = async (selector, top) => titleFrame.locator(selector).evaluate((element, top) => new Promise((resolve,reject) => {
    const deadline=performance.now()+3000;
    const check=()=>{
      if(Math.abs(element.getBoundingClientRect().top-top)<1)resolve();
      else if(performance.now()>deadline)reject(new Error(`${element.id}: expected top ${top}, got ${element.getBoundingClientRect().top}`));
      else requestAnimationFrame(check);
    };check();
  }),top);
  await setTopInset(40);
  await expectInsetTop('#inset-floating',52);
  await expectInsetTop('#inset-row1',40);
  await expectInsetTop('#inset-row2',88);
  await expectInsetTop('#inset-shadow-header',40);
  await titleFrame.locator('#inset-dynamic').evaluate(el=>el.classList.add('is-fixed'));
  await expectInsetTop('#inset-dynamic',48);
  await titleFrame.locator('#inset-hidden').evaluate(el=>el.style.removeProperty('display'));
  await expectInsetTop('#inset-hidden',40);
  await titleFrame.locator('#inset-floating').evaluate(el=>el.style.setProperty('top','18px','important'));
  await expectInsetTop('#inset-floating',58);
  await titleFrame.locator('#inset-variants').evaluate(el=>{
    const added=document.createElement('nav');added.id='inset-added';
    added.style.cssText='position:fixed;top:0;left:800px;width:80px;height:20px';
    el.append(added);
  });
  await expectInsetTop('#inset-added',40);
  await titleFrame.locator('head').evaluate(head=>{
    const style=document.createElement('style');style.id='inset-late-stylesheet';
    style.textContent='#inset-stylesheet-nav{position:fixed;top:0;left:740px;width:50px;height:20px}';
    head.append(style);
  });
  await expectInsetTop('#inset-stylesheet-nav',40);
  await titleFrame.locator('#inset-shadow-header').evaluate(el=>el.style.top='6px');
  await expectInsetTop('#inset-shadow-header',46);
  await page.locator('#viewer').evaluate(el=>el.style.width='500px');
  await expectInsetTop('#inset-responsive',40);
  await page.locator('#viewer').evaluate(el=>el.style.width='900px');
  await setTopInset(0);
  await expectInsetTop('#inset-floating',18);
  assert.equal(await titleFrame.locator('#inset-floating').evaluate(el=>el.style.getPropertyPriority('top')),'important');
  assert.equal(await titleFrame.locator('#inset-row2').evaluate(el=>el.style.top),'48px');
  assert.equal(await titleFrame.locator('#inset-shadow-header').evaluate(el=>el.style.top),'6px');
  await titleFrame.locator('#inset-late-stylesheet').evaluate(el=>el.remove());
  await titleFrame.locator('#inset-variants').evaluate(el=>{el.remove();window.scrollTo(0,0);});
  for (const [scrollY, isScrolled] of [[0, false], [120, true], [30, true], [0, false]]) {
    await titleFrame.locator("html").evaluate((_, y) => window.scrollTo(0, y), scrollY);
    await page.waitForFunction(expected => window.__liveEvents.filter(event =>
      event?.type === "EVENT" && event.payload?.type === "DOCUMENT_SCROLL").at(-1)?.payload.isScrolled === expected,
      isScrolled);
  }
  for (const title of ["홍익대학교 | 공식 홈페이지", "학사 안내 · 홍익대학교", "", "x".repeat(350)]) {
    await titleFrame.locator("html").evaluate((_, value) => { document.title = value; }, title);
    await page.waitForFunction(expected => window.__liveEvents.filter(event =>
      event?.type === "EVENT" && event.payload?.type === "DOCUMENT_TITLE").at(-1)?.payload.title === expected,
      title.slice(0, 300));
  }

  const issues = [
    createIssue(107, "#dense-target-3", "세 번째 조밀한 대상", "LOW", "text", "6.4.3"),
    createIssue(101, "#group-target", "적절한 링크 텍스트", "LOW", "text", "6.4.3"),
    createIssue(102, "#group-target", "레이블 제공", "HIGH", "form", "KWCAG 7.3.2"),
    createIssue(103, "#group-target", "명확한 지시사항", "MEDIUM", "text", "KWACG 5.3.3"),
    createIssue(104, "#nearby-target", "색상 대비", "HIGH", "visual", "KWCAG 5.2.1"),
    createIssue(105, "#dense-target-1", "첫 번째 조밀한 대상", "LOW", "text", "6.4.3"),
    createIssue(106, "#dense-target-2", "두 번째 조밀한 대상", "LOW", "text", "6.4.3"),
    createIssue(108, "#nested-target", "중첩 문단 읽기 수준", "MEDIUM", "text", "3.1.5"),
    createIssue(109, "#nested-link", "중첩 링크 텍스트", "LOW", "text", "6.4.3")
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
  assert.equal(await markers.count(), 7, "three issues on one element must share one marker");
  if (process.env.AP_MARKER_SHOT) await page.screenshot({ path: process.env.AP_MARKER_SHOT.replace(/\.png$/, "-rest.png") });

  const groupedMarker = markers.filter({ has: frame.locator(".ap-live-marker__count", { hasText: /^3$/ }) });
  assert.equal(await groupedMarker.count(), 1);
  assert.equal(await groupedMarker.locator(".ap-live-marker__count").textContent(), "3");

  const visualMarker = markers.filter({ hasText: "시각" });
  assert.equal(await visualMarker.count(), 1, "visual issues must be labelled with the 시각 engine chip");
  const chipStyle = await visualMarker.evaluate((marker) => {
    const style = getComputedStyle(marker);
    const dot = getComputedStyle(marker, "::before");
    const rect = marker.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      dotBackground: dot.backgroundColor,
      height: Math.round(rect.height),
      label: marker.querySelector(".ap-live-marker__icon").textContent
    };
  });
  assert.deepEqual(chipStyle, {
    background: "rgb(29, 29, 31)",
    borderRadius: "999px",
    dotBackground: "rgb(251, 138, 61)",
    height: 18,
    label: "시각"
  });
  assert.equal(await frame.locator(".ap-live-marker:visible").filter({ hasText: "텍스트" }).count(), 1, "text-difficulty issues must be labelled 텍스트");
  // 같은 자리를 나눠 쓰는 중첩 문단(108)과 링크(109)는 클러스터 칩 하나로 묶인다
  const clusterMarker = frame.locator(".ap-live-marker--cluster:visible");
  assert.equal(await clusterMarker.count(), 1, "nested paragraph and link must share one cluster chip");
  assert.equal(await clusterMarker.locator(".ap-live-marker__count").textContent(), "2");
  assert.match(await clusterMarker.getAttribute("aria-label"), /근처 요소 2곳/);
  assert.equal(await frame.locator(".ap-live-marker:visible").count(), 6, "clustered member markers stay hidden");
  // 클러스터 칩 호버 → 팝오버가 묶인 이슈를 < > 로 넘기며, 하이라이트가 각 이슈의 요소를 따라간다
  await clusterMarker.hover();
  const clusterPopover = frame.locator(".ap-live-popover");
  await clusterPopover.waitFor({ state: "visible" });
  // The viewer and panel use inverse transforms. A backdrop-filter surface can
  // paint beyond the visible panel in this composition, so keep it opaque.
  const popoverSurface = await clusterPopover.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, backdrop: style.backdropFilter,
      webkitBackdrop: style.getPropertyValue("-webkit-backdrop-filter") };
  });
  assert.equal(popoverSurface.background, "rgb(255, 255, 255)");
  assert.equal(popoverSurface.backdrop, "none");
  assert.ok(["", "none"].includes(popoverSurface.webkitBackdrop));
  assert.equal(
    await clusterPopover.locator(".ap-live-popover__position").textContent(),
    "총 2개 중 1번째 문제: 중첩 문단 읽기 수준"
  );
  const highlightRectFor = () => frame.locator(".ap-live-highlight__fragment").first().evaluate((fragment) => {
    const rect = fragment.getBoundingClientRect();
    return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)];
  });
  const targetRectFor = (selector) => frame.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [Math.round(rect.left) - 4, Math.round(rect.top) - 4, Math.round(rect.right) + 4, Math.round(rect.bottom) + 4];
  });
  assert.deepEqual(await highlightRectFor(), await targetRectFor("#nested-target"), "cluster highlight must start on the first issue's element");
  const popoverRectFor = () => clusterPopover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
  // The popover opens right beside the hovered chip, not past the far edge of its element.
  const clusterChipRect = await clusterMarker.evaluate((marker) => {
    const rect = marker.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
  const clusterPopoverRectBefore = await popoverRectFor();
  const chipGap = clusterPopoverRectBefore.top >= clusterChipRect.bottom
    ? clusterPopoverRectBefore.top - clusterChipRect.bottom
    : clusterChipRect.top - clusterPopoverRectBefore.bottom;
  assert.ok(chipGap >= 0 && chipGap <= 12,
    `the popover must sit next to its chip: ${JSON.stringify({ clusterChipRect, clusterPopoverRectBefore })}`);
  const clusterPopoverHeightBefore = await clusterPopover.evaluate((element) => element.getBoundingClientRect().height);
  await clusterPopover.getByRole("button", { name: "다음 문제" }).click();
  assert.equal(
    await clusterPopover.locator(".ap-live-popover__position").textContent(),
    "총 2개 중 2번째 문제: 중첩 링크 텍스트"
  );
  const clusterPopoverHeightAfter = await clusterPopover.evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(
    Math.abs(clusterPopoverHeightAfter - clusterPopoverHeightBefore) <= 0.5,
    `popover height must stay fixed while paging a cluster: ${clusterPopoverHeightBefore} → ${clusterPopoverHeightAfter}`
  );
  assert.deepEqual(await highlightRectFor(), await targetRectFor("#nested-link"), "paging must move the highlight to the next issue's element");
  const clusterPopoverRectAfter = await popoverRectFor();
  assert.ok(Math.abs(clusterPopoverRectAfter.left - clusterPopoverRectBefore.left) <= 0.5
      && Math.abs(clusterPopoverRectAfter.top - clusterPopoverRectBefore.top) <= 0.5,
    `paging must keep the popover under the pointer: ${JSON.stringify({ clusterPopoverRectBefore, clusterPopoverRectAfter })}`);
  // After paging, the popover stays open when the pointer drifts off it.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  assert.equal(await clusterPopover.isVisible(), true, "a popover the reader worked in must not close on pointer leave");
  await page.keyboard.press("Escape");
  await clusterPopover.waitFor({ state: "hidden" });
  assert.match(await visualMarker.getAttribute("aria-label"), /색상 대비/);

  const targetSelectorByIssueId = {
    102: "#group-target",
    104: "#nearby-target",
    105: "#dense-target-1",
    106: "#dense-target-2",
    107: "#dense-target-3",
    108: "#nested-target",
    109: "#nested-link"
  };
  const readMarkerLayout = () => frame.locator("body").evaluate((_body, targetSelectors) => {
    const fact = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const union = (first, second) => second ? {
      left: Math.min(first.left, second.left),
      top: Math.min(first.top, second.top),
      right: Math.max(first.right, second.right),
      bottom: Math.max(first.bottom, second.bottom)
    } : first;
    return [...document.querySelectorAll(".ap-live-marker")].filter((marker) => !marker.hidden).map((marker) => {
      const issueId = Number(marker.dataset.issueId);
      const markerRect = fact(marker);
      const count = marker.querySelector(".ap-live-marker__count");
      const target = document.querySelector(targetSelectors[issueId]);
      if (!target) {
        throw new Error(`missing target mapping for marker ${issueId}`);
      }
      return {
        issueId,
        markerRect,
        footprint: union(markerRect, count ? fact(count) : null),
        targetRect: fact(target),
        targetAnchorY: (() => {
          const rect = target.getBoundingClientRect();
          return rect.top - 6 - 9;
        })()
      };
    }).sort((left, right) => left.targetRect.top - right.targetRect.top);
  }, targetSelectorByIssueId);
  const geometry = await readMarkerLayout();
  if (process.env.AP_MARKER_DEBUG) console.log("GEOMETRY", JSON.stringify(geometry.map(g => ({ id: g.issueId, m: [Math.round(g.markerRect.left), Math.round(g.markerRect.top), Math.round(g.markerRect.right), Math.round(g.markerRect.bottom)], t: [Math.round(g.targetRect.left), Math.round(g.targetRect.top), Math.round(g.targetRect.right), Math.round(g.targetRect.bottom)] }))));
  for (let index = 0; index < geometry.length; index += 1) {
    const current = geometry[index];
    assert.ok(
      current.markerRect.bottom <= current.targetRect.top - 5.5,
      `marker ${current.issueId} must sit above its target's top edge`
    );
    const sameTargetBefore = geometry.slice(0, index).filter((other) =>
      Math.abs(other.targetRect.top - current.targetRect.top) <= 0.5 &&
      Math.abs(other.targetRect.left - current.targetRect.left) <= 0.5
    );
    if (sameTargetBefore.length === 0) {
      assert.ok(
        Math.abs(current.markerRect.left - (current.targetRect.left - 8)) <= 0.75,
        `marker ${current.issueId} must hang on the target's top-left corner`
      );
    } else {
      // 같은 요소를 가리키는 다음 칩은 같은 줄에서 오른쪽으로 밀린다
      const previous = sameTargetBefore[sameTargetBefore.length - 1];
      assert.ok(
        current.markerRect.left >= previous.markerRect.right + 4 &&
          Math.abs(current.markerRect.top - previous.markerRect.top) <= 0.5,
        `marker ${current.issueId} must line up to the right of the previous chip on the same target`
      );
    }
    for (let otherIndex = index + 1; otherIndex < geometry.length; otherIndex += 1) {
      assert.equal(
        rectsOverlap(current.footprint, geometry[otherIndex].footprint),
        false,
        `marker visual footprints must not overlap: ${current.issueId} and ${geometry[otherIndex].issueId} `
          + JSON.stringify([current.footprint, geometry[otherIndex].footprint])
      );
    }
  }
  const markerCenterYs = geometry.map(({ markerRect }) => (markerRect.top + markerRect.bottom) / 2);
  for (let index = 1; index < markerCenterYs.length; index += 1) {
    assert.ok(markerCenterYs[index] >= markerCenterYs[index - 1] - 0.5, "marker order must follow target order");
  }
  const maximumAnchorDrift = Math.max(...geometry.map(({ markerRect, targetAnchorY }) =>
    Math.abs((markerRect.top + markerRect.bottom) / 2 - targetAnchorY)
  ));
  assert.ok(
    maximumAnchorDrift <= 24,
    `dense corner markers must stay close to their target anchors: ${maximumAnchorDrift}`
  );
  assert.equal(
    await frame.locator(".ap-live-highlight").evaluate((element) => element.hidden),
    true,
    "highlight must stay hidden before marker hover"
  );

  await groupedMarker.hover();
  const popover = frame.locator(".ap-live-popover");
  await popover.waitFor({ state: "visible" });
  assert.equal(await popover.locator('[role="tab"]').count(), 0);
  assert.equal(await popover.locator('[role="tablist"]').count(), 0);
  assert.equal(await popover.locator('[role="tabpanel"]').count(), 0);
  assert.equal(await popover.locator(".ap-live-popover__header").count(), 0);
  assert.equal(await popover.locator(".ap-live-popover__group").count(), 0);
  assert.equal(await popover.locator(".ap-live-popover__close").count(), 0);
  assert.doesNotMatch(
    await popover.innerText(),
    /(?:같은|이) 요소에서 발견된 문제/,
    "the popover must not reserve a visible title row"
  );
  assert.equal(await groupedMarker.getAttribute("aria-expanded"), "true");
  if (process.env.AP_MARKER_SHOT) await page.screenshot({ path: process.env.AP_MARKER_SHOT.replace(/\.png$/, "-hover.png") });
  assert.equal(await frame.locator(".ap-live-highlight").getAttribute("hidden"), null);
  const detailTags = popover.locator(".ap-live-popover__tags");
  const popoverPager = popover.locator(".ap-live-popover__pager");
  const previousButton = popover.getByRole("button", { name: "이전 문제" });
  const nextButton = popover.getByRole("button", { name: "다음 문제" });
  assert.equal(await popoverPager.getAttribute("aria-label"), "같은 요소의 접근성 문제 이동");
  assert.equal(await previousButton.getAttribute("aria-controls"), "ap-live-issue-detail");
  assert.equal(await nextButton.getAttribute("aria-controls"), "ap-live-issue-detail");
  assert.equal(await previousButton.locator("svg.ap-live-popover__pager-glyph path").count(), 1, "previous pager must draw a chevron icon");
  assert.equal(await nextButton.locator("svg.ap-live-popover__pager-glyph path").count(), 1, "next pager must draw a chevron icon");
  assert.equal(await previousButton.isDisabled(), true);
  assert.equal(await nextButton.isDisabled(), false);
  assert.equal(
    await popover.locator(".ap-live-popover__position").textContent(),
    "총 3개 중 1번째 문제: 레이블 제공"
  );
  assert.equal(await detailTags.locator(".ap-live-popover__severity").textContent(), "높음");
  assert.equal(await detailTags.locator(".ap-live-popover__code").textContent(), "KWCAG 7.3.2");
  const topRowLayout = await popover.locator(".ap-live-popover__toolbar").evaluate((toolbar) => {
    const popoverElement = toolbar.closest(".ap-live-popover");
    const tags = toolbar.querySelector(".ap-live-popover__tags");
    const severity = tags.querySelector(".ap-live-popover__severity");
    const code = tags.querySelector(".ap-live-popover__code");
    const previous = toolbar.querySelector(".ap-live-popover__pager-button--previous");
    const next = toolbar.querySelector(".ap-live-popover__pager-button--next");
    const popoverRect = popoverElement.getBoundingClientRect();
    const severityRect = severity.getBoundingClientRect();
    const codeRect = code.getBoundingClientRect();
    const previousRect = previous.getBoundingClientRect();
    const nextRect = next.getBoundingClientRect();
    return {
      codeBackground: getComputedStyle(code).backgroundColor,
      codeColor: getComputedStyle(code).color,
      codeGap: codeRect.left - severityRect.right,
      codeToPagerGap: previousRect.left - codeRect.right,
      nextRightGap: popoverRect.right - nextRect.right,
      pagerCenterDelta:
        (previousRect.top + previousRect.bottom) / 2 -
        (nextRect.top + nextRect.bottom) / 2,
      previousBorderRadius: getComputedStyle(previous).borderRadius,
      pagerBackground: getComputedStyle(previous.parentElement).backgroundColor,
      previousBackground: getComputedStyle(previous).backgroundColor,
      previousHeight: previousRect.height,
      previousWidth: previousRect.width,
      nextHeight: nextRect.height,
      nextWidth: nextRect.width,
      pagerGap: nextRect.left - previousRect.right,
      severityBackground: getComputedStyle(severity).backgroundColor,
      severityColor: getComputedStyle(severity).color,
      tagAndPagerCenterDelta:
        (codeRect.top + codeRect.bottom) / 2 -
        (nextRect.top + nextRect.bottom) / 2
    };
  });
  assert.equal(topRowLayout.codeBackground, "rgb(16, 24, 40)");
  assert.equal(topRowLayout.codeColor, "rgb(255, 255, 255)");
  assert.equal(topRowLayout.severityBackground, "rgb(251, 138, 61)");
  assert.equal(topRowLayout.severityColor, "rgb(16, 24, 40)");
  assert.ok(topRowLayout.codeGap >= 4 && topRowLayout.codeGap <= 8);
  assert.ok(topRowLayout.codeToPagerGap >= 8);
  assert.ok(topRowLayout.nextRightGap >= 10 && topRowLayout.nextRightGap <= 16, `pager pill must sit inside the toolbar padding: ${topRowLayout.nextRightGap}`);
  assert.ok(Math.abs(topRowLayout.pagerCenterDelta) <= 1);
  assert.ok(Math.abs(topRowLayout.tagAndPagerCenterDelta) <= 2);
  assert.equal(topRowLayout.previousBorderRadius, "50%");
  assert.ok(Math.abs(topRowLayout.previousWidth - 24) <= 1);
  assert.ok(Math.abs(topRowLayout.previousHeight - 24) <= 1);
  assert.ok(Math.abs(topRowLayout.nextWidth - 24) <= 1);
  assert.ok(Math.abs(topRowLayout.nextHeight - 24) <= 1);
  assert.ok(topRowLayout.pagerGap >= 7 && topRowLayout.pagerGap <= 9, "pager buttons must stay visibly separated");
  assert.equal(topRowLayout.pagerBackground, "rgba(0, 0, 0, 0)");
  assert.equal(topRowLayout.previousBackground, "rgb(242, 244, 247)");

  await groupedMarker.focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await nextButton.evaluate((button) => document.activeElement === button),
    true,
    "the first available pager button must follow the focused marker in keyboard order"
  );
  await page.keyboard.press("Enter");
  await popover.locator(".ap-live-popover__title").filter({ hasText: "명확한 지시사항" }).waitFor();
  assert.equal(await detailTags.locator(".ap-live-popover__severity").textContent(), "중간");
  assert.equal(
    await detailTags.locator(".ap-live-popover__code").textContent(),
    "KWCAG 5.3.3",
    "the legacy KWACG typo must be normalized"
  );
  assert.equal(await previousButton.isDisabled(), false);
  assert.equal(await nextButton.isDisabled(), false);
  assert.equal(
    await popover.locator(".ap-live-popover__position").textContent(),
    "총 3개 중 2번째 문제: 명확한 지시사항"
  );

  await nextButton.click();
  await popover.locator(".ap-live-popover__title").filter({ hasText: "적절한 링크 텍스트" }).waitFor();
  assert.equal(await detailTags.locator(".ap-live-popover__severity").textContent(), "낮음");
  assert.equal(
    await detailTags.locator(".ap-live-popover__severity").evaluate((badge) => getComputedStyle(badge).backgroundColor),
    "rgb(16, 185, 129)"
  );
  assert.equal(await detailTags.locator(".ap-live-popover__code").textContent(), "KWCAG 6.4.3");
  assert.equal(await previousButton.isDisabled(), false);
  assert.equal(await nextButton.isDisabled(), true);
  await previousButton.click();
  await popover.locator(".ap-live-popover__title").filter({ hasText: "명확한 지시사항" }).waitFor();
  await page.waitForFunction(() =>
    JSON.stringify(window.__liveEvents
      .filter(event => event?.type === "EVENT" && event.payload?.type === "ISSUE_SELECTED")
      .map(event => event.payload.issueId)
      .slice(-3)) === JSON.stringify([103, 101, 103])
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.__liveEvents
        .filter(event => event?.type === "EVENT" && event.payload?.type === "ISSUE_SELECTED")
        .map(event => event.payload.issueId)
        .slice(-3)
    ),
    [103, 101, 103]
  );
  const hiddenScrollbar = await popover.locator(".ap-live-popover__detail").evaluate((element) => ({
    scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    overflowY: getComputedStyle(element).overflowY
  }));
  assert.equal(hiddenScrollbar.scrollbarWidth, "none");
  assert.equal(hiddenScrollbar.overflowY, "auto");
  if (process.env.AP_LIVE_REPORT_SCREENSHOT) {
    await popover.screenshot({ path: process.env.AP_LIVE_REPORT_SCREENSHOT });
  }
  // Paging pinned the popover beside its chip; close it before reading another marker.
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });

  await visualMarker.hover();
  await popover.locator(".ap-live-popover__title").filter({ hasText: "색상 대비" }).waitFor();
  assert.equal(await popover.getAttribute("data-grouped"), "false");
  assert.equal(await popoverPager.isHidden(), true);
  assert.equal(await popover.locator(".ap-live-popover__pager-button:visible").count(), 0);
  assert.equal(await popover.locator(".ap-live-popover__position").textContent(), "");
  const singleDetailTags = popover.locator(".ap-live-popover__tags");
  const singleDetailTagLayout = await singleDetailTags.evaluate((tags) => {
    const severityRect = tags
      .querySelector(".ap-live-popover__severity")
      .getBoundingClientRect();
    const codeRect = tags
      .querySelector(".ap-live-popover__code")
      .getBoundingClientRect();
    return {
      alignItems: getComputedStyle(tags).alignItems,
      codeGap: codeRect.left - severityRect.right,
      justifyContent: getComputedStyle(tags).justifyContent,
      verticalCenterDelta:
        (codeRect.top + codeRect.bottom) / 2 -
        (severityRect.top + severityRect.bottom) / 2
    };
  });
  assert.equal(singleDetailTagLayout.justifyContent, "flex-start");
  assert.equal(singleDetailTagLayout.alignItems, "center");
  assert.ok(
    singleDetailTagLayout.codeGap >= 4 && singleDetailTagLayout.codeGap <= 8,
    `single-issue WCAG badge must sit directly beside severity: ${JSON.stringify(singleDetailTagLayout)}`
  );
  assert.ok(Math.abs(singleDetailTagLayout.verticalCenterDelta) <= 1);
  await visualMarker.focus();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });
  assert.equal(await visualMarker.getAttribute("aria-expanded"), "false");
  assert.equal(
    await visualMarker.evaluate((marker) => document.activeElement === marker),
    true,
    "Escape must dismiss the headerless popover and restore marker focus"
  );

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

  const announcementPopup = frame.getByRole("dialog", { name: "서비스 점검 안내" });
  for (const closeButtonId of ["popup-close-icon", "popup-close-footer"]) {
    for (const activation of ["click", "Enter", "Space"]) {
      await frame.locator("#announcement-popup").evaluate(popup => { popup.hidden = false; });
      await announcementPopup.waitFor({ state: "visible" });
      const closeButton = announcementPopup.locator(`#${closeButtonId}`);
      if (activation === "click") {
        // Exercise the icon's nested text target as well as the footer button itself.
        await (closeButtonId === "popup-close-icon" ? closeButton.locator("span") : closeButton).click();
      } else {
        await closeButton.press(activation);
      }
      assert.equal(await announcementPopup.isVisible(), false,
        `${closeButtonId} must dismiss the announcement via ${activation}`);
    }
  }
  assert.equal(await frame.locator("body").evaluate(() => window.popupDismissals), 6);

  await frame.locator("#announcement-popup").evaluate(popup => { popup.hidden = false; });
  for (const actionId of ["popup-purchase", "popup-save-close", "popup-submit", "popup-reset"]) {
    const action = announcementPopup.locator(`#${actionId}`);
    await action.click();
    await action.press("Enter");
    await action.press("Space");
    assert.equal(await frame.locator("body").evaluate(() => window.actionClicks), 0,
      `${actionId} must stay blocked inside a dialog`);
    assert.equal(await announcementPopup.isVisible(), true);
  }
  await announcementPopup.locator("#popup-close-footer").click();
  assert.equal(await announcementPopup.isVisible(), false);

  await frame.locator("#next-slide").click();
  assert.equal(await frame.locator("body").evaluate(() => window.slideClicks), 1);

  const initialPositions = new Map(geometry.map(({ issueId, markerRect }) => [issueId, markerRect]));
  await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  await page.evaluate((payload) => {
    window.__sendLiveCommand({
      source: "accessibility-dashboard",
      type: "INIT_ISSUES",
      issues: payload,
      selectedIssueId: null,
      markersVisible: true
    });
  }, [...issues].reverse());
  await frame.locator(".ap-live-marker").first().waitFor({ state: "attached" });
  await page.waitForTimeout(150);
  const reversedMarkerState = await frame.locator("body").evaluate(() => ({
    layerHidden: document.querySelector("#ap-live-marker-layer")?.hidden,
    scrollY: window.scrollY,
    targets: [
      "group-target",
      "nearby-target",
      "dense-target-1",
      "dense-target-2",
      "dense-target-3",
      "nested-target",
      "nested-link"
    ]
      .map((id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      }),
    markers: [...document.querySelectorAll(".ap-live-marker")].map((marker) => ({
      hidden: marker.hidden,
      issueId: marker.dataset.issueId,
      left: marker.style.left,
      top: marker.style.top
    }))
  }));
  assert.equal(
    await frame.locator(".ap-live-marker:visible").count(),
    6,
    JSON.stringify(reversedMarkerState)
  );
  const reorderedGeometry = await readMarkerLayout();
  for (const { issueId, markerRect } of reorderedGeometry) {
    const initial = initialPositions.get(issueId);
    assert.ok(initial, `missing initial marker position for issue ${issueId}`);
    assert.ok(Math.abs(initial.left - markerRect.left) <= 0.75);
    assert.ok(Math.abs(initial.top - markerRect.top) <= 0.75);
  }

  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.locator("#viewer").evaluate((viewer) => {
    viewer.style.width = "2262px";
    viewer.style.height = "1963px";
  });
  await page.evaluate(() => {
    window.__sendLiveCommand({
      source: "accessibility-dashboard",
      type: "SET_VIEW_SCALE",
      documentToken: window.__liveEvents.find(event => event?.type === "ACK").documentToken,
      scale: 1,
      visualWidth: 2262
    });
  });
  await page.waitForTimeout(150);
  const highResolutionGeometry = await readMarkerLayout();
  assert.equal(highResolutionGeometry.length, 6);
  const highResolutionMaximumDrift = Math.max(...highResolutionGeometry.map(({
    markerRect,
    targetAnchorY
  }) => Math.abs((markerRect.top + markerRect.bottom) / 2 - targetAnchorY)));
  assert.ok(
    highResolutionMaximumDrift <= 24,
    `4K corner markers must remain close to target anchors: ${highResolutionMaximumDrift}`
  );
  highResolutionGeometry.forEach(({ issueId, markerRect }, index) => {
    assert.ok(markerRect.right - markerRect.left >= 40, "4K chips must keep their label width");
    assert.ok(Math.abs(markerRect.bottom - markerRect.top - 18) <= 0.75, "4K chips must stay 18px tall");
    for (let otherIndex = index + 1; otherIndex < highResolutionGeometry.length; otherIndex += 1) {
      assert.equal(
        rectsOverlap(markerRect, highResolutionGeometry[otherIndex].markerRect),
        false,
        `4K marker chips must not overlap: ${issueId} and ${highResolutionGeometry[otherIndex].issueId}`
      );
    }
  });

  const locatorEvents = await page.evaluate(() =>
    window.__liveEvents
      .filter(event => event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
      .map(event => event.payload)
  );
  assert.equal(locatorEvents.filter(event => event.status === "VISIBLE").length, 18);

  await page.setViewportSize({ width: 1000, height: 820 });
  await page.locator("#viewer").evaluate((viewer) => {
    viewer.style.width = "900px";
    viewer.style.height = "760px";
  });
  await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
  const stateIssues = [
    createIssue(201, "#group-target", "현재 화면의 대상", "LOW", "text", "6.4.3"),
    createIssue(202, "#offscreen-target", "화면 밖 대상", "MEDIUM", "structure", "2.4.3"),
    createIssue(
      203,
      "#hidden-state-target",
      "숨은 캐러셀 대상",
      "HIGH",
      "interaction",
      "2.2.2",
      { carouselId: 1, slideIndex: 1, slideCount: 2 }
    ),
    createIssue(204, "#hidden-without-context", "복구 정보 없는 숨은 대상", "MEDIUM", "text", "1.3.1"),
    createIssue(205, "#missing-state-target", "사라진 대상", "HIGH", "general", "4.1.2")
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
  }, stateIssues);
  await page.waitForFunction(() => {
    const stateIds = new Set([201, 202, 203, 204, 205]);
    return new Set(window.__liveEvents
      .filter(event => event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
      .map(event => event.payload)
      .filter(event => stateIds.has(event.issueId))
      .map(event => event.issueId)).size === stateIds.size;
  });
  const latestStateEvents = await page.evaluate(() => {
    const stateIds = new Set([201, 202, 203, 204, 205]);
    const latest = {};
    window.__liveEvents
      .filter(event => event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
      .map(event => event.payload)
      .filter(event => stateIds.has(event.issueId))
      .forEach(event => { latest[event.issueId] = event; });
    return latest;
  });
  assert.equal(latestStateEvents[201].status, "VISIBLE");
  assert.equal(latestStateEvents[202].status, "OFFSCREEN");
  assert.deepEqual(
    { status: latestStateEvents[203].status, recoverable: latestStateEvents[203].recoverable },
    { status: "HIDDEN_STATE", recoverable: true }
  );
  assert.deepEqual(
    { status: latestStateEvents[204].status, recoverable: latestStateEvents[204].recoverable },
    { status: "HIDDEN_STATE", recoverable: false }
  );
  assert.equal(latestStateEvents[205].status, "UNAVAILABLE");
  assert.equal(await frame.locator(".ap-live-marker").count(), 4);
  assert.equal(await frame.locator(".ap-live-marker:visible").count(), 1);

  const unchangedStateEventCount = await page.evaluate(() => window.__liveEvents
    .filter(event => event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
    .filter(event => [201, 202, 203, 204, 205].includes(event.payload.issueId)).length);
  await page.waitForTimeout(1150);
  assert.equal(
    await page.evaluate(() => window.__liveEvents
      .filter(event => event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS")
      .filter(event => [201, 202, 203, 204, 205].includes(event.payload.issueId)).length),
    unchangedStateEventCount,
    "unchanged locator states must not be emitted on the periodic layout pass"
  );

  // Site-level smooth scrolling must not make a location command inspect
  // intermediate coordinates and fall back before the target is reached.
  await frame.locator("html").evaluate(element => { element.style.scrollBehavior = "smooth"; });
  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "FOCUS_ISSUE",
    issueId: 202
  }));
  await frame.locator('.ap-live-marker[data-issue-id="202"]').waitFor({ state: "visible" });
  await popover.locator(".ap-live-popover__title").filter({ hasText: "화면 밖 대상" }).waitFor();
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS"
      && event.payload.issueId === 202 && event.payload.status === "VISIBLE"
  ));
  assert.ok(await frame.locator("body").evaluate(() => window.scrollY) > 0);

  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "FOCUS_ISSUE",
    issueId: 203
  }));
  await frame.locator("#hidden-state-target").waitFor({ state: "visible" });
  await frame.locator('.ap-live-marker[data-issue-id="203"]').waitFor({ state: "visible" });
  await popover.locator(".ap-live-popover__title").filter({ hasText: "숨은 캐러셀 대상" }).waitFor();
  const recoveredCarouselState = await frame.locator("body").evaluate(() => ({
    activeHidden: document.querySelector("#hidden-state-slide").hidden,
    activeInert: document.querySelector("#hidden-state-slide").hasAttribute("inert"),
    cloneStates: [
      "#state-clone-class",
      "#state-clone-duplicate",
      "#state-clone-marker",
      "#state-clone-extension"
    ].map((selector) => {
      const clone = document.querySelector(selector);
      return {
        display: getComputedStyle(clone).display,
        hidden: clone.hidden,
        inert: clone.hasAttribute("inert")
      };
    }),
    inactiveHidden: document.querySelector("#visible-state-slide").hidden,
    inactiveInert: document.querySelector("#visible-state-slide").hasAttribute("inert"),
    slideClicks: window.slideClicks
  }));
  assert.deepEqual(recoveredCarouselState, {
    activeHidden: false,
    activeInert: false,
    cloneStates: Array.from({ length: 4 }, () => ({
      display: "none",
      hidden: true,
      inert: true
    })),
    inactiveHidden: true,
    inactiveInert: true,
    slideClicks: 1
  });
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS"
      && event.payload.issueId === 203 && event.payload.status === "VISIBLE"
  ));
  const locationResults = await page.evaluate(() => window.__liveEvents
    .filter(event => event?.type === "EVENT" && event.payload?.type === "ISSUE_DETAIL_FALLBACK"
      && [202, 203].includes(event.payload.issueId)));
  assert.deepEqual(locationResults, [], "smooth site scrolling must not produce a false location failure");
  const focusedTarget = await frame.locator("#hidden-state-target").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: innerHeight };
  });
  assert.ok(focusedTarget.top >= 0 && focusedTarget.bottom <= focusedTarget.viewport,
    `the requested hidden-slide target must finish inside the viewport: ${JSON.stringify(focusedTarget)}`);
  await frame.locator("html").evaluate(element => { element.style.scrollBehavior = "auto"; });

  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "FOCUS_ISSUE",
    issueId: 204
  }));
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "ISSUE_DETAIL_FALLBACK"
      && event.payload.issueId === 204
  ));
  assert.equal(await frame.locator('.ap-live-marker[data-issue-id="204"]').isHidden(), true);
  await frame.locator("#hidden-without-context").evaluate((element) => {
    element.style.display = "block";
  });
  await frame.locator('.ap-live-marker[data-issue-id="204"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS"
      && event.payload.issueId === 204 && event.payload.status === "VISIBLE"
  ));

  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "FOCUS_ISSUE",
    issueId: 205
  }));
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "ISSUE_DETAIL_FALLBACK"
      && event.payload.issueId === 205
  ));

  await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
  const dynamicIssues = [
    createIssue(206, "#replaceable-target", "교체되는 동적 대상", "MEDIUM", "structure", "4.1.2"),
    createIssue(207, "#late-mounted-target", "나중에 생성되는 대상", "LOW", "text", "1.3.1")
  ];
  await page.evaluate((payload) => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "INIT_ISSUES",
    issues: payload,
    selectedIssueId: null,
    markersVisible: true
  }), dynamicIssues);
  await frame.locator('.ap-live-marker[data-issue-id="206"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS"
      && event.payload.issueId === 207 && event.payload.status === "UNAVAILABLE"
  ));
  assert.equal(await frame.locator('.ap-live-marker[data-issue-id="207"]').count(), 0);

  const replacementVisibleEventCount = await page.evaluate(() => window.__liveEvents.filter(event =>
    event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS"
      && event.payload.issueId === 206 && event.payload.status === "VISIBLE"
  ).length);
  await frame.locator("#replaceable-target").evaluate((element) => {
    const replacement = element.cloneNode(true);
    replacement.dataset.generation = "replacement";
    replacement.textContent = "교체 후 동적 대상";
    element.replaceWith(replacement);
  });
  await page.waitForFunction((initialCount) => window.__liveEvents.filter(event =>
    event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS"
      && event.payload.issueId === 206 && event.payload.status === "VISIBLE"
  ).length > initialCount, replacementVisibleEventCount);
  await frame.locator('[data-generation="replacement"]#replaceable-target').waitFor({ state: "visible" });
  await frame.locator('.ap-live-marker[data-issue-id="206"]').waitFor({ state: "visible" });
  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "FOCUS_ISSUE",
    issueId: 206
  }));
  await popover.locator(".ap-live-popover__title").filter({ hasText: "교체되는 동적 대상" }).waitFor();

  await frame.locator("#dynamic-target-host").evaluate((host) => {
    const mounted = document.createElement("section");
    mounted.id = "late-mounted-target";
    mounted.textContent = "지연 생성된 동적 대상";
    mounted.setAttribute("onclick", "window.dynamicActionClicks += 1");
    host.append(mounted);
  });
  await frame.locator('.ap-live-marker[data-issue-id="207"]').waitFor({ state: "visible" });
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "LOCATOR_STATUS"
      && event.payload.issueId === 207 && event.payload.status === "VISIBLE"
  ));
  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "FOCUS_ISSUE",
    issueId: 207
  }));
  await popover.locator(".ap-live-popover__title").filter({ hasText: "나중에 생성되는 대상" }).waitFor();
  assert.equal(
    await frame.locator("body").evaluate(() => window.dynamicActionClicks),
    0,
    "locator reconciliation and focus must not activate target handlers"
  );

  await page.evaluate((invalidIssue) => window.__sendLiveCommand({
    source: "accessibility-dashboard",
    type: "INIT_ISSUES",
    issues: [invalidIssue],
    selectedIssueId: null,
    markersVisible: true
  }), createIssue(
    208,
    "#hidden-state-target",
    "잘못된 캐러셀 문맥",
    "LOW",
    "interaction",
    "2.2.2",
    { carouselId: 1, slideIndex: 2, slideCount: 2 }
  ));
  await page.waitForTimeout(100);
  assert.equal(await frame.locator(".ap-live-marker").count(), 2, "malformed carousel context must reject INIT");
  // The refused command still consumes its sequence and is reported, so later
  // commands are not silently dropped and the dashboard can list the issues.
  assert.ok(await page.evaluate(() => window.__liveEvents.some(event => event?.type === "EVENT" &&
    event.payload?.type === "COMMAND_REJECTED" && event.payload.commandType === "INIT_ISSUES")),
  "a rejected INIT must be reported to the dashboard");

  // Short controls at the document/viewport top cannot fit a chip above them.
  // Keep each label tied to its own corner, including in a scaled, scrolled viewer.
  // A plain bar keeps the controls independent; a nav or list would share one chip.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__liveConnected === true && window.__liveEvents.some(
    event => event?.type === "EVENT" && event.payload?.type === "READY"
  ));
  await frame.locator("body").evaluate(() => {
    window.scrollTo(0, 0);
    const header = document.createElement("div");
    header.id = "edge-marker-nav";
    header.style.cssText = "position:fixed;inset:3px 0 auto;height:44px;background:#f5f5f7;z-index:1000";
    for (let index = 0; index < 6; index += 1) {
      const target = document.createElement("button");
      target.id = `edge-marker-target-${index}`;
      target.textContent = `메뉴 ${index + 1}`;
      target.style.cssText = `position:absolute;left:${100 + index * 140}px;top:0;width:22px;height:44px;padding:0;border:0;font-size:10px`;
      header.append(target);
    }
    document.body.append(header);
  });
  const edgeIssues = Array.from({ length: 6 }, (_, index) => createIssue(
    301 + index, `#edge-marker-target-${index}`, `상단 메뉴 ${index + 1}`, "HIGH", "interaction", "6.1.3"
  ));
  edgeIssues.push(createIssue(307, "#edge-marker-target-0", "첫 메뉴 추가 문제", "LOW", "text", "6.4.3"));
  const edgeLayouts = [];
  for (const scale of [1, 0.5]) {
    await page.locator("#viewer").evaluate((iframe, value) => {
      iframe.style.transformOrigin = "top left";
      iframe.style.transform = `scale(${value})`;
    }, scale);
    await page.evaluate(({ scale, issues }) => {
      window.__sendLiveCommand({ source: "accessibility-dashboard", type: "SET_VIEW_SCALE",
        documentToken: window.__liveEvents.find(event => event?.type === "ACK").documentToken,
        scale, visualWidth: 900 * scale });
      window.__sendLiveCommand({ source: "accessibility-dashboard", type: "INIT_ISSUES", issues, selectedIssueId: null, markersVisible: true });
    }, { scale, issues: edgeIssues });
    for (const scrollTop of [0, 220, 0]) {
      await frame.locator("body").evaluate((_body, value) => window.scrollTo(0, value), scrollTop);
      await frame.locator('.ap-live-marker[data-issue-id="301"]').waitFor({ state: "visible" });
      await waitForReportFrames(frame.locator("body"));
      const layout = await frame.locator("body").evaluate(() => {
        const rect = element => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
        };
        return Array.from({ length: 6 }, (_, index) => {
          const marker = document.querySelector(`.ap-live-marker[data-issue-id="${301 + index}"]`);
          return {
            hidden: marker.hidden,
            issueCount: Number(marker.querySelector(".ap-live-marker__count")?.textContent || 1),
            position: getComputedStyle(marker).position,
            marker: rect(marker),
            target: rect(document.getElementById(`edge-marker-target-${index}`)),
            count: marker.querySelector(".ap-live-marker__count") ? rect(marker.querySelector(".ap-live-marker__count")) : null
          };
        });
      });
      assert.equal(layout.filter(item => !item.hidden).reduce((sum, item) => sum + item.issueCount, 0), edgeIssues.length,
        "clustering at a viewport edge must keep every menu issue available");
      let previousVisible = null;
      for (const [index, item] of layout.entries()) {
        if (item.hidden) {
          await page.evaluate(issueId => window.__sendLiveCommand({
            source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId
          }), 301 + index);
          await popover.locator(".ap-live-popover__title").filter({ hasText: `상단 메뉴 ${index + 1}` }).waitFor();
          const gap = 4 / scale;
          assert.deepEqual(await highlightRectFor(), [
            item.target.left - gap, Math.max(0, item.target.top - gap),
            item.target.right + gap, item.target.bottom + gap
          ].map(Math.round), "an edge-cluster member must still open and highlight its own menu");
          continue;
        }
        assert.equal(item.position, "fixed", "fixed menu markers must use viewport coordinates");
        assert.ok(Math.abs(item.marker.left - (item.target.left - 8 / scale)) * scale <= 18,
          `edge packing must keep marker ${index} near its own menu at scale ${scale}, scroll ${scrollTop}: ${JSON.stringify(item)}`);
        assert.ok(item.marker.top >= 0 && item.marker.top <= 12 / scale, "top-edge marker must stay visible near the target top");
        if (item.count) assert.ok(item.count.top >= 0, "group count must remain inside the viewport");
        assert.ok(Math.abs(item.marker.top - layout[0].marker.top) * scale <= 0.75,
          `same-row chips must share a baseline with and without a count badge: ${JSON.stringify(layout)}`);
        assert.ok(item.marker.right <= 900 && (!item.count || item.count.right <= 900),
          "the chip and its count must fit inside the right edge");
        if (previousVisible) {
          const previousRight = Math.max(previousVisible.marker.right, previousVisible.count?.right ?? 0);
          assert.ok((item.marker.left - previousRight) * scale >= 5.5,
            "neighboring menu chips and count badges must keep at least a 6px gap");
        }
        previousVisible = item;
      }
      await frame.locator('.ap-live-marker[data-issue-id="301"]').hover();
      await popover.locator(".ap-live-popover__title").filter({ hasText: "상단 메뉴 1" }).waitFor();
      const firstTarget = layout[0].target;
      const highlightGap = 4 / scale;
      const expectedHighlight = [
        firstTarget.left - highlightGap, Math.max(0, firstTarget.top - highlightGap),
        firstTarget.right + highlightGap, firstTarget.bottom + highlightGap
      ].map(Math.round);
      assert.deepEqual(await highlightRectFor(), expectedHighlight, "the corner marker must highlight its own menu, clipped to the viewport");
      if (process.env.AP_MARKER_SHOT && scale === 0.5 && scrollTop === 220) {
        await page.screenshot({ path: process.env.AP_MARKER_SHOT.replace(/\.png$/, "-top-edge.png") });
      }
      await page.mouse.move(980, 800);
      await popover.waitFor({ state: "hidden" });
      edgeLayouts.push({ scale, scrollTop, layout });
    }
  }

  // Slightly uneven target tops, different engine labels, a nested cluster at
  // the right edge, and partially visible document targets after scrolling.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__liveConnected === true && window.__liveEvents.some(
    event => event?.type === "EVENT" && event.payload?.type === "READY"
  ));
  await frame.locator("body").evaluate(() => {
    const main = document.querySelector("main");
    main.replaceChildren();
    main.style.cssText = "position:relative;width:900px;height:2200px;padding:0";
    [0, 2, 4, 1].forEach((offset, index) => {
      const target = document.createElement("button");
      target.id = `aligned-target-${index}`;
      target.textContent = `같은 줄 ${index + 1}`;
      target.style.cssText = `position:absolute;left:${[100, 232, 392, 520][index]}px;top:${220 + offset}px;width:96px;height:80px`;
      main.append(target);
    });
    const right = document.createElement("section");
    right.id = "right-cluster-target";
    right.style.cssText = "position:absolute;left:860px;top:430px;width:32px;height:60px";
    const child = document.createElement("button");
    child.id = "right-cluster-child";
    child.textContent = "끝";
    child.style.cssText = "display:block;width:32px;height:60px;padding:0;border:0";
    right.append(child);
    main.append(right);
  });
  const alignmentIssues = [
    createIssue(501, "#aligned-target-0", "첫 메뉴 규칙", "HIGH", "interaction", "6.1.3"),
    createIssue(502, "#aligned-target-1", "문장 읽기 수준", "MEDIUM", "text", "3.1.5"),
    createIssue(503, "#aligned-target-2", "색상 대비", "HIGH", "visual", "5.4.3"),
    createIssue(504, "#aligned-target-3", "마지막 메뉴", "HIGH", "interaction", "6.1.3"),
    createIssue(505, "#right-cluster-target", "끝 영역", "HIGH", "interaction", "6.1.3"),
    createIssue(506, "#right-cluster-child", "끝 영역의 문장", "MEDIUM", "text", "3.1.5"),
    createIssue(507, "#aligned-target-0", "첫 메뉴 추가 문제", "LOW", "text", "6.4.3")
  ];
  const alignmentLayouts = [];
  for (const scale of [1, 0.5, 0.24]) {
    await page.locator("#viewer").evaluate((iframe, value) => {
      iframe.style.transformOrigin = "top left";
      iframe.style.transform = `scale(${value})`;
    }, scale);
    await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(({ scale, issues }) => {
      window.__sendLiveCommand({ source: "accessibility-dashboard", type: "SET_VIEW_SCALE",
        documentToken: window.__liveEvents.find(event => event?.type === "ACK").documentToken,
        scale, visualWidth: 900 * scale });
      window.__sendLiveCommand({ source: "accessibility-dashboard", type: "INIT_ISSUES", issues, selectedIssueId: null, markersVisible: true });
    }, { scale, issues: alignmentIssues });
    let initialRow = null;
    for (const scrollTop of [0, 205, 225, 0]) {
      await frame.locator("body").evaluate((_body, value) => window.scrollTo(0, value), scrollTop);
      await frame.locator('.ap-live-marker[data-issue-id="501"]').waitFor({ state: "visible" });
      await waitForReportFrames(frame.locator("body"));
      const layout = await frame.locator("body").evaluate(() => {
        const rect = element => {
          const r = element.getBoundingClientRect();
          return { left:r.left, top:r.top, right:r.right, bottom:r.bottom };
        };
        const markers = [...document.querySelectorAll(".ap-live-marker")].filter(marker => !marker.hidden).map(marker => {
          const count = marker.querySelector(".ap-live-marker__count");
          const r = rect(marker);
          const badge = count ? rect(count) : r;
          return { id:Number(marker.dataset.issueId), rect:r, count:Number(count?.textContent || 1), footprint:{
            left:Math.min(r.left,badge.left), top:Math.min(r.top,badge.top),
            right:Math.max(r.right,badge.right), bottom:Math.max(r.bottom,badge.bottom)
          }};
        });
        const targets = Array.from({length:4}, (_, index) => rect(document.getElementById(`aligned-target-${index}`)));
        return {width:document.documentElement.clientWidth, height:document.documentElement.clientHeight, markers, targets};
      });
      assert.equal(layout.markers.reduce((sum, marker) => sum + marker.count, 0), alignmentIssues.length,
        "edge packing and narrow-screen clustering must keep every visible issue reachable");
      for (const [index, marker] of layout.markers.entries()) {
        const r = marker.footprint;
        assert.ok(r.left >= -0.1 && r.top >= -0.1 && r.right <= layout.width + 0.1 && r.bottom <= layout.height + 0.1,
          `whole chip and count must remain inside all viewport edges at scale ${scale}, scroll ${scrollTop}: ${JSON.stringify(marker)}`);
        for (const other of layout.markers.slice(index + 1)) {
          assert.equal(rectsOverlap(r, other.footprint), false,
            `chips including cluster badges must not overlap: ${marker.id}, ${other.id}`);
        }
      }
      const row = layout.markers.filter(marker => marker.id >= 501 && marker.id <= 504).sort((a, b) => a.rect.left - b.rect.left);
      if (scale === 1) assert.equal(row.length, 4, "noncolliding target anchors must keep distinct markers available");
      for (const [index, marker] of row.entries()) {
        const target = layout.targets[marker.id - 501];
        assert.ok(Math.abs(marker.rect.left - (target.left - 8 / scale)) * scale <= 0.75,
          `row alignment must keep each chip at its own target, including uneven gaps: ${JSON.stringify({marker,target,scale})}`);
        assert.ok(Math.abs(marker.rect.top - row[0].rect.top) * scale <= 0.75,
          `same-row targets must align despite small target offsets, scroll ${scrollTop}: ${JSON.stringify(row)}`);
        assert.ok(Math.abs((marker.rect.right - marker.rect.left) * scale - 56) <= 0.75,
          "engine labels must use a consistent chip width");
        if (index) assert.ok((marker.rect.left - row[index - 1].footprint.right) * scale >= 5.5,
          "mixed engine labels and count badges must retain the standard minimum gap");
      }
      if (initialRow === null) initialRow = row;
      else if (scrollTop === 0) {
        assert.deepEqual(row.map(marker => marker.rect), initialRow.map(marker => marker.rect),
          "scrolling back must restore the row instead of preserving a boundary-clamped offset");
      }
      alignmentLayouts.push({scale, scrollTop, layout});
    }
    if (scale < 1) {
      for (const issue of alignmentIssues) {
        await page.evaluate(issueId => window.__sendLiveCommand({
          source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId
        }), issue.id);
        await popover.locator(".ap-live-popover__title").filter({ hasText: issue.title }).waitFor();
      }
    }
  }

  // An uneven three-column news grid must not distribute the middle chip
  // across the row's span. Its corner stays tied to the middle card even when
  // the neighboring cards, chip widths and count badges have different sizes.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__liveConnected === true && window.__liveEvents.some(
    event => event?.type === "EVENT" && event.payload?.type === "READY"
  ));
  await frame.locator("body").evaluate(() => {
    const main = document.querySelector("main");
    main.replaceChildren();
    main.style.cssText = "position:relative;width:900px;height:2200px;padding:0";
    [{left:52,width:420,top:220}, {left:500,width:180,top:222}, {left:714,width:150,top:221}]
      .forEach(({left,width,top}, index) => {
        const card = document.createElement("article");
        card.id = `uneven-card-${index}`;
        card.textContent = `소식 카드 ${index + 1}`;
        card.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:120px;background:#edf1f7`;
        main.append(card);
      });
  });
  const unevenIssues = [
    createIssue(601, "#uneven-card-0", "첫 소식의 링크", "HIGH", "text", "6.4.3"),
    createIssue(602, "#uneven-card-1", "가운데 소식의 대비", "HIGH", "visual", "5.4.3"),
    createIssue(603, "#uneven-card-2", "마지막 소식의 문장", "MEDIUM", "text", "3.1.5"),
    createIssue(604, "#uneven-card-0", "첫 소식의 제목", "LOW", "interaction", "6.1.3")
  ];
  const unevenColumnLayouts = [];
  for (const scale of [1, 0.5]) {
    await page.locator("#viewer").evaluate((iframe, value) => {
      iframe.style.transformOrigin = "top left";
      iframe.style.transform = `scale(${value})`;
    }, scale);
    await frame.locator("body").evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(({scale, issues}) => {
      window.__sendLiveCommand({ source:"accessibility-dashboard", type:"SET_VIEW_SCALE",
        documentToken:window.__liveEvents.find(event => event?.type === "ACK").documentToken,
        scale, visualWidth:900 * scale });
      window.__sendLiveCommand({ source:"accessibility-dashboard", type:"INIT_ISSUES", issues, selectedIssueId:null, markersVisible:true });
    }, {scale, issues:unevenIssues});
    await frame.locator('.ap-live-marker[data-issue-id="602"]').waitFor({state:"visible"});
    await frame.locator("body").evaluate(() => {
      [44, 72, 56].forEach((width, index) => {
        document.querySelector(`.ap-live-marker[data-issue-id="${601 + index}"]`).style.width = `${width}px`;
      });
    });
    await page.evaluate(scale => window.__sendLiveCommand({
      source:"accessibility-dashboard", type:"SET_VIEW_SCALE",
      documentToken:window.__liveEvents.find(event => event?.type === "ACK").documentToken,
      scale, visualWidth:900 * scale
    }), scale);
    for (const scrollTop of [0, 190, 0]) {
      await frame.locator("body").evaluate((_body, value) => window.scrollTo(0, value), scrollTop);
      await waitForReportFrames(frame.locator("body"));
      const layout = await frame.locator("body").evaluate(() => {
        const rect = element => {
          const r = element.getBoundingClientRect();
          return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};
        };
        return Array.from({length:3}, (_, index) => {
          const marker = document.querySelector(`.ap-live-marker[data-issue-id="${601 + index}"]`);
          return {hidden:marker.hidden,marker:rect(marker),target:rect(document.getElementById(`uneven-card-${index}`))};
        });
      });
      for (const item of layout) {
        assert.equal(item.hidden, false, "well-separated news cards must retain their own markers");
        assert.ok(Math.abs(item.marker.left - (item.target.left - 8 / scale)) * scale <= 0.75,
          `uneven columns must not move the middle chip toward the first card: ${JSON.stringify({scale,scrollTop,layout})}`);
        assert.ok(Math.abs(item.marker.top - layout[0].marker.top) * scale <= 0.75,
          "uneven columns must preserve the existing vertical row alignment");
      }
      await frame.locator('.ap-live-marker[data-issue-id="602"]').hover();
      await popover.locator(".ap-live-popover__title").filter({hasText:"가운데 소식의 대비"}).waitFor();
      // Hover/focus can scroll the scaled iframe to reveal its chip. Compare
      // the target and highlight together after that interaction settles.
      await waitForReportFrames(frame.locator("body"));
      const focusedGeometry = await frame.locator("body").evaluate((_body, scale) => {
        const target = document.getElementById("uneven-card-1").getBoundingClientRect();
        const highlight = document.querySelector(".ap-live-highlight__fragment").getBoundingClientRect();
        const gap = 4 / scale;
        return {
          target: [target.left-gap,target.top-gap,target.right+gap,target.bottom+gap].map(Math.round),
          highlight: [highlight.left,highlight.top,highlight.right,highlight.bottom].map(Math.round)
        };
      }, scale);
      assert.deepEqual(focusedGeometry.highlight, focusedGeometry.target,
        "the middle news marker must show its own issue and highlight its own card");
      await page.mouse.move(980, 800);
      await popover.waitFor({state:"hidden"});
      unevenColumnLayouts.push({scale,scrollTop,layout});
    }
  }

  // A tab strip and a calendar read as one component. Their chips merge into a
  // single cluster even when the items are far enough apart not to collide,
  // while a tall list keeps a chip per item. The header nav around the tabs
  // also holds a search button; it must not absorb the tab strip's chip.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__liveConnected === true && window.__liveEvents.some(
    event => event?.type === "EVENT" && event.payload?.type === "READY"
  ));
  await page.locator("#viewer").evaluate(iframe => { iframe.style.transform = "scale(1)"; });
  await frame.locator("body").evaluate(() => {
    window.scrollTo(0, 0);
    const main = document.querySelector("main");
    main.replaceChildren();
    main.style.cssText = "position:relative;width:900px;height:2200px;padding:0";
    const tabs = document.createElement("nav");
    tabs.innerHTML = "<button id='group-search' style='display:block;margin:0 0 40px 520px;width:200px;height:36px'>검색</button>"
      + "<ul id='group-tabs' style='display:flex;gap:64px;margin:0;padding:0;list-style:none'>"
      + ["추천", "카테고리", "웹툰", "패션뷰티", "리빙푸드", "책방"].map((label, index) =>
        `<li><a id="group-tab-${index}" href="#">${label}</a></li>`).join("") + "</ul>";
    tabs.style.cssText = "position:absolute;left:60px;top:60px;width:800px";
    const calendar = document.createElement("table");
    calendar.id = "group-calendar";
    calendar.style.cssText = "position:absolute;left:60px;top:260px;border-spacing:8px";
    calendar.innerHTML = Array.from({ length: 5 }, (_, row) => "<tr>" + Array.from({ length: 7 }, (_, column) =>
      `<td id="group-day-${row * 7 + column + 1}" style="width:32px;height:28px">${row * 7 + column + 1}</td>`).join("") + "</tr>").join("");
    const tall = document.createElement("ul");
    tall.id = "group-tall-list";
    tall.style.cssText = "position:absolute;left:520px;top:260px;width:300px;margin:0;padding:0;list-style:none";
    tall.innerHTML = Array.from({ length: 6 }, (_, index) =>
      `<li id="group-tall-${index}" style="height:80px">긴 목록 ${index + 1}</li>`).join("");
    main.append(tabs, calendar, tall);
  });
  const groupIssues = [
    createIssue(700, "#group-search", "검색 버튼 이름", "HIGH", "interaction", "6.1.3"),
    createIssue(701, "#group-tab-0", "추천 탭 이름", "MEDIUM", "interaction", "6.1.3"),
    createIssue(702, "#group-tab-2", "웹툰 탭 이름", "HIGH", "interaction", "6.1.3"),
    createIssue(703, "#group-tab-4", "리빙푸드 탭 이름", "LOW", "interaction", "6.1.3"),
    createIssue(704, "#group-tab-5", "책방 탭 이름", "LOW", "text", "6.4.3"),
    createIssue(705, "#group-tab-5", "책방 탭 문장", "LOW", "text", "3.1.5"),
    createIssue(711, "#group-day-1", "1일 버튼", "LOW", "interaction", "6.1.3"),
    createIssue(712, "#group-day-10", "10일 버튼", "MEDIUM", "interaction", "6.1.3"),
    createIssue(713, "#group-day-20", "20일 버튼", "LOW", "interaction", "6.1.3"),
    createIssue(714, "#group-day-33", "33일 대비", "HIGH", "visual", "5.4.3"),
    createIssue(721, "#group-tall-0", "긴 목록 첫 항목", "LOW", "interaction", "6.1.3"),
    createIssue(722, "#group-tall-4", "긴 목록 다섯째 항목", "LOW", "interaction", "6.1.3")
  ];
  await page.evaluate(issues => {
    window.__sendLiveCommand({ source: "accessibility-dashboard", type: "SET_VIEW_SCALE",
      documentToken: window.__liveEvents.find(event => event?.type === "ACK").documentToken,
      scale: 1, visualWidth: 900 });
    window.__sendLiveCommand({ source: "accessibility-dashboard", type: "INIT_ISSUES", issues,
      selectedIssueId: null, markersVisible: true });
  }, groupIssues);
  await frame.locator('.ap-live-marker[data-issue-id="701"]').waitFor({ state: "visible" });
  await waitForReportFrames(frame.locator("body"));
  const groupLayout = await frame.locator("body").evaluate(() => [...document.querySelectorAll(".ap-live-marker")]
    .filter(marker => !marker.hidden)
    .map(marker => ({
      id: Number(marker.dataset.issueId),
      cluster: marker.classList.contains("ap-live-marker--cluster"),
      count: Number(marker.querySelector(".ap-live-marker__count")?.textContent || 1),
      left: marker.getBoundingClientRect().left
    })).sort((left, right) => left.id - right.id));
  assert.deepEqual(groupLayout.map(({ id, cluster, count }) => ({ id, cluster, count })), [
    { id: 700, cluster: false, count: 1 },
    { id: 701, cluster: true, count: 5 },
    { id: 711, cluster: true, count: 4 },
    { id: 721, cluster: false, count: 1 },
    { id: 722, cluster: false, count: 1 }
  ], `a tab strip and a calendar must each share one chip, a tall list must not: ${JSON.stringify(groupLayout)}`);
  const firstTabLeft = await frame.locator("#group-tab-0").evaluate(element => element.getBoundingClientRect().left);
  assert.ok(Math.abs(groupLayout[1].left - (firstTabLeft - 8)) <= 0.75, "the tab cluster chip must stay on the first tab");
  for (const issue of groupIssues) {
    await page.evaluate(issueId => window.__sendLiveCommand({
      source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId
    }), issue.id);
    await popover.locator(".ap-live-popover__title").filter({ hasText: issue.title }).waitFor();
    assert.deepEqual(await highlightRectFor(), await targetRectFor(issue.pathSteps[0].selector), `grouped issue ${issue.id} must highlight its own element`);
  }
  await page.mouse.move(980, 800);

  // A tall target leaves no room for the popover above or below it. The
  // popover moves beside the target instead of covering the problem area.
  await frame.locator("body").evaluate(() => {
    window.scrollTo(0, 0);
    const main = document.querySelector("main");
    main.replaceChildren();
    main.style.cssText = "position:relative;width:900px;height:2200px;padding:0";
    const tall = document.createElement("section");
    tall.id = "popover-tall-target";
    tall.textContent = "세로로 긴 영역";
    tall.style.cssText = "position:absolute;left:100px;top:150px;width:200px;height:480px;background:#edf1f7";
    main.append(tall);
  });
  await page.evaluate(issues => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "INIT_ISSUES",
    issues, selectedIssueId: null, markersVisible: true }),
  [createIssue(731, "#popover-tall-target", "긴 영역의 대비", "HIGH", "visual", "5.4.3")]);
  const tallMarker = frame.locator('.ap-live-marker[data-issue-id="731"]');
  await tallMarker.waitFor({ state: "visible" });
  await tallMarker.hover();
  await popover.locator(".ap-live-popover__title").filter({ hasText: "긴 영역의 대비" }).waitFor();
  await waitForReportFrames(frame.locator("body"));
  const sidePlacement = await frame.locator("body").evaluate(() => {
    const rect = element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
    };
    return {
      popover: rect(document.querySelector(".ap-live-popover")),
      target: rect(document.getElementById("popover-tall-target")),
      marker: rect(document.querySelector('.ap-live-marker[data-issue-id="731"]')),
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
    };
  });
  assert.equal(rectsOverlap(sidePlacement.popover, sidePlacement.target), false,
    `the popover must not cover its problem area: ${JSON.stringify(sidePlacement)}`);
  assert.equal(rectsOverlap(sidePlacement.popover, sidePlacement.marker), false,
    `the popover must not cover its chip: ${JSON.stringify(sidePlacement)}`);
  assert.ok(sidePlacement.popover.left >= sidePlacement.target.right
    && sidePlacement.popover.right <= sidePlacement.viewport.width
    && sidePlacement.popover.bottom <= sidePlacement.viewport.height,
  `without room above or below, the popover must sit beside the target inside the viewport: ${JSON.stringify(sidePlacement)}`);
  await page.mouse.move(980, 800);
  await popover.waitFor({ state: "hidden" });

  // Auto-advancing content must hold still while a marker is being read, so the
  // marker does not move away from under the pointer. A page timeout resolves
  // only once the previous hover has released the page.
  await frame.locator("body").evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await frame.locator("body").evaluate(() => {
    window.scrollTo(0, 0);
    const slide = document.createElement("div");
    slide.id = "motion-slide";
    slide.style.cssText = "position:absolute;left:120px;top:160px;width:200px;height:80px;background:#ddd";
    document.body.append(slide);
    const ticks = window.__motionTicks = { interval: 0, timeout: 0, frame: 0, due: 0 };
    ticks.intervalId = setInterval(() => { ticks.interval += 1; }, 40);
    const chain = () => { ticks.timeout += 1; ticks.timeoutId = setTimeout(chain, 40); };
    ticks.timeoutId = setTimeout(chain, 40);
    const loop = () => { ticks.frame += 1; ticks.frameId = requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    slide.animate([{ transform: "translateX(0)" }, { transform: "translateX(100px)" }], { duration: 4000 });
  });
  await page.evaluate(issues => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "INIT_ISSUES",
    issues, selectedIssueId: null, markersVisible: true }),
  [createIssue(741, "#motion-slide", "자동 슬라이드 대비", "HIGH", "visual", "5.4.3")]);
  const motionMarker = frame.locator('.ap-live-marker[data-issue-id="741"]');
  await motionMarker.waitFor({ state: "visible" });
  const readMotion = () => frame.locator("#motion-slide").evaluate(slide => ({
    interval: window.__motionTicks.interval, timeout: window.__motionTicks.timeout,
    frame: window.__motionTicks.frame, due: window.__motionTicks.due,
    animationTime: slide.getAnimations()[0]?.currentTime ?? null
  }));
  await motionMarker.hover();
  await popover.locator(".ap-live-popover__title").filter({ hasText: "자동 슬라이드 대비" }).waitFor();
  await frame.locator("body").evaluate(() => { setTimeout(() => { window.__motionTicks.due += 1; }, 30); });
  const pausedStart = await readMotion();
  await page.waitForTimeout(400);
  const pausedEnd = await readMotion();
  assert.deepEqual(pausedEnd, pausedStart,
    `timers, frames and animations must hold while the marker is hovered: ${JSON.stringify({ pausedStart, pausedEnd })}`);
  await page.mouse.move(980, 800);
  await popover.waitFor({ state: "hidden" });
  await page.waitForTimeout(500);
  const resumed = await readMotion();
  assert.ok(resumed.interval > pausedEnd.interval && resumed.timeout > pausedEnd.timeout
    && resumed.frame > pausedEnd.frame && resumed.animationTime > pausedEnd.animationTime,
  `page motion must resume after the pointer leaves: ${JSON.stringify({ pausedEnd, resumed })}`);
  assert.equal(resumed.due, 1, "a timeout that came due while hovered must run once after resuming");
  await frame.locator("#motion-slide").evaluate(slide => {
    const ticks = window.__motionTicks;
    clearInterval(ticks.intervalId);
    clearTimeout(ticks.timeoutId);
    cancelAnimationFrame(ticks.frameId);
    slide.getAnimations().forEach(animation => animation.cancel());
    slide.remove();
  });

  await frame.locator("body").evaluate(() => {
    const embedded = document.createElement("iframe");
    embedded.id = "unsupported-frame";
    embedded.srcdoc = "<button>Frame target</button>";
    document.body.append(embedded);
  });
  // A saved positional selector must not attach a text analysis to a new article.
  // Use the generated bridge with real DOM mutations, including characterData
  // changes that preserve both the target element and its text node.
  await page.locator("#viewer").evaluate(iframe => { iframe.style.transform = "scale(1)"; });
  await frame.locator("body").evaluate(() => {
    window.scrollTo(0, 0);
    const main = document.querySelector("main");
    main.replaceChildren();
    main.style.cssText = "position:relative;display:grid;grid-template-columns:280px 280px;gap:70px 100px;width:900px;height:1200px;padding:100px 70px;align-content:start";
    const matching = document.createElement("p");
    matching.id = "content-identity-matching";
    matching.textContent = "학교 소식 ＡＢＣ\u00a0전시\n  안내입니다";
    const list = document.createElement("ul");
    list.id = "content-identity-news";
    for (const text of ["디자인컨버전스학부 XR 글래스 기반 온보딩 OS BE-ON 수상 2026.09.06",
      "“나란히 가자!” 몽골 해외봉사단 ‘나란’을 만나다 본교 해외봉사단이 몽골에서 교육과 문화 교류를 펼쳤다. 학교 2026.08.31"]) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = "#";
      link.style.display = "block";
      link.textContent = text;
      item.append(link);
      list.append(item);
    }
    const mutable = document.createElement("p");
    mutable.id = "content-identity-mutable";
    mutable.append(document.createTextNode("사유의 발화점 행사 2026.08.30"));
    const labelled = document.createElement("button");
    labelled.id = "content-identity-labelled";
    labelled.setAttribute("aria-label", "검색 페이지 열기");
    const placeholder = document.createElement("input");
    placeholder.id = "content-identity-placeholder";
    placeholder.placeholder = "검색어를 입력하세요";
    const legacy = document.createElement("p");
    legacy.id = "content-identity-legacy";
    legacy.textContent = "이전 분석 원문이 없는 현재 기사";
    const container = document.createElement("section");
    container.id = "content-identity-container";
    const inline = document.createElement("strong");
    inline.textContent = "중요 안내";
    const block = document.createElement("div");
    block.textContent = "별도로 수집되는 블록 내용";
    container.append("앞 문장 ", inline, block, " 끝 문장");
    for (const element of [matching, list, mutable, labelled, placeholder, legacy, container]) {
      element.style.cssText = "display:block;box-sizing:border-box;width:280px;min-height:60px;margin:0";
      main.append(element);
    }
  });
  const withSourceText = (issue, sourceText) => ({
    ...issue,
    analyzer: "AI_TEXT",
    textAnalysis: { kind: "text-analysis", sourceText, flags: [], suggestions: [], revision: null }
  });
  const contentIdentityIssues = [
    withSourceText(createIssue(601, "#content-identity-matching", "공백과 전각 문자", "MEDIUM", "text", "3.1.5"), "ABC 전시 안내"),
    withSourceText(createIssue(602, "ul#content-identity-news > li:nth-of-type(1) > a", "몽골 봉사 기사", "LOW", "text", "6.4.3"),
      "“나란히 가자!” 몽골 해외봉사단 ‘나란’을 만나다 본교 해외봉사단이 몽골에서 교육과 문화 교류를 펼쳤다. 학교 2026.08.31"),
    withSourceText(createIssue(603, "#content-identity-mutable", "원문이 바뀌는 기사", "LOW", "text", "6.4.3"), "사유의 발화점 행사 2026.08.30"),
    withSourceText(createIssue(604, "#content-identity-labelled", "접근성 이름의 원문", "LOW", "text", "6.4.3"), "검색 페이지 열기"),
    withSourceText(createIssue(605, "#content-identity-placeholder", "입력 안내의 원문", "LOW", "text", "6.4.3"), "검색어를 입력하세요"),
    createIssue(606, "#content-identity-legacy", "원문 없는 기존 문제", "MEDIUM", "text", "3.1.5"),
    withSourceText(createIssue(607, "#content-identity-container", "컨테이너의 직접 문장", "MEDIUM", "text", "3.1.5"), "앞 문장 중요 안내 끝 문장")
  ];
  await page.evaluate(issues => {
    window.__sendLiveCommand({ source: "accessibility-dashboard", type: "SET_VIEW_SCALE",
      documentToken: window.__liveEvents.find(event => event?.type === "ACK").documentToken,
      scale: 1, visualWidth: 900 });
    window.__sendLiveCommand({ source: "accessibility-dashboard", type: "INIT_ISSUES", issues,
      selectedIssueId: null, markersVisible: true });
  }, contentIdentityIssues);
  const waitForContentStatus = (issueId, status, reason = null, timeout = 30_000) => page.waitForFunction(expected => {
    const latest = window.__liveEvents.filter(event => event?.type === "EVENT"
      && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === expected.issueId).at(-1)?.payload;
    return latest?.status === expected.status && (expected.reason === null || latest.reason === expected.reason);
  }, { issueId, status, reason }, { timeout });
  for (const id of [601, 603, 604, 605, 606, 607]) {
    await waitForContentStatus(id, "VISIBLE");
    await frame.locator(`.ap-live-marker[data-issue-id="${id}"]`).waitFor({ state: "visible" });
  }
  const assertMongoliaTarget = async () => {
    await waitForContentStatus(602, "VISIBLE");
    await page.evaluate(() => window.__sendLiveCommand({
      source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 602
    }));
    await popover.locator(".ap-live-popover__title").filter({ hasText: "몽골 봉사 기사" }).waitFor();
    await page.waitForFunction(() => {
      const viewerDocument = document.querySelector("#viewer").contentDocument;
      const article = Array.from(viewerDocument.querySelectorAll("#content-identity-news a"))
        .find(element => element.textContent.includes("몽골"));
      const target = article?.getBoundingClientRect();
      const highlight = viewerDocument.querySelector(".ap-live-highlight__fragment")?.getBoundingClientRect();
      return target && highlight && Math.abs(target.left - 4 - highlight.left) < 1
        && Math.abs(target.top - 4 - highlight.top) < 1
        && Math.abs(target.right + 4 - highlight.right) < 1
        && Math.abs(target.bottom + 4 - highlight.bottom) < 1;
    });
  };
  await assertMongoliaTarget();
  const movedArticle = await frame.locator("#content-identity-news li").nth(1).elementHandle();
  await frame.locator("#content-identity-news").evaluate(list => {
    const newer = document.createElement("li");
    newer.innerHTML = "<a href='#'>추가된 새로운 학교 소식 2026.09.07</a>";
    list.prepend(newer);
  });
  await assertMongoliaTarget();
  await movedArticle.evaluate(element => element.remove());
  await waitForContentStatus(602, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED");
  await frame.locator('.ap-live-marker[data-issue-id="602"]').waitFor({ state: "detached" });
  // An identical article elsewhere must not defeat the saved structural scope.
  await movedArticle.evaluate(element => document.querySelector("main").append(element));
  await waitForContentStatus(602, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED");
  await page.evaluate(() => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 602 }));
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "ISSUE_DETAIL_FALLBACK" && event.payload.issueId === 602));
  await movedArticle.evaluate(element => document.querySelector("#content-identity-news").append(element));
  await assertMongoliaTarget();
  await movedArticle.evaluate(element => {
    const duplicate = element.cloneNode(true);
    duplicate.id = "ambiguous-article";
    element.after(duplicate);
  });
  await waitForContentStatus(602, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED");
  await frame.locator('.ap-live-marker[data-issue-id="602"]').waitFor({ state: "detached" });
  await frame.locator("#ambiguous-article").evaluate(element => element.remove());
  await assertMongoliaTarget();
  await movedArticle.dispose();

  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 603
  }));
  await popover.locator(".ap-live-popover__title").filter({ hasText: "원문이 바뀌는 기사" }).waitFor();
  const originalContentNode = await frame.locator("#content-identity-mutable").evaluateHandle(element => element.firstChild);
  await originalContentNode.evaluate(node => { node.nodeValue = "Becoming Forms 전시 2026.09.05"; });
  await waitForContentStatus(603, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED");
  await frame.locator('.ap-live-marker[data-issue-id="603"]').waitFor({ state: "detached" });
  await popover.waitFor({ state: "hidden" });
  assert.equal(await originalContentNode.evaluate(node => node.parentElement?.id), "content-identity-mutable",
    "content reconciliation must detect characterData changes without replacing the target or text node");
  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 603
  }));
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event?.type === "EVENT" && event.payload?.type === "ISSUE_DETAIL_FALLBACK" && event.payload.issueId === 603
  ));
  await waitForContentStatus(603, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED");
  assert.equal(await frame.locator('.ap-live-marker[data-issue-id="603"]').count(), 0,
    "explicit focus must not resurrect a marker on changed content");
  await originalContentNode.evaluate(node => { node.nodeValue = "사유의 발화점 행사 2026.08.30"; });
  await waitForContentStatus(603, "VISIBLE");
  await frame.locator('.ap-live-marker[data-issue-id="603"]').waitFor({ state: "visible" });
  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 603
  }));
  await popover.locator(".ap-live-popover__title").filter({ hasText: "원문이 바뀌는 기사" }).waitFor();
  await originalContentNode.dispose();

  // Open shadow trees are separate mutation-observation roots. No light-DOM
  // mutation is allowed to accidentally rescue these asynchronous updates.
  await frame.locator("html").evaluate(() => {
    window.scrollTo(0, 0);
    const main = document.querySelector("main");
    main.replaceChildren();
    main.style.cssText = "width:900px;height:1200px;padding:100px";
    const host = document.createElement("div");
    host.id = "shadow-locator-host";
    host.style.cssText = "width:320px;height:160px";
    host.attachShadow({ mode: "open" });
    main.append(host);
  });
  const shadowIssue = withSourceText({
    ...createIssue(701, "#shadow-locator-host", "Shadow DOM 문장", "HIGH", "text", "3.1.5"),
    pathSteps: [{ context: "DOCUMENT", selector: "#shadow-locator-host" }, { context: "SHADOW_ROOT", selector: "#shadow-text" }]
  }, "분석 당시 저장된 Shadow DOM 원문입니다");
  const initializeLocatorIssues = issues => page.evaluate(issues => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "INIT_ISSUES", issues, selectedIssueId: null, markersVisible: true
  }), issues);
  await initializeLocatorIssues([shadowIssue]);
  await waitForContentStatus(701, "UNAVAILABLE", "SELECTOR_NOT_FOUND");
  await frame.locator("html").evaluate(() => {
    const target = document.createElement("p");
    target.id = "shadow-text";
    target.textContent = "분석 당시 저장된 Shadow DOM 원문입니다";
    document.querySelector("#shadow-locator-host").shadowRoot.append(target);
  });
  await waitForContentStatus(701, "VISIBLE", null, 3_000);
  const shadowText = await frame.locator("#shadow-text").elementHandle();
  await shadowText.evaluate(element => { element.firstChild.data = "새로 바뀐 뉴스의 전혀 다른 내용입니다"; });
  await waitForContentStatus(701, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED", 3_000);
  await frame.locator('.ap-live-marker[data-issue-id="701"]').waitFor({ state: "detached" });
  await shadowText.evaluate(element => { element.firstChild.data = "분석 당시 저장된 Shadow DOM 원문입니다"; });
  await waitForContentStatus(701, "VISIBLE", null, 3_000);
  await shadowText.evaluate(element => element.remove());
  await waitForContentStatus(701, "UNAVAILABLE", "SELECTOR_NOT_FOUND", 3_000);
  await shadowText.evaluate(element => document.querySelector("#shadow-locator-host").shadowRoot.append(element));
  await waitForContentStatus(701, "VISIBLE", null, 3_000);
  await shadowText.dispose();

  await frame.locator("html").evaluate(() => {
    const nested = document.createElement("div");
    nested.id = "late-shadow-host";
    document.querySelector("#shadow-locator-host").shadowRoot.replaceChildren(nested);
  });
  const nestedIssue = {
    ...shadowIssue, id: 702,
    pathSteps: [{ context: "DOCUMENT", selector: "#shadow-locator-host" },
      { context: "SHADOW_ROOT", selector: "#late-shadow-host" }, { context: "SHADOW_ROOT", selector: "#shadow-text" }]
  };
  await initializeLocatorIssues([nestedIssue]);
  await waitForContentStatus(702, "UNAVAILABLE", "SHADOW_ROOT_UNAVAILABLE");
  await frame.locator("html").evaluate(() => document.querySelector("#shadow-locator-host").shadowRoot
    .querySelector("#late-shadow-host").attachShadow({ mode: "open" }));
  // The root is now available, but its target is still absent: even an
  // UNAVAILABLE -> UNAVAILABLE transition must update the reason.
  await waitForContentStatus(702, "UNAVAILABLE", "SELECTOR_NOT_FOUND", 3_000);
  await frame.locator("html").evaluate(() => {
    const target = document.createElement("p");
    target.id = "shadow-text";
    target.textContent = "분석 당시 저장된 Shadow DOM 원문입니다";
    document.querySelector("#shadow-locator-host").shadowRoot.querySelector("#late-shadow-host").shadowRoot.append(target);
  });
  await waitForContentStatus(702, "VISIBLE", null, 3_000);
  await frame.locator("#late-shadow-host").evaluate(host => host.remove());
  await waitForContentStatus(702, "UNAVAILABLE", "SELECTOR_NOT_FOUND", 3_000);
  await frame.locator("html").evaluate(() => {
    const host = document.createElement("div"); host.id = "late-shadow-host";
    const root = host.attachShadow({ mode: "open" });
    const target = document.createElement("p"); target.id = "shadow-text";
    target.textContent = "분석 당시 저장된 Shadow DOM 원문입니다"; root.append(target);
    document.querySelector("#shadow-locator-host").shadowRoot.append(host);
  });
  await waitForContentStatus(702, "VISIBLE", null, 3_000);
  await initializeLocatorIssues([]);
  await frame.locator(".ap-live-marker").waitFor({ state: "detached" });
  await frame.locator("#shadow-text").evaluate(element => { element.textContent = "더 이상 분석 대상이 아닌 내용"; });
  assert.equal(await frame.locator(".ap-live-marker").count(), 0);

  // Content in a closed tab or collapsed menu is shown on the visible area
  // around it; the marker follows the element as its hidden reason changes.
  await frame.locator("html").evaluate(() => {
    const area = document.createElement("div"); area.id = "approximate-area";
    area.style.cssText = "position:fixed;left:24px;top:120px;width:320px;height:80px;background:#fff";
    area.textContent = "탭 영역";
    const target = document.createElement("p"); target.id = "changing-hidden-reason";
    target.textContent = "숨김 원인이 바뀌는 요소"; target.style.display = "none";
    area.append(target);
    document.querySelector("main").append(area);
    const loose = document.createElement("p"); loose.id = "page-level-hidden";
    loose.textContent = "페이지 바로 아래에 숨은 요소"; loose.style.display = "none";
    document.body.append(loose);
  });
  await initializeLocatorIssues([
    createIssue(703, "#changing-hidden-reason", "숨김 이유", "HIGH", "rule", "5.1.1"),
    createIssue(704, "#page-level-hidden", "가리킬 영역 없음", "HIGH", "rule", "5.1.1")
  ]);
  await waitForContentStatus(703, "VISIBLE", "APPROXIMATE_AREA");
  assert.equal(await frame.locator('.ap-live-marker[data-issue-id="703"]')
    .evaluate(marker => marker.classList.contains("ap-live-marker--approximate")), true,
  "a marker placed on the surrounding area is drawn as approximate");
  // Without a visible container smaller than the page there is nothing to point at.
  await waitForContentStatus(704, "HIDDEN_STATE", "DISPLAY_NONE");
  // A transparent element keeps its box, so its marker sits on the element
  // itself, and moves back to the area when the element is hidden again.
  await frame.locator("#changing-hidden-reason").evaluate(element => {
    element.style.display = "block"; element.style.opacity = "0";
  });
  await waitForContentStatus(703, "VISIBLE", "TRANSPARENT_ELEMENT", 3_000);
  assert.equal(await frame.locator('.ap-live-marker[data-issue-id="703"]')
    .evaluate(marker => marker.classList.contains("ap-live-marker--approximate")), false,
  "a transparent element is marked at its exact position");
  await frame.locator("#changing-hidden-reason").evaluate(element => {
    element.style.opacity = "1"; element.hidden = true;
  });
  await waitForContentStatus(703, "VISIBLE", "APPROXIMATE_AREA", 3_000);
  await frame.locator("#changing-hidden-reason").evaluate(element => { element.hidden = false; });
  await page.waitForFunction(() => {
    const latest = window.__liveEvents.filter(event => event?.type === "EVENT"
      && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === 703).at(-1)?.payload;
    return latest?.status === "VISIBLE" && !latest.reason;
  }, null, { timeout: 3_000 });
  await initializeLocatorIssues([]);
  await frame.locator("html").evaluate(() => {
    document.querySelector("#approximate-area").remove();
    document.querySelector("#page-level-hidden").remove();
  });

  // Hidden panels are marked on the control that opens them, visibility:hidden
  // text in place, a closed shadow root on its host, a renamed frame by the page
  // it loads, and a skip link that focus cannot reveal on the area around it.
  await frame.locator("html").evaluate(() => {
    const fixture = document.createElement("section");
    fixture.id = "reveal-fixture";
    fixture.style.cssText = "position:fixed;left:400px;top:100px;width:360px;background:#fff";
    fixture.innerHTML = `<div role="tablist"><button id="reveal-tab" type="button" role="tab" aria-selected="false">두 번째 탭</button></div>
      <div id="reveal-panel" role="tabpanel" aria-labelledby="reveal-tab" hidden><p id="reveal-panel-text">탭 안의 공지</p></div>
      <button id="reveal-menu-button" type="button" aria-controls="reveal-menu" aria-expanded="false">메뉴</button>
      <ul id="reveal-menu" style="display:none"><li><a id="reveal-menu-link" href="#m">메뉴 항목</a></li></ul>
      <details><summary id="reveal-summary">자세히</summary><p id="reveal-details-text">접힌 설명</p></details>
      <p id="visibility-hidden-text" style="visibility:hidden">숨겨진 안내</p>
      <div id="closed-shadow-host" style="width:120px;height:24px"></div>
      <iframe id="renamed-frame" title="new-title" src="https://frames.example/widget" style="width:120px;height:40px"></iframe>
      <nav id="stuck-skip-nav" style="position:relative;width:200px;height:32px">
        <a id="stuck-skip" href="#x" style="position:absolute;left:-9999px;top:0">나타나지 않는 바로가기</a></nav>`;
    document.body.append(fixture);
    fixture.querySelector("#closed-shadow-host").attachShadow({ mode: "closed" }).innerHTML = "<p>닫힌 내용</p>";
  });
  const frameUrl = "https://frames.example/widget";
  await initializeLocatorIssues([
    createIssue(901, "#reveal-panel-text", "탭 안의 공지", "HIGH", "text", "3.1.5"),
    createIssue(902, "#reveal-menu-link", "메뉴 항목", "HIGH", "rule", "6.4.3"),
    createIssue(903, "#reveal-details-text", "접힌 설명", "HIGH", "text", "3.1.5"),
    createIssue(904, "#visibility-hidden-text", "숨겨진 안내", "HIGH", "rule", "5.4.3"),
    { ...createIssue(905, "#closed-shadow-host", "닫힌 Shadow DOM", "HIGH", "rule", "5.1.1"),
      pathSteps: [{ context: "DOCUMENT", selector: "#closed-shadow-host" }, { context: "SHADOW_ROOT", selector: "p" }] },
    { ...createIssue(906, 'iframe[title="old-title"]', "이름이 바뀐 프레임", "HIGH", "rule", "5.1.1"),
      pathSteps: [{ context: "DOCUMENT", selector: 'iframe[title="old-title"]', frameUrl },
        { context: "FRAME", selector: "button", frameUrl }] },
    createIssue(907, "#stuck-skip", "나타나지 않는 바로가기", "HIGH", "rule", "6.4.1")
  ]);
  const latestStatusOf = issueId => page.evaluate(id => window.__liveEvents.filter(event => event?.type === "EVENT"
    && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === id).at(-1)?.payload ?? null, issueId);
  const markerIsApproximate = issueId => frame.locator(`.ap-live-marker[data-issue-id="${issueId}"]`)
    .evaluate(marker => marker.classList.contains("ap-live-marker--approximate"));
  for (const [issueId, reason, ownerKind, approximate] of [
    [901, "REVEALED_BY_CONTROL", "BUTTON", true],
    [902, "REVEALED_BY_CONTROL", "BUTTON", true],
    [903, "REVEALED_BY_CONTROL", "BUTTON", true],
    [904, "HIDDEN_IN_PLACE", undefined, false],
    [905, "SHADOW_HOST", undefined, true],
    [906, "FRAME_CONTENT", undefined, false]
  ]) {
    await waitForContentStatus(issueId, "VISIBLE", reason);
    assert.equal((await latestStatusOf(issueId)).ownerKind, ownerKind, `${issueId} names its control`);
    assert.equal(await markerIsApproximate(issueId), approximate, `${issueId} marker style`);
  }
  // The tab marker sits on the tab, and moves to the text once the tab opens.
  assert.equal(await frame.locator("#reveal-tab").evaluate(tab => {
    const marker = document.querySelector('.ap-live-marker[data-issue-id="901"]').getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    return Math.abs(marker.top - rect.top) < 40;
  }), true, "the hidden tab content is marked at its tab");
  await frame.locator("#reveal-panel").evaluate(panel => { panel.hidden = false; });
  await page.waitForFunction(() => {
    const latest = window.__liveEvents.filter(event => event?.type === "EVENT"
      && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === 901).at(-1)?.payload;
    return latest?.status === "VISIBLE" && !latest.reason;
  }, null, { timeout: 3_000 });
  // Focus cannot reveal this link; after trying, the surrounding nav carries it.
  await waitForContentStatus(907, "HIDDEN_STATE", "FOCUS_TO_REVEAL");
  await page.evaluate(() => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 907 }));
  await waitForContentStatus(907, "VISIBLE", "APPROXIMATE_AREA");
  await popover.locator(".ap-live-popover__note").filter({ hasText: "대략적으로" }).waitFor();
  await initializeLocatorIssues([]);
  await frame.locator("#reveal-fixture").evaluate(element => element.remove());

  // Findings that are not on screen themselves are shown where they belong.
  await frame.locator("html").evaluate(() => {
    const style = document.createElement("style");
    style.textContent = ".presentation-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}"
      + ".presentation-skip{position:absolute;left:-9999px;top:0}.presentation-skip:focus{left:8px;top:8px}"
      + "#presentation-carousel .swiper-wrapper{display:flex;gap:8px}#presentation-carousel .swiper-slide{width:120px}";
    document.head.append(style);
    const viewport = document.createElement("meta");
    viewport.name = "viewport"; viewport.content = "width=device-width, user-scalable=no";
    document.head.append(viewport);
    const section = document.createElement("section");
    section.id = "presentation-fixture";
    section.innerHTML = `<h2 id="presentation-heading" class="presentation-sr">주요 소식</h2>
      <button id="presentation-button" style="width:48px;height:32px"><span id="presentation-label" class="presentation-sr">검색</span>?<span id="presentation-empty-ghost" style="display:inline-block;width:0;height:0;opacity:0"></span></button>
      <p id="presentation-ghost" style="opacity:0">투명한 안내 문구</p>
      <div aria-hidden="true"><p id="presentation-decorative">장식 문구</p></div>
      <div id="presentation-carousel" class="swiper"><div class="swiper-wrapper">
        <div class="swiper-slide"><a href="#one">첫 번째</a></div>
        <div class="swiper-slide"><a href="#two" title="">두 번째</a></div>
        <div class="swiper-slide"><a href="#three">세 번째</a></div>
      </div></div>`;
    document.querySelector("main").prepend(section);
    const skip = document.createElement("a");
    skip.id = "presentation-skip"; skip.className = "presentation-skip"; skip.href = "#main"; skip.textContent = "본문 바로가기";
    document.body.prepend(skip);
    // Skip-link lists are often a zero-height box whose links slide in on focus.
    const skipList = document.createElement("div");
    skipList.id = "presentation-skip-list"; skipList.style.cssText = "position:relative;height:0";
    skipList.innerHTML = '<a class="presentation-skip" href="#main">메뉴 바로가기</a>';
    document.body.prepend(skipList);
    // Or a 0×0 fixed wrapper whose link waits above the page.
    const skipWrap = document.createElement("div");
    skipWrap.id = "presentation-skip-wrap"; skipWrap.style.cssText = "position:fixed;left:0;top:0;width:0;height:0";
    skipWrap.innerHTML = '<a href="#main" style="position:absolute;left:0;top:-200px;width:60px;height:40px">본문 영역 바로가기</a>';
    document.body.prepend(skipWrap);
    window.scrollTo(0, 0);
  });
  const presentationIssues = [
    createIssue(801, "#presentation-label", "버튼 이름", "HIGH", "rule", "5.1.1"),
    createIssue(802, "#presentation-heading", "영역 제목", "HIGH", "rule", "5.1.1"),
    createIssue(803, "#presentation-ghost", "투명 문구", "HIGH", "rule", "5.1.1"),
    createIssue(804, "#presentation-decorative", "장식 문구", "HIGH", "rule", "5.1.1"),
    createIssue(805, "#presentation-skip", "건너뛰기 링크", "HIGH", "rule", "6.4.1"),
    createIssue(806, 'meta[name="viewport"]', "확대 제한", "HIGH", "rule", "meta-viewport"),
    createIssue(807, "html", "기본 언어", "HIGH", "rule", "7.1.1"),
    createIssue(808, 'div[data-ua-audit-slide-index="1"] > a[title=""]', "예전 슬라이드 경로", "HIGH", "rule", "6.4.3",
      { carouselId: 1, slideIndex: 1, slideCount: 3 }),
    { ...createIssue(809, "#unsupported-frame", "프레임 내부", "HIGH", "rule", "5.1.1"),
      pathSteps: [{ context: "DOCUMENT", selector: "#unsupported-frame" }, { context: "FRAME", selector: "button" }] },
    createIssue(810, "#presentation-skip-list", "건너뛰기 링크 목록", "HIGH", "text", "3.1.5"),
    createIssue(811, "#presentation-skip-wrap", "건너뛰기 링크 묶음", "HIGH", "text", "3.1.5"),
    // Transparent and without a box: nothing to mark in place, so its button carries it.
    createIssue(812, "#presentation-empty-ghost", "크기 없는 투명 요소", "HIGH", "rule", "5.1.1")
  ];
  await initializeLocatorIssues(presentationIssues);
  const latestLocatorStatus = issueId => page.evaluate(id => window.__liveEvents.filter(event => event?.type === "EVENT"
    && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === id).at(-1)?.payload ?? null, issueId);
  const waitForLocatorReason = (issueId, reason, timeout = 10_000) => page.waitForFunction(expected => {
    const latest = window.__liveEvents.filter(event => event?.type === "EVENT"
      && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === expected.issueId).at(-1)?.payload;
    return latest?.reason === expected.reason;
  }, { issueId, reason }, { timeout });
  for (const [issueId, reason, ownerKind] of [
    [801, "SCREEN_READER_ONLY", "BUTTON"],
    [802, "SCREEN_READER_ONLY", "REGION"],
    [803, "TRANSPARENT_ELEMENT", undefined],
    [812, "INVISIBLE_ELEMENT", "BUTTON"],
    [804, "ASSISTIVE_HIDDEN", undefined],
    [809, "FRAME_CONTENT", undefined]
  ]) {
    await waitForLocatorReason(issueId, reason);
    const latest = await latestLocatorStatus(issueId);
    assert.ok(["VISIBLE", "OFFSCREEN"].includes(latest.status), `${issueId} is shown on the page`);
    assert.equal(latest.ownerKind, ownerKind, `${issueId} names the element it belongs to`);
  }
  await waitForContentStatus(805, "HIDDEN_STATE", "FOCUS_TO_REVEAL");
  assert.equal((await latestLocatorStatus(805)).recoverable, true);
  await waitForContentStatus(810, "HIDDEN_STATE", "FOCUS_TO_REVEAL");
  assert.equal((await latestLocatorStatus(810)).recoverable, true, "a zero-height skip-link list reveals its first link");
  await waitForContentStatus(811, "HIDDEN_STATE", "FOCUS_TO_REVEAL");
  assert.equal((await latestLocatorStatus(811)).recoverable, true, "a 0×0 skip-link wrapper reveals its link");
  // A screen-reader-only label is not a skip link, even inside a button.
  assert.equal((await latestLocatorStatus(801)).reason, "SCREEN_READER_ONLY");
  await waitForContentStatus(806, "UNAVAILABLE", "DOCUMENT_METADATA");
  await waitForContentStatus(807, "UNAVAILABLE", "DOCUMENT_METADATA");
  await page.waitForFunction(() => window.__liveEvents.some(event => event?.type === "EVENT"
    && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === 808));
  assert.notEqual((await latestLocatorStatus(808)).status, "UNAVAILABLE",
    "a selector with the scanner's temporary slide attribute still finds its slide");

  // The screen-reader-only label is marked on its button, with a note.
  await page.evaluate(() => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 801 }));
  await popover.locator(".ap-live-popover__note").filter({ hasText: "버튼에 표시했습니다" }).waitFor();
  const buttonMarker = await frame.locator('.ap-live-marker[data-issue-id="801"]').isVisible();
  assert.equal(buttonMarker, true, "the button carries the marker of its hidden label");
  await page.evaluate(() => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 809 }));
  await popover.locator(".ap-live-popover__note").filter({ hasText: "iframe" }).waitFor();

  // A skip link appears once it has focus.
  await page.evaluate(() => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 805 }));
  await page.waitForFunction(() => {
    const latest = window.__liveEvents.filter(event => event?.type === "EVENT"
      && event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === 805).at(-1)?.payload;
    return latest?.status === "VISIBLE" || latest?.reason === "FOCUS_REVEAL_FAILED";
  });
  assert.equal((await latestLocatorStatus(805)).status, "VISIBLE", "focusing the skip link reveals it");

  // Page settings never get a marker and open the details instead.
  await page.evaluate(() => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 806 }));
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event.payload?.type === "ISSUE_DETAIL_FALLBACK" && event.payload.issueId === 806));
  assert.equal(await frame.locator('.ap-live-marker[data-issue-id="806"]').count(), 0);
  await initializeLocatorIssues([]);
  await frame.locator("#presentation-fixture").evaluate(element => element.remove());
  await frame.locator("#presentation-skip").evaluate(element => element.remove());
  await frame.locator("#presentation-skip-list").evaluate(element => element.remove());
  await frame.locator("#presentation-skip-wrap").evaluate(element => element.remove());

  const locationReasonCases = [
    { issue: { ...createIssue(401, "", "프레임 내부", "HIGH", "rule", "5.1.1"),
      pathSteps: [{ context: "FRAME", selector: "button" }] }, reason: "FRAME_UNSUPPORTED" },
    { issue: { ...createIssue(402, "", "경로 없음", "HIGH", "rule", "5.1.1"), pathSteps: [] }, reason: "EMPTY_PATH" },
    { issue: createIssue(403, "[", "경로 오류", "HIGH", "rule", "5.1.1"), reason: "INVALID_SELECTOR" }
  ];
  await page.evaluate(issues => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "INIT_ISSUES", issues, selectedIssueId: null, markersVisible: true
  }), locationReasonCases.map(({ issue }) => issue));
  for (const { issue, reason } of locationReasonCases) {
    await page.waitForFunction(({ id, reason }) => window.__liveEvents.some(event =>
      event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === id && event.payload.reason === reason
    ), { id: issue.id, reason });
    await page.evaluate(issueId => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId }), issue.id);
    await page.waitForFunction(id => window.__liveEvents.some(event =>
      event.payload?.type === "ISSUE_DETAIL_FALLBACK" && event.payload.issueId === id
    ), issue.id);
    assert.equal(await page.evaluate(id => window.__liveEvents.filter(event =>
      event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === id
    ).at(-1)?.payload.reason, issue.id), reason, "retrying an unavailable location must preserve its actual failure reason");
  }

  // Visual-engine findings carry only the analysis box. The viewer places a
  // coordinate target there and reuses the marker, scrolling and detail path.
  const coordinateBox = { x: 48, y: 1400, width: 120, height: 24 };
  const coordinateIssue = {
    ...createIssue(501, "", "텍스트 콘텐츠의 명도 대비", "HIGH", "visual", "5.4.3"),
    path: null, pathSteps: [], box: coordinateBox
  };
  await page.evaluate(issues => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "INIT_ISSUES", issues, selectedIssueId: null, markersVisible: true
  }), [coordinateIssue]);
  await page.waitForFunction(() => window.__liveEvents.some(event =>
    event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === 501));
  await page.evaluate(() => window.__sendLiveCommand({ source: "accessibility-dashboard", type: "FOCUS_ISSUE", issueId: 501 }));
  await page.waitForFunction(() => window.__liveEvents.filter(event =>
    event.payload?.type === "LOCATOR_STATUS" && event.payload.issueId === 501).at(-1)?.payload.status === "VISIBLE");
  assert.equal(await page.evaluate(() => window.__liveEvents.some(event =>
    event.payload?.type === "ISSUE_DETAIL_FALLBACK" && event.payload.issueId === 501)), false,
    "a coordinate finding opens its marker instead of the unavailable fallback");
  const coordinateTarget = await frame.locator(".ap-live-coordinate-target").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
  });
  assert.deepEqual(coordinateTarget, coordinateBox, "the target uses the analysis box in document coordinates");
  assert.equal(await frame.locator('.ap-live-marker[data-issue-id="501"]').isVisible(), true);
  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "INIT_ISSUES", issues: [], selectedIssueId: null, markersVisible: true
  }));
  await frame.locator(".ap-live-coordinate-target").waitFor({ state: "detached" });

  // Visual-engine findings located on an element follow that element and keep
  // their marker only while it shows the analysed text and image.
  await frame.locator("main").evaluate(main => {
    window.scrollTo(0, 0);
    main.replaceChildren();
    const card = document.createElement("a");
    card.id = "cv-feed-card";
    card.href = "#";
    card.style.cssText = "display:block;width:300px;height:120px";
    const image = document.createElement("img");
    image.id = "cv-feed-image";
    image.width = 80;
    image.height = 60;
    image.alt = "";
    image.src = "/thumb/1.jpg?type=f";
    const headline = document.createElement("strong");
    headline.id = "cv-feed-text";
    headline.textContent = "33kg 감량 풍자";
    card.append(image, headline);
    main.append(card);
  });
  const anchoredCvIssues = [
    { ...createIssue(502, "#cv-feed-image", "썸네일 속 글자의 명도 대비", "MEDIUM", "visual", "5.4.3"),
      content: { text: "", image: "/thumb/1.jpg?type=f" } },
    { ...createIssue(503, "#cv-feed-text", "기사 제목의 명도 대비", "MEDIUM", "visual", "5.4.3"),
      content: { text: "33kg감량풍자", image: null } }
  ];
  await page.evaluate(issues => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "INIT_ISSUES", issues, selectedIssueId: null, markersVisible: true
  }), anchoredCvIssues);
  for (const id of [502, 503]) {
    await waitForContentStatus(id, "VISIBLE");
    await frame.locator(`.ap-live-marker[data-issue-id="${id}"]`).waitFor({ state: "visible" });
  }
  assert.equal(await frame.locator(".ap-live-coordinate-target").count(), 0,
    "a located visual finding uses its element, not the analysis box");
  // The feed now shows another article in the same card.
  await frame.locator("#cv-feed-image").evaluate(image => { image.src = "/thumb/2.jpg"; });
  await waitForContentStatus(502, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED");
  await frame.locator('.ap-live-marker[data-issue-id="502"]').waitFor({ state: "detached" });
  await frame.locator("#cv-feed-text").evaluate(headline => { headline.firstChild.nodeValue = "다른 기사 제목"; });
  await waitForContentStatus(503, "UNAVAILABLE", "ELEMENT_CONTENT_CHANGED");
  await frame.locator('.ap-live-marker[data-issue-id="503"]').waitFor({ state: "detached" });
  await frame.locator("#cv-feed-image").evaluate(image => { image.src = "/thumb/1.jpg?type=f"; });
  await waitForContentStatus(502, "VISIBLE");
  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "INIT_ISSUES", issues: [], selectedIssueId: null, markersVisible: true
  }));

  await page.goto(`http://127.0.0.1:${address.port}/keyboard`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__liveConnected === true);
  assert.notEqual(new URL(page.url()).origin,
    new URL(await page.locator('#viewer').getAttribute('src')).origin,
    "keyboard navigation must work across the real cross-origin iframe boundary");
  await verifyLiveReportKeyboardNavigation(page, frame, createIssue, rewrittenHtml);

  console.log(JSON.stringify({
    result: "PASS",
    bridge: "LiveReportDocumentRewriter",
    markerCount: geometry.length,
    visualMarkerChip: chipStyle,
    groupedIssueCount: 3,
    keyboardNavigation: "report controls only, bidirectional frame exit",
    locatorStatusCount: locatorEvents.length,
    deterministicLeftRail: true,
    topEdgeScenarios: edgeLayouts.length,
    alignedRowAndBoundaryScenarios: alignmentLayouts.length,
    unevenColumnAnchorScenarios: unevenColumnLayouts.length,
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
