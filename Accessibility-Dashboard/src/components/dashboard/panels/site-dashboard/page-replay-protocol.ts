import type { IssueLocatorPathStep } from "@/types/accessibility-domain";

import { normalizeIssueCode } from "./constants";
import { getReplayIssuePathSteps } from "./issue-locator";
import type { RecentIssueRow } from "./types";

export const DASHBOARD_REPLAY_SOURCE = "accessibility-dashboard" as const;
export const PAGE_REPLAY_SOURCE = "accessibility-page-replay" as const;
export const REPLAY_VIEW_SCALE_MIN = 0.01;
export const REPLAY_VIEW_SCALE_MAX = 1;
export const REPLAY_VISUAL_WIDTH_MAX = 16_384;

export type ReplayViewportMetrics = {
  scale: number;
  visualWidth: number;
};

const DOCUMENT_TOKEN_MAX_LENGTH = 128;
const LEGACY_TEXT_ANALYSIS_INPUT_MAX_LENGTH = 16_384;

const REPLAY_TEXT_LIMITS = {
  severityLabel: 32,
  code: 128,
  title: 300,
  message: 1_600,
  path: 2_048
} as const;

const TEXT_ANALYSIS_LIMITS = {
  total: 2_400,
  sourceText: 800,
  flag: 320,
  flags: 12,
  suggestion: 600,
  suggestions: 4,
  revisionText: 800,
  revisionReason: 500
} as const;

export type ReplayIssueCategory =
  | "visual"
  | "text"
  | "media"
  | "navigation"
  | "form"
  | "keyboard"
  | "interaction"
  | "structure"
  | "general";

export type ReplayTextAnalysisDetail = {
  kind: "text-analysis";
  sourceText: string;
  flags: string[];
  suggestions: string[];
  revision: {
    text: string;
    reason: string;
  } | null;
};

const RULE_BASED_CATEGORY_BY_KWCAG_CODE: Readonly<Record<string, ReplayIssueCategory>> = {
  "5.1.1": "media",
  "5.2.1": "media",
  "5.3.1": "structure",
  "5.3.2": "structure",
  "5.3.3": "text",
  "5.4.1": "visual",
  "5.4.2": "media",
  "5.4.3": "visual",
  "5.4.4": "visual",
  "6.1.1": "keyboard",
  "6.1.2": "keyboard",
  "6.1.3": "interaction",
  "6.1.4": "keyboard",
  "6.2.1": "interaction",
  "6.2.2": "media",
  "6.3.1": "visual",
  "6.4.1": "keyboard",
  "6.4.2": "structure",
  "6.4.3": "navigation",
  "6.4.4": "navigation",
  "6.5.1": "interaction",
  "6.5.2": "interaction",
  "6.5.3": "form",
  "6.5.4": "interaction",
  "7.1.1": "structure",
  "7.2.1": "interaction",
  "7.2.2": "navigation",
  "7.3.1": "form",
  "7.3.2": "form",
  "7.3.3": "form",
  "7.3.4": "form",
  "8.1.1": "structure",
  "8.2.1": "structure"
};

export type PageReplayIssue = {
  id: number;
  severity: RecentIssueRow["severity"]["key"];
  severityLabel: string;
  category: ReplayIssueCategory;
  code: string;
  title: string;
  message: string;
  textAnalysis: ReplayTextAnalysisDetail | null;
  path: string | null;
  pathSteps: IssueLocatorPathStep[];
};

export type DashboardToPageReplayMessage =
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "REQUEST_DOCUMENT_STATE";
    }
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "INIT_ISSUES";
      issues: PageReplayIssue[];
      selectedIssueId: number | null;
      markersVisible: boolean;
    }
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "FOCUS_ISSUE";
      issueId: number | null;
    }
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "SET_MARKERS_VISIBLE";
      markersVisible: boolean;
    }
  | {
      source: typeof DASHBOARD_REPLAY_SOURCE;
      type: "SET_VIEW_SCALE";
      documentToken: string;
      scale: number;
      visualWidth: number;
    };

export type LocatorConnectionStatus = "CONNECTED" | "UNAVAILABLE";

export type LiveDocumentHealthStatus = "EMPTY" | "MEANINGFUL";

