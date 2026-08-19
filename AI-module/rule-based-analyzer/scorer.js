/**
 * ============================================================
 *  KWCAG 점수화 모듈 (scorer.js)
 *  adapter.js의 변환 결과 → 100점 만점 접근성 점수 산출
 * ============================================================
 *
 * [파일 목적]
 *   adapter.js가 axe-core 결과를 KWCAG 2.2 기준으로 재분류한 후,
 *   이 파일이 그 결과를 받아서 "이 웹페이지의 접근성 점수는 몇 점인가"를
 *   계산. 기존 평가 도구(WAVE, Lighthouse 등)는 "준수/미준수"만
 *   알려주지만, 본 프로젝트는 정량화된 점수를 통해 기관 간 비교와
 *   시간에 따른 개선 추이 확인이 가능하도록 설계.
 *
 * [점수 산출 방식: 100점 만점 감점제]
 *   만점(100점)에서 시작하여, 발견된 위반마다 심각도(severity)와
 *   가중치(weight)를 함께 반영하여 감점.
 *
 *   감점 공식:
 *     항목별 감점 = severity 기본 감점 × weight 배수 × 위반 노드 수
 *
 *   severity 기본 감점:
 *     critical (장애인 접근 자체 불가):  건당 3점
 *     major    (심각한 사용 불편):      건당 2점
 *     minor    (경미한 불편):           건당 1점
 *
 *   weight 배수 (KWCAG 항목의 상대적 중요도):
 *     high   (핵심 항목):  ×1.5
 *     medium (중요 항목):  ×1.0
 *     low    (부가 항목):  ×0.5
 *
 *   계산 예시:
 *     5.1.1 (severity=critical, weight=high): alt 없는 <img> 5개 발견
 *     → 3 × 1.5 × 5 = 22.5점 감점
 *
 *     7.1.1 (severity=minor, weight=medium): lang 속성 누락 1건
 *     → 1 × 1.0 × 1 = 1점 감점
 *
 *     6.1.4 (severity=minor, weight=low): 문자 단축키 관련 위반 2건
 *     → 1 × 0.5 × 2 = 1점 감점
 *
 *   unmapped 위반: minor(1점) × medium(×1.0)로 취급하여 건당 1점 감점
 *
 *   총 감점은 소수점 이하 반올림하며, 최저 점수는 0점 (음수 없음)
 *
 * [등급 판정 기준]
 *   95점 이상 → A등급 (우수)
 *   85점 이상 → B등급 (양호)
 *   70점 이상 → C등급 (보통)
 *   50점 이상 → D등급 (미흡)
 *   50점 미만 → F등급 (심각)
 *
 * [파이프라인 내 위치]
 *   axe-core 실행 → adapter.js (KWCAG 변환) → scorer.js (점수 계산) → run.js (결과 출력)
 *
 * [사용법]
 *   const { score } = require('./scorer');
 *   const adapterResult = convert(axeResults);  // adapter.js
 *   const scoreResult = score(adapterResult);
 *   // scoreResult.score    → 최종 점수 (예: 68)
 *   // scoreResult.grade    → 등급 (예: 'C')
 *   // scoreResult.items    → 항목별 감점 상세
 */

const { kwcagItems } = require('./mapping');


// ── 심각도별 기본 감점 점수 ──
// 장애 사용자에 대한 영향도가 클수록 더 큰 감점을 부여
const DEDUCTION = {
  critical: 3,  // 장애인 콘텐츠 접근 자체 불가 (예: 대체 텍스트 누락, 자막 없음)
  major: 2,     // 심각한 사용 불편 발생 (예: heading 순서 오류, 링크 텍스트 부적절)
  minor: 1,     // 경미한 불편 또는 간접적 영향 (예: lang 속성 누락, 빈 heading)
};

// ── 가중치별 배수 ──
// KWCAG 항목의 상대적 중요도에 따라 감점을 증감
// mapping.js의 kwcagItems에 정의된 weight 값에 대응
const WEIGHT_MULTIPLIER = {
  high: 1.5,    // 핵심 항목: 위반 시 접근 자체가 차단되므로 감점 1.5배
  medium: 1.0,  // 중요 항목: 기본 감점 그대로 적용
  low: 0.5,     // 부가 항목: 편의성 수준이므로 감점 절반
};

// 만점 기준
const MAX_SCORE = 100;


// ============================================================
//  메인 점수 계산 함수
// ============================================================

/**
 * score - adapter.js의 변환 결과를 받아 최종 점수를 계산하는 메인 함수
 *
 * [입력]
 *   adapterResult: adapter.js의 convert() 함수가 반환한 객체
 *
 * [출력 구조]
 *   {
 *     score: 68,              ← 최종 점수 (0~100)
 *     maxScore: 100,          ← 만점
 *     totalDeduction: 32,     ← 총 감점
 *     grade: 'C',             ← 등급
 *     severityBreakdown: {    ← 심각도별 감점 상세
 *       critical: { count, deductionPerNode, totalDeduction },
 *       major:    { count, deductionPerNode, totalDeduction },
 *       minor:    { count, deductionPerNode, totalDeduction },
 *     },
 *     unmapped: { violationNodes, deduction },
 *     items: {                ← KWCAG 항목별 감점 상세
 *       '5.1.1': { name, severity, weight, weightMultiplier, deduction, ... },
 *       ...
 *     }
 *   }
 *
 * @param {Object} adapterResult - adapter.convert()의 반환값
 * @returns {Object} 점수 결과
 */
