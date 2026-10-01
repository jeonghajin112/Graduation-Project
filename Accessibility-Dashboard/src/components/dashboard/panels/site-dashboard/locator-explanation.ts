import { getLocatorExplanationKey, locatorLabels, type LocatorExplanationKey, type LocatorExplanationOptions } from "./locator-labels";
import type { LocatorIssueState } from "./types";

// A finding shown on another element than itself, and why. The rail lists
// never contain on-page findings, so these labels live with the details.
const presentations: Record<string, { label: string; ownedLabel?: string; description: string }> = {
  SCREEN_READER_ONLY: {
    label: "스크린리더 전용 텍스트",
    ownedLabel: "{owner}의 스크린리더 전용 텍스트",
    description: "화면에는 보이지 않고 스크린리더가 읽는 텍스트입니다. 이 텍스트가 속한 {owner}에 마커를 표시합니다."
  },
  INVISIBLE_ELEMENT: {
    label: "보이지 않는 요소",
    ownedLabel: "{owner} 안의 보이지 않는 요소",
    description: "크기가 없어 눈에 보이지 않지만 스크린리더와 키보드로는 접근할 수 있는 요소입니다. 이 요소가 속한 {owner}에 마커를 표시합니다."
  },
  TRANSPARENT_ELEMENT: {
    label: "투명한 요소",
    description: "투명도가 0이라 눈에 보이지 않는 요소입니다. 크기와 위치는 그대로 있으므로 요소가 있는 자리에 마커와 테두리를 표시합니다."
  },
  HIDDEN_IN_PLACE: {
    label: "숨겨진 요소(visibility)",
    description: "visibility:hidden으로 숨겨진 요소입니다. 크기와 위치는 그대로 있으므로 요소가 있는 자리에 마커와 테두리를 표시합니다."
  },
  REVEALED_BY_CONTROL: {
    label: "닫힌 탭·메뉴 안의 요소",
    ownedLabel: "닫힌 탭·메뉴 안의 요소 · 여는 {owner}에 표시",
    description: "닫힌 탭이나 메뉴 안에 있어 지금은 보이지 않는 요소입니다. 누르면 이 요소를 보여 주는 {owner}에 마커를 표시합니다."
  },
  SHADOW_HOST: {
    label: "닫힌 Shadow DOM 안의 요소 · 대략적 위치",
    description: "들어갈 수 없는 닫힌 Shadow DOM 안에 있는 요소입니다. 정확한 위치 대신 이를 감싼 바깥 요소에 마커를 표시합니다."
  },
  FRAME_CONTENT: {
    label: "프레임 안의 요소",
    description: "iframe 안에 있는 요소입니다. 프레임 내부의 정확한 위치 대신 프레임 영역에 마커를 표시합니다."
  },
  ASSISTIVE_HIDDEN: {
    label: "보조기기에서 숨김",
    description: "화면에는 보이지만 aria-hidden이 설정되어 스크린리더가 읽지 않는 요소입니다."
  },
  ASSISTIVE_INERT: {
    label: "조작이 막힌 요소",
    description: "화면에는 보이지만 inert가 설정되어 선택하거나 입력할 수 없는 요소입니다."
  },
  APPROXIMATE_AREA: {
    label: "숨겨진 영역의 요소 · 대략적 위치",
    ownedLabel: "{owner} 안의 숨겨진 요소 · 대략적 위치",
    description: "닫힌 탭, 접힌 메뉴, 넘어간 슬라이드처럼 지금은 숨겨진 곳에 있는 요소입니다. 정확한 위치를 알 수 없어 이 요소가 들어 있는 {owner}에 대략적으로 마커를 표시합니다."
  }
};

const ownerLabels: Record<string, string> = {
  LINK: "링크", BUTTON: "버튼", FORM_CONTROL: "입력 요소", TABLE: "표", REGION: "영역", ELEMENT: "상위 요소"
};

function presentationFor(state?: LocatorIssueState) {
  const onPage = state?.status === "VISIBLE" || state?.status === "CONNECTED" || state?.status === "OFFSCREEN";
  return onPage && state.reason && Object.prototype.hasOwnProperty.call(presentations, state.reason)
    ? presentations[state.reason]
    : undefined;
}

export function hasLocatorPresentation(state?: LocatorIssueState): boolean {
  return presentationFor(state) !== undefined;
}

