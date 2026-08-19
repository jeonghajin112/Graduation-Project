/**
 * ============================================================================
 *  run.js — KWCAG 접근성 검사 실행기 (규칙 기반 분석 모듈의 진입점)
 * ============================================================================
 *
 * [파일 역할]
 *   사용자가 입력한 URL 하나에 대해 전체 규칙 기반 접근성 검사를 수행하는
 *   최상위 오케스트레이터. 브라우저를 띄워 페이지를 렌더링하고, axe-core로
 *   접근성 검사를 돌린 뒤, KWCAG(한국형 웹 콘텐츠 접근성 지침) 기준으로 변환·
 *   점수화하여 JSON 파일로 저장. 동시에 AI 분석 모듈이 사용할 수 있도록
 *   렌더링된 HTML도 함께 저장(문장 난이도 분석에 사용)
 *
 * [전체 파이프라인에서의 위치]
 *   [이 파일] ─ 규칙 기반 모듈 (axe-core + KWCAG 매핑 + 점수화)
 *             ├─ 출력 1: result.json          (디버깅용, 내부 형식)
 *             ├─ 출력 2: result_api.json      (백엔드 전송용, API 스펙 형식)
 *             ├─ 출력 3: result.html          (정적 DOM replay)
 *             └─ 출력 4: result_artifact.json (DOM replay 메타데이터)
 *                          │
 *                          ▼
 *                   text_extractor.py → difficulty_engine.py → suggestion_generator.py
 *                   (AI 분석 모듈 — 별도 파이프라인)
 *
 * [사용법]
 *   node run.js <URL> [출력파일.json]
 *   예: node run.js https://www.gov.kr result.json
 *
 * [처리 흐름]
 *   URL 입력
 *     → Playwright로 헤드리스 브라우저 실행 및 페이지 로딩
 *     → axe-core 실행 (WCAG 2.0/2.1/2.2 규칙 기반 검사)
 *     → 동일한 일시정지 DOM의 script-free replay HTML/메타데이터 저장
 *     → adapter.convert() : axe 결과를 KWCAG 33개 항목 기준으로 재분류
 *     → scorer.score()    : 100점 감점 방식으로 점수 산출
 *     → toApiFormat()     : 백엔드 API 스펙(snake_case)으로 변환
 *     → JSON 저장 + (선택) 백엔드 전송
 *
 * [설계상 주의점]
 *   - Playwright 인스턴스를 run.js 한 곳에서만 띄움
 *     → 규칙 기반 모듈과 AI 모듈이 각자 브라우저를 띄우면 리소스 낭비가 크고,
 *        동적 렌더링 시점이 달라 데이터 일관성도 깨짐. 따라서 이 파일에서
 *        "렌더링된 최종 DOM"을 HTML 파일로 떨어뜨려 두고, AI 모듈은 그 파일을
 *        소비하는 방식으로 역할을 분리함.
 *   - axe-core는 "외부 라이브러리"가 아니라 "로컬 라이브러리"로 취급
 *     → 네트워크 호출이 아니라 Node 모듈로 import해서 쓰므로, 동일 입력에
 *        동일 출력이 보장되고 실험 재현성이 있음.
 * ============================================================================
 */

const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { convert } = require('./adapter');  // axe 결과 → KWCAG 33개 항목 기준으로 재분류
const { score } = require('./scorer');     // KWCAG 결과 → 100점 감점 방식 점수화
const {
  buildDomReplayArtifactMetadata,
  pauseDocumentAnimations,
  pausePageVirtualTime,
  revalidateAxeLocators,
  serializeDomReplayHtml,
} = require('./artifact');
const { analyzeWithCarouselStates } = require('./carousel-audit');
const fs = require('fs');
const path = require('path');

const MAX_INITIAL_RESPONSE_HTML_BYTES = 10 * 1024 * 1024;
const INITIAL_RESPONSE_CAPTURE_TIMEOUT_MS = 10000;

