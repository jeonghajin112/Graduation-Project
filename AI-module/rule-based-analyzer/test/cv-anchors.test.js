'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { chromium } = require('playwright');
const { collectCvAnchors } = require('../cv-anchors');
const { run } = require('../run');

const PAGE = `<!doctype html><html lang="ko"><head><title>피드</title>
  <style>body{margin:0}.card{display:block;width:300px;height:120px}
  .tab::before{content:"/"}.bg{width:100px;height:50px;background-image:url("/banner/bg.png?v=2")}</style></head>
  <body>
    <ul id="tabs"><li class="tab"><a href="#">추천</a></li><li class="tab"><a href="#">건강</a></li></ul>
    <section>
      <a class="card" href="/news/1"><img src="/thumb/1.jpg?type=f" width="80" height="60" alt="">
        <strong>33kg   감량 풍자</strong></a>
      <a class="card" href="/news/2"><img data-src="/thumb/2.jpg" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80" height="60" alt=""></a>
    </section>
    <div class="bg"></div>
    <p style="visibility:hidden">숨김</p>
    <svg width="20" height="20"><linearGradient id="g"></linearGradient><rect width="20" height="20"/></svg>
  </body></html>`;

test('collects each visible element with a unique selector and its content signature', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }));
    await page.goto('https://feed.example/');
    const anchors = await collectCvAnchors(page);

    for (const anchor of anchors) {
      assert.equal(await page.locator(anchor.selector).count(), 1, `${anchor.selector} identifies one element`);
    }
    const bySelectorEnd = (suffix) => anchors.find((anchor) => anchor.selector.endsWith(suffix));

    const secondTab = bySelectorEnd('#tabs > li:nth-of-type(2)');
    assert.equal(secondTab.text, '건강');
    const firstImage = bySelectorEnd('a:nth-of-type(1) > img');
    assert.equal(firstImage.image, '/thumb/1.jpg?type=f', 'images are identified by path and query, not host');
    assert.equal(bySelectorEnd('a:nth-of-type(2) > img').image, '/thumb/2.jpg', 'lazy images use their real source');
    assert.equal(bySelectorEnd('a:nth-of-type(1) > strong').text, '33kg감량풍자', 'text is compared without spaces');
    assert.equal(bySelectorEnd('body > div').image, '/banner/bg.png?v=2');
    assert.equal(anchors.find((anchor) => anchor.text === '숨김'), undefined, 'invisible elements are not anchors');
    assert.ok(anchors.some((anchor) => anchor.selector.endsWith('svg > rect')));
    assert.match(firstImage.htmlSnippet, /^<img [^>]*src="\/thumb\/1\.jpg\?type=f"/);
    assert.equal(firstImage.x, 0);
    assert.ok(firstImage.width === 80 && firstImage.height === 60);
  } finally {
    await browser.close();
  }
});

test('the rule scan writes the anchors next to the CV capture', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-anchors-test-'));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`, path.join(directory, 'result.json'), {
      settleMs: 0, contentGraceMs: 0, compareLoad: false,
      cvScreenshotPath: path.join(directory, 'capture.png'),
    });
    const anchors = JSON.parse(fs.readFileSync(path.join(directory, 'result_cv_anchors.json'), 'utf8'));
    assert.ok(anchors.some((anchor) => anchor.image === '/thumb/1.jpg?type=f'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
