/**
 * ============================================================
 *  KWCAG 어댑터 (adapter.js)
 *  axe-core 검사 결과(JSON) → KWCAG 2.2 기준 분류 결과(JSON)
 * ============================================================
 *
 * [파일 목적]
 *   axe-core는 국제 표준인 WCAG 기준으로 검사 결과를 출력하지만,
 *   본 프로젝트는 한국형 웹 접근성 지침(KWCAG 2.2) 기준으로 평가해야 함.
 *   이 파일은 axe-core의 결과를 KWCAG 2.2의 33개 검사항목 기준으로
 *   재분류하는 "변환기(어댑터)" 역할을 하게 됨.
 *
 * [왜 어댑터 패턴인가?]
 *   axe-core를 직접 수정하지 않고, 중간에 어댑터 레이어를 두어 변환.
 *   이렇게 하면 나중에 axe-core를 다른 검사 엔진으로 교체하더라도
 *   이 어댑터만 수정하면 되므로, 나머지 파이프라인(scorer.js, 백엔드 등)에
 *   영향을 주지 않음. 
 *
 * [변환 흐름 - 2단계 매핑 (Two-stage Resolution)]
 *   axe-core가 위반(violation)을 발견하면, 다음 순서로 KWCAG 항목을 찾음.
 *
 *   1단계 - 직접 매핑 (axeRuleToKwcag 사용):
 *       axe-core 규칙 ID로 KWCAG 번호를 직접 찾음 (정밀도 높음)
 *       예: 'image-alt' → KWCAG '5.1.1'
 *
 *   2단계 - WCAG 태그 기반 폴백 (wcagToKwcag 사용):
 *       1단계에서 못 찾은 경우, axe-core 결과에 포함된 WCAG 태그 번호로
 *       KWCAG 항목을 찾음 (재현율 우선, 정밀도는 1단계보다 낮음)
 *       예: WCAG 태그 'wcag412' → WCAG '4.1.2' → KWCAG '8.1.1', '8.2.1'
 *
 *   매핑 불가 (unmapped):
 *       두 단계 모두 실패한 경우, WCAG 기준 정보를 보존하여
 *       unmapped 목록에 별도 저장 (위반 정보 유실 방지)
 *
 * [처리 대상]
 *   axe-core 결과에는 세 가지 유형의 항목이 있으며, 모두 같은 매핑 로직을 적용.
 *   - violations:  위반 항목 (접근성 기준을 충족하지 못한 요소)
 *   - passes:      통과 항목 (접근성 기준을 충족한 요소)
 *   - incomplete:  판단 보류 항목 (자동 검사로 확정할 수 없어 수동 확인 필요)
 *
 * [사용하는 파일]
 *   - mapping.js: kwcagItems(33개 항목 정의), axeRuleToKwcag(1단계), wcagToKwcag(2단계)
 *
 * [이 파일을 사용하는 파일]
 *   - run.js:     convert() 함수를 호출하여 axe-core 결과를 KWCAG 형식으로 변환
 *   - scorer.js:  convert()의 출력 결과를 받아서 점수를 계산
 */

const { kwcagItems, axeRuleToKwcag, wcagToKwcag } = require('./mapping');


// ============================================================
//  유틸리티 함수들
// ============================================================

/**
 * extractWcagIds - axe-core의 tags 배열에서 WCAG 성공 기준 번호를 추출
 *
 * axe-core는 각 규칙의 tags에 WCAG 관련 정보를 문자열로 포함.
 * 이 함수는 그중 'wcag + 숫자' 패턴만 골라서 점(.) 구분 형식으로 변환.
 *
 * 변환 예시:
 *   입력: ['wcag2a', 'wcag111', 'cat.text-alternatives', 'wcag2411']
 *                     ^^^^^^^^                             ^^^^^^^^
 *                     매칭됨                                매칭됨
 *   출력: ['1.1.1', '2.4.11']
 *
 *   'wcag2a'는 적합성 레벨(A/AA/AAA)을 나타내는 태그이므로 숫자 패턴에 매칭되지 않음
 *   'cat.text-alternatives'는 axe-core 내부 카테고리이므로 매칭되지 않음
 *
 * 정규식 분석: /^wcag(\d)(\d)(\d+)$/
 *   ^wcag  → 'wcag'로 시작
 *   (\d)   → 첫 번째 숫자 = WCAG 원칙 번호 (1~4)
 *   (\d)   → 두 번째 숫자 = WCAG 지침 번호
 *   (\d+)  → 세 번째 이후 숫자 = WCAG 성공 기준 번호 (1자리 또는 2자리)
 *   $      → 문자열 끝
 *
 *   예: 'wcag2411' → match[1]='2', match[2]='4', match[3]='11' → '2.4.11'
 *
 * @param {string[]} tags - axe-core 규칙의 tags 배열
 * @returns {string[]} WCAG 성공 기준 번호 배열 (예: ['1.1.1', '2.4.11'])
 */
