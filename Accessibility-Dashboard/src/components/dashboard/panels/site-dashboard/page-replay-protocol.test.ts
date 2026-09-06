import { describe, expect, it } from "vitest";

import type { AnalyzerType, IssueResultModel } from "@/types/accessibility-domain";

import {
  DASHBOARD_REPLAY_SOURCE,
  PAGE_REPLAY_SOURCE,
  REPLAY_VIEW_SCALE_MIN,
  REPLAY_VISUAL_WIDTH_MAX,
  classifyReplayIssueCategory,
  isMeaningfulLiveDocumentHealth,
  isValidReplayViewportMetrics,
  parsePageReplayMessage,
  parseLegacyTextAnalysisMessage,
  toPageReplayIssue
} from "./page-replay-protocol";
import type { DashboardToPageReplayMessage } from "./page-replay-protocol";
import type { RecentIssueRow } from "./types";

function classify(issueCode: string, analyzerType?: AnalyzerType, issueTitle = "접근성 문제") {
  const issue: IssueResultModel = {
    id: 1,
    analysisResultId: 1,
    issueCode,
    issueTitle,
    severity: "LOW",
    locationPath: "#target",
    message: "",
    resolved: false,
    createdAt: "2026-08-31T00:00:00",
    updatedAt: "2026-08-31T00:00:00"
  };

  return classifyReplayIssueCategory({ issue, analyzerType });
}

function replayIssue(
  message: string,
  analyzerType: AnalyzerType = "AI_TEXT",
  locator?: IssueResultModel["locator"]
) {
  const issue: IssueResultModel = {
    id: 7,
    analysisResultId: 2,
    issueCode: "WCAG 3.1.5",
    issueTitle: "읽기 수준",
    severity: "LOW",
    locationPath: "#target",
    ...(locator !== undefined ? { locator } : {}),
    message,
    resolved: false,
    createdAt: "2026-08-31T00:00:00",
    updatedAt: "2026-08-31T00:00:00"
  };
  const row: RecentIssueRow = {
    issue,
    severity: { key: "LOW", label: "낮음", color: "#027a48" },
    analyzerType
  };
  return toPageReplayIssue(row);
}

describe("replay marker issue category", () => {
  it("prioritizes the analyzer module over an ambiguous KWCAG code", () => {
    expect(classify("6.4.3", "AI_TEXT", "긴 링크 텍스트")).toBe("text");
    expect(classify("7.3.2", "AI_TEXT", "긴 레이블 텍스트")).toBe("text");
    expect(classify("5.4.3", "CV_VISION", "시각 명도 대비")).toBe("visual");
  });

  it.each([
    ["5.1.1", "media"],
    ["5.4.3", "visual"],
    ["6.1.3", "interaction"],
    ["6.4.3", "navigation"],
    ["7.3.2", "form"],
    ["8.1.1", "structure"]
  ] as const)("maps rule-based KWCAG %s to %s", (code, category) => {
    expect(classify(code, "RULE_BASED")).toBe(category);
  });

  it("supports legacy text codes and a safe unknown fallback", () => {
    expect(classify("TEXT_DIFFICULTY")).toBe("text");
    expect(classify("UNMAPPED_ENGINE_RULE", undefined, "알 수 없는 문제")).toBe("general");
  });
});

describe("replay locator adaptation", () => {
  it("forwards a validated carousel state and drops malformed state hints", () => {
    const valid = replayIssue("", "RULE_BASED", {
      pathSteps: [{ context: "DOCUMENT", selector: "#target" }],
      carouselContext: { carouselId: 3, slideIndex: 1, slideCount: 4 }
    });
    const invalid = replayIssue("", "RULE_BASED", {
      pathSteps: [{ context: "DOCUMENT", selector: "#target" }],
      carouselContext: { carouselId: 3, slideIndex: 4, slideCount: 4 }
    });
    const oversized = replayIssue("", "RULE_BASED", {
      pathSteps: [{ context: "DOCUMENT", selector: "#target" }],
      carouselContext: { carouselId: 3, slideIndex: 1, slideCount: 10_001 }
    });

    expect(valid.carouselContext).toEqual({ carouselId: 3, slideIndex: 1, slideCount: 4 });
    expect(invalid.carouselContext).toBeNull();
    expect(oversized.carouselContext).toBeNull();
  });
});

