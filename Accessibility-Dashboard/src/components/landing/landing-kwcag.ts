/**
 * 랜딩용 KWCAG 2.2 검사 항목 표 (번호·이름·자동 검사 여부).
 * 랜딩 번들은 대시보드 모듈을 가져올 수 없으므로 site-dashboard/kwcag-criteria.ts 의 표를 옮겨 둔다.
 * automated 는 그 표에서 분석기가 하나라도 있는 항목이다. 두 표를 함께 고칠 것.
 * sample 은 최종 리포트 예시 화면에만 쓰는 문제 건수이며, 실제 분석 결과가 아니다.
 */
export type LandingCriterion = { code: string; name: string; automated: boolean; sample?: number };

export const KWCAG_LANDING_PRINCIPLES: ReadonlyArray<{ name: string; criteria: readonly LandingCriterion[] }> = [
  { name: "인식의 용이성", criteria: [
    { code: "5.1.1", name: "적절한 대체 텍스트 제공", automated: true, sample: 14 },
    { code: "5.2.1", name: "자막 제공", automated: true },
    { code: "5.3.1", name: "표의 구성", automated: true, sample: 0 },
    { code: "5.3.2", name: "콘텐츠의 선형구조", automated: false },
    { code: "5.3.3", name: "명확한 지시사항 제공", automated: true, sample: 9 },
    { code: "5.4.1", name: "색에 무관한 콘텐츠 인식", automated: true, sample: 0 },
    { code: "5.4.2", name: "자동 재생 금지", automated: true, sample: 0 },
    { code: "5.4.3", name: "텍스트 콘텐츠의 명도 대비", automated: true, sample: 31 },
    { code: "5.4.4", name: "콘텐츠 간의 구분", automated: true, sample: 9 }
  ] },
  { name: "운용의 용이성", criteria: [
    { code: "6.1.1", name: "키보드 사용 보장", automated: true, sample: 1 },
    { code: "6.1.2", name: "초점 이동과 표시", automated: false },
    { code: "6.1.3", name: "조작 가능", automated: true, sample: 0 },
    { code: "6.1.4", name: "문자 단축키", automated: false },
    { code: "6.2.1", name: "응답시간 조절", automated: true, sample: 0 },
    { code: "6.2.2", name: "정지 기능 제공", automated: true, sample: 0 },
    { code: "6.3.1", name: "깜빡임과 번쩍임 사용 제한", automated: false },
    { code: "6.4.1", name: "반복 영역 건너뛰기", automated: true, sample: 1 },
    { code: "6.4.2", name: "제목 제공", automated: true, sample: 3 },
    { code: "6.4.3", name: "적절한 링크 텍스트", automated: true, sample: 42 },
    { code: "6.4.4", name: "고정된 참조 위치 정보", automated: false },
    { code: "6.5.1", name: "단일 포인터 입력 지원", automated: false },
    { code: "6.5.2", name: "포인터 입력 취소", automated: false },
    { code: "6.5.3", name: "레이블과 네임", automated: false },
    { code: "6.5.4", name: "동작기반 작동", automated: false }
  ] },
  { name: "이해의 용이성", criteria: [
    { code: "7.1.1", name: "기본 언어 표시", automated: true, sample: 0 },
    { code: "7.2.1", name: "사용자 요구에 따른 실행", automated: true, sample: 0 },
    { code: "7.2.2", name: "찾기 쉬운 도움 정보", automated: false },
    { code: "7.3.1", name: "오류 정정", automated: true, sample: 0 },
    { code: "7.3.2", name: "레이블 제공", automated: true, sample: 2 },
    { code: "7.3.3", name: "접근 가능한 인증", automated: false },
    { code: "7.3.4", name: "반복 입력 정보", automated: false }
  ] },
  { name: "견고성", criteria: [
    { code: "8.1.1", name: "마크업 오류 방지", automated: true, sample: 4 },
    { code: "8.2.1", name: "웹 애플리케이션 접근성 준수", automated: true, sample: 6 }
  ] }
];
