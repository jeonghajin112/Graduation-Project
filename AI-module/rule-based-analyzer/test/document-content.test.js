'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TargetPageUnavailableError, run } = require('../run');

const html = (title, body) =>
  `<!doctype html><html lang="ko"><head><title>${title}</title></head><body>${body}</body></html>`;

const pages = {
  // The saved HTML in the reported failure had only head metadata.
  '/head-only': [200, '<!doctype html><html lang="ko"><head><title>제목만 있는 문서</title><meta name="description" content="설정"></head></html>'],
  '/late-body': [200, html('늦게 채워지는 본문', `<script>setTimeout(() => {
      document.body.insertAdjacentHTML('beforeend', '<main><h1>늦게 도착한 본문</h1><p>본문 내용이 스크립트로 채워졌습니다.</p></main>');
    }, 1200);</script>`)],
  '/image-only': [200, html('이미지 페이지',
    '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="120" height="80">')],
  '/maintenance': [503, html('서비스 점검 중',
    '<main><h1>서비스 점검 안내</h1><p>현재 시스템 점검으로 서비스를 이용할 수 없습니다. 잠시 후 다시 이용해 주세요.</p></main>')],
  '/not-found': [404, html('페이지를 찾을 수 없습니다',
    '<main><h1>404</h1><p>요청하신 페이지를 찾을 수 없습니다. 주소를 다시 확인해 주세요.</p></main>')],
  // A security check that keeps the original URL and HTTP 200.
  '/challenge': [200, `<!doctype html><html lang="en"><head><title>Verify you are human</title></head><body>
    <main><h1>Verify you are human</h1><p>Automated access detected. Complete the CAPTCHA security check to continue.</p></main></body></html>`],
  // Cloudflare's interstitial keeps the original URL and HTTP 200.
  '/cloudflare-wait': [200, `<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body>
    <main><h1>www.example.go.kr</h1><p>Checking if the site connection is secure</p>
    <p>www.example.go.kr needs to review the security of your connection before proceeding.</p></main></body></html>`],
  // A Korean block notice that keeps the original URL.
  '/korean-deny': [200, html('접근 차단 안내',
    '<main><h1>접근 차단 안내</h1><p>비정상적인 경로로 접속하여 접근이 차단되었습니다. 관리자에게 문의하세요.</p></main>')],
  // A normal page that embeds a CAPTCHA field keeps its own content and links.
  '/login-with-captcha': [200, html('회원 로그인', `<header><nav>
      <a href="/">홈</a><a href="/notice">공지사항</a><a href="/help">도움말</a><a href="/join">회원가입</a><a href="/find">아이디 찾기</a>
    </nav></header><main><h1>로그인</h1><form><label>아이디 <input name="id"></label><label>비밀번호 <input type="password"></label>
    <p>자동 가입 방지를 위해 보안 확인 문자를 입력해 주세요. Security check: I'm not a robot.</p>
    <label>보안 문자 <input name="captcha"></label><button>로그인</button></form></main>`)],
  // Web-component page: every visible element is inside an open shadow root.
  '/shadow': [200, html('웹 컴포넌트', `<app-root></app-root><script>
      const root = document.querySelector('app-root').attachShadow({ mode: 'open' });
      root.innerHTML = '<main><h1>웹 컴포넌트 페이지</h1><p>그림자 DOM 안에 본문과 버튼이 있습니다.</p><button>신청하기</button></main>';
    </script>`)],
};

async function withServer(callback) {
  const server = http.createServer((request, response) => {
    const [status, body] = pages[request.url] ?? [404, 'not found'];
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-content-test-'));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, directory);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function expectUnavailable(route, options) {
  let marker = null;
  await withServer(async (origin, directory) => {
    const output = path.join(directory, 'result.json');
    await assert.rejects(
      run(`${origin}${route}`, output, { settleMs: 0, ...options }),
      (error) => error instanceof TargetPageUnavailableError,
    );
    marker = readJson(path.join(directory, 'result_api.json'));
    assert.equal(marker.metadata.url, `${origin}${route}`);
    assert.equal(marker.score, undefined, 'the marker must not carry a score');
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(path.join(directory, 'result.html')), false);
  });
  return marker.metadata.document_health;
}

async function expectScored(route, options) {
  let api = null;
  await withServer(async (origin, directory) => {
    await run(`${origin}${route}`, path.join(directory, 'result.json'), { settleMs: 0, ...options });
    api = readJson(path.join(directory, 'result_api.json'));
    assert.equal(typeof api.score.score, 'number');
    api.html = fs.readFileSync(path.join(directory, 'result.html'), 'utf8');
  });
  return api;
}

test('does not score a document whose body never arrived', async () => {
  assert.deepEqual(await expectUnavailable('/head-only', { contentGraceMs: 300 }), {
    status: 'EMPTY', http_status: 200, has_body: true, visible_text_length: 0, visible_content_count: 0,
  });
});

test('reports HTTP error pages as unavailable without waiting for content', async () => {
  // A long grace period would dominate the run time if it were applied.
  const started = Date.now();
  const maintenance = await expectUnavailable('/maintenance', { contentGraceMs: 60000 });
  assert.ok(Date.now() - started < 30000, 'an HTTP error is final and skips the content grace period');
  assert.equal(maintenance.status, 'HTTP_ERROR');
  assert.equal(maintenance.http_status, 503);
  assert.ok(maintenance.visible_text_length > 20, 'the error page has content but is still rejected');
  assert.equal((await expectUnavailable('/not-found', { contentGraceMs: 0 })).http_status, 404);
});

test('reports a same-origin security check as blocked', async () => {
  const health = await expectUnavailable('/challenge', { contentGraceMs: 0 });
  assert.equal(health.status, 'BLOCKED');
  assert.equal(health.http_status, 200);
});

test('reports a Cloudflare wait page and a Korean block notice as blocked', async () => {
  assert.equal((await expectUnavailable('/cloudflare-wait', { contentGraceMs: 0 })).status, 'BLOCKED');
  assert.equal((await expectUnavailable('/korean-deny', { contentGraceMs: 0 })).status, 'BLOCKED');
});

test('still scores a normal page that embeds a CAPTCHA field', async () => {
  const api = await expectScored('/login-with-captcha', { contentGraceMs: 0 });
  assert.equal(api.metadata.document_health.status, 'MEANINGFUL');
});

test('waits for a body that streams in after load before scanning', async () => {
  const api = await expectScored('/late-body', { contentGraceMs: 5000 });
  assert.equal(api.metadata.document_health.status, 'MEANINGFUL');
  assert.ok(api.metadata.document_health.visible_text_length >= 20);
  assert.match(api.html, /늦게 도착한 본문/);
});

test('treats visible media without text as analyzable content', async () => {
  const api = await expectScored('/image-only', { contentGraceMs: 0 });
  assert.equal(api.metadata.document_health.status, 'MEANINGFUL');
  assert.equal(api.metadata.document_health.visible_content_count, 1);
  // The unlabeled image is still reported as a violation.
  assert.ok(api.violations.some((violation) => violation.kwcag_id === '5.1.1'));
});

test('measures content inside open shadow roots', async () => {
  const api = await expectScored('/shadow', { contentGraceMs: 0 });
  assert.equal(api.metadata.document_health.status, 'MEANINGFUL');
  assert.ok(api.metadata.document_health.visible_text_length >= 20);
  assert.equal(api.metadata.document_health.visible_content_count, 1);
});