describe("replay document and issue messages", () => {
  it.each(["DOCUMENT_LOADING", "DOCUMENT_UNLOADING", "READY"] as const)(
    "accepts %s only with an exact, bounded document identity",
    (type) => {
      const message = { source: PAGE_REPLAY_SOURCE, type, documentToken: "doc_501" };
      expect(parsePageReplayMessage(message)).toEqual(message);

      for (const overrides of [
        { documentToken: undefined },
        { documentToken: "" },
        { documentToken: "bad token" },
        { documentToken: "a".repeat(129) },
        { source: DASHBOARD_REPLAY_SOURCE },
        { unexpected: true }
      ]) {
        expect(parsePageReplayMessage({ ...message, ...overrides })).toBeNull();
      }
    }
  );

  it.each(["ISSUE_SELECTED", "ISSUE_DETAIL_FALLBACK"] as const)(
    "accepts %s as an id or explicit clear, never viewer-supplied content",
    (type) => {
      const message = { source: PAGE_REPLAY_SOURCE, type, documentToken: "doc_501", issueId: 42 };
      expect(parsePageReplayMessage(message)).toEqual(message);
      expect(parsePageReplayMessage({ ...message, issueId: null })).toEqual({ ...message, issueId: null });

      for (const issueId of [undefined, "42", 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(parsePageReplayMessage({ ...message, issueId })).toBeNull();
      }
      expect(parsePageReplayMessage({ ...message, documentToken: undefined })).toBeNull();
      expect(parsePageReplayMessage({ ...message, documentToken: "bad token" })).toBeNull();
      expect(parsePageReplayMessage({ ...message, title: "Untrusted viewer content" })).toBeNull();
    }
  );
});

describe("replay locator status messages", () => {
  it("accepts legacy and render-aware locator status contracts", () => {
    expect(parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: "doc_9001",
      issueId: 9001,
      status: "CONNECTED"
    })).toEqual({
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: "doc_9001",
      issueId: 9001,
      status: "CONNECTED"
    });
    expect(parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: "doc_9002",
      issueId: 9002,
      status: "UNAVAILABLE",
      reason: "SELECTOR_NOT_FOUND"
    })).toEqual({
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: "doc_9002",
      issueId: 9002,
      status: "UNAVAILABLE",
      reason: "SELECTOR_NOT_FOUND"
    });
    expect(parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: "doc_9003",
      issueId: 9003,
      status: "HIDDEN_STATE",
      reason: "CAROUSEL_STATE_AVAILABLE",
      recoverable: true
    })).toEqual({
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: "doc_9003",
      issueId: 9003,
      status: "HIDDEN_STATE",
      reason: "CAROUSEL_STATE_AVAILABLE",
      recoverable: true
    });
    for (const status of ["VISIBLE", "OFFSCREEN"] as const) {
      expect(parsePageReplayMessage({
        source: PAGE_REPLAY_SOURCE,
        type: "LOCATOR_STATUS",
        documentToken: "doc_9004",
        issueId: 9004,
        status
      })).toMatchObject({ type: "LOCATOR_STATUS", status });
    }
  });

  it.each([
    { issueId: 9001, status: "OTHER" },
    { issueId: 0, status: "UNAVAILABLE" },
    { issueId: 1.5, status: "UNAVAILABLE" },
    { issueId: 9001, status: "UNAVAILABLE", documentToken: "bad token" },
    { issueId: 9001, status: "UNAVAILABLE", reason: 42 },
    { issueId: 9001, status: "VISIBLE", recoverable: true },
    { issueId: 9001, status: "HIDDEN_STATE", recoverable: "yes" },
    { issueId: 9001, status: "UNAVAILABLE", extra: true }
  ])("rejects malformed locator status payload %#", (overrides) => {
    const payload: Record<string, unknown> = {
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: "doc_valid",
      issueId: 9001,
      status: "UNAVAILABLE"
    };
    Object.assign(payload, overrides);
    expect(parsePageReplayMessage(payload)).toBeNull();
  });
});