function extractWcagIds(tags) {
  const wcagIds = [];
  for (const tag of tags) {
    const match = tag.match(/^wcag(\d)(\d)(\d+)$/);
    if (match) {
      wcagIds.push(`${match[1]}.${match[2]}.${match[3]}`);
    }
  }
  return wcagIds;
}


/**
 * resolveKwcagIds - axe-core 규칙 하나를 KWCAG 항목 번호로 매핑 (2단계 매핑의 핵심)
 *
 * 이 함수가 2단계 매핑을 실제로 수행하는 함수.
 *
 * 동작 순서:
 *   1) axeRuleToKwcag 객체에서 규칙 ID로 직접 매핑 시도 (1단계)
 *      → 찾으면 즉시 반환 (가장 정확한 결과)
 *
 *   2) 1단계 실패 시, tags에서 WCAG 번호를 추출하고
 *      wcagToKwcag 객체에서 KWCAG 번호를 찾음 (2단계 폴백)
 *      → Set을 사용하여 중복 제거 (하나의 규칙이 여러 WCAG 태그를 가질 수 있고,
 *        서로 다른 WCAG 태그가 같은 KWCAG를 가리킬 수 있으므로)
 *
 *   3) 둘 다 실패 시 빈 배열 반환 → 호출부에서 unmapped로 분류
 *
 * 사용 예시:
 *   resolveKwcagIds('image-alt', ['wcag2a', 'wcag111'])
 *   → 1단계에서 바로 ['5.1.1'] 반환 (axeRuleToKwcag에 등록되어 있으므로)
 *
 *   resolveKwcagIds('unknown-rule', ['wcag412'])
 *   → 1단계 실패 → 2단계에서 WCAG '4.1.2' 추출 → ['8.1.1', '8.2.1'] 반환
 *
 *   resolveKwcagIds('unknown-rule', ['best-practice'])
 *   → 1단계 실패 → 2단계에서도 WCAG 번호 없음 → [] 반환 (unmapped)
 *
 * @param {string} ruleId - axe-core 규칙 ID (예: 'image-alt', 'color-contrast')
 * @param {string[]} tags - axe-core 규칙의 tags 배열
 * @returns {string[]} 매핑된 KWCAG 번호 배열 (빈 배열이면 매핑 실패 → unmapped)
 */
function resolveKwcagIds(ruleId, tags) {
  // 1단계: axe-core 규칙 ID로 직접 매핑 (정밀도 높음)
  if (axeRuleToKwcag[ruleId]) {
    return axeRuleToKwcag[ruleId];
  }

  // 2단계: WCAG 태그에서 번호 추출 → KWCAG 매핑 (폴백, 안전망)
  const wcagIds = extractWcagIds(tags);
  const kwcagIds = new Set();  // 중복 제거를 위해 Set 사용
  for (const wcagId of wcagIds) {
    if (wcagToKwcag[wcagId]) {
      for (const kid of wcagToKwcag[wcagId]) {
        kwcagIds.add(kid);
      }
    }
  }

  return [...kwcagIds];  // Set → 배열로 변환하여 반환
}


