'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright');

const {
  challengeSignals,
  detectCrossOriginBotChallenge,
  usableInitialHtml,
} = require('../run');

test('routes only an active same-document BotManager shell to the initial HTML fallback', async () => {
  const url = 'about:blank';
  const initialSnapshot = {
    url,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    html: `<!doctype html><html lang="ko"><head><title>실제 초기 페이지</title></head>
      <body><main><h1>대학교 홈페이지</h1><p>사용자에게 제공되는 실제 초기 페이지 본문입니다.</p>
      <nav aria-label="주요 메뉴"><a href="/admission">입학 안내</a></nav></main></body></html>`,
  };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.setContent(`<!doctype html><html><head><style>
      #bm-wait-background, #loading-overlay { position: fixed; inset: 0; }
    </style></head><body>
      <div id="bm-wait-background"></div>
      <div id="loading-overlay" role="status"></div>
    </body></html>`);

    const activeChallenge = await detectCrossOriginBotChallenge(page, url);
    assert.deepEqual(activeChallenge.signals, ['BOT_MANAGER_WAIT_OVERLAY']);
    assert.equal(activeChallenge.detected, true);
    assert.equal(usableInitialHtml(initialSnapshot), true);

    await page.setContent(`<!doctype html><html><head><style>
      #bm-wait-background, #loading-overlay { display: none; }
    </style></head><body>
      <main><h1>정상 페이지</h1><p>사용자에게 보이는 실제 본문입니다.</p></main>
      <div id="bm-wait-background"></div>
      <div id="loading-overlay" role="status"></div>
    </body></html>`);

    const dormantChallenge = await detectCrossOriginBotChallenge(page, url);
    assert.equal(dormantChallenge.signals.includes('BOT_MANAGER_WAIT_OVERLAY'), false);
    assert.equal(dormantChallenge.detected, false);
  } finally {
    await browser.close();
  }
});

test('does not treat ordinary loading UI or a partial BotManager marker as a challenge', () => {
  const ordinaryLoadingHtml = `<!doctype html><html><body>
    <main>대시보드를 불러오는 중입니다.</main>
    <div id="loading-overlay" role="status">Loading</div>
  </body></html>`;
  const partialMarkerHtml = '<html><body><div id="bm-wait-background"></div></body></html>';

  assert.deepEqual(challengeSignals({ html: ordinaryLoadingHtml }), []);
  assert.deepEqual(challengeSignals({ html: partialMarkerHtml }), []);

  const dormantMarkerPair = `<html><body><main>정상 본문</main>
    <div id="bm-wait-background" hidden></div>
    <div id="loading-overlay" hidden></div></body></html>`;
  assert.deepEqual(challengeSignals({ html: dormantMarkerPair }), []);
});

test('recognises the government MBuster redirect, Cloudflare and vendor markers', () => {
  assert.deepEqual(challengeSignals({ url: 'https://plus.gov.kr/mbuster?returnUrl=%2F' }), ['MBUSTER']);
  assert.deepEqual(challengeSignals({ url: 'https://www.gov.kr/portal/main' }), []);
  assert.deepEqual(challengeSignals({ url: 'https://www.example.go.kr/deny/index.html' }), ['CHALLENGE_URL']);
  assert.deepEqual(challengeSignals({
    title: 'Just a moment...',
    html: '<script>window._cf_chl_opt = {};</script><div id="cf-chl-widget"></div>',
  }), ['CLOUDFLARE']);
  // PerimeterX(px-captcha)·DataDome(captcha-delivery.com) block pages are
  // already covered by the generic CAPTCHA marker.
  assert.deepEqual(challengeSignals({ html: '<div id="px-captcha"></div>' }), ['CAPTCHA']);
  assert.deepEqual(challengeSignals({ html: '<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>' }), ['CAPTCHA']);
});

test('does not treat vendor tags on an ordinary page as a challenge', () => {
  // Cloudflare injects challenge-platform scripts and DataDome injects its tag
  // on normal pages too; neither alone may route a page to the fallback.
  const ordinary = `<html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
    <script src="https://js.datadome.co/tags.js"></script></head><body><main>정상 본문</main></body></html>`;
  assert.deepEqual(challengeSignals({ title: '기관 홈페이지', html: ordinary }), []);
});

test('detects a cross-origin redirect to the MBuster block page', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.route('https://plus.gov.kr/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="ko"><head><title>정부24</title></head><body><p>잠시 후 다시 이용해 주세요.</p></body></html>',
    }));
    await page.goto('https://plus.gov.kr/mbuster?returnUrl=%2F');
    const challenge = await detectCrossOriginBotChallenge(page, 'https://www.gov.kr/');
    assert.equal(challenge.detected, true);
    assert.deepEqual(challenge.signals, ['MBUSTER']);
  } finally {
    await browser.close();
  }
});
