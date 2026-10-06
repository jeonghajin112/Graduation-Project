'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run } = require('../run');
const { changedContentKeys } = require('../excluded-regions');

const IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

// Every request serves different headlines and a carousel that starts on a
// different slide, like a portal home page.
function portalPage(load) {
  const headlines = [1, 2, 3].map((item) => `<li><a href="/news/${load}-${item}">오늘의 뉴스 ${load}-${item} 제목입니다</a></li>`).join('');
  // A recommendation feed that switches its layout between visits, like the
  // Naver interest feed: no structural key of one load exists in the other.
  const feedDepth = (load % 3) + 1;
  const cards = [1, 2, 3, 4, 5, 6].map((item) => `<p>추천 콘텐츠 ${load}-${item}</p>`).join('');
  const feed = `${'<div>'.repeat(feedDepth)}<img class="feed-photo" src="${IMAGE}" width="80" height="60">${cards}${'</div>'.repeat(feedDepth)}`;
  // Its tab bar picks another tab on each visit and wraps the selected one,
  // which shifts the tabs' structural keys while their labels stay the same.
  const tabs = ['추천', '웹툰', '건강'].map((label, index) => {
    const tab = `<a class="feed-tab" href="#" role="tab" style="color:#c8c8c8">${label}</a>`;
    return `<li>${index === load % 3 ? `<span>${tab}</span>` : tab}</li>`;
  }).join('');
  const slides = load % 2 ? ['첫 번째 캠페인', '두 번째 캠페인'] : ['두 번째 캠페인', '첫 번째 캠페인'];
  return `<!doctype html><html lang="ko"><head><title>포털</title>
    <style>.swiper{width:400px;overflow:hidden}.swiper-wrapper{display:flex}.swiper-slide{flex:0 0 400px;height:60px}</style></head>
    <body>
      <header><img id="logo" src="${IMAGE}" width="120" height="40"><h1>포털 서비스</h1></header>
      <main>
        <section id="feed"><h2>추천 관심사</h2><ul role="tablist">${tabs}</ul>${feed}</section>
        <section id="news"><h2>뉴스</h2><ul>${headlines}</ul><img id="news-photo" src="${IMAGE}" width="80" height="60"></section>
        <div id="ad-area"><ins class="adsbygoogle" style="display:block;width:300px;height:100px">
          <img id="ad-image" src="${IMAGE}" width="300" height="100"></ins></div>
        <div class="swiper"><div class="swiper-wrapper">
          ${slides.map((text) => `<div class="swiper-slide"><p>${text}</p><img src="${IMAGE}" width="40" height="40"></div>`).join('')}
        </div></div>
        <p>변하지 않는 서비스 안내 문구입니다. 이 영역은 계속 검사합니다.</p>
        <div style="height:2400px">A portal page is much taller than one widget.</div>
      </main>
    </body></html>`;
}

