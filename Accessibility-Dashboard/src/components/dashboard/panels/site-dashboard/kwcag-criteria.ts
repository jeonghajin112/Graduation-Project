import type { AnalyzerType } from "@/types/accessibility-domain";

import { normalizeIssueCode } from "./constants";
import type { RecentIssueRow } from "./types";

type Criterion = {
  code: string;
  name: string;
  engines: AnalyzerType[];
  /** What the criterion asks of a page, in plain words. */
  description: string;
};

const R: AnalyzerType = "RULE_BASED";
const T: AnalyzerType = "AI_TEXT";
const C: AnalyzerType = "CV_VISION";

/**
 * The 33 KWCAG 2.2 criteria and the engines that can report each one.
 * Coverage mirrors the analysers: AI-module/rule-based-analyzer/mapping.js
 * (axe rules that actually run under run.js's tag set, including the WCAG-tag
 * fallback), text_standard_mapper.py and cv_runner.py. A criterion without an
 * engine is never checked automatically. Update this table with those files.
 */
export const KWCAG_PRINCIPLES: Array<{ name: string; criteria: Criterion[] }> = [
  { name: "인식의 용이성", criteria: [
    { code: "5.1.1", name: "적절한 대체 텍스트 제공", engines: [R],
      description: "이미지처럼 글이 아닌 콘텐츠는 그 의미나 용도를 알 수 있도록 대체 텍스트를 제공해야 합니다." },
    { code: "5.2.1", name: "자막 제공", engines: [R],
      description: "동영상 같은 멀티미디어 콘텐츠에는 자막, 대본 또는 수어를 제공해야 합니다." },
    { code: "5.3.1", name: "표의 구성", engines: [R],
      description: "표는 제목 셀과 내용 셀을 구분하는 등 이해하기 쉽게 구성해야 합니다." },
    { code: "5.3.2", name: "콘텐츠의 선형구조", engines: [],
      description: "콘텐츠는 읽는 순서가 논리적이도록 제공해야 합니다." },
    { code: "5.3.3", name: "명확한 지시사항 제공", engines: [T],
      description: "지시사항은 모양·크기·위치·방향·색·소리에 관계없이 이해할 수 있어야 합니다." },
    { code: "5.4.1", name: "색에 무관한 콘텐츠 인식", engines: [R],
      description: "콘텐츠는 색을 구분하지 못해도 인식할 수 있어야 합니다." },
    { code: "5.4.2", name: "자동 재생 금지", engines: [R],
      description: "소리가 자동으로 재생되지 않아야 합니다." },
    { code: "5.4.3", name: "텍스트 콘텐츠의 명도 대비", engines: [R, C],
      description: "텍스트와 배경의 명도 대비는 4.5:1 이상이어야 합니다. 큰 글자는 3:1 이상이면 됩니다." },
    { code: "5.4.4", name: "콘텐츠 간의 구분", engines: [R],
      description: "이웃한 콘텐츠는 서로 구별할 수 있어야 합니다." }
  ] },
  { name: "운용의 용이성", criteria: [
    { code: "6.1.1", name: "키보드 사용 보장", engines: [R],
      description: "모든 기능은 키보드만으로도 사용할 수 있어야 합니다." },
    { code: "6.1.2", name: "초점 이동과 표시", engines: [],
      description: "키보드 초점은 논리적인 순서로 이동하고, 눈으로 구별할 수 있게 표시되어야 합니다." },
    { code: "6.1.3", name: "조작 가능", engines: [R],
      description: "사용자 입력과 컨트롤은 누르거나 조작할 수 있도록 제공해야 합니다." },
    { code: "6.1.4", name: "문자 단축키", engines: [],
      description: "문자 단축키는 실수로 눌러 생기는 오동작을 막을 수 있어야 합니다." },
    { code: "6.2.1", name: "응답시간 조절", engines: [R],
      description: "시간 제한이 있는 콘텐츠는 응답 시간을 조절할 수 있어야 합니다." },
    { code: "6.2.2", name: "정지 기능 제공", engines: [R],
      description: "자동으로 바뀌는 콘텐츠는 움직임을 멈추거나 제어할 수 있어야 합니다." },
    { code: "6.3.1", name: "깜빡임과 번쩍임 사용 제한", engines: [],
      description: "초당 3~50회로 깜빡이거나 번쩍이는 콘텐츠를 제공하지 않아야 합니다." },
    { code: "6.4.1", name: "반복 영역 건너뛰기", engines: [R],
      description: "반복되는 영역은 건너뛸 수 있어야 합니다." },
    { code: "6.4.2", name: "제목 제공", engines: [R, T],
      description: "페이지, 프레임, 콘텐츠 블록에는 알맞은 제목을 제공해야 합니다." },
    { code: "6.4.3", name: "적절한 링크 텍스트", engines: [R, T],
      description: "링크 텍스트만 읽어도 링크의 용도나 목적을 알 수 있어야 합니다." },
    { code: "6.4.4", name: "고정된 참조 위치 정보", engines: [],
      description: "전자출판 문서 형식의 페이지는 각 페이지로 이동할 수 있고 참조 위치 정보를 일관되게 제공해야 합니다." },
    { code: "6.5.1", name: "단일 포인터 입력 지원", engines: [],
      description: "여러 손가락이나 경로를 따라 하는 동작은 한 번의 포인터 입력으로도 조작할 수 있어야 합니다." },
    { code: "6.5.2", name: "포인터 입력 취소", engines: [],
      description: "한 번의 포인터 입력으로 실행되는 기능은 취소할 수 있어야 합니다." },
    { code: "6.5.3", name: "레이블과 네임", engines: [],
      description: "눈에 보이는 레이블이 있는 구성요소는 그 글자를 접근 가능한 이름에도 포함해야 합니다." },
    { code: "6.5.4", name: "동작기반 작동", engines: [],
      description: "기기를 흔드는 등 동작으로 실행되는 기능은 화면 요소로도 조작할 수 있고, 동작 기능을 끌 수 있어야 합니다." }
  ] },
  { name: "이해의 용이성", criteria: [
    { code: "7.1.1", name: "기본 언어 표시", engines: [R],
      description: "페이지에서 주로 사용하는 언어를 명시해야 합니다." },
    { code: "7.2.1", name: "사용자 요구에 따른 실행", engines: [R],
      description: "새 창 열림이나 초점에 따른 화면 변화처럼 사용자가 의도하지 않은 기능은 실행되지 않아야 합니다." },
    { code: "7.2.2", name: "찾기 쉬운 도움 정보", engines: [],
      description: "도움 정보가 있다면 각 페이지에서 같은 상대적 순서로 찾을 수 있어야 합니다." },
    { code: "7.3.1", name: "오류 정정", engines: [R],
      description: "입력 오류가 생기면 고칠 수 있는 방법을 제공해야 합니다." },
    { code: "7.3.2", name: "레이블 제공", engines: [R, T],
      description: "입력 서식에는 무엇을 입력하는지 알려 주는 레이블을 제공해야 합니다." },
    { code: "7.3.3", name: "접근 가능한 인증", engines: [],
      description: "인증 과정은 기억이나 계산 같은 인지 기능 시험에만 의존하지 않아야 합니다." },
    { code: "7.3.4", name: "반복 입력 정보", engines: [],
      description: "반복해서 입력하는 정보는 자동으로 채우거나 선택해서 입력할 수 있어야 합니다." }
  ] },
  { name: "견고성", criteria: [
    { code: "8.1.1", name: "마크업 오류 방지", engines: [R],
      description: "마크업은 요소의 열고 닫음, 중첩 관계, 속성 선언에 오류가 없어야 합니다." },
    { code: "8.2.1", name: "웹 애플리케이션 접근성 준수", engines: [R],
      description: "콘텐츠에 포함된 웹 애플리케이션도 접근성을 갖춰야 합니다." }
  ] }
];

