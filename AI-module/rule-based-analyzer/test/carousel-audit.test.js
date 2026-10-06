'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AxeBuilder } = require('@axe-core/playwright');
const { chromium } = require('playwright');
const {
  AUDIT_ATTRIBUTES,
  analyzeWithCarouselStates,
  mergeAxeResults,
} = require('../carousel-audit');
const { serializeDomReplayHtml } = require('../artifact');
const { run } = require('../run');

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function imageAltNodes(results) {
  return (results.violations || [])
    .find(result => result.id === 'image-alt')
    ?.nodes || [];
}

function nodeById(results, id) {
  return imageAltNodes(results).find(node => node.html.includes(`id="${id}"`));
}

function scanImageAlt(page) {
  return new AxeBuilder({ page }).withRules(['image-alt']).analyze();
}

test('finds a hidden logical Swiper slide, excludes clones, and restores page state', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    await page.setContent(`
      <!doctype html><html lang="ko"><head><title>Swiper fixture</title>
      <style>
        body { margin: 0; min-height: 1800px; }
        .swiper { width: 500px; height: 180px; overflow: hidden; }
        .swiper-wrapper { display: flex; transform: translate3d(-500px, 0, 0); }
        .swiper-slide { display: flex; flex: 0 0 500px; min-height: 160px; }
        img { width: 40px; height: 40px; }
      </style></head><body>
        <button id="focus-owner" style="margin-top:700px">focus owner</button>
        <div class="swiper">
          <div class="swiper-wrapper" style="transition: transform 300ms ease">
            <section class="swiper-slide swiper-slide-active" aria-hidden="false"
                     style="color:red"><div><img id="baseline-image" src="${PIXEL}"></div></section>
            <section class="swiper-slide" aria-hidden="true" hidden inert tabindex="-1"
                     style="display:none;color:blue"><div><img id="hidden-image" src="${PIXEL}"></div></section>
            <section class="swiper-slide swiper-slide-duplicate">
              <img id="clone-image" src="${PIXEL}">
            </section>
          </div>
        </div>
      </body></html>
    `);
    await page.locator('#focus-owner').focus();
    await page.evaluate(() => window.scrollTo(0, 450));

    const before = await page.evaluate(() => ({
      activeId: document.activeElement?.id,
      cloneAttrs: Object.fromEntries(['style', 'aria-hidden', 'inert']
        .map(name => [name, document.querySelector('#clone-image').closest('section')
          .hasAttribute(name)
          ? document.querySelector('#clone-image').closest('section').getAttribute(name)
          : null])),
      hiddenAttrs: Object.fromEntries(['style', 'aria-hidden', 'hidden', 'inert', 'tabindex']
        .map(name => [name, document.querySelector('#hidden-image').closest('section')
          .hasAttribute(name)
          ? document.querySelector('#hidden-image').closest('section').getAttribute(name)
          : null])),
      scrollY: window.scrollY,
      wrapperStyle: document.querySelector('.swiper-wrapper').getAttribute('style'),
    }));

    const ordinary = await scanImageAlt(page);
    assert.ok(nodeById(ordinary, 'baseline-image'));
    assert.equal(nodeById(ordinary, 'hidden-image'), undefined,
      'a single axe run must demonstrate that display:none adjacent slides are missed');
    assert.ok(nodeById(ordinary, 'clone-image'),
      'the control scan shows why scanner-side clone suppression is needed');

    const observedHiddenDisplays = [];
    const audited = await analyzeWithCarouselStates(page, async () => {
      observedHiddenDisplays.push(
        await page.locator('#hidden-image').evaluate(element => getComputedStyle(element.closest('section')).display),
      );
      return scanImageAlt(page);
    });

    assert.ok(nodeById(audited, 'baseline-image'));
    const hiddenNode = nodeById(audited, 'hidden-image');
    assert.ok(hiddenNode, 'the hidden logical slide must be audited');
    assert.equal(nodeById(audited, 'clone-image'), undefined, 'duplicate slides must never be audited');
    assert.deepEqual(hiddenNode.locator.carouselContext, {
      carouselId: 1,
      slideIndex: 1,
      slideCount: 2,
    });
    assert.equal(imageAltNodes(audited).length, 2, 'baseline findings must be deduplicated');
    assert.deepEqual(audited.carouselAudit.frameworks, {
      generic: 0,
      slick: 0,
      splide: 0,
      swiper: 1,
    });
    assert.equal(audited.carouselAudit.statesScanned, 1);
    assert.ok(observedHiddenDisplays.includes('flex'),
      'the activated slide must preserve the carousel slide display mode');

    const after = await page.evaluate(attributes => {
      const hidden = document.querySelector('#hidden-image').closest('section');
      const clone = document.querySelector('#clone-image').closest('section');
      return {
        activeId: document.activeElement?.id,
        annotations: Object.fromEntries([
          document.querySelector('#baseline-image').closest('section'), hidden,
        ].map((slide, index) => [index, [
          slide.getAttribute('data-ua-audit-carousel-id'),
          slide.getAttribute('data-ua-audit-slide-index'),
          slide.getAttribute('data-ua-audit-slide-count'),
        ]])),
        cloneAnnotated: attributes.some(name => clone.hasAttribute(name)),
        cloneAttrs: Object.fromEntries(['style', 'aria-hidden', 'inert']
          .map(name => [name, clone.hasAttribute(name) ? clone.getAttribute(name) : null])),
        hiddenAttrs: Object.fromEntries(['style', 'aria-hidden', 'hidden', 'inert', 'tabindex']
          .map(name => [name, hidden.hasAttribute(name) ? hidden.getAttribute(name) : null])),
        scrollY: window.scrollY,
        wrapperStyle: document.querySelector('.swiper-wrapper').getAttribute('style'),
      };
    }, AUDIT_ATTRIBUTES);
    assert.equal(after.activeId, before.activeId);
    assert.equal(after.scrollY, before.scrollY);
    assert.equal(after.wrapperStyle, before.wrapperStyle);
    assert.deepEqual(after.hiddenAttrs, before.hiddenAttrs);
    assert.deepEqual(after.cloneAttrs, before.cloneAttrs);
    assert.deepEqual(after.annotations, {
      0: ['1', '0', '2'],
      1: ['1', '1', '2'],
    });
    assert.equal(after.cloneAnnotated, false);

    const replayHtml = await serializeDomReplayHtml(page);
    assert.match(replayHtml, /data-ua-audit-carousel-id="1"/);
    assert.match(replayHtml, /data-ua-audit-slide-index="1"/);
    assert.match(replayHtml, /data-ua-audit-slide-count="2"/);
    assert.doesNotMatch(
      replayHtml.match(/<section class="swiper-slide swiper-slide-duplicate"[^>]*>/)?.[0] || '',
      /data-ua-audit-/,
    );
    assert.deepEqual(hiddenNode.locator.pathSteps.at(-1), {
      context: 'DOCUMENT',
      selector: '#hidden-image',
    });
  } finally {
    await browser.close();
  }
});

