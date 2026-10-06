import { describe, expect, it } from "vitest";

import type { AnalyzerType, IssueLocatorContent } from "@/types/accessibility-domain";

import { severityChartItems } from "./constants";
import { CONTRAST_GUIDE, CONTRAST_PROBLEM, buildSharedGuidance, describeElement, describeIssueLine, partLabel, readIssue } from "./issue-guidance";
import type { RecentIssueRow } from "./types";

function row(id: number, analyzer: AnalyzerType, message: string, content?: IssueLocatorContent, html = "<a href=\"/\">"): RecentIssueRow {
  const severity = severityChartItems[1]!;
  return {
    severity,
    analyzerType: analyzer,
    issue: {
      id,
      analysisResultId: 1,
      issueCode: "6.4.3",
      issueTitle: "적절한 링크 텍스트",
      ruleId: null,
      severity: severity.key,
      locationPath: "#a",
      locator: { pathSteps: [{ context: "DOCUMENT", selector: "#a" }], htmlSnippet: html, content: content ?? null },
      message,
      recommendation: null,
      resolved: false,
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z"
    }
  };
}

const text = (sentence: string, suggestion: string, rewrite?: string) =>
  [`분석 문장\n${sentence}`, "개선 필요\n• 링크 텍스트 길이 과다: 36글자 (기준: 30글자)", `개선 제안\n${suggestion}`,
    ...(rewrite ? [`수정 예시\n${rewrite}`, "수정 이유\n짧게 줄였습니다."] : [])].join("\n\n");

function shared(rows: RecentIssueRow[]) {
  return buildSharedGuidance(rows, readIssue);
}

describe("shared guidance", () => {
  it("finds advice every finding repeats and still opens it with each finding", () => {
    const rows = [row(1, "AI_TEXT", text("첫 문장", "짧게 쓰세요.")), row(2, "AI_TEXT", text("둘째 문장", "짧게 쓰세요."))];
    const guidance = shared(rows);
    expect(guidance.entries).toEqual([{ label: "이렇게 고치세요", body: "짧게 쓰세요." }]);
    const line = describeIssueLine(rows[0]!, readIssue(rows[0]!), guidance);
    expect(line.title).toBe("첫 문장");
    expect(line.metrics).toEqual(["링크 텍스트 길이 과다: 36글자 (기준: 30글자)"]);
    expect(line.details.map((part) => part.heading)).toEqual(["분석 문장", "개선 제안"]);
    expect(line.details.map(partLabel)).toEqual(["분석 문장", "이렇게 고치세요"]);
  });

  it("keeps advice in each finding when the findings disagree", () => {
    const rows = [row(1, "AI_TEXT", text("가", "짧게 쓰세요.")), row(2, "AI_TEXT", text("나", "쉬운 단어를 쓰세요."))];
    const guidance = shared(rows);
    expect(guidance.entries).toEqual([]);
    expect(describeIssueLine(rows[1]!, readIssue(rows[1]!), guidance).details.map((part) => part.body))
      .toContain("쉬운 단어를 쓰세요.");
  });

  it("never lifts a finding's sentence or rewrite to the group, even when there is one finding", () => {
    const only = row(1, "AI_TEXT", text("문장", "짧게 쓰세요.", "고친 문장"));
    const guidance = shared([only]);
    expect(guidance.entries.map((entry) => entry.label)).toEqual(["이렇게 고치세요"]);
    const line = describeIssueLine(only, readIssue(only), guidance);
    expect(line.compare).toEqual({ before: "문장", after: "고친 문장", reason: "짧게 줄였습니다." });
    expect(line.details).toEqual([{ heading: "개선 제안", body: "짧게 쓰세요." }]);
  });

  it("labels each engine's shared advice when a criterion mixes engines", () => {
    const rows = [
      row(1, "AI_TEXT", text("가", "짧게 쓰세요.")),
      row(2, "AI_TEXT", text("나", "짧게 쓰세요.")),
      row(3, "RULE_BASED", "링크 이름이 없습니다.")
    ];
    expect(shared(rows).entries.map((entry) => entry.label)).toEqual([
      "텍스트 검사 2건 · 이렇게 고치세요",
      "규칙 검사 1건 · 무엇이 문제인가요"
    ]);
  });

  it("reads contrast findings as the measured glyphs with one shared explanation", () => {
    const rows = [
      row(1, "CV_VISION", "text=다운로드, contrast=2.10:1, required=4.5", { text: "자료다운로드", image: null }, "<a href=\"/f\">자료 &amp; 다운로드</a>"),
      row(2, "CV_VISION", "text=뉴스, contrast=1.90:1, required=4.5")
    ];
    const guidance = shared(rows);
    expect(guidance.entries).toEqual([
      { label: "무엇이 문제인가요", body: CONTRAST_PROBLEM },
      { label: "이렇게 고치세요", body: CONTRAST_GUIDE }
    ]);
    const line = describeIssueLine(rows[0]!, readIssue(rows[0]!), guidance);
    expect(line.title).toBe("“다운로드”");
    expect(line.context).toBe("자료 & 다운로드");
    expect(line.details.map((part) => [partLabel(part), part.body])).toEqual([
      ["무엇이 문제인가요", CONTRAST_PROBLEM],
      ["이렇게 고치세요", CONTRAST_GUIDE]
    ]);
  });
});

describe("element names", () => {
  const photo = "https://s.pstatic.net/shopping.phinf/20260929_16/9f141f49-6cf5-412c-bef6-53d9714e61f6.jpg?type=f300";

  it("names an image by its alt text only", () => {
    expect(describeElement(`<img class="recoShoppingView_img__udoPB" src="${photo}" width="90" he`)).toBe("img-alt");
    expect(describeElement(`<img src="${photo}" alt="">`)).toBe("img-alt");
    expect(describeElement(`<img src="${photo}" alt="가을 신상 니트">`)).toBe("img-alt “가을 신상 니트”");
  });

  it("prefers the words a person sees or hears over attributes", () => {
    expect(describeElement('<a href="https://whale.naver.com/ko/" class="link_download">웨일 다운로드</a>')).toBe("링크 “웨일 다운로드”");
    expect(describeElement('<a href="/newmens" role="tab" aria-selected="false" title="맨즈는 광고영역입니다.">맨즈</a>'))
      .toBe("탭 “맨즈”");
    expect(describeElement('<button aria-label="검색 열기"><svg></svg></button>')).toBe("버튼 “검색 열기”");
    expect(describeElement('<input type="search" placeholder="검색어 입력">')).toBe("검색창 “검색어 입력”");
  });

  it("reads a snippet cut inside a tag without leaking markup", () => {
    expect(describeElement('<a href="/trendreco" role="tab">지금뜨는<')).toBe("탭 “지금뜨는”");
    expect(describeElement('<a href="/promotion" class="Menu-module-scss-module__sWjwWG__tab" role="tab" data-nlog')).toBe("탭");
  });

  it("uses a finding's element name instead of its markup as the title", () => {
    const image = row(1, "RULE_BASED", "이미지에 대체 텍스트가 없습니다.", undefined, `<img src="${photo}">`);
    expect(describeIssueLine(image, readIssue(image), shared([image])).title).toBe("img-alt");
  });
});