/**
 * fail: issues were found. pass: an engine that checks it finished without
 * finding any. unknown: no engine that checks it is known to have finished,
 * and at least one has no recorded outcome (older analyses). skipped: every
 * engine that checks it failed or did not run. manual: no engine checks it,
 * so a person must.
 */
export type CriterionStatus = "fail" | "pass" | "unknown" | "skipped" | "manual";

export type CriterionResult = Criterion & { status: CriterionStatus; count: number };

export type CriteriaOverview = {
  principles: Array<{ name: string; criteria: CriterionResult[] }>;
  counts: Record<CriterionStatus, number>;
  /** Issue codes outside the 33 criteria, such as WCAG-only recommendations. */
  others: Array<{ code: string; name: string; count: number }>;
};

/** Korean names for the out-of-scope codes the engines report today. */
const OTHER_NAMES: Record<string, string> = {
  "WCAG 3.1.5": "읽기 수준",
  TEXT_DIFFICULTY: "기타 텍스트 이해도",
  "meta-viewport": "화면 확대 제한"
};

const OTHER_DESCRIPTIONS: Record<string, string> = {
  "WCAG 3.1.5": "글이 어려우면 쉬운 요약이나 보충 설명을 함께 제공해 누구나 내용을 이해할 수 있어야 합니다.",
  TEXT_DIFFICULTY: "문장은 어려운 낱말이나 복잡한 구조 없이 쉽게 읽히도록 써야 합니다.",
  "meta-viewport": "사용자가 화면을 확대해 볼 수 있도록 확대를 막지 않아야 합니다."
};