async function analyzePortal(options = {}) {
  let load = 0;
  const server = http.createServer((request, response) => {
    load += 1;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(portalPage(load));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'excluded-regions-test-'));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`, path.join(directory, 'result.json'),
      { settleMs: 0, contentGraceMs: 0, ...options });
    return {
      api: JSON.parse(fs.readFileSync(path.join(directory, 'result_api.json'), 'utf8')),
      html: fs.readFileSync(path.join(directory, 'result.html'), 'utf8'),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const imageAltSelectors = (violations) => violations
  .filter((violation) => violation.kwcag_id === '5.1.1')
  .flatMap((violation) => violation.rules.flatMap((rule) => rule.nodes.map((node) => node.selector)));

test('excludes ads and content that changed between loads, and keeps stable content and carousels', async () => {
  const { api, html } = await analyzePortal();

  const scored = imageAltSelectors(api.violations);
  assert.ok(scored.some((selector) => selector.includes('logo')), 'the stable banner is still checked');
  assert.ok(scored.every((selector) => !/news-photo|ad-image/.test(selector)), 'excluded images are not scored');
  const scoredSlideNodes = api.violations
    .filter((violation) => violation.kwcag_id === '5.1.1')
    .flatMap((violation) => violation.rules.flatMap((rule) => rule.nodes))
    .filter((node) => node.locator?.carouselContext);
  assert.ok(scoredSlideNodes.length >= 1, 'carousel slides that rotate between loads stay in the analysis');

  const byReason = Object.fromEntries(api.excluded_violations.map((group) => [group.reason, group]));
  assert.deepEqual(Object.keys(byReason).sort(), ['AD', 'DYNAMIC']);
  assert.ok(imageAltSelectors(byReason.AD.violations).some((selector) => selector.includes('ad-image')));
  assert.ok(imageAltSelectors(byReason.DYNAMIC.violations).some((selector) => selector.includes('news-photo')));
  assert.ok(imageAltSelectors(byReason.DYNAMIC.violations).some((selector) => selector.includes('feed-photo')),
    'a feed whose structure differs between loads is dynamic');
  assert.ok(scored.every((selector) => !selector.includes('feed-photo')));

  const contrastSelectors = (violations) => violations
    .filter((violation) => violation.kwcag_id === '5.4.3')
    .flatMap((violation) => violation.rules.flatMap((rule) => rule.nodes.map((node) => node.selector)));
  assert.equal(contrastSelectors(api.violations).filter((selector) => selector.includes('feed-tab')).length, 3,
    'the tab bar above a changing feed stays in the analysis');
  assert.ok(contrastSelectors(byReason.DYNAMIC.violations).every((selector) => !selector.includes('feed-tab')));
  assert.doesNotMatch(html, /<section id="feed"[^>]*data-ua-excluded-region/,
    'the feed section is excluded around its tab bar, not as a whole');

  const reasons = api.metadata.excluded_regions.map((region) => region.reason);
  assert.ok(reasons.includes('AD') && reasons.includes('DYNAMIC'));
  for (const region of api.metadata.excluded_regions) {
    assert.ok(region.width > 0 && region.height > 0);
  }
  // The text analyzer reads these marks from the DOM snapshot.
  assert.match(html, /data-ua-excluded-region="DYNAMIC"/);
  assert.match(html, /data-ua-excluded-region="AD"/);
  assert.doesNotMatch(html, /swiper-slide"[^>]*data-ua-excluded-region/);
});

test('still excludes ads when the comparison load is disabled', async () => {
  const { api } = await analyzePortal({ compareLoad: false });
  assert.deepEqual(api.excluded_violations.map((group) => group.reason), ['AD']);
  assert.ok(imageAltSelectors(api.violations).some((selector) => selector.includes('news-photo')),
    'without a comparison load nothing is treated as dynamic');
});

// A site that records visits with a cookie shows returning visitors a
// different greeting. The first visit sets the cookie from the server and the
// page script sets another, like a visit counter. Content that changes only
// because of the first visit's cookies is not dynamic: both loads must see
// the page as a first-time visitor does.
test('content that changes only for a returning visitor is not dynamic', async () => {
  const server = http.createServer((request, response) => {
    const returning = /(?:^|;\s*)(?:visited|seen)=1/.test(request.headers.cookie || '');
    const greeting = returning ? '다시 오신 것을 환영합니다' : '처음 오셨군요, 환영합니다';
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'visited=1; Path=/',
    });
    response.end(`<!doctype html><html lang="ko"><head><title>기관 홈</title></head><body><main>
      <h1>기관 누리집</h1><p>변하지 않는 서비스 안내 문구입니다. 이 영역은 계속 검사합니다.</p>
      <div id="greeting"><img id="greeting-photo" src="${IMAGE}#${returning ? 'returning' : 'first'}" width="80" height="60">
        <span id="greeting-text" style="color:#d4d4d4;background:#fff">${greeting}</span></div>
      <script>document.cookie = 'seen=1; path=/';</script>
    </main></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'excluded-regions-cookie-test-'));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`, path.join(directory, 'result.json'),
      { settleMs: 300, contentGraceMs: 0 });
    const api = JSON.parse(fs.readFileSync(path.join(directory, 'result_api.json'), 'utf8'));
    assert.ok(api.excluded_violations.every((group) => group.reason !== 'DYNAMIC'),
      'a returning-visitor greeting is not dynamic content');
    assert.ok(imageAltSelectors(api.violations).some((selector) => selector.includes('greeting-photo')),
      'the greeting image is still checked');
    const selectors = api.violations.flatMap((violation) =>
      violation.rules.flatMap((rule) => rule.nodes.map((node) => node.selector)));
    assert.ok(selectors.some((selector) => selector.includes('greeting-text')),
      'the greeting text is still checked for contrast');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('content present in only one load counts as changed', () => {
  const current = { 'body>header:1': '로고', 'body>main:1>p:1': '안내', 'body>main:1>div:2>p:1': '피드 A' };
  const comparison = { 'body>header:1': '로고', 'body>main:1>p:1': '안내', 'body>main:1>ul:1>li:1': '피드 B' };
  assert.deepEqual(changedContentKeys(current, comparison), ['body>main:1>div:2>p:1']);
});

test('content that only moved inside its id-anchored block is unchanged', () => {
  const current = {
    '#tabs>li:1>span:1>a:1': '추천', '#tabs>li:2>a:1': '웹툰',
    '#feed>div:1>p:1': '새 기사', 'body>main:1>p:1': '안내',
  };
  const comparison = {
    '#tabs>li:1>a:1': '추천', '#tabs>li:2>span:1>a:1': '웹툰',
    '#feed>div:1>p:1': '지난 기사', 'body>main:1>p:1': '안내', 'body>main:1>p:2': '웹툰',
  };
  assert.deepEqual(changedContentKeys(current, comparison), ['#feed>div:1>p:1']);
  assert.deepEqual(changedContentKeys({ '#feed>p:1': '웹툰', 'body>p:1': '안내' }, { 'body>p:1': '안내', '#tabs>a:1': '웹툰' }),
    ['#feed>p:1'], 'the same text in another block does not count');
});

test('a comparison load that is a different page marks nothing', () => {
  const current = { a: '1', b: '2', c: '3', d: '4' };
  assert.deepEqual(changedContentKeys(current, { a: '1', x: '오류 페이지' }), []);
  assert.deepEqual(changedContentKeys(current, null), []);
});

test('excludes an in-page ad that names itself [광고], and keeps an ordinary link about ads', async () => {
  // Naver's headline ad is a plain link with an image whose alt starts with
  // "[광고]"; no ad marker or ad iframe is involved.
  const page = `<!doctype html><html lang="ko"><head><title>포털</title></head><body><main>
    <h1>포털 서비스</h1><p>변하지 않는 서비스 안내 문구입니다. 이 영역은 계속 검사합니다.</p>
    <a id="headline-ad" href="/ad"><img src="${IMAGE}" width="240" height="60" alt="[광고]멤버십 초대 이벤트">
      <span id="headline-ad-text" style="color:#d4d4d4;background:#fff">구독료보다 더 큰 적립 혜택</span></a>
    <a id="ad-guide" href="/guide"><img src="${IMAGE}" width="240" height="60" alt="광고 안내 페이지">
      <span id="ad-guide-text" style="color:#d4d4d4;background:#fff">광고 문의 안내</span></a>
  </main></body></html>`;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'excluded-regions-label-test-'));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`, path.join(directory, 'result.json'),
      { settleMs: 0, contentGraceMs: 0, compareLoad: false });
    const api = JSON.parse(fs.readFileSync(path.join(directory, 'result_api.json'), 'utf8'));
    const html = fs.readFileSync(path.join(directory, 'result.html'), 'utf8');
    const selectors = (violations) => violations.flatMap((violation) =>
      violation.rules.flatMap((rule) => rule.nodes.map((node) => node.selector)));
    const ad = api.excluded_violations.find((group) => group.reason === 'AD');
    assert.ok(ad && selectors(ad.violations).some((selector) => selector.includes('headline-ad-text')));
    assert.ok(selectors(api.violations).every((selector) => !selector.includes('headline-ad-text')));
    assert.ok(selectors(api.violations).some((selector) => selector.includes('ad-guide-text')),
      'an alt text that merely mentions ads is not an ad');
    assert.match(html, /<a id="headline-ad"[^>]*data-ua-excluded-region="AD"/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