describe("live document health messages", () => {
  it.each(["EMPTY", "MEANINGFUL"] as const)(
    "accepts an exact %s visible-content report",
    (status) => {
      expect(parsePageReplayMessage({
        source: PAGE_REPLAY_SOURCE,
        type: "DOCUMENT_HEALTH",
        documentToken: "live_doc_501",
        status,
        consecutiveMeaningfulSamples: status === "MEANINGFUL" ? 4 : 0,
        visibleControlCount: 0,
        visibleElementCount: status === "MEANINGFUL" ? 12 : 0,
        visibleImageCount: status === "MEANINGFUL" ? 1 : 0,
        largestVisibleVisualArea: status === "MEANINGFUL" ? 24_000 : 0,
        visibleTextLength: status === "MEANINGFUL" ? 48 : 0
      })).toEqual({
        source: PAGE_REPLAY_SOURCE,
        type: "DOCUMENT_HEALTH",
        documentToken: "live_doc_501",
        status,
        consecutiveMeaningfulSamples: status === "MEANINGFUL" ? 4 : 0,
        visibleControlCount: 0,
        visibleElementCount: status === "MEANINGFUL" ? 12 : 0,
        visibleImageCount: status === "MEANINGFUL" ? 1 : 0,
        largestVisibleVisualArea: status === "MEANINGFUL" ? 24_000 : 0,
        visibleTextLength: status === "MEANINGFUL" ? 48 : 0
      });
    }
  );

  it.each([
    { status: "UNKNOWN" },
    { consecutiveMeaningfulSamples: -1 },
    { visibleControlCount: 1.5 },
    { visibleElementCount: -1 },
    { visibleImageCount: 1.5 },
    { largestVisibleVisualArea: 1.5 },
    { largestVisibleVisualArea: 1_000_001 },
    { visibleTextLength: Number.POSITIVE_INFINITY },
    { visibleTextLength: 1_000_001 },
    { unexpected: true }
  ])("rejects malformed document health payload %#", (overrides) => {
    expect(parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "DOCUMENT_HEALTH",
      documentToken: "live_doc_501",
      status: "MEANINGFUL",
      consecutiveMeaningfulSamples: 4,
      visibleControlCount: 0,
      visibleElementCount: 12,
      visibleImageCount: 1,
      largestVisibleVisualArea: 24_000,
      visibleTextLength: 48,
      ...overrides
    })).toBeNull();
  });

  it("requires the complete exact health contract", () => {
    expect(parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "DOCUMENT_HEALTH",
      documentToken: "live_doc_legacy",
      status: "MEANINGFUL",
      consecutiveMeaningfulSamples: 4,
      visibleControlCount: 0,
      visibleElementCount: 2,
      visibleImageCount: 1,
      visibleTextLength: 0
    })).toBeNull();
  });

  it("accepts the first substantive sample but rejects a small loading image", () => {
    const loadingImage = parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "DOCUMENT_HEALTH",
      documentToken: "live_doc_loader",
      status: "MEANINGFUL",
      consecutiveMeaningfulSamples: 8,
      visibleControlCount: 0,
      visibleElementCount: 3,
      visibleImageCount: 1,
      largestVisibleVisualArea: 2_304,
      visibleTextLength: 0
    });
    const visualPage = parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "DOCUMENT_HEALTH",
      documentToken: "live_doc_visual",
      status: "MEANINGFUL",
      consecutiveMeaningfulSamples: 4,
      visibleControlCount: 0,
      visibleElementCount: 2,
      visibleImageCount: 1,
      largestVisibleVisualArea: 10_000,
      visibleTextLength: 0
    });
    const unstableVisualPage = parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "DOCUMENT_HEALTH",
      documentToken: "live_doc_visual_loading",
      status: "MEANINGFUL",
      consecutiveMeaningfulSamples: 1,
      visibleControlCount: 0,
      visibleElementCount: 2,
      visibleImageCount: 1,
      largestVisibleVisualArea: 40_000,
      visibleTextLength: 0
    });
    const substantivePage = parsePageReplayMessage({
      source: PAGE_REPLAY_SOURCE,
      type: "DOCUMENT_HEALTH",
      documentToken: "live_doc_page",
      status: "MEANINGFUL",
      consecutiveMeaningfulSamples: 4,
      visibleControlCount: 0,
      visibleElementCount: 6,
      visibleImageCount: 0,
      largestVisibleVisualArea: 0,
      visibleTextLength: 40
    });

    expect(loadingImage?.type).toBe("DOCUMENT_HEALTH");
    expect(loadingImage?.type === "DOCUMENT_HEALTH" && isMeaningfulLiveDocumentHealth(loadingImage)).toBe(false);
    expect(unstableVisualPage?.type === "DOCUMENT_HEALTH" && isMeaningfulLiveDocumentHealth(unstableVisualPage)).toBe(true);
    expect(visualPage?.type === "DOCUMENT_HEALTH" && isMeaningfulLiveDocumentHealth(visualPage)).toBe(true);
    expect(substantivePage?.type === "DOCUMENT_HEALTH" && isMeaningfulLiveDocumentHealth(substantivePage)).toBe(true);
  });
});

