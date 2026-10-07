import type { AnalyzerType } from "@/types/accessibility-domain";

import { analyzerLabels, parseContrastMessage, splitDescriptionSections, type ContrastFinding } from "./final-report";
import { formatIssueDescription } from "./page-replay-protocol";
import type { RecentIssueRow } from "./types";

/** The fixed explanation and advice every visual contrast finding shares. */
export const CONTRAST_PROBLEM = "글자와 배경의 명도 대비가 기준보다 낮아 저시력 사용자가 읽기 어렵습니다.";
export const CONTRAST_GUIDE = "글자색이나 배경색을 바꿔 대비를 기준 이상으로 높여 주세요.";

/** A description part; `heading` null is the unlabelled lead sentence. */
export type IssuePart = { heading: string | null; body: string };

export type IssueReading = {
  parts: IssuePart[];
  contrast: ContrastFinding | null;
};

export function readIssue(row: RecentIssueRow): IssueReading {
  const { issue } = row;
  const contrast = row.analyzerType === "CV_VISION" ? parseContrastMessage(issue.message) : null;
  if (contrast) {
    const parts = [{ heading: null, body: CONTRAST_PROBLEM }, { heading: "개선 안내", body: CONTRAST_GUIDE }];
    return { parts, contrast };
  }
  const formatted = formatIssueDescription(issue.message, row.analyzerType, issue.ruleId);
  return { parts: splitDescriptionSections(formatted), contrast: null };
}

// Only general explanations may move to the group. Sentences, measured
// values and rewrites (분석 문장, 개선 필요, 수정 예시, 수정 이유) belong to one finding.
const GENERAL_HEADINGS = new Set(["개선 안내", "개선 제안", "권장사항"]);

function partKey(part: IssuePart): string {
  return part.heading ?? "";
}

function isGeneral(key: string): boolean {
  return key === "" || GENERAL_HEADINGS.has(key);
}

function sharedLabel(key: string): string {
  return key === "" ? "무엇이 문제인가요" : "이렇게 고치세요";
}

/** How a part is labelled when a finding opens. */
export function partLabel(part: IssuePart): string {
  const key = partKey(part);
  return isGeneral(key) ? sharedLabel(key) : key;
}

export type SharedGuidance = {
  entries: Array<{ label: string; body: string }>;
  /** Whether a part of this row is already said once for the whole group. */
  isShared: (row: RecentIssueRow, part: IssuePart) => boolean;
};

/**
 * A criterion group's findings mostly repeat the same explanation and advice.
 * Text every finding of one engine shares never becomes a finding's title, so
 * the closed rows tell findings apart; with several engines in a group, each
 * engine's shared text is labelled with it.
 */
export function buildSharedGuidance(
  rows: readonly RecentIssueRow[],
  readingOf: (row: RecentIssueRow) => IssueReading
): SharedGuidance {
  const partitions = new Map<string, RecentIssueRow[]>();
  for (const row of rows) {
    const key = row.analyzerType ?? "OTHER";
    const members = partitions.get(key);
    if (members) members.push(row);
    else partitions.set(key, [row]);
  }
  const sharedKeys = new Map<string, Map<string, string>>();
  const entries: SharedGuidance["entries"] = [];
  const labelled = partitions.size > 1;
  for (const [analyzer, members] of partitions) {
    const first = readingOf(members[0]!).parts;
    const shared = new Map<string, string>();
    for (const part of first) {
      const key = partKey(part);
      if (!isGeneral(key) || shared.has(key)) continue;
      const same = members.every((member) =>
        readingOf(member).parts.some((candidate) => partKey(candidate) === key && candidate.body === part.body));
      if (same) shared.set(key, part.body);
    }
    sharedKeys.set(analyzer, shared);
    for (const [key, body] of shared) {
      const prefix = labelled
        ? `${analyzer in analyzerLabels ? analyzerLabels[analyzer as AnalyzerType] : "기타"} 검사 ${members.length.toLocaleString("ko-KR")}건 · `
        : "";
      entries.push({ label: `${prefix}${sharedLabel(key)}`, body });
    }
  }
  return {
    entries,
    isShared: (row, part) => sharedKeys.get(row.analyzerType ?? "OTHER")?.get(partKey(part)) === part.body
  };
}

export type IssueLine = {
  /** The finding's own words: the measured glyphs, the analysed sentence or the problem. */
  title: string;
  /** Context under the title, when the title alone is not enough. */
  context: string | null;
  metrics: string[];
  compare: { before: string; after: string; reason: string | null } | null;
  /** What to show when the row opens, the group's shared advice included. */
  details: IssuePart[];
};

function bodyOf(parts: readonly IssuePart[], heading: string): string | null {
  return parts.find((part) => part.heading === heading)?.body ?? null;
}

const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => entities[entity] ?? entity);
}

