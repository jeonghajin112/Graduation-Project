/**
 * KWCAG 2.2 ↔ WCAG ↔ axe-core 매핑 테이블
 * 매핑 테이블 v2 (2026.03.25) 기반
 *
 * 구조:
 *   kwcagItems  – KWCAG 33개 검사항목 정의 (WCAG 대응, 모듈, 가중치 등)
 *   wcagToKwcag – WCAG 번호 → KWCAG 번호 역매핑 (어댑터 변환용)
 *   axeRuleToKwcag – axe-core 규칙 ID → KWCAG 번호 직접 매핑
 *                    (동일 WCAG인데 KWCAG가 나뉘는 경우 대응, 예: 8.1.1 vs 8.2.1)
 */

const kwcagItems = {
  // ── 원칙 1: 인식의 용이성 ──
  '5.1.1': {
    name: '적절한 대체 텍스트 제공',
    wcag: ['1.1.1'],
    mappingType: '1:1', 
    module: '규칙기반',
    weight: 'high',
    severity: 'critical',   // 스크린리더 사용자 콘텐츠 접근 불가
    axeRules: ['image-alt', 'input-image-alt', 'area-alt', 'object-alt', 'svg-img-alt', 'role-img-alt'],
  },
  '5.2.1': {
    name: '자막 제공',
    wcag: ['1.2.2', '1.2.4', '1.2.5'],
    mappingType: '1:N',
    module: '규칙기반',
    weight: 'high',
    severity: 'critical',   // 청각장애인 영상 콘텐츠 접근 불가
    axeRules: ['video-caption'],
  },
  '5.3.1': {
    name: '표의 구성',
    wcag: ['1.3.1'],
    mappingType: 'N:1(부분)',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 스크린리더 표 내비게이션 혼란
    axeRules: ['td-headers-attr', 'th-has-data-cells', 'td-has-header', 'scope-attr-valid'],
  },
  '5.3.2': {
    name: '콘텐츠의 선형구조',
    wcag: ['1.3.2'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // heading 순서 오류 → 내비게이션 혼란
    axeRules: ['heading-order'],
  },
  '5.3.3': {
    name: '명확한 지시사항 제공',
    wcag: ['1.3.3'],
    mappingType: '1:1',
    module: 'AI분석',
    weight: 'medium',
    severity: 'major',      // 인지약자 이해 곤란
    axeRules: [],
  },
  '5.4.1': {
    name: '색에 무관한 콘텐츠 인식',
    wcag: ['1.4.1'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 색각이상자 정보 누락
    axeRules: ['link-in-text-block'],
  },
  '5.4.2': {
    name: '자동 재생 금지',
    wcag: ['1.4.2'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'high',
    severity: 'critical',   // 스크린리더 간섭 + 인지장애 혼란
    axeRules: ['no-autoplay-audio'],
  },
  '5.4.3': {
    name: '텍스트 콘텐츠의 명도 대비',
    wcag: ['1.4.3', '1.4.6'],
    mappingType: '1:N',
    module: '규칙기반+CV',
    weight: 'high',
    severity: 'major',      // 저시력 사용자 읽기 곤란
    axeRules: ['color-contrast', 'color-contrast-enhanced'],
  },
  '5.4.4': {
    name: '콘텐츠 간의 구분',
    wcag: ['1.4.11', '1.4.12', '1.4.13'],
    mappingType: '1:N',
    module: 'CV',
    weight: 'medium',
    severity: 'minor',      // 구분 어려움, 사용 불가는 아님
    axeRules: [],
  },

  // ── 원칙 2: 운용의 용이성 ──
  '6.1.1': {
    name: '키보드 사용 보장',
    wcag: ['2.1.1', '2.1.2'],
    mappingType: '1:N',
    module: '수동',
    weight: 'high',
    severity: 'critical',   // 키보드 전용 사용자 조작 불가
    axeRules: [],
  },
  '6.1.2': {
    name: '초점 이동과 표시',
    wcag: ['2.4.3', '2.4.7', '2.4.11', '2.4.12'],
    mappingType: '1:N',
    module: '수동',
    weight: 'high',
    severity: 'critical',   // 키보드 사용자 현재 위치 파악 불가
    axeRules: [],
  },
  '6.1.3': {
    name: '조작 가능',
    wcag: ['2.5.5', '2.5.8'],
    mappingType: '1:N',
    module: '규칙기반+CV',
    weight: 'medium',
    severity: 'major',      // 운동장애 사용자 터치/클릭 곤란
    axeRules: ['target-size'],
  },
  '6.1.4': {
    name: '문자 단축키',
    wcag: ['2.1.4'],
    mappingType: '1:1',
    module: '수동',
    weight: 'low',
    severity: 'minor',      // 편의 기능, 접근 차단은 아님
    axeRules: [],
  },
  '6.2.1': {
    name: '응답시간 조절',
    wcag: ['2.2.1', '2.2.6'],
    mappingType: '1:N',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 인지/운동장애 사용자 시간 부족
    axeRules: ['meta-refresh'],
  },
  '6.2.2': {
    name: '정지 기능 제공',
    wcag: ['2.2.2'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 움직이는 콘텐츠로 인지 부담
    axeRules: ['marquee', 'blink'],
  },
  '6.3.1': {
    name: '깜빡임과 번쩍임 사용 제한',
    wcag: ['2.3.1'],
    mappingType: '1:1',
    module: '수동',
    weight: 'high',
    severity: 'critical',   // 광과민성 발작 위험
    axeRules: [],
  },
  '6.4.1': {
    name: '반복 영역 건너뛰기',
    wcag: ['2.4.1'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 키보드 사용자 탐색 효율 저하
    axeRules: ['bypass', 'skip-link'],
  },
  '6.4.2': {
    name: '제목 제공',
    wcag: ['2.4.2', '2.4.6'],
    mappingType: '1:N',
    module: '규칙기반',
    weight: 'medium',
    severity: 'minor',      // 페이지 식별 불편, 접근 차단은 아님
    axeRules: ['document-title', 'page-has-heading-one', 'empty-heading'],
  },
  '6.4.3': {
    name: '적절한 링크 텍스트',
    wcag: ['2.4.4', '2.4.9'],
    mappingType: '1:N',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 스크린리더 링크 목적 파악 불가
    axeRules: ['link-name', 'identical-links-same-purpose'],
  },
  '6.4.4': {
    name: '고정된 참조 위치 정보',
    wcag: [],
    mappingType: '고유',
    module: '수동',
    weight: 'low',
    severity: 'minor',      // KWCAG 고유 항목, 편의 수준
    axeRules: [],
  },
  '6.5.1': {
    name: '단일 포인터 입력 지원',
    wcag: ['2.5.1'],
    mappingType: '1:1',
    module: '수동',
    weight: 'medium',
    severity: 'major',      // 운동장애 사용자 입력 곤란
    axeRules: [],
  },
  '6.5.2': {
    name: '포인터 입력 취소',
    wcag: ['2.5.2'],
    mappingType: '1:1',
    module: '수동',
    weight: 'medium',
    severity: 'major',      // 실수 입력 복구 불가
    axeRules: [],
  },
  '6.5.3': {
    name: '레이블과 네임',
    wcag: ['2.5.3'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 음성입력 사용자 조작 실패
    axeRules: ['label-content-name-mismatch'],
  },
  '6.5.4': {
    name: '동작기반 작동',
    wcag: ['2.5.4'],
    mappingType: '1:1',
    module: '수동',
    weight: 'low',
    severity: 'minor',      // 대체 수단 있으면 문제 없음
    axeRules: [],
  },

  // ── 원칙 3: 이해의 용이성 ──
  '7.1.1': {
    name: '기본 언어 표시',
    wcag: ['3.1.1'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'medium',
    severity: 'minor',      // 스크린리더 발음 오류, 치명적이지 않음
    axeRules: ['html-has-lang', 'html-lang-valid', 'html-xml-lang-mismatch'],
  },
  '7.2.1': {
    name: '사용자 요구에 따른 실행',
    wcag: ['3.2.1', '3.2.2', '3.2.5'],
    mappingType: '1:N',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 예기치 않은 동작으로 인지 혼란
    axeRules: ['select-name'],
  },
  '7.2.2': {
    name: '찾기 쉬운 도움 정보',
    wcag: ['3.2.6'],
    mappingType: '1:1',
    module: '수동',
    weight: 'low',
    severity: 'minor',      // 도움 정보 부재, 기능 차단은 아님
    axeRules: [],
  },
  '7.3.1': {
    name: '오류 정정',
    wcag: ['3.3.1', '3.3.3', '3.3.4'],
    mappingType: '1:N',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // 오류 원인 파악 불가 → 폼 제출 실패
    axeRules: ['aria-input-field-name'],
  },
  '7.3.2': {
    name: '레이블 제공',
    wcag: ['3.3.2'],
    mappingType: '1:1',
    module: '규칙기반',
    weight: 'high',
    severity: 'critical',   // 입력란 용도 불명 → 폼 사용 불가
    axeRules: ['label', 'form-field-multiple-labels', 'select-name', 'input-button-name'],
  },
  '7.3.3': {
    name: '접근 가능한 인증',
    wcag: ['3.3.8'],
    mappingType: '1:1',
    module: '수동',
    weight: 'medium',
    severity: 'major',      // 인지장애 사용자 인증 실패
    axeRules: [],
  },
  '7.3.4': {
    name: '반복 입력 정보',
    wcag: ['3.3.9'],
    mappingType: '1:1',
    module: '수동',
    weight: 'low',
    severity: 'minor',      // 불편하지만 사용 가능
    axeRules: [],
  },

  // ── 원칙 4: 견고성 ──
  '8.1.1': {
    name: '마크업 오류 방지',
    wcag: ['4.1.1', '4.1.2'],
    mappingType: '1:N',
    module: '규칙기반',
    weight: 'high',
    severity: 'minor',      // 파싱 오류, 브라우저가 대부분 보정
    axeRules: ['aria-valid-attr', 'aria-valid-attr-val', 'aria-roles', 'duplicate-id', 'aria-required-attr'],
  },
  '8.2.1': {
    name: '웹 애플리케이션 접근성 준수',
    wcag: ['4.1.2'],
    mappingType: 'N:1(부분)',
    module: '규칙기반',
    weight: 'medium',
    severity: 'major',      // ARIA 위젯 역할/상태 미제공 → 보조기기 조작 곤란
    axeRules: ['aria-command-name', 'aria-meter-name', 'aria-progressbar-name', 'aria-toggle-field-name'],
  },
};

// ── axe-core 규칙 ID → KWCAG 직접 매핑 (빌드) ──
// WCAG 태그 기반보다 우선순위가 높음 (같은 WCAG 4.1.2인데 KWCAG가 다른 경우 해결)
const axeRuleToKwcag = {};
for (const [kwcagId, item] of Object.entries(kwcagItems)) {
  for (const ruleId of item.axeRules) {
    // 하나의 axe rule이 여러 KWCAG에 매핑될 수 있음 (예: select-name)
    if (!axeRuleToKwcag[ruleId]) {
      axeRuleToKwcag[ruleId] = [];
    }
    axeRuleToKwcag[ruleId].push(kwcagId);
  }
}

// ── WCAG 번호 → KWCAG 번호 역매핑 (빌드) ──
// axe-core 규칙 직접 매핑이 안 될 때 fallback으로 사용
const wcagToKwcag = {};
for (const [kwcagId, item] of Object.entries(kwcagItems)) {
  for (const wcagId of item.wcag) {
    if (!wcagToKwcag[wcagId]) {
      wcagToKwcag[wcagId] = [];
    }
    wcagToKwcag[wcagId].push(kwcagId);
  }
}

// 세 가지 객체를 다른 파일에서 쓸 수 있게 추출
module.exports = { kwcagItems, axeRuleToKwcag, wcagToKwcag };