export type PageReplayToDashboardMessage =
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "DOCUMENT_LOADING" | "DOCUMENT_UNLOADING" | "READY";
      documentToken: string;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "DOCUMENT_HEALTH";
      documentToken: string;
      status: LiveDocumentHealthStatus;
      consecutiveMeaningfulSamples: number;
      visibleControlCount: number;
      visibleElementCount: number;
      visibleImageCount: number;
      largestVisibleVisualArea: number;
      visibleTextLength: number;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "ISSUE_SELECTED";
      documentToken: string;
      issueId: number | null;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "ISSUE_DETAIL_FALLBACK";
      documentToken: string;
      issueId: number | null;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "LOCATOR_STATUS";
      documentToken: string;
      issueId: number;
      status: LocatorConnectionStatus;
      reason?: string;
    }
  | {
      source: typeof PAGE_REPLAY_SOURCE;
      type: "LINK_BLOCKED";
      documentToken: string;
      href?: string;
    };

export type LiveDocumentHealthMessage = Extract<
  PageReplayToDashboardMessage,
  { type: "DOCUMENT_HEALTH" }
>;

const LIVE_DOCUMENT_MIN_TEXT_LENGTH = 12;
const LIVE_DOCUMENT_MIN_CONTROL_COUNT = 2;
const LIVE_DOCUMENT_MIN_IMAGE_COUNT = 2;
const LIVE_DOCUMENT_MIN_VISIBLE_VISUAL_AREA = 10_000;
const LIVE_DOCUMENT_MIN_STABLE_SAMPLES = 4;

