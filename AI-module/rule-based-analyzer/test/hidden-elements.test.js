'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run } = require('../run');

const IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

// A notice list duplicated for mobile, screen-reader-only text, and a
// carousel whose identical later slides hold images without alternative
// text, so only the audit's slide attributes would tell them apart.
const PAGE = `<!doctype html><html lang="ko"><head><title>숨김 요소</title>
  <style>
    .pc-hide{display:none}
    .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
    .ghost{visibility:hidden}.ghost .shown{visibility:visible}
    .swiper{width:300px;overflow:hidden}.swiper-wrapper{display:flex}.swiper-slide{flex:0 0 300px;height:80px}
  </style></head>
  <body><main>
    <h1>학교 소식</h1>
    <div class="pc-hide"><ul id="mobile-notice"><li>모바일 전용 공지 목록입니다</li></ul></div>
    <ul id="pc-notice"><li>화면에 보이는 공지 목록입니다</li></ul>
    <button id="search"><span class="sr-only">검색</span><img src="${IMAGE}" alt="" width="16" height="16"></button>
    <p class="ghost">숨긴 문단<span class="shown">보이는 문장</span></p>
    <p id="transparent" style="opacity:0">투명한 안내 문구입니다</p>
    <div class="swiper"><div class="swiper-wrapper">
      <div class="swiper-slide swiper-slide-active"><img src="${IMAGE}" alt="첫 번째 배너" width="300" height="80"></div>
      <div class="swiper-slide"><a href="#"><img src="${IMAGE}" width="300" height="80"></a></div>
      <div class="swiper-slide"><a href="#"><img src="${IMAGE}" width="300" height="80"></a></div>
    </div></div>
  </main></body></html>`;

async function analyze() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-elements-test-'));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`, path.join(directory, 'result.json'),
      { settleMs: 0, contentGraceMs: 0, compareLoad: false });
    return {
      api: JSON.parse(fs.readFileSync(path.join(directory, 'result_api.json'), 'utf8')),
      html: fs.readFileSync(path.join(directory, 'result.html'), 'utf8'),
    };
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('marks content hidden at the analysis viewport and keeps content read aloud', async () => {
  const { api, html } = await analyze();

  assert.match(html, /<div class="pc-hide" data-ua-hidden="true">/, 'the mobile-only copy is marked');
  assert.doesNotMatch(html, /<ul id="pc-notice"[^>]*data-ua-hidden/);
  assert.doesNotMatch(html, /<span class="sr-only"[^>]*data-ua-hidden/, 'screen-reader-only text stays readable');
  assert.doesNotMatch(html, /<p id="transparent"[^>]*data-ua-hidden/, 'transparent text is still read aloud');
  assert.doesNotMatch(html, /<p class="ghost"[^>]*data-ua-hidden/, 'a hidden parent with a visible child stays');
  assert.doesNotMatch(html, /swiper-slide[^"]*"[^>]*data-ua-hidden/, 'carousel slides are checked slide by slide');
  assert.ok(api.metadata.hidden_element_count >= 1);

  const nodes = [...api.violations.flatMap(violation => violation.rules),
    ...(api.unmapped_violations || [])].flatMap(rule => rule.nodes || []);
  assert.ok(nodes.length > 0);
  for (const node of nodes) {
    assert.doesNotMatch(JSON.stringify(node.locator?.pathSteps || []), /data-ua-audit-/,
      'stored paths never use the carousel audit attributes, which the live page does not have');
  }
  const slideNode = nodes.find(node => node.locator?.carouselContext?.slideIndex === 1);
  assert.ok(slideNode, 'the hidden slide was audited');
});