test('traverses Swiper, Slick, Splide, and generic logical slides with bounded IDs', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await context.newPage();
    await page.setContent(`
      <!doctype html><html lang="ko"><head><title>framework fixtures</title>
      <style>
        .fixture { width:300px;min-height:60px;overflow:hidden;margin:8px }
        .slide { min-height:50px }
        img { width:30px;height:30px }
      </style></head><body>
        <div class="swiper fixture"><div class="swiper-wrapper">
          <div class="swiper-slide swiper-slide-active"><img id="swiper-0" src="${PIXEL}"></div>
          <div class="swiper-slide" style="display:none"><img id="swiper-1" src="${PIXEL}"></div>
          <div class="swiper-slide swiper-slide-duplicate"><img id="swiper-clone" src="${PIXEL}"></div>
        </div></div>
        <div class="slick-slider fixture"><div class="slick-track">
          <div class="slick-slide slick-current"><img id="slick-0" src="${PIXEL}"></div>
          <div class="slick-slide" style="display:none"><img id="slick-1" src="${PIXEL}"></div>
          <div class="slick-slide slick-cloned"><img id="slick-clone" src="${PIXEL}"></div>
        </div></div>
        <div class="splide fixture"><div class="splide__list">
          <div class="splide__slide is-active"><img id="splide-0" src="${PIXEL}"></div>
          <div class="splide__slide" style="display:none"><img id="splide-1" src="${PIXEL}"></div>
          <div class="splide__slide is-clone"><img id="splide-clone" src="${PIXEL}"></div>
        </div></div>
        <div data-carousel class="fixture">
          <article data-slide aria-current="true"><img id="generic-0" src="${PIXEL}"></article>
          <article data-slide style="display:none"><div><img id="generic-1" src="${PIXEL}"></div></article>
        </div>
        <div id="shadow-host"></div>
        <script>
          document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML =
            '<style>:host{display:block}.fixture{width:300px;min-height:60px}</style>'
            + '<div data-carousel class="fixture">'
            + '<article data-slide aria-current="true"><img id="shadow-0" src="${PIXEL}"></article>'
            + '<article data-slide style="display:none"><div><img id="shadow-1" src="${PIXEL}"></div></article>'
            + '</div>';
        <\/script>
      </body></html>
    `);

    const audited = await analyzeWithCarouselStates(page, () => scanImageAlt(page));
    assert.deepEqual(audited.carouselAudit.frameworks, {
      generic: 2,
      slick: 1,
      splide: 1,
      swiper: 1,
    });
    assert.equal(audited.carouselAudit.carouselsScanned, 5);
    assert.equal(audited.carouselAudit.statesScanned, 5);
    for (const [id, carouselId] of [
      ['swiper-1', 1],
      ['slick-1', 2],
      ['splide-1', 3],
      ['generic-1', 4],
      ['shadow-1', 5],
    ]) {
      assert.deepEqual(nodeById(audited, id)?.locator.carouselContext, {
        carouselId,
        slideIndex: 1,
        slideCount: 2,
      });
    }
    for (const id of ['swiper-clone', 'slick-clone', 'splide-clone']) {
      assert.equal(nodeById(audited, id), undefined);
    }
    assert.ok(
      nodeById(audited, 'shadow-1').locator.pathSteps
        .some(step => step.context === 'SHADOW_ROOT'),
    );
    const replayHtml = await serializeDomReplayHtml(page);
    assert.match(replayHtml, /shadowrootmode="open"/);
    assert.match(replayHtml, /id="shadow-1"/);
    assert.match(replayHtml, /data-ua-audit-carousel-id="5"/);
  } finally {
    await browser.close();
  }
});

