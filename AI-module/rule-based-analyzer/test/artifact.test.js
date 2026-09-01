'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AxeBuilder } = require('@axe-core/playwright');
const { chromium } = require('playwright');
const { convert } = require('../adapter');
const { score } = require('../scorer');
const { run, siblingOutputPath, toApiFormat } = require('../run');
const {
  buildDomReplayArtifactMetadata,
  buildPathSteps,
  enrichAxeResultsWithLocators,
  localDateTimeIso,
  normalizeAxeTarget,
  pausePageVirtualTime,
  redactFrameUrl,
  revalidateAxeLocators,
  resolveAxeNodeLocator,
  serializeDomReplayHtml,
} = require('../artifact');

test('normalizes axe target without flattening shadow-root selector arrays', () => {
  const target = ['iframe#outer', ['my-widget', 'button.submit']];
  assert.deepEqual(normalizeAxeTarget(target), target);
});

test('builds explicit document, frame, and shadow-root path steps', () => {
  const steps = buildPathSteps(
    ['iframe#outer', ['my-widget', 'button.submit']],
    ['https://child.example/form'],
  );

  assert.deepEqual(steps, [
    {
      context: 'DOCUMENT',
      selector: 'iframe#outer',
      frameUrl: 'https://child.example/form',
    },
    {
      context: 'FRAME',
      selector: 'my-widget',
      frameUrl: 'https://child.example/form',
    },
    {
      context: 'SHADOW_ROOT',
      selector: 'button.submit',
      frameUrl: 'https://child.example/form',
    },
  ]);
});

test('redacts credentials, query, fragment, and opaque frame URLs', () => {
  assert.equal(
    redactFrameUrl('https://user:pass@example.test/frame?signature=secret#token'),
    'https://example.test/frame',
  );
  assert.equal(redactFrameUrl('data:text/html,<p>secret</p>'), 'data:');
  assert.equal(redactFrameUrl('blob:https://example.test/private-id'), 'blob:');
  assert.equal(redactFrameUrl('about:srcdoc'), 'about:srcdoc');
});

test('derives distinct output files even when the CLI output argument is omitted', () => {
  assert.equal(siblingOutputPath('result_2026-08-11.json', '.html'), 'result_2026-08-11.html');
  assert.equal(
    siblingOutputPath('result_2026-08-11.json', '_artifact.json'),
    'result_2026-08-11_artifact.json',
  );
});

test('serializes capturedAt for the backend LocalDateTime contract', () => {
  const timestamp = localDateTimeIso(new Date('2026-08-11T12:34:56.789Z'));
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(timestamp.endsWith('Z'), false);
});

test('preserves typed locator through adapter and API conversion', () => {
  const locator = {
    kind: 'DOM_RECT',
    pathSteps: [{ context: 'DOCUMENT', selector: '#logo' }],
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    coordinateSpace: 'DOCUMENT_CSS_PX',
    visible: true,
    htmlSnippet: '<img id="logo">',
  };
  const axeResult = {
    url: 'https://example.test/',
    timestamp: '2026-08-11T00:00:00.000Z',
    testEngine: { version: '4.11.4' },
    violations: [{
      id: 'image-alt',
      description: 'Images must have alternate text',
      help: 'Images must have alternate text',
      impact: 'critical',
      tags: ['wcag2a', 'wcag111'],
      nodes: [{
        target: ['#logo'],
        html: '<img id="logo">',
        impact: 'critical',
        failureSummary: 'Fix the missing alt attribute',
        locator,
      }],
    }],
    passes: [],
    incomplete: [],
  };

  const converted = convert(axeResult);
  const apiResult = toApiFormat(converted, score(converted));
  const apiNode = apiResult.violations[0].rules[0].nodes[0];

  assert.equal(apiNode.selector, '#logo');
  assert.equal(apiNode.html, '<img id="logo">');
  assert.deepEqual(apiNode.locator, locator);
});