export function isMeaningfulLiveDocumentHealth(
  message: LiveDocumentHealthMessage
): boolean {
  const hasSubstantiveContent =
    message.visibleTextLength >= LIVE_DOCUMENT_MIN_TEXT_LENGTH ||
    message.visibleControlCount >= LIVE_DOCUMENT_MIN_CONTROL_COUNT ||
    message.visibleImageCount >= LIVE_DOCUMENT_MIN_IMAGE_COUNT ||
    message.largestVisibleVisualArea >= LIVE_DOCUMENT_MIN_VISIBLE_VISUAL_AREA;
  return (
    message.status === "MEANINGFUL" &&
    message.consecutiveMeaningfulSamples >= LIVE_DOCUMENT_MIN_STABLE_SAMPLES &&
    hasSubstantiveContent
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isValidReplayViewportMetrics(
  value: unknown
): value is ReplayViewportMetrics {
  if (!isRecord(value)) return false;
  const { scale, visualWidth } = value;
  return (
    typeof scale === "number"
    && Number.isFinite(scale)
    && scale >= REPLAY_VIEW_SCALE_MIN
    && scale <= REPLAY_VIEW_SCALE_MAX
    && typeof visualWidth === "number"
    && Number.isFinite(visualWidth)
    && visualWidth > 0
    && visualWidth <= REPLAY_VISUAL_WIDTH_MAX
  );
}

function isIssueId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}

function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isDocumentToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DOCUMENT_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function toPageReplayIssue(row: RecentIssueRow): PageReplayIssue {
  const code = toBoundedReplayText(
    normalizeIssueCode(row.issue.issueCode),
    REPLAY_TEXT_LIMITS.code,
    "UNKNOWN"
  );
  const textAnalysis = row.analyzerType === "AI_TEXT"
    ? parseLegacyTextAnalysisMessage(row.issue.message)
    : null;
  const displayMessage = textAnalysis
    ? formatTextAnalysisMessage(textAnalysis)
    : row.issue.message;

  return {
    id: row.issue.id,
    severity: row.severity.key,
    severityLabel: toBoundedReplayText(
      row.severity.label,
      REPLAY_TEXT_LIMITS.severityLabel,
      row.severity.key
    ),
    category: classifyReplayIssueCategory(row, code),
    code,
    title: toBoundedReplayText(
      row.issue.issueTitle,
      REPLAY_TEXT_LIMITS.title,
      "접근성 문제"
    ),
    message: toBoundedReplayText(
      displayMessage,
      REPLAY_TEXT_LIMITS.message,
      "상세 설명이 없습니다."
    ),
    textAnalysis,
    path: toOptionalBoundedReplayText(row.issue.locationPath, REPLAY_TEXT_LIMITS.path),
    pathSteps: getReplayIssuePathSteps(row.issue)
  };
}

export function parseLegacyTextAnalysisMessage(
  value: string | null | undefined
): ReplayTextAnalysisDetail | null {
  if (typeof value !== "string" || value.length > LEGACY_TEXT_ANALYSIS_INPUT_MAX_LENGTH) {
    return null;
  }
  const message = value.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();
  if (!message.startsWith("text=")) return null;

  const revisionMarker = "\nllm_revision=";
  const suggestionsMarker = "\nsuggestions=";
  const flagsMarker = "\nflags=";
  const revisionIndex = message.lastIndexOf(revisionMarker);
  const suggestionsBoundary = revisionIndex >= 0 ? revisionIndex : message.length;
  const suggestionsIndex = message.lastIndexOf(suggestionsMarker, suggestionsBoundary - 1);
  const flagsBoundary = suggestionsIndex >= 0 ? suggestionsIndex : suggestionsBoundary;
  const flagsIndex = message.lastIndexOf(flagsMarker, flagsBoundary - 1);
  if (flagsIndex < "text=".length) return null;
  if (
    message.indexOf(flagsMarker) !== flagsIndex
    || (suggestionsIndex >= 0 && message.indexOf(suggestionsMarker) !== suggestionsIndex)
    || (revisionIndex >= 0 && message.indexOf(revisionMarker) !== revisionIndex)
  ) {
    return null;
  }

  const sourceText = toOptionalBoundedReplayText(
    message.slice("text=".length, flagsIndex),
    TEXT_ANALYSIS_LIMITS.sourceText
  ) ?? "";
  const flagsEnd = suggestionsIndex >= 0 ? suggestionsIndex : suggestionsBoundary;
  const flags = parseTextAnalysisFlags(
    message.slice(flagsIndex + flagsMarker.length, flagsEnd)
  );
  if (!flags) return null;

  const suggestions = suggestionsIndex >= 0
    ? parseTextAnalysisSuggestions(
        message.slice(suggestionsIndex + suggestionsMarker.length, suggestionsBoundary)
      )
    : [];
  const revision = revisionIndex >= 0
    ? parseTextAnalysisRevision(message.slice(revisionIndex + revisionMarker.length))
    : null;
  if (revisionIndex >= 0 && !revision) return null;
  if (!sourceText && flags.length === 0 && suggestions.length === 0 && !revision) return null;

  return boundTextAnalysisDetail({
    kind: "text-analysis",
    sourceText,
    flags,
    suggestions,
    revision
  });
}

function boundTextAnalysisDetail(
  detail: ReplayTextAnalysisDetail
): ReplayTextAnalysisDetail {
  let remaining = TEXT_ANALYSIS_LIMITS.total;
  const take = (value: string) => {
    if (remaining <= 0) return "";
    const normalized = value.slice(0, remaining);
    remaining -= normalized.length;
    return normalized;
  };
  const sourceText = take(detail.sourceText);
  const flags = detail.flags.map(take).filter(Boolean);
  const suggestions = detail.suggestions.map(take).filter(Boolean);
  const revisionText = take(detail.revision?.text ?? "");
  const revisionReason = take(detail.revision?.reason ?? "");
  return {
    kind: "text-analysis",
    sourceText,
    flags,
    suggestions,
    revision: revisionText || revisionReason
      ? { text: revisionText, reason: revisionReason }
      : null
  };
}

function parseTextAnalysisFlags(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return null;
    return normalizeTextAnalysisList(
      parsed,
      TEXT_ANALYSIS_LIMITS.flags,
      TEXT_ANALYSIS_LIMITS.flag
    );
  } catch {
    return null;
  }
}

function parseTextAnalysisSuggestions(value: string): string[] {
  const normalized = value.trim();
  if (!normalized) return [];

  if (normalized.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        const guides = parsed.map((entry) => {
          if (typeof entry === "string") return entry;
          if (isRecord(entry) && typeof entry.guide === "string") return entry.guide;
          return "";
        });
        return normalizeTextAnalysisList(
          guides,
          TEXT_ANALYSIS_LIMITS.suggestions,
          TEXT_ANALYSIS_LIMITS.suggestion
        );
      }
    } catch {
      // The current backend stores concatenated guide text rather than JSON.
    }
  }

  const suggestion = toOptionalBoundedReplayText(
    normalized,
    TEXT_ANALYSIS_LIMITS.suggestion
  );
  return suggestion ? [suggestion] : [];
}