test('skips oversized carousels and restores state/network routing after scan failure', async () => {
  let probeCount = 0;
  const slides = Array.from({ length: 21 }, (_, index) => (
    `<div data-slide${index === 0 ? ' aria-current="true"' : ' style="display:none"'}>`
    + `<img id="oversized-${index}" src="${PIXEL}"></div>`
  )).join('');
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/probe')) {
      probeCount += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ko"><head><title>bounds fixture</title></head>
      <body style="min-height:1200px"><button id="focus-owner">focus</button>
      <div data-carousel id="oversized">${slides}</div>
      <div data-carousel id="failing">
        <div data-slide aria-current="true"><img id="failure-0" src="${PIXEL}"></div>
        <div data-slide style="display:none"><img id="failure-1" src="${PIXEL}"></div>
      </div>
      <div data-carousel id="state-limited">
        <div data-slide aria-current="true"><img id="limited-0" src="${PIXEL}"></div>
        <div data-slide style="display:none"><img id="limited-1" src="${PIXEL}"></div>
        <div data-slide style="display:none"><img id="limited-2" src="${PIXEL}"></div>
      </div>
      <script>
        let sent = false;
        new MutationObserver(() => {
          if (!sent) { sent = true; fetch('/probe-during-audit').catch(() => {}); }
        }).observe(document, { subtree:true, attributes:true });
        window.__clicks = 0;
        document.addEventListener('click', () => { window.__clicks += 1; });
      <\/script></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.locator('#focus-owner').focus();
    await page.evaluate(() => window.scrollTo(0, 300));

    let scans = 0;
    await assert.rejects(
      analyzeWithCarouselStates(page, async () => {
        scans += 1;
        if (scans > 1) throw new Error('fixture scan failure');
        return scanImageAlt(page);
      }, { maxSlidesPerCarousel: 20 }),
      /fixture scan failure/,
    );
    await page.waitForTimeout(50);
    assert.equal(probeCount, 0, 'scanner-triggered mutation network must be blocked');

    const state = await page.evaluate(() => ({
      activeId: document.activeElement?.id,
      annotationsOnOversized: document.querySelectorAll(
        '#oversized [data-ua-audit-carousel-id]',
      ).length,
      clicks: window.__clicks,
      failureHiddenStyle: document.querySelector('#failure-1').closest('[data-slide]')
        .getAttribute('style'),
      scrollY: window.scrollY,
    }));
    assert.equal(state.activeId, 'focus-owner');
    assert.equal(state.annotationsOnOversized, 0);
    assert.equal(state.clicks, 0);
    assert.equal(state.failureHiddenStyle, 'display:none');
    assert.equal(state.scrollY, 300);

    await page.evaluate(() => fetch('/probe-after-audit').then(() => null));
    assert.equal(probeCount, 1, 'the temporary route must be removed after failure');

    const bounded = await analyzeWithCarouselStates(page, () => scanImageAlt(page), {
      maxSlidesPerCarousel: 20,
      maxStates: 1,
    });
    assert.equal(bounded.carouselAudit.skipped.oversized, 1);
    assert.equal(bounded.carouselAudit.skipped.limit, 1);
    assert.equal(bounded.carouselAudit.carouselsScanned, 1);
    assert.equal(bounded.carouselAudit.statesScanned, 1);
    assert.equal(
      await page.locator('#state-limited [data-ua-audit-carousel-id]').count(),
      0,
    );
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('merges every axe result group by rule and carousel-aware node identity', () => {
  const makeNode = slideIndex => ({
    target: ['#same-target'],
    html: '<img id="same-target">',
    failureSummary: 'missing alt',
    locator: { carouselContext: { carouselId: 1, slideIndex, slideCount: 2 } },
  });
  const base = {
    violations: [{ id: 'image-alt', nodes: [makeNode(0)] }],
    incomplete: [{ id: 'color-contrast', nodes: [makeNode(0)] }],
    passes: [{ id: 'document-title', nodes: [makeNode(0)] }],
    inapplicable: [{ id: 'audio-caption', nodes: [] }],
  };
  const addition = {
    violations: [{ id: 'image-alt', nodes: [makeNode(0), makeNode(1)] }],
    incomplete: [{ id: 'color-contrast', nodes: [makeNode(0), makeNode(1)] }],
    passes: [{ id: 'document-title', nodes: [makeNode(0), makeNode(1)] }],
    inapplicable: [{ id: 'audio-caption', nodes: [] }],
  };

  mergeAxeResults(base, addition);
  assert.equal(base.violations[0].nodes.length, 2);
  assert.equal(base.incomplete[0].nodes.length, 2);
  assert.equal(base.passes[0].nodes.length, 2);
  assert.equal(base.inapplicable.length, 1);
});

test('run pipeline writes hidden slide findings and replay annotations end to end', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ko"><head><title>end-to-end</title>
      <style>[data-carousel]{width:320px;min-height:80px}img{width:40px;height:40px}</style>
      </head><body><main><div data-carousel>
        <section data-slide aria-current="true"><img id="visible-valid" alt="설명" src="${PIXEL}"></section>
        <section data-slide style="display:none"><div><img id="hidden-e2e" src="${PIXEL}"></div></section>
      </div></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'carousel-run-test-'));
  const output = path.join(directory, 'result.json');
  try {
    const result = await run(
      `http://127.0.0.1:${server.address().port}/fixture`,
      output,
      { settleMs: 0 },
    );
    const imageAlt = result.kwcag['5.1.1'].violations
      .find(violation => violation.axeRuleId === 'image-alt');
    const hidden = imageAlt.nodes.find(node => node.html.includes('id="hidden-e2e"'));
    assert.ok(hidden);
    assert.deepEqual(hidden.locator.carouselContext, {
      carouselId: 1,
      slideIndex: 1,
      slideCount: 2,
    });
    assert.equal(result.meta.carouselAudit.statesScanned, 1);

    const replayHtml = fs.readFileSync(path.join(directory, 'result.html'), 'utf8');
    assert.match(
      replayHtml,
      /<section[^>]*data-ua-audit-carousel-id="1"[^>]*data-ua-audit-slide-index="1"[^>]*data-ua-audit-slide-count="2"/,
    );
    const api = JSON.parse(fs.readFileSync(path.join(directory, 'result_api.json'), 'utf8'));
    const apiHidden = api.violations.flatMap(item => item.rules)
      .flatMap(rule => rule.nodes)
      .find(node => node.html.includes('id="hidden-e2e"'));
    assert.deepEqual(apiHidden.locator.carouselContext, hidden.locator.carouselContext);
    assert.ok(apiHidden.locator.pathSteps.length > 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