describe("replay viewport scale contract", () => {
  it("accepts bounded finite viewport metrics and exposes the dashboard message shape", () => {
    const message = {
      source: DASHBOARD_REPLAY_SOURCE,
      type: "SET_VIEW_SCALE",
      documentToken: "doc_390",
      scale: 0.3047,
      visualWidth: 390
    } satisfies DashboardToPageReplayMessage;

    expect(isValidReplayViewportMetrics(message)).toBe(true);
    expect(isValidReplayViewportMetrics({
      scale: REPLAY_VIEW_SCALE_MIN,
      visualWidth: REPLAY_VISUAL_WIDTH_MAX
    })).toBe(true);
  });

  it.each([
    { scale: 0, visualWidth: 390 },
    { scale: REPLAY_VIEW_SCALE_MIN / 2, visualWidth: 390 },
    { scale: 1.01, visualWidth: 390 },
    { scale: Number.NaN, visualWidth: 390 },
    { scale: 0.5, visualWidth: 0 },
    { scale: 0.5, visualWidth: REPLAY_VISUAL_WIDTH_MAX + 1 },
    { scale: 0.5, visualWidth: Number.POSITIVE_INFINITY }
  ])("rejects unsafe metrics %#", (metrics) => {
    expect(isValidReplayViewportMetrics(metrics)).toBe(false);
  });
});