test('serializes DOM replay and resolves axe DOM_RECT from the same paused state', async () => {
  const browser = await chromium.launch({ headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-browser-test-'));

  try {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent(`
      <!doctype html>
      <html lang="ko">
        <head><title>artifact fixture</title></head>
        <body style="margin:0;min-height:1800px">
          <img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
               style="position:absolute;left:40px;top:900px;width:120px;height:80px">
          <input id="csrf-token" type="hidden" value="must-not-persist">
          <input id="password" type="password" value="must-not-persist-either">
          <button id="inline-handler" onclick="window.__shouldNotRun = true">handler</button>
          <template id="ordinary-template"><button onclick="window.__templateHandler = true">template</button><script>window.__templateScript = true;<\/script></template>
          <iframe id="fixture-frame"
                  style="position:absolute;left:100px;top:200px;width:300px;height:180px;border:0"
                  srcdoc='<button id="inside-frame" style="position:absolute;left:20px;top:30px;width:90px;height:40px">frame</button><button id="outside-frame" style="position:absolute;left:20px;top:1000px;width:90px;height:40px">outside</button>'></iframe>
          <iframe id="scaled-frame"
                  style="position:absolute;left:100px;top:400px;width:300px;height:180px;border:0;transform:scale(.5);transform-origin:top left"
                  srcdoc='<button id="scaled-inside" style="position:absolute;left:20px;top:30px;width:90px;height:40px">inside</button><button id="scaled-outside" style="position:absolute;left:400px;top:30px;width:90px;height:40px">outside</button>'></iframe>
          <div id="shadow-host" style="position:absolute;left:420px;top:500px;width:160px;height:90px"></div>
          <div id="closed-shadow-host"></div>
          <div id="overflow-parent" style="position:absolute;left:100px;top:1100px;width:120px;height:80px;overflow:hidden">
            <button id="overflow-clipped" style="position:absolute;left:10px;top:500px;width:90px;height:40px">clipped</button>
          </div>
          <div id="clip-path-parent" style="position:absolute;left:300px;top:1100px;width:120px;height:80px;clip-path:inset(100%)">
            <button id="clip-path-child" style="width:90px;height:40px">clipped</button>
          </div>
          <button id="moving" style="position:absolute;left:0;top:1300px;width:90px;height:40px">moving</button>
          <script>
            const root = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
            root.innerHTML = '<button id="inside-shadow" style="display:block;width:110px;height:45px">shadow</button><span id="nested-shadow-host"></span>';
            const nestedRoot = root.querySelector('#nested-shadow-host').attachShadow({ mode: 'open' });
            nestedRoot.innerHTML = '<strong id="nested-shadow-content">nested</strong><script>window.__nestedShouldNotRun = true;<\\/script>';
            const closedRoot = document.querySelector('#closed-shadow-host').attachShadow({ mode: 'closed' });
            closedRoot.innerHTML = '<strong id="closed-shadow-content">must not be serialized</strong>';
            setInterval(() => {
              const moving = document.querySelector('#moving');
              moving.style.left = (parseFloat(moving.style.left) + 2) + 'px';
            }, 1);
          </script>
        </body>
      </html>
    `);
    await page.waitForFunction(() => document.querySelector('#fixture-frame').contentDocument?.readyState === 'complete');

    const axeResults = await new AxeBuilder({ page }).withRules(['image-alt']).analyze();
    await enrichAxeResultsWithLocators(page, axeResults);
    const issueLocator = axeResults.violations[0].nodes[0].locator;
    const frameLocator = await resolveAxeNodeLocator(page, {
      target: ['#fixture-frame', '#inside-frame'],
      html: '<button id="inside-frame">frame</button>',
    });
    const shadowLocator = await resolveAxeNodeLocator(page, {
      target: [['#shadow-host', '#inside-shadow']],
      html: '<button id="inside-shadow">shadow</button>',
    });
    const outsideFrameLocator = await resolveAxeNodeLocator(page, {
      target: ['#fixture-frame', '#outside-frame'],
      html: '<button id="outside-frame">outside</button>',
    });
    const scaledInsideLocator = await resolveAxeNodeLocator(page, {
      target: ['#scaled-frame', '#scaled-inside'],
      html: '<button id="scaled-inside">inside</button>',
    });
    const scaledOutsideLocator = await resolveAxeNodeLocator(page, {
      target: ['#scaled-frame', '#scaled-outside'],
      html: '<button id="scaled-outside">outside</button>',
    });
    const overflowLocator = await resolveAxeNodeLocator(page, {
      target: ['#overflow-clipped'],
      html: '<button id="overflow-clipped">clipped</button>',
    });
    const clipPathLocator = await resolveAxeNodeLocator(page, {
      target: ['#clip-path-child'],
      html: '<button id="clip-path-child">clipped</button>',
    });

    const movingNode = {
      target: ['#moving'],
      html: '<button id="moving">moving</button>',
    };
    movingNode.locator = await resolveAxeNodeLocator(page, movingNode);
    await new Promise(resolve => setTimeout(resolve, 40));
    const movingResults = { violations: [{ nodes: [movingNode] }], incomplete: [] };
    await revalidateAxeLocators(page, movingResults);

    const releaseVirtualTime = await pausePageVirtualTime(page);
    const pausedX = await page.locator('#moving').boundingBox();
    await new Promise(resolve => setTimeout(resolve, 40));
    const stillPausedX = await page.locator('#moving').boundingBox();
    assert.equal(stillPausedX.x, pausedX.x);
    await releaseVirtualTime();
    const replayHtml = await serializeDomReplayHtml(page, {
      baseUrl: 'https://fixture.invalid/',
      sourceMode: 'RENDERED_DOM',
    });
    const metadata = await buildDomReplayArtifactMetadata(page, {
      requestedUrl: 'https://fixture.invalid/',
      finalUrl: 'https://fixture.invalid/',
    });

    assert.equal(issueLocator.kind, 'DOM_RECT');
    assert.equal(issueLocator.coordinateSpace, 'DOCUMENT_CSS_PX');
    assert.equal(issueLocator.visible, true);
    assert.deepEqual(issueLocator.pathSteps, [
      { context: 'DOCUMENT', selector: '#missing-alt' },
    ]);
    assert.equal(issueLocator.x, 40);
    assert.equal(issueLocator.y, 900);
    assert.equal(issueLocator.width, 120);
    assert.equal(issueLocator.height, 80);
    assert.deepEqual(frameLocator.pathSteps, [
      { context: 'DOCUMENT', selector: '#fixture-frame', frameUrl: 'about:srcdoc' },
      { context: 'FRAME', selector: '#inside-frame', frameUrl: 'about:srcdoc' },
    ]);
    assert.equal(frameLocator.x, 120);
    assert.equal(frameLocator.y, 230);
    assert.equal(frameLocator.visible, true);
    assert.equal(outsideFrameLocator.visible, false);
    assert.equal(outsideFrameLocator.x, null);
    assert.equal(outsideFrameLocator.y, null);
    assert.equal(outsideFrameLocator.width, null);
    assert.equal(outsideFrameLocator.height, null);
    assert.equal(scaledInsideLocator.visible, true);
    assert.equal(scaledInsideLocator.x, 110);
    assert.equal(scaledInsideLocator.y, 415);
    assert.equal(scaledInsideLocator.width, 45);
    assert.equal(scaledInsideLocator.height, 20);
    assert.equal(scaledOutsideLocator.visible, false);
    assert.equal(scaledOutsideLocator.x, null);
    assert.equal(overflowLocator.visible, false);
    assert.equal(overflowLocator.x, null);
    assert.equal(clipPathLocator.visible, false);
    assert.equal(clipPathLocator.x, null);
    assert.equal(movingNode.locator.visible, false);
    assert.equal(movingNode.locator.x, null);
    assert.deepEqual(shadowLocator.pathSteps, [
      { context: 'DOCUMENT', selector: '#shadow-host' },
      { context: 'SHADOW_ROOT', selector: '#inside-shadow' },
    ]);
    assert.equal(shadowLocator.x, 420);
    assert.equal(shadowLocator.y, 500);
    assert.equal(shadowLocator.visible, true);
    assert.equal(metadata.captureMode, 'DOM_REPLAY');
    assert.deepEqual(Object.keys(metadata).sort(), [
      'captureMode',
      'capturedAt',
      'deviceScaleFactor',
      'finalUrl',
      'pageHeightCssPx',
      'pageWidthCssPx',
      'requestedUrl',
      'viewportHeightCssPx',
      'viewportWidthCssPx',
    ]);
    assert.ok(metadata.pageHeightCssPx >= 1800);
    assert.match(replayHtml, /data-accessibility-replay="DOM_REPLAY"/);
    assert.match(replayHtml, /<base href="https:\/\/fixture\.invalid\/">/);
    assert.match(replayHtml, /id="missing-alt"/);
    assert.doesNotMatch(replayHtml, /<script\b/i);
    assert.doesNotMatch(replayHtml, /onclick=/i);
    assert.doesNotMatch(replayHtml, /__templateScript|__templateHandler/);
    assert.doesNotMatch(replayHtml, /must-not-persist/);
    assert.equal((replayHtml.match(/shadowrootmode="open"/g) || []).length, 2);
    assert.doesNotMatch(replayHtml, /shadowrootmode="closed"/i);
    assert.match(replayHtml, /id="nested-shadow-content"/);
    assert.doesNotMatch(replayHtml, /id="closed-shadow-content"/);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.png')), []);

    const replayPage = await context.newPage();
    await replayPage.goto(`data:text/html;charset=utf-8,${encodeURIComponent(replayHtml)}`);
    const replayShadowState = await replayPage.locator('#shadow-host').evaluate(host => ({
      hasOpenRoot: Boolean(host.shadowRoot),
      hasButton: Boolean(host.shadowRoot?.querySelector('#inside-shadow')),
      hasNestedRoot: Boolean(
        host.shadowRoot?.querySelector('#nested-shadow-host')?.shadowRoot,
      ),
      hasNestedContent: Boolean(
        host.shadowRoot
          ?.querySelector('#nested-shadow-host')
          ?.shadowRoot
          ?.querySelector('#nested-shadow-content'),
      ),
    }));
    assert.deepEqual(replayShadowState, {
      hasOpenRoot: true,
      hasButton: true,
      hasNestedRoot: true,
      hasNestedContent: true,
    });
    assert.equal(await replayPage.evaluate(() => window.__nestedShouldNotRun), undefined);
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('excludes a frame child when the iframe element is clipped by a parent overflow', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`
      <!doctype html>
      <html lang="ko">
        <head><title>clipped frame fixture</title></head>
        <body style="margin:0">
          <div style="position:absolute;left:50px;top:60px;width:120px;height:100px;overflow:hidden">
            <iframe id="clipped-frame"
                    style="position:absolute;left:400px;top:0;width:300px;height:180px;border:0"
                    srcdoc='<button id="frame-child" style="position:absolute;left:20px;top:20px;width:90px;height:40px">child</button>'></iframe>
          </div>
        </body>
      </html>
    `);
    await page.waitForFunction(
      () => document.querySelector('#clipped-frame').contentDocument?.readyState === 'complete',
    );

    const locator = await resolveAxeNodeLocator(page, {
      target: ['#clipped-frame', '#frame-child'],
      html: '<button id="frame-child">child</button>',
    });

    assert.equal(locator.visible, false);
    assert.equal(locator.x, null);
    assert.equal(locator.y, null);
    assert.equal(locator.width, null);
    assert.equal(locator.height, null);
    assert.deepEqual(locator.pathSteps, [
      { context: 'DOCUMENT', selector: '#clipped-frame', frameUrl: 'about:srcdoc' },
      { context: 'FRAME', selector: '#frame-child', frameUrl: 'about:srcdoc' },
    ]);
  } finally {
    await browser.close();
  }
});

test('applies rendered scale when intersecting a transformed overflow ancestor', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`
      <!doctype html>
      <html lang="ko">
        <head><title>scaled overflow fixture</title></head>
        <body style="margin:0">
          <div style="position:absolute;left:100px;top:80px;width:200px;height:100px;overflow:hidden;transform:scale(.5);transform-origin:top left">
            <button id="scaled-overflow-child"
                    style="position:absolute;left:300px;top:10px;width:90px;height:40px">child</button>
          </div>
        </body>
      </html>
    `);

    const locator = await resolveAxeNodeLocator(page, {
      target: ['#scaled-overflow-child'],
      html: '<button id="scaled-overflow-child">child</button>',
    });

    assert.equal(locator.visible, false);
    assert.equal(locator.x, null);
    assert.equal(locator.y, null);
    assert.equal(locator.width, null);
    assert.equal(locator.height, null);
  } finally {
    await browser.close();
  }
});