/** The words an element showed, read from its stored HTML with spacing kept. */
function visibleText(html: string): string {
  // A stored snippet may stop inside a tag.
  return decode(html.replace(/<[^>]*>/g, " ").replace(/<[^>]*$/, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const roleNames: Record<string, string> = {
  button: "버튼", link: "링크", tab: "탭", menuitem: "메뉴 항목", checkbox: "체크박스", radio: "라디오 버튼",
  img: "이미지", dialog: "대화상자", slider: "슬라이더", switch: "스위치", combobox: "선택 상자", textbox: "입력란",
  heading: "제목", navigation: "메뉴 영역", tabpanel: "탭 내용", listbox: "목록 상자", option: "선택 항목"
};

const tagNames: Record<string, string> = {
  img: "이미지", a: "링크", button: "버튼", select: "선택 상자", textarea: "입력란", input: "입력란",
  iframe: "프레임", frame: "프레임", svg: "그림", video: "동영상", audio: "오디오", table: "표", label: "레이블",
  html: "페이지", p: "문단", form: "입력 양식", ul: "목록", ol: "목록", li: "목록 항목", nav: "메뉴 영역", area: "이미지 영역",
  h1: "제목", h2: "제목", h3: "제목", h4: "제목", h5: "제목", h6: "제목"
};

const inputNames: Record<string, string> = {
  checkbox: "체크박스", radio: "라디오 버튼", submit: "버튼", button: "버튼", reset: "버튼",
  image: "이미지 버튼", search: "검색창", file: "파일 선택"
};

function attribute(openTag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(openTag);
  const value = match ? decode(match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
  return value || null;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A short name for the element a finding points at, instead of its markup:
 * an image is named by its alt text, anything else by its kind and the
 * words that tell it apart.
 */
export function describeElement(html: string, content?: { text?: string | null; image?: string | null } | null): string | null {
  const open = /^\s*<([a-zA-Z][\w-]*)([^>]*)>?/.exec(html);
  const contentText = content?.text?.trim() ?? "";
  const contentImage = content?.image?.trim() ?? "";
  if (!open && !contentText && !contentImage) return null;
  const tag = open?.[1]?.toLowerCase() ?? (contentImage && !contentText ? "img" : "");
  const openTag = open?.[0] ?? "";
  if (tag === "img") {
    const alt = attribute(openTag, "alt");
    return alt ? `img-alt “${clip(alt, 60)}”` : "img-alt";
  }
  const role = attribute(openTag, "role")?.toLowerCase() ?? "";
  const type = tag === "input" ? attribute(openTag, "type")?.toLowerCase() ?? "text" : "";
  const kind = roleNames[role] ?? (type ? inputNames[type] : undefined) ?? tagNames[tag] ?? "요소";
  const text = contentText || visibleText(html);
  const words = attribute(openTag, "aria-label") ?? (text || null)
    ?? attribute(openTag, "title") ?? attribute(openTag, "placeholder")
    ?? (type && type !== "text" ? attribute(openTag, "value") : null);
  return words ? `${kind} “${clip(words.replace(/\s+/g, " "), 60)}”` : kind;
}

function splitMetrics(body: string): string[] {
  return body.split(/\n|•/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** How one finding reads as a single line, given what its group already says. */
export function describeIssueLine(row: RecentIssueRow, reading: IssueReading, shared?: SharedGuidance): IssueLine {
  const { issue } = row;
  const content = issue.locator?.content;
  const html = issue.locator?.htmlSnippet?.trim() ?? "";
  const own = reading.parts.filter((part) => !shared?.isShared(row, part));

  if (reading.contrast) {
    // The measured glyphs are often one character; the element's own words
    // say where they are. An image only says that it is one.
    const context = visibleText(html) || (content?.image ? "이미지 속 글자" : content?.text?.trim() || null);
    return {
      title: reading.contrast.text ? `“${reading.contrast.text}”` : "글자 정보 없음",
      context,
      metrics: [],
      compare: null,
      details: reading.parts
    };
  }

  const sentence = bodyOf(reading.parts, "분석 문장");
  const rewrite = bodyOf(reading.parts, "수정 예시");
  // Only the first unlabelled paragraph names the problem; when the group
  // already says it, later paragraphs are explanation, not a title.
  const firstLead = reading.parts.find((part) => part.heading === null);
  const lead = firstLead && own.includes(firstLead) ? firstLead.body : null;
  const needs = bodyOf(reading.parts, "개선 필요");
  const compare = sentence && rewrite ? { before: sentence, after: rewrite, reason: bodyOf(reading.parts, "수정 이유") } : null;
  const consumed = new Set(["개선 필요", ...(compare ? ["분석 문장", "수정 예시", "수정 이유"] : [])]);
  const title = sentence ?? lead ?? describeElement(html, content) ?? issue.issueTitle;
  return {
    title,
    context: null,
    metrics: needs ? splitMetrics(needs) : [],
    compare,
    // The lead used as the title is not repeated; a long sentence stays
    // readable in full when there is no rewrite to compare it with. Shared
    // advice is kept: the group header explains the criterion instead.
    details: reading.parts.filter((part) => !consumed.has(part.heading ?? "") && !(part.heading === null && part.body === title))
  };
}
