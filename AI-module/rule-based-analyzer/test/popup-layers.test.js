'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run } = require('../run');

const IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const page = (popup) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>테스트 시청</title></head><body>
  <header style="position:fixed;top:0;left:0;right:0;height:40px;z-index:500;background:#fff">
    <a href="/">테스트 시청</a> <a href="/civil">민원</a></header>
  <main style="padding-top:60px"><h1>시정 소식</h1>
    <p>시청 홈페이지 본문입니다. 민원 신청, 공지사항, 자료실 서비스를 안내합니다.</p>
    <img id="main-noalt" src="${IMAGE}" width="200" height="80"></main>
  ${popup}</body></html>`;

// A notice popup whose close controls have no handler, so it has to be hidden.
const POPUP = `<div id="layerPopup" style="position:fixed;top:60px;left:200px;width:800px;height:500px;
    background:#fff;border:2px solid #333;z-index:1000">
  <img id="pop-noalt" src="${IMAGE}" width="700" height="380">
  <p>[공지] 추석 연휴 민원실 운영 안내</p>
  <button id="pop-x"><span class="ico"></span></button>
  <a href="#" id="pop-today">오늘 하루 보지 않기</a></div>`;

const pages = { '/with-popup': page(POPUP), '/without-popup': page('') };

async function analyze(route) {
  const server = http.createServer((request, response) => {
    response.writeHead(pages[request.url] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(pages[request.url] ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-layers-test-'));
  try {
    const output = path.join(directory, 'result.json');
    await run(`http://127.0.0.1:${server.address().port}${route}`, output, { settleMs: 0, contentGraceMs: 0 });
    return {
      api: JSON.parse(fs.readFileSync(path.join(directory, 'result_api.json'), 'utf8')),
      html: fs.readFileSync(path.join(directory, 'result.html'), 'utf8'),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const nodeIds = (violations) => violations.flatMap((violation) => violation.rules.flatMap((rule) =>
  rule.nodes.map((node) => `${rule.axe_rule_id}:${(node.html.match(/id="([^"]+)"/) || [])[1]}`)));

test('reports a layer popup outside the score and analyzes the page behind it', async () => {
  const { api, html } = await analyze('/with-popup');

  assert.deepEqual(nodeIds(api.violations), ['image-alt:main-noalt']);
  const popup = api.excluded_violations.find((group) => group.reason === 'POPUP');
  assert.ok(popup, 'popup violations are reported under POPUP');
  assert.deepEqual(nodeIds(popup.violations).sort(), ['button-name:pop-x', 'image-alt:pop-noalt']);

  assert.equal(api.metadata.popup_layers.length, 1);
  assert.equal(api.metadata.popup_layers[0].id, 'layerPopup');
  // The snapshot used by the live report and the text analyzer has the popup closed.
  assert.match(html, /id="layerPopup"[^>]*display: none !important/);
});

test('leaves a page without popups and its fixed header unchanged', async () => {
  const { api } = await analyze('/without-popup');

  assert.deepEqual(nodeIds(api.violations), ['image-alt:main-noalt']);
  assert.equal(api.excluded_violations.some((group) => group.reason === 'POPUP'), false);
  assert.deepEqual(api.metadata.popup_layers, []);
});
