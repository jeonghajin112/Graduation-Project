import { describe, expect, it } from "vitest";

import { ApiRequestError, getApiErrorMessage } from "./backend-api";
import { UserFacingError } from "./user-facing-error";

const SAFE_FALLBACK = "요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const INTERNAL_PATH = "/dashboard/overview";
const INTERNAL_MESSAGE =
  "서버 응답 계약이 올바르지 않습니다. data.organizations: 배열 형식이어야 합니다.";
const INTERNAL_PAYLOAD = {
  message: "SQLException: relation dashboard_overview does not exist",
  error: "internal-server-error"
};

function createApiError(status: number | null, message = INTERNAL_MESSAGE): ApiRequestError {
  return new ApiRequestError({
    method: "GET",
    path: INTERNAL_PATH,
    payload: INTERNAL_PAYLOAD,
    status,
    url: `http://127.0.0.1:9090/api${INTERNAL_PATH}`,
    message
  });
}

describe("API error presentation", () => {
  it("retains structured request diagnostics without making them the user message", () => {
    const error = createApiError(500);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiRequestError");
    expect(error.message).toContain(INTERNAL_MESSAGE);
    expect(error.message).toContain(`[GET ${INTERNAL_PATH}, HTTP 500]`);
    expect(error.method).toBe("GET");
    expect(error.path).toBe(INTERNAL_PATH);
    expect(error.status).toBe(500);
    expect(error.payload).toBe(INTERNAL_PAYLOAD);
    expect(error.url).toBe(`http://127.0.0.1:9090/api${INTERNAL_PATH}`);

    expect(getApiErrorMessage(error, SAFE_FALLBACK)).not.toBe(error.message);
  });

  it.each([
    [null, "서비스에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 잠시 후 다시 시도해 주세요."],
    [400, "입력한 내용을 확인한 뒤 다시 시도해 주세요."],
    [401, "로그인 정보가 만료되었거나 확인되지 않았습니다. 다시 로그인해 주세요."],
    [403, "이 작업을 수행할 권한이 없습니다. 권한이 필요하면 관리자에게 문의해 주세요."],
    [404, "요청한 정보를 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요."],
    [408, "요청 처리에 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요."],
    [409, "다른 변경과 겹쳐 요청을 완료하지 못했습니다. 최신 상태를 불러온 뒤 다시 시도해 주세요."],
    [413, "전송할 내용이 너무 큽니다. 크기를 줄인 뒤 다시 시도해 주세요."],
    [422, "입력한 내용을 확인한 뒤 다시 시도해 주세요."],
    [429, "요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해 주세요."],
    [500, "서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."],
    [503, "서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."],
    [504, "요청 처리에 시간이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요."]
  ] as const)("maps status %s to safe Korean copy", (status, expected) => {
    expect(getApiErrorMessage(createApiError(status), SAFE_FALLBACK)).toBe(expected);
  });

  it("uses contextual fallback for an unmapped response failure", () => {
    expect(getApiErrorMessage(createApiError(418), SAFE_FALLBACK)).toBe(SAFE_FALLBACK);
  });

  it("does not expose request metadata, server payloads, or contract details", () => {
    for (const status of [null, 400, 403, 404, 418, 429, 500] as const) {
      const message = getApiErrorMessage(createApiError(status), SAFE_FALLBACK);

      expect(message).not.toContain(INTERNAL_PATH);
      expect(message).not.toContain("HTTP");
      expect(message).not.toContain("SQLException");
      expect(message).not.toContain("internal-server-error");
      expect(message).not.toContain("data.organizations");
      expect(message).not.toContain("응답 계약");
    }
  });

  it("preserves an intentionally safe UserFacingError message", () => {
    const error = new UserFacingError("  입력 내용을 저장하지 못했습니다. 다시 시도해 주세요.  ");

    expect(getApiErrorMessage(error, SAFE_FALLBACK)).toBe(
      "입력 내용을 저장하지 못했습니다. 다시 시도해 주세요."
    );
  });

  it("uses fallback for blank or ordinary errors", () => {
    expect(getApiErrorMessage(new UserFacingError("   "), SAFE_FALLBACK)).toBe(SAFE_FALLBACK);
    expect(getApiErrorMessage(new Error("TypeError: cannot read internalState"), SAFE_FALLBACK)).toBe(
      SAFE_FALLBACK
    );
    expect(getApiErrorMessage("raw failure", SAFE_FALLBACK)).toBe(SAFE_FALLBACK);
  });
});