/**
 * extractNodeInfo - axe-core 위반 노드에서 필요한 정보만 추출
 *
 * axe-core는 위반을 발견한 HTML 요소(노드) 하나하나에 대해 상세 정보를 제공.
 * 이 함수는 그중 우리 프로젝트에서 사용하는 4가지 정보만 추출.
 *
 * 추출 항목:
 *   selector       - 위반 요소의 CSS 선택자 (위치 식별용)
 *                    예: 'html > body > main > img'
 *   html           - 위반 요소의 실제 HTML 코드 (문제 코드 확인용)
 *                    예: '<img src="banner.jpg">'
 *   impact         - axe-core가 판정한 이 위반의 심각도 (런타임 severity)
 *                    예: 'critical', 'serious', 'moderate', 'minor'
 *                    ※ 이 값이 scorer.js에서 3단계(critical/major/minor)로 변환됨
 *   failureSummary - 위반 원인 설명 (영어)
 *                    예: 'Fix any of the following: Element does not have an alt attribute'
 *
 * @param {Object} node - axe-core 결과의 nodes 배열 내 개별 노드 객체
 * @returns {Object} 필요한 정보만 담긴 객체
 */
function extractNodeInfo(node) {
  return {
    selector: node.target ? node.target.join(' > ') : '',
    html: node.html || '',
    impact: node.impact || null,
    failureSummary: node.failureSummary || '',
    // Preserve the typed cross-document path and scan-time geometry generated
    // from the same rendered DOM as the axe result. `selector` remains above
    // for compatibility with existing ingestion and dashboards.
    locator: node.locator || null,
  };
}


/**
 * formatWcagReference - WCAG 번호 배열을 사람이 읽을 수 있는 참조 문자열로 변환
 *
 * unmapped(KWCAG 매핑 불가) 항목에 부착하여,
 * 비록 KWCAG에는 매핑 못했지만 어떤 WCAG 기준과 관련된 위반인지 알 수 있게 함.
 *
 * 변환 예시:
 *   ['1.4.4', '1.4.10'] → 'WCAG 1.4.4, 1.4.10 기준'
 *   []                  → 'WCAG 기준 미확인'
 *
 * @param {string[]} wcagTags - WCAG 성공 기준 번호 배열
 * @returns {string} 사람이 읽을 수 있는 참조 문자열
 */
function formatWcagReference(wcagTags) {
  if (!wcagTags || wcagTags.length === 0) {
    return 'WCAG 기준 미확인';
  }
  return `WCAG ${wcagTags.join(', ')} 기준`;
}


// ============================================================
//  메인 변환 함수
// ============================================================

/**
 * convert - axe-core 결과 전체를 KWCAG 2.2 기준으로 재분류하는 메인 함수
 *
 * 이 함수가 어댑터의 핵심이며, run.js에서 호출.
 *
 * [입력]
 *   axeResults: axe-core가 실행 후 반환하는 AxeResults 객체
 *   주요 속성:
 *     - violations[]:  위반 항목 배열
 *     - passes[]:      통과 항목 배열
 *     - incomplete[]:  판단 보류 항목 배열
 *     - url:           검사 대상 URL
 *     - timestamp:     검사 시각
 *     - testEngine:    axe-core 버전 정보
 *
 * [출력 구조]
 *   {
 *     meta:     { url, timestamp, engine, adapterVersion, ... },
 *     kwcag:    { '5.1.1': { name, violations[], passes[], ... }, ... },  ← 33개 항목
 *     unmapped: { violations[], passes[] },                               ← 매핑 불가 항목
 *     summary:  { totalViolations, kwcagViolations, ... }                 ← 요약 통계
 *   }
 *
 * [처리 과정]
 *   1. KWCAG 33개 항목 구조를 초기화 (각 항목에 빈 violations/passes/incomplete 배열)
 *   2. axe-core의 violations를 순회하며 resolveKwcagIds()로 KWCAG 항목에 분배
 *      → 매핑 성공 시: 해당 kwcag 항목의 violations에 추가
 *      → 매핑 실패 시: unmapped.violations에 추가 (WCAG 참조 정보 부착)
 *   3. passes, incomplete도 동일한 방식으로 처리
 *   4. 요약 통계 계산 (총 위반 수, KWCAG 매핑된 위반 수, unmapped 수 등)
 *
 * @param {Object} axeResults - axe-core 실행 결과 (AxeResults 객체)
 * @returns {Object} KWCAG 2.2 기준으로 재분류된 결과 JSON
 */