function parseTextAnalysisRevision(
  value: string
): ReplayTextAnalysisDetail["revision"] {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    if (!isRecord(parsed)) return null;
    if (
      (hasOwnKey(parsed, "revised_text") && typeof parsed.revised_text !== "string")
      || (hasOwnKey(parsed, "reason") && typeof parsed.reason !== "string")
    ) {
      return null;
    }
    const text = toOptionalBoundedReplayText(
      typeof parsed.revised_text === "string" ? parsed.revised_text : "",
      TEXT_ANALYSIS_LIMITS.revisionText
    ) ?? "";
    const reason = toOptionalBoundedReplayText(
      typeof parsed.reason === "string" ? parsed.reason : "",
      TEXT_ANALYSIS_LIMITS.revisionReason
    ) ?? "";
    return text || reason ? { text, reason } : null;
  } catch {
    return null;
  }
}

function normalizeTextAnalysisList(
  values: unknown[],
  maximumItems: number,
  maximumLength: number
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = toOptionalBoundedReplayText(
      typeof value === "string" ? value : "",
      maximumLength
    );
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximumItems) break;
  }
  return result;
}

function formatTextAnalysisMessage(detail: ReplayTextAnalysisDetail): string {
  const sections: string[] = [];
  if (detail.sourceText) sections.push(`분석 문장\n${detail.sourceText}`);
  if (detail.flags.length > 0) {
    sections.push(`개선 필요\n${detail.flags.map((flag) => `• ${flag}`).join("\n")}`);
  }
  if (detail.suggestions.length > 0) {
    sections.push(`개선 제안\n${detail.suggestions.map((suggestion) => `• ${suggestion}`).join("\n")}`);
  }
  if (detail.revision?.text) sections.push(`수정 예시\n${detail.revision.text}`);
  if (detail.revision?.reason) sections.push(`수정 이유\n${detail.revision.reason}`);
  return sections.join("\n\n");
}

export function classifyReplayIssueCategory(
  row: Pick<RecentIssueRow, "analyzerType" | "issue">,
  normalizedCode = normalizeIssueCode(row.issue.issueCode)
): ReplayIssueCategory {
  if (row.analyzerType === "AI_TEXT") {
    return "text";
  }
  if (row.analyzerType === "CV_VISION") {
    return "visual";
  }

  const code = normalizedCode.trim().replace(/^(?:KWCAG|WCAG)\s+/i, "");
  const mappedCategory = RULE_BASED_CATEGORY_BY_KWCAG_CODE[code];
  if (mappedCategory) {
    return mappedCategory;
  }

  const signature = [normalizedCode, row.issue.issueTitle].join(" ").toUpperCase();
  if (/(?:COLOR|CONTRAST|VISUAL|CV_|명도|대비|색상|시각)/.test(signature)) return "visual";
  if (/(?:IMAGE|IMG|ALT|CAPTION|VIDEO|AUDIO|MEDIA|대체 텍스트|자막|자동 재생)/.test(signature)) return "media";
  if (/(?:LINK|NAV|BYPASS|SKIP|링크|탐색|건너뛰기|참조 위치)/.test(signature)) return "navigation";
  if (/(?:FORM|INPUT|LABEL|AUTH|ERROR|레이블|입력|인증|오류 정정)/.test(signature)) return "form";
  if (/(?:POINTER|TARGET_SIZE|GESTURE|포인터|동작기반|조작 가능|응답시간|사용자 요구)/.test(signature)) return "interaction";
  if (/(?:KEYBOARD|FOCUS|SHORTCUT|키보드|초점|단축키)/.test(signature)) return "keyboard";
  if (/(?:ARIA|ROLE|MARKUP|TABLE|STRUCTURE|SEMANTIC|표의 구성|선형구조|마크업)/.test(signature)) return "structure";
  if (/(?:TEXT_DIFFICULTY|READING|LANG|TITLE|HEADING|TEXT|텍스트|문장|언어|제목)/.test(signature)) return "text";
  return "general";
}

function toBoundedReplayText(
  value: string | null | undefined,
  maxLength: number,
  fallback: string
): string {
  const normalized = typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
  return (normalized || fallback).slice(0, maxLength);
}

