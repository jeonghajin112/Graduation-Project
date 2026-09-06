import type { LocatorIssueState } from "./types";

export function getLocatorExplanation(state?: LocatorIssueState): { label: string; description: string } {
  if (!state) return { label: "위치 확인 중", description: "현재 페이지에서 이 문제의 위치를 확인하고 있습니다." };
  if (state.status === "VISIBLE" || state.status === "CONNECTED") {
    return { label: "현재 화면에서 찾음", description: "요소의 위치가 다시 연결되었습니다. 현재 화면에서 해당 위치로 이동할 수 있습니다." };
  }
  if (state.status === "OFFSCREEN") {
    return { label: "화면 밖의 요소", description: "요소는 현재 페이지에 있습니다. 해당 위치로 스크롤해서 확인할 수 있습니다." };
  }
  if (state.status === "HIDDEN_STATE" && state.recoverable) {
    return { label: "다른 슬라이드의 요소", description: "현재 보이지 않는 슬라이드에 있습니다. ‘해당 장면에서 보기’로 이동할 수 있습니다." };
  }
  switch (state.reason) {
    case "EMPTY_PATH":
    case "LOCATOR_MISSING":
      return { label: "요소 경로 없음", description: "분석 결과에 현재 페이지의 요소를 찾을 경로가 저장되어 있지 않습니다." };
    case "INVALID_PATH_STEP":
    case "INVALID_SELECTOR":
      return { label: "요소 경로 오류", description: "저장된 요소 경로를 현재 페이지에서 해석하지 못했습니다." };
    case "SELECTOR_NOT_FOUND":
      return { label: "요소를 찾지 못함", description: "저장된 경로와 일치하는 요소가 현재 페이지에 없습니다. 분석 이후 구조가 바뀌었거나 아직 생성되지 않았을 수 있습니다." };
    case "ELEMENT_DETACHED":
      return { label: "페이지에서 사라진 요소", description: "찾았던 요소가 페이지 갱신 과정에서 제거되었습니다." };
    case "ELEMENT_CONTENT_CHANGED":
      return { label: "분석 이후 내용이 바뀜", description: "저장된 경로의 현재 내용이 분석한 문장과 다릅니다. 다른 내용에 마커를 표시하지 않습니다. 페이지를 다시 분석해 최신 결과를 확인해 주세요." };
    case "FRAME_UNSUPPORTED":
      return { label: "내부 프레임의 요소", description: "iframe 안에 있는 요소입니다. 현재 뷰어는 프레임 내부 위치 추적을 지원하지 않습니다." };
    case "SHADOW_ROOT_UNAVAILABLE":
      return { label: "접근할 수 없는 내부 영역", description: "요소가 있는 Shadow DOM에 접근하지 못했습니다. 저장된 경로에서 바깥 요소와 내부 경로를 확인할 수 있습니다." };
    case "UNSUPPORTED_CONTEXT":
      return { label: "지원하지 않는 위치 형식", description: "저장된 위치 형식을 현재 뷰어가 지원하지 않습니다." };
    case "ARIA_HIDDEN_STATE":
      return { label: "접근성 숨김으로 분류됨", description: "요소나 상위 영역에 aria-hidden이 설정되어 있습니다. 실제로 눈에 보일 수도 있지만 현재 뷰어는 숨김 상태로 분류합니다." };
    case "INERT_STATE":
      return { label: "비활성 영역의 요소", description: "요소나 상위 영역에 inert가 설정되어 상호작용이 비활성화되어 있습니다." };
    case "NO_LAYOUT_BOX":
      return { label: "표시할 크기 없음", description: "요소에 너비·높이를 가진 표시 영역이 없어 마커를 붙일 수 없습니다." };
    case "ZERO_OPACITY":
      return { label: "투명한 요소", description: "요소나 상위 영역의 투명도가 0으로 설정되어 있습니다." };
    case "HIDDEN_ATTRIBUTE":
    case "DISPLAY_NONE":
    case "VISIBILITY_HIDDEN":
    case "CONTENT_VISIBILITY_HIDDEN":
      return { label: "현재 숨겨진 요소", description: "요소나 상위 영역이 숨겨져 있습니다. 닫힌 팝업이나 접힌 영역에 있는 문제일 수 있습니다." };
    case "CAROUSEL_CONTEXT_MISMATCH":
    case "CAROUSEL_RECOVERY_FAILED":
      return { label: "슬라이드 복원 실패", description: "분석 당시 슬라이드로 전환하지 못했습니다. 저장된 슬라이드 순서와 요소 경로를 확인해 주세요." };
    case "ISSUE_LIMIT_EXCEEDED":
      return { label: "표시 한도 초과", description: "동적 화면은 최대 5,000개 문제의 위치를 확인합니다. 이 문제는 그 범위를 초과했습니다." };
    default:
      return state.status === "HIDDEN_STATE"
        ? { label: "현재 숨겨진 요소", description: "현재 화면에서는 보이지 않으며, 자동으로 해당 장면을 복원할 정보가 없습니다." }
        : { label: "위치를 확인하지 못함", description: "뷰어가 자세한 미표시 이유를 제공하지 않았습니다. 저장된 위치 정보를 참고해 주세요." };
  }
}