function score(adapterResult) {

  // 항목별 점수 상세를 저장할 객체
  const itemScores = {};

  // 총 감점 누적 변수
  let totalDeduction = 0;

  // 심각도별 위반 노드 수 및 감점 집계 (severityBreakdown 출력용)
  const severityStats = {
    critical: { count: 0, deduction: 0 },
    major:    { count: 0, deduction: 0 },
    minor:    { count: 0, deduction: 0 },
  };

  // ── KWCAG 항목별 감점 계산 ──
  for (const [kwcagId, itemResult] of Object.entries(adapterResult.kwcag)) {

    // mapping.js에서 이 항목의 정의 정보 가져오기
    const definition = kwcagItems[kwcagId];
    if (!definition) continue;

    // 심각도와 가중치 결정
    const severity = definition.severity || 'minor';
    const weight = definition.weight || 'medium';

    // 감점 계산에 사용할 값 조회
    const baseDeduction = DEDUCTION[severity] || DEDUCTION.minor;
    const weightMultiplier = WEIGHT_MULTIPLIER[weight] || WEIGHT_MULTIPLIER.medium;

    // 이 항목에서 발견된 위반 노드(HTML 요소) 수
    const violationNodes = itemResult.violationCount || 0;

    // 항목별 감점 = severity 기본 감점 × weight 배수 × 위반 노드 수
    // 예: critical(3) × high(1.5) × 5건 = 22.5
    const itemDeduction = baseDeduction * weightMultiplier * violationNodes;

    // 심각도별 통계 누적
    if (severityStats[severity]) {
      severityStats[severity].count += violationNodes;
      severityStats[severity].deduction += itemDeduction;
    }

    // 이 항목의 점수 상세 기록
    itemScores[kwcagId] = {
      name: definition.name,
      severity,
      weight,
      weightMultiplier,
      deductionPerNode: Math.round(baseDeduction * weightMultiplier * 10) / 10,  // 건당 실제 감점 (배수 적용 후)
      violationCount: violationNodes,
      ruleCount: itemResult.violations.length,
      passCount: itemResult.passCount || 0,
      deduction: Math.round(itemDeduction * 10) / 10,  // 소수점 첫째 자리까지
    };

    totalDeduction += itemDeduction;
  }

  // ── unmapped 감점 (minor × medium 취급) ──
  // KWCAG에 매핑되지 않은 위반도 점수에 반영 (누락 방지)
  // 정확한 심각도와 가중치를 알 수 없으므로 minor(1점) × medium(×1.0)으로 감점
  let unmappedNodes = 0;
  for (const v of (adapterResult.unmapped?.violations || [])) {
    unmappedNodes += (v.nodes || []).length;
  }
  const unmappedDeduction = DEDUCTION.minor * WEIGHT_MULTIPLIER.medium * unmappedNodes;
  totalDeduction += unmappedDeduction;

  // minor 통계에 unmapped 합산
  severityStats.minor.count += unmappedNodes;
  severityStats.minor.deduction += unmappedDeduction;

  // ── 총 감점 반올림 ──
  // weight 배수 적용으로 소수점이 발생할 수 있으므로 최종 감점을 반올림
  totalDeduction = Math.round(totalDeduction);

  // ── 최종 점수 계산 ──
  // 만점(100)에서 총 감점을 빼되, 0점 미만으로 내려가지 않도록 보정
  const finalScore = Math.max(0, MAX_SCORE - totalDeduction);

  // ── 등급 판정 ──
  // 점수 구간에 따라 5단계 등급 부여
  // 이 구간은 프로젝트에서 자체 설계한 기준이며,
  // 향후 실제 공공 웹사이트 테스트 결과를 바탕으로 조정할 수 있음
  let grade;
  if (finalScore >= 95) grade = 'A';       // 우수: 거의 모든 기준 충족
  else if (finalScore >= 85) grade = 'B';  // 양호: 경미한 위반만 존재
  else if (finalScore >= 70) grade = 'C';  // 보통: 일부 중요 위반 존재
  else if (finalScore >= 50) grade = 'D';  // 미흡: 다수의 위반 존재
  else grade = 'F';                        // 심각: 접근성 개선이 시급함

  // ── 최종 결과 반환 ──
  return {
    score: finalScore,
    maxScore: MAX_SCORE,
    totalDeduction,
    grade,

    // 심각도별 감점 상세
    // → 프론트엔드에서 "critical 5건(-22.5점), major 3건(-6점)" 형태로 시각화
    // ※ weight 배수가 항목마다 다르므로, totalDeduction은 단순히 count × deductionPerNode가 아님
    severityBreakdown: {
      critical: {
        count: severityStats.critical.count,
        deductionPerNode: DEDUCTION.critical,
        totalDeduction: Math.round(severityStats.critical.deduction * 10) / 10,
      },
      major: {
        count: severityStats.major.count,
        deductionPerNode: DEDUCTION.major,
        totalDeduction: Math.round(severityStats.major.deduction * 10) / 10,
      },
      minor: {
        count: severityStats.minor.count,
        deductionPerNode: DEDUCTION.minor,
        totalDeduction: Math.round(severityStats.minor.deduction * 10) / 10,
      },
    },

    // unmapped 위반 별도 표시
    unmapped: {
      violationNodes: unmappedNodes,
      deduction: Math.round(unmappedDeduction * 10) / 10,
    },

    // KWCAG 항목별 감점 상세
    // → 프론트엔드에서 "5.1.1 적절한 대체 텍스트 제공: 위반 5건, -22.5점 (critical×high)" 표시
    items: itemScores,
  };
}


// ============================================================
//  모듈 내보내기
// ============================================================
//  - score:             메인 점수 계산 함수 (run.js에서 호출)
//  - DEDUCTION:         심각도별 기본 감점 상수
//  - WEIGHT_MULTIPLIER: 가중치별 배수 상수
//  - MAX_SCORE:         만점 상수

module.exports = { score, DEDUCTION, WEIGHT_MULTIPLIER, MAX_SCORE };
