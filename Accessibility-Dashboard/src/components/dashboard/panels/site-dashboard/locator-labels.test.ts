import { describe, expect, it } from "vitest";

import { getLocatorExplanation, hasLocatorPresentation } from "./locator-explanation";
import { getLocatorCategory, getLocatorLabel } from "./locator-labels";

describe("locator labels", () => {
  it.each([
    [undefined, "위치 확인 중"],
    [{ status: "CONNECTED" }, "현재 화면에서 찾음"],
    [{ status: "OFFSCREEN", reason: "OUTSIDE_VIEWPORT_OR_CLIPPED" }, "화면 밖의 요소"],
    [{ status: "HIDDEN_STATE", reason: "DISPLAY_NONE", recoverable: true }, "다른 슬라이드의 요소"],
    [{ status: "HIDDEN_STATE", reason: "DISPLAY_NONE", recoverable: false }, "현재 숨겨진 요소"],
    [{ status: "UNAVAILABLE", reason: "LOCATOR_MISSING" }, "요소 경로 없음"],
    [{ status: "UNAVAILABLE", reason: "INVALID_SELECTOR" }, "요소 경로 오류"],
    [{ status: "UNAVAILABLE", reason: "FRAME_UNSUPPORTED" }, "내부 프레임의 요소"],
    [{ status: "UNAVAILABLE", reason: "ISSUE_LIMIT_EXCEEDED" }, "표시 한도 초과"],
    [{ status: "HIDDEN_STATE", reason: "SOMETHING_NEW" }, "현재 숨겨진 요소"],
    [{ status: "UNAVAILABLE", reason: "toString" }, "위치를 확인하지 못함"],
    [{ status: "UNAVAILABLE" }, "위치를 확인하지 못함"],
    [{ status: "VISIBLE", reason: "SCREEN_READER_ONLY", ownerKind: "BUTTON" }, "버튼의 스크린리더 전용 텍스트"],
    [{ status: "OFFSCREEN", reason: "INVISIBLE_ELEMENT", ownerKind: "LINK" }, "링크 안의 보이지 않는 요소"],
    [{ status: "VISIBLE", reason: "SCREEN_READER_ONLY" }, "스크린리더 전용 텍스트"],
    [{ status: "VISIBLE", reason: "FRAME_CONTENT" }, "프레임 안의 요소"],
    [{ status: "VISIBLE", reason: "ASSISTIVE_HIDDEN" }, "보조기기에서 숨김"],
    [{ status: "VISIBLE", reason: "ASSISTIVE_INERT" }, "조작이 막힌 요소"],
    [{ status: "VISIBLE", reason: "APPROXIMATE_AREA", ownerKind: "REGION" }, "영역 안의 숨겨진 요소 · 대략적 위치"],
    [{ status: "OFFSCREEN", reason: "TRANSPARENT_ELEMENT" }, "투명한 요소"],
    [{ status: "VISIBLE", reason: "HIDDEN_IN_PLACE" }, "숨겨진 요소(visibility)"],
    [{ status: "VISIBLE", reason: "REVEALED_BY_CONTROL", ownerKind: "BUTTON" }, "닫힌 탭·메뉴 안의 요소 · 여는 버튼에 표시"],
    [{ status: "VISIBLE", reason: "SHADOW_HOST" }, "닫힌 Shadow DOM 안의 요소 · 대략적 위치"],
    [{ status: "OFFSCREEN", reason: "APPROXIMATE_AREA" }, "숨겨진 영역의 요소 · 대략적 위치"],
    [{ status: "HIDDEN_STATE", reason: "FOCUS_TO_REVEAL", recoverable: true }, "포커스하면 나타나는 요소"],
    [{ status: "HIDDEN_STATE", reason: "FOCUS_REVEAL_FAILED", recoverable: false }, "포커스해도 나타나지 않음"],
    [{ status: "UNAVAILABLE", reason: "DOCUMENT_METADATA" }, "페이지 전체 설정"],
    [{ status: "UNAVAILABLE", reason: "STATUS_TIMEOUT" }, "위치 확인 시간 초과"],
    [{ status: "UNAVAILABLE", reason: "REPLAY_REJECTED" }, "검사 화면이 받지 못함"],
    [{ status: "UNAVAILABLE", reason: "CAPTURE_METADATA_MISSING" }, "분석 당시 화면 정보 없음"]
  ] as const)("classifies %o as %s in the rail and the details", (state, label) => {
    expect(getLocatorExplanation(state).label).toBe(label);
    expect(getLocatorExplanation(state).description.length).toBeGreaterThan(0);
    // The rail lists only contain findings without a marker.
    if (!hasLocatorPresentation(state)) expect(getLocatorLabel(state)).toBe(label);
  });

  it("names the element a moved marker belongs to", () => {
    const { description } = getLocatorExplanation({ status: "VISIBLE", reason: "SCREEN_READER_ONLY", ownerKind: "TABLE" });
    expect(description).toContain("속한 표에");
    expect(description).not.toContain("{owner}");
    expect(getLocatorExplanation({ status: "VISIBLE", reason: "INVISIBLE_ELEMENT" }).description).toContain("상위 요소");
  });
});

describe("dashboard-assigned locator reasons", () => {
  it.each(["STATUS_TIMEOUT", "REPLAY_REJECTED", "CAPTURE_METADATA_MISSING"])(
    "lists %s in the not-shown list",
    (reason) => {
      expect(getLocatorCategory({ status: "UNAVAILABLE", reason })).toBe("unavailable");
    }
  );
});