describe("legacy AI text issue presentation", () => {
  it("turns raw text, flags, suggestions, and revision fields into bounded sections", () => {
    const message = [
      "text=건축학부 제70회 졸업 전시회 개최",
      'flags=["어려운 어휘 과다: 쉬운 단어 비율 40.0%","어려운 어휘 과다: 쉬운 단어 비율 40.0%"]',
      "suggestions=어려운 표현을 쉬운 단어로 바꾸고 문장을 짧게 나누세요.",
      'llm_revision={"revised_text":"건축학부 졸업 전시회가 열립니다.","reason":"짧고 쉬운 문장으로 바꿨습니다.","model":"internal-model"}'
    ].join("\r\n");

    const issue = replayIssue(message);

    expect(issue.textAnalysis).toEqual({
      kind: "text-analysis",
      sourceText: "건축학부 제70회 졸업 전시회 개최",
      flags: ["어려운 어휘 과다: 쉬운 단어 비율 40.0%"],
      suggestions: ["어려운 표현을 쉬운 단어로 바꾸고 문장을 짧게 나누세요."],
      revision: {
        text: "건축학부 졸업 전시회가 열립니다.",
        reason: "짧고 쉬운 문장으로 바꿨습니다."
      }
    });
    expect(issue.message).toContain("분석 문장\n건축학부 제70회 졸업 전시회 개최");
    expect(issue.message).toContain("개선 필요\n• 어려운 어휘 과다");
    expect(issue.message).toContain("개선 제안\n• 어려운 표현을 쉬운 단어로");
    expect(issue.message).toContain("수정 예시\n건축학부 졸업 전시회가 열립니다.");
    expect(issue.message).not.toContain("flags=");
    expect(issue.message).not.toContain("internal-model");
  });

  it("uses the final line-start flags marker even when the analyzed text contains marker-like text", () => {
    const detail = parseLegacyTextAnalysisMessage(
      'text=안내문에 flags=예시를 표시합니다.\nflags=["문장 길이 과다"]'
    );

    expect(detail?.sourceText).toBe("안내문에 flags=예시를 표시합니다.");
    expect(detail?.flags).toEqual(["문장 길이 과다"]);
  });

  it("preserves malformed AI messages and every non-AI message without guessing", () => {
    const malformed = 'text=검사 문장\nflags={"unexpected":true}';
    const mixedFlags = 'text=검사 문장\nflags=["정상",{"unexpected":true}]';
    const malformedRevision = [
      "text=검사 문장",
      'flags=["문장 길이 과다"]',
      'llm_revision={"revised_text":42,"reason":"수정 이유"}'
    ].join("\n");
    const malformedIssue = replayIssue(malformed);
    const ruleIssue = replayIssue(
      'text=규칙 설명\nflags=["원시 키가 포함된 일반 메시지"]',
      "RULE_BASED"
    );

    expect(malformedIssue.textAnalysis).toBeNull();
    expect(malformedIssue.message).toBe(malformed);
    expect(parseLegacyTextAnalysisMessage(mixedFlags)).toBeNull();
    expect(parseLegacyTextAnalysisMessage(malformedRevision)).toBeNull();
    expect(ruleIssue.textAnalysis).toBeNull();
    expect(ruleIssue.message).toContain("flags=");
  });

  it("fails closed for duplicate section markers and oversized legacy payloads", () => {
    const duplicateMarker = [
      "text=첫 문장",
      'flags=["원문에 섞인 가짜 구간"]',
      'flags=["실제 구간"]'
    ].join("\n");
    const oversized = `text=${"가".repeat(16_384)}\nflags=[]`;

    expect(parseLegacyTextAnalysisMessage(duplicateMarker)).toBeNull();
    expect(parseLegacyTextAnalysisMessage(oversized)).toBeNull();
    expect(replayIssue(oversized).message).toHaveLength(1_600);
  });

  it("caps the complete structured detail independently from individual field limits", () => {
    const message = [
      `text=${"가".repeat(800)}`,
      `flags=${JSON.stringify(Array.from({ length: 12 }, (_, index) => `${index}${"나".repeat(319)}`))}`,
      `suggestions=${"다".repeat(600)}`,
      `llm_revision=${JSON.stringify({ revised_text: "라".repeat(800), reason: "마".repeat(500) })}`
    ].join("\n");
    const detail = parseLegacyTextAnalysisMessage(message);
    const totalLength = detail
      ? detail.sourceText.length
        + detail.flags.join("").length
        + detail.suggestions.join("").length
        + (detail.revision?.text.length ?? 0)
        + (detail.revision?.reason.length ?? 0)
      : 0;

    expect(detail).not.toBeNull();
    expect(totalLength).toBe(2_400);
  });

  it("keeps markup-shaped analyzer content as inert text data", () => {
    const issue = replayIssue(
      'text=<img src=x onerror="window.__xss=1">\nflags=["<script>window.__xss=2</script>"]'
    );

    expect(issue.textAnalysis?.sourceText).toContain("<img");
    expect(issue.textAnalysis?.flags[0]).toContain("<script>");
    expect(issue.message).toContain("<script>");
  });
});
