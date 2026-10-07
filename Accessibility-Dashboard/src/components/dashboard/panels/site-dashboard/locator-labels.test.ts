import { describe, expect, it } from "vitest";

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
    [{ status: "HIDDEN_STATE", reason: "FOCUS_TO_REVEAL", recoverable: true }, "포커스하면 나타나는 요소"],
    [{ status: "HIDDEN_STATE", reason: "FOCUS_REVEAL_FAILED", recoverable: false }, "포커스해도 나타나지 않음"],
    [{ status: "UNAVAILABLE", reason: "DOCUMENT_METADATA" }, "페이지 전체 설정"],
    [{ status: "UNAVAILABLE", reason: "STATUS_TIMEOUT" }, "위치 확인 시간 초과"],
    [{ status: "UNAVAILABLE", reason: "REPLAY_REJECTED" }, "검사 화면이 받지 못함"],
    [{ status: "UNAVAILABLE", reason: "CAPTURE_METADATA_MISSING" }, "분석 당시 화면 정보 없음"],
    [{ status: "UNAVAILABLE", reason: "CAPTURE_METADATA_FAILED" }, "화면 정보를 불러오지 못함"]
  ] as const)("labels %o as %s in the rail", (state, label) => {
    expect(getLocatorLabel(state)).toBe(label);
  });

});

describe("dashboard-assigned locator reasons", () => {
  it.each(["STATUS_TIMEOUT", "REPLAY_REJECTED", "CAPTURE_METADATA_MISSING", "CAPTURE_METADATA_FAILED"])(
    "lists %s in the not-shown list",
    (reason) => {
      expect(getLocatorCategory({ status: "UNAVAILABLE", reason })).toBe("unavailable");
    }
  );
});