test('falls back to nonblank initial HTML after a cross-origin bot challenge without PNG', async () => {
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    if (request.url.startsWith('/challenge')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>STCLab Security Check</title></head>
        <body>webdriver detected - automated browser security verification</body></html>`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ko"><head><title>Original page</title></head>
      <body><main id="original-content">Initial main response content</main>
        <img id="fixture-missing-alt"
             src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <script>setTimeout(() => {
          location.href = 'http://localhost:${port}/challenge?atn=Selenium';
        }, 0);</script>
      </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-replay-fallback-test-'));
  const cvCapturePath = path.join(
    os.tmpdir(),
    `uniaccess-cv-test-${process.pid}-${Date.now()}.png`,
  );
  const outputPath = path.join(directory, 'result.json');
  const initialUrl = `http://127.0.0.1:${server.address().port}/initial`;
  try {
    await run(initialUrl, outputPath, {
      settleMs: 250,
      cvScreenshotPath: cvCapturePath,
    });

    const replayHtml = fs.readFileSync(path.join(directory, 'result.html'), 'utf8');
    const artifact = JSON.parse(
      fs.readFileSync(path.join(directory, 'result_artifact.json'), 'utf8'),
    );
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

    assert.match(replayHtml, /Initial main response content/);
    assert.doesNotMatch(replayHtml, /STCLab Security Check/);
    assert.doesNotMatch(replayHtml, /<script\b/i);
    assert.match(
      replayHtml,
      /data-accessibility-replay-source="INITIAL_RESPONSE_STATIC"/,
    );
    assert.equal(artifact.captureMode, 'DOM_REPLAY');
    assert.equal(artifact.requestedUrl, initialUrl);
    assert.equal(artifact.finalUrl, initialUrl);
    assert.equal(result.meta.replaySource, 'INITIAL_RESPONSE_STATIC');
    assert.ok(result.kwcag['5.1.1'].violationCount >= 1);
    assert.equal(fs.existsSync(cvCapturePath), true);
    assert.deepEqual(
      fs.readFileSync(cvCapturePath).subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.png')), []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(cvCapturePath, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