function toOptionalBoundedReplayText(
  value: string | null | undefined,
  maxLength: number
): string | null {
  const normalized = typeof value === "string" ? value.replace(/\0/g, "").trim() : "";
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function parsePageReplayMessage(value: unknown): PageReplayToDashboardMessage | null {
  if (!isRecord(value) || value.source !== PAGE_REPLAY_SOURCE || typeof value.type !== "string") {
    return null;
  }

  if (
    (value.type === "DOCUMENT_LOADING" ||
      value.type === "DOCUMENT_UNLOADING" ||
      value.type === "READY") &&
    hasExactOwnKeys(value, ["source", "type", "documentToken"]) &&
    isDocumentToken(value.documentToken)
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: value.type,
      documentToken: value.documentToken
    };
  }

  if (
    value.type === "DOCUMENT_HEALTH" &&
    hasExactOwnKeys(value, [
      "source",
      "type",
      "documentToken",
      "status",
      "consecutiveMeaningfulSamples",
      "visibleControlCount",
      "visibleElementCount",
      "visibleImageCount",
      "largestVisibleVisualArea",
      "visibleTextLength"
    ]) &&
    isDocumentToken(value.documentToken) &&
    (value.status === "EMPTY" || value.status === "MEANINGFUL") &&
    isBoundedCount(value.consecutiveMeaningfulSamples) &&
    isBoundedCount(value.visibleControlCount) &&
    isBoundedCount(value.visibleElementCount) &&
    isBoundedCount(value.visibleImageCount) &&
    isBoundedCount(value.largestVisibleVisualArea) &&
    isBoundedCount(value.visibleTextLength)
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "DOCUMENT_HEALTH",
      documentToken: value.documentToken,
      status: value.status,
      consecutiveMeaningfulSamples: value.consecutiveMeaningfulSamples,
      visibleControlCount: value.visibleControlCount,
      visibleElementCount: value.visibleElementCount,
      visibleImageCount: value.visibleImageCount,
      largestVisibleVisualArea: value.largestVisibleVisualArea,
      visibleTextLength: value.visibleTextLength
    };
  }

  if (
    value.type === "ISSUE_SELECTED" &&
    hasExactOwnKeys(value, ["source", "type", "documentToken", "issueId"]) &&
    isDocumentToken(value.documentToken) &&
    (value.issueId === null || isIssueId(value.issueId))
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "ISSUE_SELECTED",
      documentToken: value.documentToken,
      issueId: value.issueId
    };
  }

  if (
    value.type === "ISSUE_DETAIL_FALLBACK" &&
    hasExactOwnKeys(value, ["source", "type", "documentToken", "issueId"]) &&
    isDocumentToken(value.documentToken) &&
    (value.issueId === null || isIssueId(value.issueId))
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "ISSUE_DETAIL_FALLBACK",
      documentToken: value.documentToken,
      issueId: value.issueId
    };
  }

  if (
    value.type === "LOCATOR_STATUS" &&
    hasExactOwnKeys(
      value,
      hasOwnKey(value, "reason")
        ? ["source", "type", "documentToken", "issueId", "status", "reason"]
        : ["source", "type", "documentToken", "issueId", "status"]
    ) &&
    isDocumentToken(value.documentToken) &&
    isIssueId(value.issueId) &&
    (value.status === "CONNECTED" || value.status === "UNAVAILABLE") &&
    (value.reason === undefined || typeof value.reason === "string")
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "LOCATOR_STATUS",
      documentToken: value.documentToken,
      issueId: value.issueId,
      status: value.status,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {})
    };
  }

  if (
    value.type === "LINK_BLOCKED" &&
    hasExactOwnKeys(
      value,
      hasOwnKey(value, "href")
        ? ["source", "type", "documentToken", "href"]
        : ["source", "type", "documentToken"]
    ) &&
    isDocumentToken(value.documentToken) &&
    (value.href === undefined || typeof value.href === "string")
  ) {
    return {
      source: PAGE_REPLAY_SOURCE,
      type: "LINK_BLOCKED",
      documentToken: value.documentToken,
      ...(typeof value.href === "string" ? { href: value.href } : {})
    };
  }

  return null;
}