const descriptions: Record<LocatorExplanationKey, string> = {
  checking: "현재 페이지에서 이 문제의 위치를 확인하고 있습니다.",
  coordinate: "요소 경로가 없는 시각 검사 결과입니다. 분석 화면에서 측정한 좌표에 표시하므로, 분석 이후 페이지 배치가 바뀌었다면 실제 글자와 어긋날 수 있습니다.",
  visible: "요소의 위치가 다시 연결되었습니다. 현재 화면에서 해당 위치로 이동할 수 있습니다.",
  offscreen: "요소는 현재 페이지에 있습니다. 해당 위치로 스크롤해서 확인할 수 있습니다.",
  otherSlide: "현재 보이지 않는 슬라이드에 있습니다. ‘문제 위치로 이동’을 누르면 해당 슬라이드로 전환됩니다.",
  missingPath: "분석 결과에 현재 페이지의 요소를 찾을 경로가 저장되어 있지 않습니다.",
  invalidPath: "저장된 요소 경로를 현재 페이지에서 해석하지 못했습니다.",
  notFound: "저장된 경로와 일치하는 요소가 현재 페이지에 없습니다. 분석 이후 구조가 바뀌었거나 아직 생성되지 않았을 수 있습니다.",
  detached: "찾았던 요소가 페이지 갱신 과정에서 제거되었습니다.",
  contentChanged: "저장된 경로의 현재 내용이 분석한 문장과 다릅니다. 다른 내용에 마커를 표시하지 않습니다. 페이지를 다시 분석해 최신 결과를 확인해 주세요.",
  frame: "iframe 안에 있는 요소입니다. 현재 뷰어는 프레임 내부 위치 추적을 지원하지 않습니다.",
  shadowRoot: "요소가 있는 Shadow DOM에 접근하지 못했습니다. 저장된 경로에서 바깥 요소와 내부 경로를 확인할 수 있습니다.",
  unsupportedContext: "저장된 위치 형식을 현재 뷰어가 지원하지 않습니다.",
  ariaHidden: "요소나 상위 영역에 aria-hidden이 설정되어 있습니다. 실제로 눈에 보일 수도 있지만 현재 뷰어는 숨김 상태로 분류합니다.",
  inert: "요소나 상위 영역에 inert가 설정되어 상호작용이 비활성화되어 있습니다.",
  noLayoutBox: "요소에 너비·높이를 가진 표시 영역이 없어 마커를 붙일 수 없습니다.",
  zeroOpacity: "요소나 상위 영역의 투명도가 0으로 설정되어 있습니다.",
  hidden: "요소나 상위 영역이 숨겨져 있습니다. 닫힌 팝업이나 접힌 영역에 있는 문제일 수 있습니다.",
  carouselFailed: "분석 당시 슬라이드로 전환하지 못했습니다. 저장된 슬라이드 순서와 요소 경로를 확인해 주세요.",
  limitExceeded: "동적 화면은 최대 5,000개 문제의 위치를 확인합니다. 이 문제는 그 범위를 초과했습니다.",
  hiddenUnknown: "현재 화면에서는 보이지 않으며, 자동으로 해당 장면을 복원할 정보가 없습니다.",
  unknown: "뷰어가 자세한 미표시 이유를 제공하지 않았습니다. 저장된 위치 정보를 참고해 주세요.",
  pageSetting: "뷰포트, 문서 제목, 언어처럼 화면에 그려지지 않고 페이지 전체에 적용되는 설정입니다. 특정 위치가 없으므로 마커를 표시하지 않습니다.",
  focusReveal: "키보드로 초점을 옮기면 나타나는 요소입니다(예: 본문 바로가기). ‘문제 위치로 이동’을 누르면 초점을 옮겨 표시합니다.",
  focusRevealFailed: "초점을 옮겼지만 요소가 화면에 나타나지 않았습니다. 저장된 요소 경로를 확인해 주세요.",
  statusTimeout: "검사 화면이 제한 시간 안에 이 문제의 위치를 알려 주지 않았습니다. 저장된 위치 정보를 참고하거나 화면을 다시 불러와 주세요.",
  replayRejected: "검사 화면이 문제 목록을 받지 못했습니다. 화면을 다시 불러와 주세요.",
  captureMissing: "분석 당시 화면 크기와 배율 정보를 불러오지 못해 좌표로 찾은 문제의 위치를 현재 화면에 맞출 수 없습니다."
};

// Descriptions are only read in the lazily loaded issue details; the page
// detail rail imports the short labels from locator-labels.ts.
export function getLocatorExplanation(
  state?: LocatorIssueState,
  options?: LocatorExplanationOptions
): { label: string; description: string } {
  const presentation = options?.coordinateOnly ? undefined : presentationFor(state);
  if (presentation) {
    const owner = (state?.ownerKind && ownerLabels[state.ownerKind]) || "";
    return {
      label: owner && presentation.ownedLabel ? presentation.ownedLabel.replace("{owner}", owner) : presentation.label,
      description: presentation.description.replace("{owner}", owner || "상위 요소")
    };
  }
  const key = getLocatorExplanationKey(state, options);
  return { label: locatorLabels[key], description: descriptions[key] };
}