function convert(axeResults) {

  // ── 결과 객체 초기화 ──
  const result = {

    // 메타 정보: 검사 대상, 시각, 엔진 버전 등
    meta: {
      url: axeResults.url || '',
      timestamp: axeResults.timestamp || new Date().toISOString(),
      engine: 'axe-core',
      engineVersion: axeResults.testEngine?.version || 'unknown',
      adapterVersion: '2.0.0',  // 이 어댑터의 버전
    },

    // KWCAG 항목별 결과 (33개 항목 각각에 위반/통과/보류 정보가 들어감)
    kwcag: {},

    // KWCAG에 매핑되지 않은 axe-core 결과
    // → 2단계 매핑까지 실패한 항목들이 여기에 저장됨
    // → WCAG 기준 정보(wcagReference)를 부착하여 완전한 정보 유실을 방지
    unmapped: {
      violations: [],
      passes: [],
    },

    // 요약 통계: 프론트엔드 대시보드와 scorer.js에서 활용
    summary: {
      totalViolations: 0,     // 전체 위반 수 (KWCAG 매핑 + unmapped)
      totalPasses: 0,         // 전체 통과 수
      kwcagViolations: 0,     // KWCAG에 매핑된 위반 수
      kwcagPasses: 0,         // KWCAG에 매핑된 통과 수
      unmappedViolations: 0,  // 매핑 실패한 위반 수
      unmappedPasses: 0,      // 매핑 실패한 통과 수
      itemBreakdown: {},      // KWCAG 항목별 위반/통과 수 요약
    },
  };

  // ── KWCAG 33개 항목 초기화 ──
  // mapping.js의 kwcagItems에서 항목 정보를 가져와서
  // 각 항목에 빈 violations/passes/incomplete 배열을 준비
  for (const [kwcagId, item] of Object.entries(kwcagItems)) {
    result.kwcag[kwcagId] = {
      name: item.name,            // KWCAG 항목명 (예: '적절한 대체 텍스트 제공')
      wcag: item.wcag,            // 대응 WCAG 번호 배열
      mappingType: item.mappingType, // 매핑 유형 (1:1, 1:N 등)
      module: item.module,        // 담당 모듈 (규칙기반, AI분석, CV 등)
      weight: item.weight,        // 가중치 (high/medium/low) → scorer.js에서 감점 크기 결정에 사용
      violations: [],             // 이 항목에서 발견된 위반 목록
      passes: [],                 // 이 항목에서 통과한 검사 목록
      incomplete: [],             // 이 항목에서 판단 보류된 목록
      violationCount: 0,          // 위반 노드(HTML 요소) 총 개수
      passCount: 0,               // 통과 노드 총 개수
    };
  }

  // ── violations 처리 ──
  // axe-core가 발견한 각 위반을, 2단계 매핑을 통해 해당 KWCAG 항목에 분배
  for (const violation of (axeResults.violations || [])) {

    // 2단계 매핑 실행: 이 위반이 KWCAG 어디에 해당하는지 찾기
    const kwcagIds = resolveKwcagIds(violation.id, violation.tags || []);

    // 위반 정보를 우리 프로젝트 형식으로 정리
    const violationData = {
      axeRuleId: violation.id,         // axe-core 규칙 ID (예: 'image-alt')
      description: violation.description || '',  // 위반 설명
      help: violation.help || '',      // 간단한 도움말
      helpUrl: violation.helpUrl || '', // 상세 도움말 URL (axe-core 문서 링크)
      impact: violation.impact || '',  // 런타임 심각도 (critical/serious/moderate/minor)
      wcagTags: extractWcagIds(violation.tags || []),  // 관련 WCAG 번호
      nodes: (violation.nodes || []).map(extractNodeInfo),  // 위반 HTML 요소 목록
    };

    if (kwcagIds.length > 0) {
      // 매핑 성공: 해당 KWCAG 항목에 위반 추가
      // ※ kwcagIds가 여러 개일 수 있음 (예: select-name → 7.2.1, 7.3.2)
      //    이 경우 두 항목 모두에 같은 위반이 기록됨
      for (const kwcagId of kwcagIds) {
        result.kwcag[kwcagId].violations.push(violationData);
        result.kwcag[kwcagId].violationCount += violationData.nodes.length;
      }
    } else {
      // 매핑 실패 (unmapped): KWCAG에 대응하지 못하는 위반
      // WCAG 기준 참조 문자열을 부착하여 어떤 기준의 위반인지는 알 수 있게 보존
      violationData.wcagReference = formatWcagReference(violationData.wcagTags);
      result.unmapped.violations.push(violationData);
    }
  }

  // ── passes 처리 ──
  // 통과 항목도 위반과 동일한 매핑 로직 적용
  // → 통과 정보도 KWCAG 항목별로 분류해야 "이 항목은 N개 통과, M개 위반" 표시 가능
  for (const pass of (axeResults.passes || [])) {
    const kwcagIds = resolveKwcagIds(pass.id, pass.tags || []);

    const passData = {
      axeRuleId: pass.id,
      description: pass.description || '',
      wcagTags: extractWcagIds(pass.tags || []),
      nodeCount: (pass.nodes || []).length,  // 통과한 HTML 요소 개수
    };

    if (kwcagIds.length > 0) {
      for (const kwcagId of kwcagIds) {
        result.kwcag[kwcagId].passes.push(passData);
        result.kwcag[kwcagId].passCount += passData.nodeCount;
      }
    } else {
      passData.wcagReference = formatWcagReference(passData.wcagTags);
      result.unmapped.passes.push(passData);
    }
  }

  // ── incomplete 처리 ──
  // 자동 검사로 확정할 수 없는 항목 (수동 확인 필요)
  // 예: axe-core가 색 대비를 계산했는데 배경이 그라데이션이라 정확한 판정 불가
  // → 점수에는 반영하지 않고 참고 정보로만 기록
  for (const inc of (axeResults.incomplete || [])) {
    const kwcagIds = resolveKwcagIds(inc.id, inc.tags || []);

    const incData = {
      axeRuleId: inc.id,
      description: inc.description || '',
      help: inc.help || '',
      nodes: (inc.nodes || []).map(extractNodeInfo),
    };

    if (kwcagIds.length > 0) {
      for (const kwcagId of kwcagIds) {
        result.kwcag[kwcagId].incomplete.push(incData);
      }
    }
    // ※ incomplete는 unmapped에 넣지 않음 (점수에 영향 없으므로 누락되어도 무방)
  }

  // ── 요약 통계 계산 ──
  // 프론트엔드 대시보드에서 "총 위반 수", "항목별 위반 수" 등을 표시하기 위한 집계
  let totalViolations = 0;
  let totalPasses = 0;
  let kwcagViolations = 0;
  let kwcagPasses = 0;

  // KWCAG에 매핑된 위반/통과 수 집계
  for (const [kwcagId, item] of Object.entries(result.kwcag)) {
    kwcagViolations += item.violationCount;
    kwcagPasses += item.passCount;

    // 항목별 요약: 프론트엔드에서 "5.1.1: 위반 3건, 통과 12건" 형태로 표시
    result.summary.itemBreakdown[kwcagId] = {
      name: item.name,
      violationCount: item.violationCount,  // 위반 노드 수
      passCount: item.passCount,            // 통과 노드 수
      ruleCount: item.violations.length,    // 위반을 발생시킨 axe-core 규칙 종류 수
    };
  }

  // unmapped 위반/통과 수 집계
  for (const v of result.unmapped.violations) {
    totalViolations += (v.nodes || []).length;
  }
  for (const p of result.unmapped.passes) {
    totalPasses += p.nodeCount || 0;
  }

  // 최종 요약 수치 기록
  result.summary.totalViolations = kwcagViolations + totalViolations;
  result.summary.totalPasses = kwcagPasses + totalPasses;
  result.summary.kwcagViolations = kwcagViolations;
  result.summary.kwcagPasses = kwcagPasses;
  result.summary.unmappedViolations = totalViolations;
  result.summary.unmappedPasses = totalPasses;

  return result;
}


// ============================================================
//  모듈 내보내기
// ============================================================
//  - convert:             메인 변환 함수 (run.js에서 호출)
//  - extractWcagIds:      WCAG 태그 추출 유틸리티 (테스트/디버깅용으로도 사용 가능)
//  - resolveKwcagIds:     2단계 매핑 함수 (테스트/디버깅용으로도 사용 가능)
//  - formatWcagReference: WCAG 참조 문자열 생성 유틸리티

module.exports = { convert, extractWcagIds, resolveKwcagIds, formatWcagReference };