function siblingOutputPath(outputPath, suffix) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}${suffix}`);
}

function urlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function challengeSignals({ url = '', title = '', text = '', html = '' }) {
  let decodedUrl = url;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    // A malformed escape sequence must not broaden fallback detection.
  }

  const signals = [];
  const urlPatterns = [
    ['AUTOMATION_REASON', /[?&](?:atn|reason)=(?:selenium|webdriver|automation|bot)(?:[&#]|$)/i],
    ['CHALLENGE_URL', /(?:captcha|botmanager|stclab|security[-_/]?check|browser[-_/]?check|challenge)/i],
  ];
  for (const [name, pattern] of urlPatterns) {
    if (pattern.test(decodedUrl)) signals.push(name);
  }

  const documentText = `${title}\n${text}\n${html}`.slice(0, 50000);
  const documentPatterns = [
    ['STCLAB', /stclab|botmanager/i],
    ['CAPTCHA', /hcaptcha|recaptcha|turnstile|captcha/i],
    ['WEBDRIVER', /navigator\.webdriver|atn\s*[=:]\s*["']?selenium|webdriver detected/i],
    ['SECURITY_CHECK', /verify (?:that )?you are human|security (?:verification|check)|automated (?:access|browser|traffic)/i],
  ];
  for (const [name, pattern] of documentPatterns) {
    if (pattern.test(documentText)) signals.push(name);
  }
  return [...new Set(signals)];
}

async function detectCrossOriginBotChallenge(page, initialUrl) {
  const currentUrl = page.url();
  const initialOrigin = urlOrigin(initialUrl);
  const currentOrigin = urlOrigin(currentUrl);
  const crossOrigin = Boolean(
    initialOrigin && currentOrigin && initialOrigin !== currentOrigin,
  );
  if (!crossOrigin) {
    return { detected: false, currentUrl, signals: [] };
  }

  const state = await page.evaluate(() => ({
    title: document.title || '',
    text: (document.body?.innerText || '').slice(0, 20000),
    html: (document.documentElement?.outerHTML || '').slice(0, 30000),
  })).catch(() => ({ title: '', text: '', html: '' }));
  const signals = challengeSignals({ url: currentUrl, ...state });
  const strongSignals = new Set(['AUTOMATION_REASON', 'STCLAB', 'CAPTCHA', 'WEBDRIVER']);
  return {
    detected: signals.some(signal => strongSignals.has(signal)) || signals.length >= 2,
    currentUrl,
    signals,
  };
}

function usableInitialHtml(snapshot) {
  return Boolean(
    snapshot
      && snapshot.status >= 200
      && snapshot.status < 300
      && /(?:text\/html|application\/xhtml\+xml)/i.test(snapshot.contentType || '')
      && typeof snapshot.html === 'string'
      && snapshot.html.trim().length >= 100,
  );
}

function captureInitialMainResponse(page) {
  let snapshotPromise = null;
  const onResponse = response => {
    if (snapshotPromise) return;
    try {
      const request = response.request();
      const contentType = response.headers()['content-type'] || '';
      if (!request.isNavigationRequest()
          || request.frame() !== page.mainFrame()
          || response.status() < 200
          || response.status() >= 300
          || !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
        return;
      }
      // Begin consuming the body as soon as response headers arrive. Waiting
      // until page.goto() settles can lose the body when client JS immediately
      // replaces the main document with a challenge page.
      snapshotPromise = response.body()
        .then(body => {
          if (body.length > MAX_INITIAL_RESPONSE_HTML_BYTES) {
            return null;
          }
          const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] || 'utf-8';
          let html;
          try {
            html = new TextDecoder(charset).decode(body);
          } catch {
            html = body.toString('utf8');
          }
          return {
            url: response.url(),
            status: response.status(),
            contentType,
            html,
          };
        })
        .catch(() => null);
    } catch {
      // Ignore non-standard/closing responses and retain the first valid one.
    }
  };
  page.on('response', onResponse);

  return {
    async value() {
      if (!snapshotPromise) return null;
      return new Promise(resolve => {
        const timer = setTimeout(
          () => resolve(null),
          INITIAL_RESPONSE_CAPTURE_TIMEOUT_MS,
        );
        snapshotPromise.then(value => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    stop() {
      page.off('response', onResponse);
    },
  };
}

async function loadStaticInitialResponseFallback(page, snapshot) {
  const staticHtml = await serializeDomReplayHtml(page, {
    baseUrl: snapshot.url,
    sourceHtml: snapshot.html,
    sourceMode: 'INITIAL_RESPONSE_STATIC',
  });

  // Defense in depth: the serialized clone has no executable elements or
  // handlers, and all script requests are also blocked during fallback analysis.
  await page.route('**/*', route => {
    if (route.request().resourceType() === 'script') {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await page.goto('about:blank', { waitUntil: 'load', timeout: 10000 });
  await page.setContent(staticHtml, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
//  백엔드 서버 설정
// ─────────────────────────────────────────────────────────────────────────────
//  현재는 벡엔드의 Spring Boot 서버가 아직 배포되지 않은 상태이므로
//  로컬 주소를 placeholder로 둠. 서버 배포 후 실제 주소로 교체 예정.
//  참고: 이 주소로 전송이 실패해도 파이프라인 전체는 중단되지 않고 로컬 JSON
//  저장까지는 정상 수행되도록 sendToBackend()가 예외를 삼킴(아래 참조).
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE_URL = 'http://localhost:8080/api/v1';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  toApiFormat(kwcagResult, scoreResult)
 * ─────────────────────────────────────────────────────────────────────────
 *  adapter.convert() 결과와 scorer.score() 결과를 받아,
 *  백엔드 API 스펙(snake_case, v1)에 맞는 단일 JSON으로 병합한다.
 *
 *  [왜 이런 변환이 필요한가 — 설계 의도]
 *    내부 모듈(adapter, scorer)은 JavaScript 관례에 따라 camelCase를 씀.
 *    하지만 백엔드(Spring Boot/Java)와 주고받을 API 스펙은 snake_case로
 *    통일되어 있음. "모듈 내부 표현"과 "외부 공개 인터페이스"를 분리함으로써
 *    내부 리팩터링이 API 호환성을 깨지 않게 함과 동시에 toApiFormat은 이
 *    파일에서만 호출되는 얇은 변환 계층이라 유지보수 비용이 낮음.
 *
 *  [입력 스키마]
 *    kwcagResult (from adapter.js):
 *      - kwcag: { '5.1.1': { name, violations[], passes[], violationCount, ... }, ... }
 *          → KWCAG 33개 항목(예: 5.1.1 = 대체 텍스트 제공) 기준으로 재분류된 결과
 *      - unmapped: { violations[], passes[] }
 *          → KWCAG에 매핑 불가한 axe 규칙(예: WCAG 2.2 신규 항목 등). 버리지 않고
 *            "추가 참고" 섹션으로 보존 — 발표에서 "우리는 axe가 찾은 모든 위반을
 *            감추지 않는다"는 투명성 근거가 됨.
 *      - summary: { totalViolations, totalPasses, kwcagViolations, ... }
 *      - meta: { url, timestamp, engine, engineVersion, adapterVersion }
 *
 *    scoreResult (from scorer.js):
 *      - score, maxScore, totalDeduction, grade
 *      - severityBreakdown: { critical, major, minor } — 심각도별 감점 집계
 *      - items: KWCAG 항목별 점수 상세 (weight, weightMultiplier 포함)
 *
 *  [출력 스키마]
 *    이 함수의 반환값이 그대로 result_api.json 및 백엔드 POST body가 됨.
 *    최상위 키(analyzer_type, summary, violations, passes, unmapped_violations,
 *    score, metadata) 구조는 v1 API 스펙 문서에 정의되어 있음.
 * ─────────────────────────────────────────────────────────────────────────
 */
function toApiFormat(kwcagResult, scoreResult) {
  // ── 1) violations: KWCAG 항목별로 그룹화 ──
  //    위반이 0건인 항목은 제외(noise 감소). 각 위반은 axe 규칙 단위로 묶이고,
  //    그 안에 실제 위반 DOM 노드들이 nodes[]로 들어감.
  const violations = [];
  for (const [kwcagId, item] of Object.entries(kwcagResult.kwcag)) {
    if (item.violationCount === 0) continue;

    violations.push({
      kwcag_id: kwcagId,
      kwcag_name: item.name,
      // severity는 scorer에서 계산한 값을 재사용(항목별 고정 심각도).
      // scorer가 분류 실패한 경우 'minor'로 fallback — 점수 계산은 되지만
      // 가장 가벼운 등급으로 보수적 처리.
      severity: scoreResult.items[kwcagId]?.severity || 'minor',
      violation_count: item.violationCount,
      rules: item.violations.map(v => ({
        axe_rule_id: v.axeRuleId,
        description: v.description,
        help: v.help,
        impact: v.impact,
        nodes: v.nodes.map(n => ({
          selector: n.selector,        // CSS 셀렉터: 프론트엔드가 해당 요소 하이라이트할 때 사용
          html: n.html,                // 위반 요소의 outerHTML: 수정 가이드 생성 시 참조
          failure_summary: n.failureSummary,  // axe가 제공하는 "왜 위반인지" 자연어 설명
          locator: n.locator || null,  // 프레임/Shadow DOM 경계와 문서 좌표를 보존한 typed locator
        })),
      })),
    });
  }

  // ── 2) passes: KWCAG 항목별로 그룹화 ──
  //    통과 항목도 저장하는 이유: 대시보드에서 "이 사이트는 X개 기준을 충족했다"
  //    라는 긍정 지표를 보여주기 위함. 접근성 개선의 동기 부여가 목적.
  //    (계획서 §4 "정량화된 점수 … 접근성 개선의 필요성·동기 제공").
  const passes = [];
  for (const [kwcagId, item] of Object.entries(kwcagResult.kwcag)) {
    if (item.passCount === 0) continue;

    passes.push({
      kwcag_id: kwcagId,
      kwcag_name: item.name,
      pass_count: item.passCount,
      rules: item.passes.map(p => ({
        axe_rule_id: p.axeRuleId,
        description: p.description,
        node_count: p.nodeCount,
      })),
    });
  }

  // ── 3) unmapped_violations: KWCAG 33개 항목에 매핑되지 않은 axe 위반 ──
  //    예: axe-core는 WCAG 2.2에 새로 추가된 항목도 검사하는데, KWCAG는
  //    2.1 기반 항목이 중심이라 매핑이 없는 경우가 생김. 이를 버리지 않고
  //    "참고 정보"로 노출해서 향후 KWCAG 확장 시 바로 편입할 수 있도록 함.
  const unmappedViolations = kwcagResult.unmapped.violations.map(v => ({
    axe_rule_id: v.axeRuleId,
    description: v.description,
    impact: v.impact,
    wcag_reference: v.wcagReference || 'WCAG 기준 미확인',
    node_count: (v.nodes || []).length,
  }));

  // ── 4) score: scorer 결과의 camelCase를 snake_case로 변환 ──
  //    단순 키 이름 변환이지만, 계층 구조(severityBreakdown, items 등)가 있어
  //    손으로 한 번 펼쳐서 매핑함. Object.entries + reduce로 일반화하는 것도
  //    가능하지만, 명시적 매핑이 스펙 변경 시 더 안전하고 diff가 읽기 쉬움.
  const scoreData = {
    score: scoreResult.score,
    max_score: scoreResult.maxScore,
    total_deduction: scoreResult.totalDeduction,
    grade: scoreResult.grade,
    severity_breakdown: {
      critical: {
        count: scoreResult.severityBreakdown.critical.count,
        deduction_per_node: scoreResult.severityBreakdown.critical.deductionPerNode,
        total_deduction: scoreResult.severityBreakdown.critical.totalDeduction,
      },
      major: {
        count: scoreResult.severityBreakdown.major.count,
        deduction_per_node: scoreResult.severityBreakdown.major.deductionPerNode,
        total_deduction: scoreResult.severityBreakdown.major.totalDeduction,
      },
      minor: {
        count: scoreResult.severityBreakdown.minor.count,
        deduction_per_node: scoreResult.severityBreakdown.minor.deductionPerNode,
        total_deduction: scoreResult.severityBreakdown.minor.totalDeduction,
      },
    },
    items: {},
  };

  // items: KWCAG 항목별 점수 상세도 snake_case 변환
  // ※ weight, weight_multiplier 필드 포함 (scorer.js에서 가중치 배수 적용)
  for (const [kwcagId, item] of Object.entries(scoreResult.items)) {
    scoreData.items[kwcagId] = {
      name: item.name,
      severity: item.severity,
      weight: item.weight,                      // 가중치 등급 (high/medium/low)
      weight_multiplier: item.weightMultiplier,  // 가중치 배수 (1.5/1.0/0.5)
      deduction_per_node: item.deductionPerNode,
      violation_count: item.violationCount,
      rule_count: item.ruleCount,
      pass_count: item.passCount,
      deduction: item.deduction,
    };
  }

  // ── 5) 최종 API 스펙 JSON 조립 ──
  //    analyzer_type: 'RULE_BASED' — 백엔드가 AI/CV 분석 결과와 구분하기 위한
  //    필드. v2 스펙에서는 여기에 'AI_NLP', 'COMPUTER_VISION'이 추가될 예정.
  return {
    analyzer_type: 'RULE_BASED',
    summary: {
      total_violations: kwcagResult.summary.totalViolations,
      total_passes: kwcagResult.summary.totalPasses,
      kwcag_violations: kwcagResult.summary.kwcagViolations,
      kwcag_passes: kwcagResult.summary.kwcagPasses,
      unmapped_violations: kwcagResult.summary.unmappedViolations,
      unmapped_passes: kwcagResult.summary.unmappedPasses,
    },
    violations,
    passes,
    unmapped_violations: unmappedViolations,
    score: scoreData,
    metadata: {
      url: kwcagResult.meta.url,
      engine: kwcagResult.meta.engine,
      engine_version: kwcagResult.meta.engineVersion,
      adapter_version: kwcagResult.meta.adapterVersion,
      scan_duration_ms: null,  // 여기서는 채우지 않음 — run() 본문에서 실제 측정값으로 덮어씀
      timestamp: kwcagResult.meta.timestamp,
    },
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  sendToBackend(requestId, apiData)
 * ─────────────────────────────────────────────────────────────────────────
 *  분석 결과를 백엔드 Spring Boot 서버로 POST 전송한다.
 *
 *  [왜 try/catch로 감싸서 예외를 "삼키는가"]
 *    중간발표 시점에는 백엔드가 아직 개발 중이라, 서버가 내려가 있어도 규칙
 *    기반 모듈 자체는 독립적으로 결과를 낼 수 있어야 한다. 네트워크 오류로
 *    인해 전체 파이프라인이 실패하면 데모·테스트가 막히므로, 실패를 조용히
 *    로그로만 남기고 로컬 JSON 저장은 계속 진행하게 설계했다.
 *    통합 단계(Phase 4)에서는 실패 시 재시도·큐잉 로직을 추가할 예정.
 *
 *  [엔드포인트 명명 규칙]
 *    /evaluations/{requestId}/analysis/rule-based
 *    → 하나의 "평가 요청(requestId)" 아래에 rule-based / ai-nlp / cv 세 개의
 *       분석 결과가 병렬로 POST되는 구조. 백엔드가 세 결과를 합쳐 대시보드를
 *       구성한다.
 * ─────────────────────────────────────────────────────────────────────────
 */
async function sendToBackend(requestId, apiData) {
  const url = `${API_BASE_URL}/evaluations/${requestId}/analysis/rule-based`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiData),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`   백엔드 전송 성공 (analysis_id: ${result.analysis_id})`);
      return result;
    } else {
      // 4xx/5xx: 서버는 살아있지만 거부한 경우 (스펙 불일치 등)
      console.log(`    백엔드 전송 실패 (HTTP ${response.status})`);
      return null;
    }
  } catch (err) {
    // 네트워크 오류: 서버 자체가 접근 불가
    console.log(`    백엔드 서버 연결 불가 (${API_BASE_URL})`);
    console.log('      → 로컬 JSON 파일로만 저장됩니다.');
    return null;
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  run(url, outputPath) — 메인 실행 함수
 * ─────────────────────────────────────────────────────────────────────────
 * - 전체 흐름
    1. 브라우저 실행 & 페이지 로드
    2. 교차 출처 bot challenge 여부 판정 및 제한적 정적 fallback
    3. axe-core 접근성 검사 + typed locator 해석
    4. 동일 DOM의 정적 replay HTML/메타데이터 저장
    5. 어댑터 변환 및 점수 산출
    6. API 형태/로컬 JSON 저장
    7. 콘솔 요약 출력
 * ─────────────────────────────────────────────────────────────────────────
 *  단일 URL에 대한 전체 규칙 기반 분석 파이프라인을 수행
 *
 *  [왜 헤드리스 브라우저를 쓰는가]
 *    단순 fetch로 HTML을 가져오면 JavaScript가 실행되기 전의 "비어있는 DOM"이
 *    반환됨. 특히 정부24(www.gov.kr)는 Nuxt.js(Vue 기반 SSR/CSR 혼합)로
 *    만들어져 있어서, 원본 HTML에는 <div id="__nuxt"></div>만 있고 실제
 *    콘텐츠는 JS 실행 후에야 DOM에 들어감. Playwright로 실제 브라우저
 *    환경에서 렌더링해야 "사용자가 실제로 보는 화면"을 기준으로 접근성을
 *    검사할 수 있음.
 *
 *  [왜 chromium을 선택했는가]
 *    Playwright는 chromium/firefox/webkit 세 엔진을 지원하지만,
 *    ① 공공 웹사이트의 주요 사용자층(일반 국민) 중 크롬 계열 점유율이 높아
 *       실사용 환경과 가장 일치하고,
 *    ② axe-core가 chromium 기반에서 가장 많이 테스트되어 있으며,
 *    ③ Playwright 설치 시 기본으로 포함되어 초기 설정이 간단함.
 *
 *  [왜 locale: 'ko-KR' 을 명시하는가]
 *    일부 사이트가 Accept-Language 헤더로 언어별 다른 콘텐츠를 반환.
 *    (다국어 지원 정부 사이트). 한국 사용자 기준 접근성을 평가하므로 ko-KR로
 *    강제 고정해야 결과 재현성이 확보됨.
 *
 *  [왜 뷰포트를 1280x720으로 고정하는가]
 *    반응형 웹에서 뷰포트 크기에 따라 DOM 구조와 스타일이 달라질 수 있음.
 *    데스크톱 공공 서비스의 대표값으로 1280x720을 고정 — 테스트 재현성 확보.
 *    (모바일 접근성은 추후 별도 뷰포트로 확장 예정)
 * ─────────────────────────────────────────────────────────────────────────
 */
async function run(url, outputPath, options = {}) {
  console.log(`\n검사 대상: ${url}`);
  console.log('─'.repeat(50));

  // ── 1) 브라우저 실행 & 페이지 로드 ──
  console.log('1. 브라우저 실행 중...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ko-KR',                     // 한국어 환경 강제 (Accept-Language: ko-KR)
    viewport: { width: 1280, height: 720 },  // 데스크톱 대표 해상도 고정
    deviceScaleFactor: 1,                 // 문서 CSS 좌표 재현성을 위한 고정 배율
  });
  const page = await context.newPage();
  const output = outputPath || `result_${new Date().toISOString().slice(0, 10)}.json`;
  const settleMs = Number.isFinite(options.settleMs)
    ? Math.max(0, options.settleMs)
    : 5000;
  const cvScreenshotPath = typeof options.cvScreenshotPath === 'string'
    && options.cvScreenshotPath.trim()
    ? options.cvScreenshotPath
    : null;

  try {
    console.log('2. 페이지 로딩 중...');
    // waitUntil: 'load' — 문서와 초기 종속 리소스의 load 이벤트까지 대기
    //   → 이후 고정 settle 구간에서 CSR(Vue/React 등) 초기 변경을 추가 관찰
    // timeout: 60000 (60초) — 공공 사이트 일부가 로딩이 느려 넉넉히 잡음
    let initialSnapshot = null;
    const initialResponseCapture = captureInitialMainResponse(page);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    } catch { }
    initialSnapshot = await initialResponseCapture.value();
    initialResponseCapture.stop();
    await page.waitForTimeout(settleMs);
    
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => {});

    let analysisFinalUrl = page.url();
    let replaySourceMode = 'RENDERED_DOM';
    if (initialSnapshot) {
      const challenge = await detectCrossOriginBotChallenge(page, initialSnapshot.url);
      if (challenge.detected && usableInitialHtml(initialSnapshot)) {
        console.log('   [정적 fallback] 교차 출처 봇/보안 챌린지 이동을 감지했습니다.');
        console.log(`   [정적 fallback] ${challenge.signals.join(', ')}: ${challenge.currentUrl}`);
        console.log('   [정적 fallback] 최초 2xx HTML을 스크립트 없이 재현하여 정적 DOM만 분석합니다.');
        console.log('   [정적 fallback] CAPTCHA를 우회하거나 webdriver 값을 위장하지 않습니다.');
        await loadStaticInitialResponseFallback(page, initialSnapshot);
        analysisFinalUrl = initialSnapshot.url;
        replaySourceMode = 'INITIAL_RESPONSE_STATIC';
      } else if (challenge.detected) {
        throw new Error(
          '교차 출처 봇/보안 챌린지를 감지했지만 사용할 수 있는 최초 2xx HTML을 보존하지 못했습니다.',
        );
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // Freeze CSS/Web Animations before both axe and replay serialization so the
    // reported element rectangles describe the stored DOM state.
    await pauseDocumentAnimations(page);

    // ── 3) axe-core 실행 ──
    //   withTags로 검사 범위를 명시적으로 제한
    //     wcag2a, wcag2aa   : WCAG 2.0 A/AA 등급 (국내 KWCAG의 직접 기반)
    //     wcag21a, wcag21aa : WCAG 2.1 A/AA (KWCAG 2.2가 참조하는 상위 기준)
    //     wcag22aa          : WCAG 2.2 AA (국제 최신 기준 — 추가 참고용)
    //   → KWCAG 2.2와 매핑되는 핵심 규칙을 모두 커버하되, AAA(최상위) 등급은
    //      공공 서비스의 현실적 준수 수준을 고려해 제외함.
    console.log('3. axe-core 접근성 검사 실행 중...');
    const scanStart = Date.now();
    const scanPage = () => new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const axeResults = await analyzeWithCarouselStates(page, scanPage);
    // page.setContent() intentionally uses an about:blank container in static
    // fallback mode. Keep the analyzed resource identity honest and stable.
    axeResults.url = analysisFinalUrl;
    const scanDuration = Date.now() - scanStart;  // 성능 측정용 (API metadata에 기록)
    const releaseVirtualTime = await pausePageVirtualTime(page);
    let htmlOutput;
    let artifactOutput;
    try {
      // Save a UTF-8 static replay from the same paused DOM consumed by axe and
      // the locator resolver. Scripts are removed from the stored copy so a
      // later replay cannot rerun the target application's automation checks.
      const renderedHtml = await serializeDomReplayHtml(page, {
        sourceMode: replaySourceMode,
      });
      htmlOutput = siblingOutputPath(output, '.html');
      fs.writeFileSync(htmlOutput, renderedHtml, 'utf-8');
      console.log(`4. DOM replay HTML 저장: ${htmlOutput}`);

      const artifactMetadata = await buildDomReplayArtifactMetadata(page, {
        requestedUrl: url,
        finalUrl: analysisFinalUrl,
      });
      artifactOutput = siblingOutputPath(output, '_artifact.json');
      fs.writeFileSync(artifactOutput, JSON.stringify(artifactMetadata, null, 2), 'utf-8');

      // Re-resolve after serialization. Coordinates describe the analyzed DOM
      // and are no longer clipped to a screenshot/tile boundary.
      await revalidateAxeLocators(page, axeResults);
      console.log(`5. DOM replay 메타데이터 저장: ${artifactOutput}`);

      if (cvScreenshotPath) {
        try {
          // This raster exists only as an inter-module CV input in the OS temp
          // directory. It is never metadata, replay evidence, or an upload part.
          const cvImage = await page.screenshot({
            type: 'png',
            fullPage: true,
            caret: 'hide',
            animations: 'disabled',
            scale: 'css',
            timeout: 60000,
          });
          fs.writeFileSync(cvScreenshotPath, cvImage);
          console.log(`   CV 전용 임시 이미지 생성: ${cvScreenshotPath}`);
        } catch (error) {
          console.warn(`   CV 전용 임시 이미지 생성 실패: ${error.message}`);
        }
      }
    } finally {
      await releaseVirtualTime();
    }

    // ── 5) 어댑터 변환: axe 결과 → KWCAG 33개 항목 ──
    //   axe-core는 WCAG 기준의 영어 결과를 반환하므로, 이를 KWCAG 2.2의 한국
    //   항목 번호 체계(예: 5.1.1 "대체 텍스트 제공")로 재분류해야 발표·대시보드
    //   에서 의미가 전달된다. adapter.js의 mapping.js가 이 매핑을 담당.
    console.log('6. KWCAG 매핑 변환 중...');
    const kwcagResult = convert(axeResults);
    kwcagResult.meta.captureMode = 'DOM_REPLAY';
    kwcagResult.meta.replaySource = replaySourceMode;
    kwcagResult.meta.carouselAudit = axeResults.carouselAudit;

    // ── 6) 점수화 ──
    //   scorer.js: 100점 만점에서 심각도 × 가중치 배수로 감점.
    //   감점 공식: severity 기본 감점 × weight 배수 × 위반 노드 수
    //   점수는 "개선 필요성의 상대적 강도"를 전달하기 위한 신호이지,
    //   학술적으로 정교한 지수는 아님 — 발표에서도 이 한계를 선제적으로 명시.
    console.log('7. 점수 산출 중...');
    const scoreResult = score(kwcagResult);

    // ── 7) API 스펙 형태로 변환 ──
    console.log('8. API 형태로 변환 중...');
    const apiData = toApiFormat(kwcagResult, scoreResult);
    apiData.metadata.scan_duration_ms = scanDuration;  // placeholder를 실측값으로 덮어쓰기

    // ── 8) 로컬 JSON 저장 ──
    //   두 종류를 모두 저장:
    //   ① 내부 형식 (kwcagResult + score 병합) — 개발·디버깅용, camelCase
    //   ② API 스펙 형식 (apiData) — 백엔드 전송용, snake_case
    //   병렬 저장의 이유: 문제 발생 시 어느 단계에서 틀어졌는지 원본/변환
    //   결과를 모두 확인할 수 있어야 함.
    kwcagResult.score = scoreResult;  // 내부 형식에 score를 덧붙여 단일 객체로 묶음
    fs.writeFileSync(output, JSON.stringify(kwcagResult, null, 2), 'utf-8');

    // API 스펙 형식은 _api 접미사를 붙인 별도 파일로 저장
    const apiOutput = siblingOutputPath(output, '_api.json');
    fs.writeFileSync(apiOutput, JSON.stringify(apiData, null, 2), 'utf-8');

    // ── 8) 백엔드 전송 시도 (현재는 비활성화) ──
    //   TODO: request_id는 백엔드가 평가 요청 생성 시 먼저 발급해야 하는 값.
    //   현재 Phase 1 단계에서는 백엔드가 미완성이므로 주석 처리.
    //   Phase 4(통합)에서 실제 requestId를 받아 활성화할 예정.
    // await sendToBackend(requestId, apiData);

    // ── 9) 콘솔 요약 출력 (사람이 읽기 위한 것) ──
    //   JSON 파일만으로는 테스트 중 한눈에 상태 파악이 어려워, 핵심 지표를
    //   구분선과 함께 출력. 발표 시연에서도 이 콘솔 출력을 그대로 보여줄 수 있음.
    console.log('─'.repeat(50));
    console.log('검사 결과 요약');
    console.log('─'.repeat(50));
    console.log(`  URL: ${kwcagResult.meta.url}`);
    console.log(`  엔진: ${kwcagResult.meta.engine} v${kwcagResult.meta.engineVersion}`);
    console.log(`  스캔 소요: ${scanDuration}ms`);
    console.log('');

    // 점수 & 등급 출력
    console.log(`   접근성 점수: ${scoreResult.score} / ${scoreResult.maxScore}점 (등급: ${scoreResult.grade})`);
    console.log(`    총 감점: -${scoreResult.totalDeduction}점`);
    console.log('');

    // 심각도별 감점 내역
    // ※ weight 배수가 항목마다 다르므로, "N건 × M점"이 아니라
    //    심각도별 총 감점을 직접 표시 (정확한 값은 scorer가 이미 계산해 둠)
    const sb = scoreResult.severityBreakdown;
    if (sb.critical.count > 0) {
      console.log(`    Critical: ${sb.critical.count}건, 총 감점 -${sb.critical.totalDeduction}점 (기본 ${sb.critical.deductionPerNode}점 × 항목별 가중치 적용)`);
    }
    if (sb.major.count > 0) {
      console.log(`    Major:    ${sb.major.count}건, 총 감점 -${sb.major.totalDeduction}점 (기본 ${sb.major.deductionPerNode}점 × 항목별 가중치 적용)`);
    }
    if (sb.minor.count > 0) {
      console.log(`    Minor:    ${sb.minor.count}건, 총 감점 -${sb.minor.totalDeduction}점 (기본 ${sb.minor.deductionPerNode}점 × 항목별 가중치 적용)`);
    }
    console.log('');

    // 전체 위반/통과 집계
    console.log(`  전체 위반: ${kwcagResult.summary.totalViolations}개 요소`);
    console.log(`  전체 통과: ${kwcagResult.summary.totalPasses}개 요소`);
    console.log(`  KWCAG 매핑 위반: ${kwcagResult.summary.kwcagViolations}개 요소`);
    console.log(`  추가 참고 위반: ${kwcagResult.summary.unmappedViolations}개 요소`);
    console.log('');

    // KWCAG 항목별 위반 출력 (위반 건수 많은 순으로 정렬)
    //   발표에서 "이 사이트는 어떤 항목이 특히 취약한가"를 한눈에 보여주기 위함.
    //   가중치(weight) 정보도 함께 표시하여 감점 근거를 명확히 함.
    const violatedItems = Object.entries(kwcagResult.kwcag)
      .filter(([, item]) => item.violationCount > 0)
      .sort((a, b) => b[1].violationCount - a[1].violationCount);

    if (violatedItems.length > 0) {
      console.log('  위반 항목:');
      for (const [id, item] of violatedItems) {
        const itemScore = scoreResult.items[id];
        const sev = itemScore?.severity || '?';
        const wt = itemScore?.weight || '?';
        const ded = itemScore?.deduction || 0;
        console.log(`    [${sev.toUpperCase()}×${wt}] ${id} ${item.name}: ${item.violationCount}건 (-${ded}점)`);
      }
    } else {
      console.log('  KWCAG 매핑 항목에서 위반 없음');
    }

    // unmapped 위반 출력 (KWCAG에 매핑되지 않지만 axe가 발견한 위반)
    //   감추지 않고 노출하는 이유: 투명성 + 향후 KWCAG 확장 시 반영 가능.
    if (kwcagResult.unmapped.violations.length > 0) {
      console.log('');
      console.log('  추가 참고 (KWCAG 미매핑):');
      for (const v of kwcagResult.unmapped.violations) {
        const nodeCount = v.nodes ? v.nodes.length : 0;
        console.log(`    [${v.impact}] ${v.axeRuleId}: ${nodeCount}건 - ${v.help}`);
      }
    }

    console.log('');
    console.log(`결과 저장: ${path.resolve(output)}`);
    console.log(`API 형태: ${path.resolve(apiOutput)}`);
    console.log(`DOM replay HTML: ${path.resolve(htmlOutput)}`);
    console.log(`DOM replay 메타데이터: ${path.resolve(artifactOutput)}`);
    console.log('─'.repeat(50));

    return kwcagResult;
  } catch (err) {
    // 페이지 로딩 실패, axe 실행 오류 등 — 메시지만 출력하고 상위로 재throw
    // (CLI 진입부에서 exit code 1로 종료)
    console.error('검사 중 오류 발생:', err.message);
    throw err;
  } finally {
    // finally 블록: try 안에서 어떤 에러가 나도 브라우저 프로세스는 반드시 종료.
    // 이게 없으면 chromium 프로세스가 좀비로 남아 메모리를 계속 점유함.
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLI 진입부
// ─────────────────────────────────────────────────────────────────────────────
//  process.argv 구조: [node 실행파일, run.js 경로, ...사용자 인자]
//  slice(2)로 사용자 인자만 남김.
//  인자가 없으면 사용법을 안내하고 exit code 1로 종료.
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('사용법: node run.js <URL> [출력파일.json]');
    console.log('예시:   node run.js https://www.gov.kr result.json');
    process.exit(1);
  }

  // run()이 실패하면 exit code 1로 종료 (CI나 쉘 스크립트가 에러를 감지할 수 있도록)
  const cvScreenshotIndex = args.indexOf('--cv-screenshot');
  const cvScreenshotPath = cvScreenshotIndex >= 0
    ? args[cvScreenshotIndex + 1]
    : null;
  const outputArgument = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  run(args[0], outputArgument, { cvScreenshotPath }).catch(() => process.exit(1));
}

module.exports = {
  challengeSignals,
  detectCrossOriginBotChallenge,
  loadStaticInitialResponseFallback,
  run,
  siblingOutputPath,
  toApiFormat,
  usableInitialHtml,
};
