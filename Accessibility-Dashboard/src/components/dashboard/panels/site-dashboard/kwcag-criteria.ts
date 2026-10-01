import type { AnalyzerType } from "@/types/accessibility-domain";

import { normalizeIssueCode } from "./constants";
import type { RecentIssueRow } from "./types";

type Criterion = { code: string; name: string; engines: AnalyzerType[] };

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
    { code: "5.1.1", name: "적절한 대체 텍스트 제공", engines: [R] },
    { code: "5.2.1", name: "자막 제공", engines: [R] },
    { code: "5.3.1", name: "표의 구성", engines: [R] },
    { code: "5.3.2", name: "콘텐츠의 선형구조", engines: [] },
    { code: "5.3.3", name: "명확한 지시사항 제공", engines: [T] },
    { code: "5.4.1", name: "색에 무관한 콘텐츠 인식", engines: [R] },
    { code: "5.4.2", name: "자동 재생 금지", engines: [R] },
    { code: "5.4.3", name: "텍스트 콘텐츠의 명도 대비", engines: [R, C] },
    { code: "5.4.4", name: "콘텐츠 간의 구분", engines: [R] }
  ] },
  { name: "운용의 용이성", criteria: [
    { code: "6.1.1", name: "키보드 사용 보장", engines: [R] },
    { code: "6.1.2", name: "초점 이동과 표시", engines: [] },
    { code: "6.1.3", name: "조작 가능", engines: [R] },
    { code: "6.1.4", name: "문자 단축키", engines: [] },
    { code: "6.2.1", name: "응답시간 조절", engines: [R] },
    { code: "6.2.2", name: "정지 기능 제공", engines: [R] },
    { code: "6.3.1", name: "깜빡임과 번쩍임 사용 제한", engines: [] },
    { code: "6.4.1", name: "반복 영역 건너뛰기", engines: [R] },
    { code: "6.4.2", name: "제목 제공", engines: [R, T] },
    { code: "6.4.3", name: "적절한 링크 텍스트", engines: [R, T] },
    { code: "6.4.4", name: "고정된 참조 위치 정보", engines: [] },
    { code: "6.5.1", name: "단일 포인터 입력 지원", engines: [] },
    { code: "6.5.2", name: "포인터 입력 취소", engines: [] },
    { code: "6.5.3", name: "레이블과 네임", engines: [] },
    { code: "6.5.4", name: "동작기반 작동", engines: [] }
  ] },
  { name: "이해의 용이성", criteria: [
    { code: "7.1.1", name: "기본 언어 표시", engines: [R] },
    { code: "7.2.1", name: "사용자 요구에 따른 실행", engines: [R] },
    { code: "7.2.2", name: "찾기 쉬운 도움 정보", engines: [] },
    { code: "7.3.1", name: "오류 정정", engines: [R] },
    { code: "7.3.2", name: "레이블 제공", engines: [R, T] },
    { code: "7.3.3", name: "접근 가능한 인증", engines: [] },
    { code: "7.3.4", name: "반복 입력 정보", engines: [] }
  ] },
  { name: "견고성", criteria: [
    { code: "8.1.1", name: "마크업 오류 방지", engines: [R] },
    { code: "8.2.1", name: "웹 애플리케이션 접근성 준수", engines: [R] }
  ] }
];

/**
 * fail: issues were found. pass: an engine that checks it finished without
 * finding any. skipped: every engine that checks it failed or did not run.
 * manual: no engine checks it, so a person must.
 */
export type CriterionStatus = "fail" | "pass" | "skipped" | "manual";

export type CriterionResult = Criterion & { status: CriterionStatus; count: number };

export type CriteriaOverview = {
  principles: Array<{ name: string; criteria: CriterionResult[] }>;
  counts: Record<CriterionStatus, number>;
  /** Issue codes outside the 33 criteria, such as WCAG-only recommendations. */
  others: Array<{ code: string; count: number }>;
};

export function buildCriteriaOverview(
  rows: readonly RecentIssueRow[],
  completedEngines: ReadonlySet<AnalyzerType>
): CriteriaOverview {
  const issueCounts = new Map<string, number>();
  for (const row of rows) {
    const code = normalizeIssueCode(row.issue.issueCode).replace(/^KWCAG\s+/i, "") || "기타";
    issueCounts.set(code, (issueCounts.get(code) ?? 0) + 1);
  }
  const counts: Record<CriterionStatus, number> = { fail: 0, pass: 0, skipped: 0, manual: 0 };
  const known = new Set<string>();
  const principles = KWCAG_PRINCIPLES.map((principle) => ({
    name: principle.name,
    criteria: principle.criteria.map((criterion) => {
      known.add(criterion.code);
      const count = issueCounts.get(criterion.code) ?? 0;
      const status: CriterionStatus = count > 0 ? "fail"
        : criterion.engines.length === 0 ? "manual"
          : criterion.engines.some((engine) => completedEngines.has(engine)) ? "pass"
            : "skipped";
      counts[status] += 1;
      return { ...criterion, status, count };
    })
  }));
  const others = [...issueCounts.entries()]
    .filter(([code]) => !known.has(code))
    .map(([code, count]) => ({ code, count }));
  return { principles, counts, others };
}
