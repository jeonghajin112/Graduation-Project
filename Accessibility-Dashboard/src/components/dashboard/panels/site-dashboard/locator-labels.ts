import type { LocatorIssueState } from "./types";

// One classification feeds the short labels shown in the page detail rail and
// the descriptions in the lazily loaded issue details (locator-explanation.ts).
export type LocatorExplanationKey =
  | "checking" | "coordinate" | "visible" | "offscreen" | "otherSlide"
  | "missingPath" | "invalidPath" | "notFound" | "detached" | "contentChanged"
  | "frame" | "shadowRoot" | "unsupportedContext" | "ariaHidden" | "inert"
  | "noLayoutBox" | "zeroOpacity" | "hidden" | "carouselFailed" | "limitExceeded"
  | "hiddenUnknown" | "unknown" | "pageSetting" | "focusReveal" | "focusRevealFailed"
  | "statusTimeout" | "replayRejected" | "captureMissing" | "captureFailed";

const keysByReason: Record<string, LocatorExplanationKey> = {
  EMPTY_PATH: "missingPath",
  LOCATOR_MISSING: "missingPath",
  INVALID_PATH_STEP: "invalidPath",
  INVALID_SELECTOR: "invalidPath",
  SELECTOR_NOT_FOUND: "notFound",
  ELEMENT_DETACHED: "detached",
  ELEMENT_CONTENT_CHANGED: "contentChanged",
  FRAME_UNSUPPORTED: "frame",
  SHADOW_ROOT_UNAVAILABLE: "shadowRoot",
  UNSUPPORTED_CONTEXT: "unsupportedContext",
  ARIA_HIDDEN_STATE: "ariaHidden",
  INERT_STATE: "inert",
  NO_LAYOUT_BOX: "noLayoutBox",
  ZERO_OPACITY: "zeroOpacity",
  HIDDEN_ATTRIBUTE: "hidden",
  DISPLAY_NONE: "hidden",
  VISIBILITY_HIDDEN: "hidden",
  CONTENT_VISIBILITY_HIDDEN: "hidden",
  CAROUSEL_CONTEXT_MISMATCH: "carouselFailed",
  CAROUSEL_RECOVERY_FAILED: "carouselFailed",
  ISSUE_LIMIT_EXCEEDED: "limitExceeded",
  DOCUMENT_METADATA: "pageSetting",
  FOCUS_REVEAL_FAILED: "focusRevealFailed",
  // Assigned by the dashboard, not the viewer.
  STATUS_TIMEOUT: "statusTimeout",
  REPLAY_REJECTED: "replayRejected",
  CAPTURE_METADATA_MISSING: "captureMissing",
  CAPTURE_METADATA_FAILED: "captureFailed"
};


export type LocatorCategory = "on-page" | "other-state" | "page-setting" | "unavailable";

// One grouping for the rail lists and the report. Findings in a hidden tab,
// menu or slide are shown on the area around them, so they are on the page.
export function getLocatorCategory(state: LocatorIssueState): LocatorCategory {
  if (state.status === "VISIBLE" || state.status === "CONNECTED" || state.status === "OFFSCREEN") return "on-page";
  if (state.status === "HIDDEN_STATE" && state.recoverable === true) return "other-state";
  if (state.reason === "DOCUMENT_METADATA") return "page-setting";
  return "unavailable";
}

export type LocatorExplanationOptions = {
  /** The finding has only an analysis-time box; the viewer places it by coordinates. */
  coordinateOnly?: boolean;
};

export function getLocatorExplanationKey(
  state?: LocatorIssueState,
  { coordinateOnly = false }: LocatorExplanationOptions = {}
): LocatorExplanationKey {
  if (!state) return "checking";
  const onPage = state.status === "VISIBLE" || state.status === "CONNECTED";
  if (coordinateOnly && (onPage || state.status === "OFFSCREEN")) return "coordinate";
  if (onPage) return "visible";
  if (state.status === "OFFSCREEN") return "offscreen";
  if (state.status === "HIDDEN_STATE" && state.recoverable) {
    return state.reason === "FOCUS_TO_REVEAL" ? "focusReveal" : "otherSlide";
  }
  const key = state.reason && Object.prototype.hasOwnProperty.call(keysByReason, state.reason)
    ? keysByReason[state.reason]
    : undefined;
  return key ?? (state.status === "HIDDEN_STATE" ? "hiddenUnknown" : "unknown");
}

export const locatorLabels: Record<LocatorExplanationKey, string> = {
  checking: "위치 확인 중",
  coordinate: "분석 당시 좌표에 표시",
  visible: "현재 화면에서 찾음",
  offscreen: "화면 밖의 요소",
  otherSlide: "다른 슬라이드의 요소",
  missingPath: "요소 경로 없음",
  invalidPath: "요소 경로 오류",
  notFound: "요소를 찾지 못함",
  detached: "페이지에서 사라진 요소",
  contentChanged: "분석 이후 내용이 바뀜",
  frame: "내부 프레임의 요소",
  shadowRoot: "접근할 수 없는 내부 영역",
  unsupportedContext: "지원하지 않는 위치 형식",
  ariaHidden: "접근성 숨김으로 분류됨",
  inert: "비활성 영역의 요소",
  noLayoutBox: "표시할 크기 없음",
  zeroOpacity: "투명한 요소",
  hidden: "현재 숨겨진 요소",
  carouselFailed: "슬라이드 복원 실패",
  limitExceeded: "표시 한도 초과",
  hiddenUnknown: "현재 숨겨진 요소",
  unknown: "위치를 확인하지 못함",
  pageSetting: "페이지 전체 설정",
  focusReveal: "포커스하면 나타나는 요소",
  focusRevealFailed: "포커스해도 나타나지 않음",
  statusTimeout: "위치 확인 시간 초과",
  replayRejected: "검사 화면이 받지 못함",
  captureMissing: "분석 당시 화면 정보 없음",
  captureFailed: "화면 정보를 불러오지 못함"
};

export function getLocatorLabel(state?: LocatorIssueState, options?: LocatorExplanationOptions): string {
  return locatorLabels[getLocatorExplanationKey(state, options)];
}