const descriptions = new Map<string, string>([
  ...KWCAG_PRINCIPLES.flatMap((principle) => principle.criteria.map((criterion) => [criterion.code, criterion.description] as const)),
  ...Object.entries(OTHER_DESCRIPTIONS)
]);

/** What a criterion asks of a page, or null for a code without one. */
export function describeCriterion(issueCode: string): string | null {
  const code = normalizeIssueCode(issueCode).replace(/^KWCAG\s+/i, "");
  return descriptions.get(code) ?? null;
}

export function buildCriteriaOverview(
  rows: readonly RecentIssueRow[],
  completedEngines: ReadonlySet<AnalyzerType>,
  unknownEngines: ReadonlySet<AnalyzerType> = new Set()
): CriteriaOverview {
  const issueCounts = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const row of rows) {
    const code = normalizeIssueCode(row.issue.issueCode).replace(/^KWCAG\s+/i, "") || "기타";
    issueCounts.set(code, (issueCounts.get(code) ?? 0) + 1);
    if (!titles.has(code) && row.issue.issueTitle) titles.set(code, row.issue.issueTitle);
  }
  const counts: Record<CriterionStatus, number> = { fail: 0, pass: 0, unknown: 0, skipped: 0, manual: 0 };
  const known = new Set<string>();
  const principles = KWCAG_PRINCIPLES.map((principle) => ({
    name: principle.name,
    criteria: principle.criteria.map((criterion) => {
      known.add(criterion.code);
      const count = issueCounts.get(criterion.code) ?? 0;
      const status: CriterionStatus = count > 0 ? "fail"
        : criterion.engines.length === 0 ? "manual"
          : criterion.engines.some((engine) => completedEngines.has(engine)) ? "pass"
            : criterion.engines.some((engine) => unknownEngines.has(engine)) ? "unknown"
              : "skipped";
      counts[status] += 1;
      return { ...criterion, status, count };
    })
  }));
  const others = [...issueCounts.entries()]
    .filter(([code]) => !known.has(code))
    .map(([code, count]) => ({ code, name: OTHER_NAMES[code] ?? titles.get(code) ?? code, count }));
  return { principles, counts, others };
}
