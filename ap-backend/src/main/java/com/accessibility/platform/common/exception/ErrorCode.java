package com.accessibility.platform.common.exception;

import lombok.Getter;
import org.springframework.http.HttpStatus;

@Getter
public enum ErrorCode {
    RESOURCE_NOT_FOUND(HttpStatus.NOT_FOUND, "요청한 데이터를 찾을 수 없습니다."),
    INVALID_REQUEST(HttpStatus.BAD_REQUEST, "잘못된 요청입니다."),
    INVALID_IDEMPOTENCY_KEY(HttpStatus.BAD_REQUEST, "Idempotency-Key는 올바른 UUID여야 합니다."),
    IDEMPOTENCY_KEY_CONFLICT(HttpStatus.CONFLICT, "이미 다른 프로젝트 생성 요청에 사용된 요청 식별자입니다."),
    INVALID_STATUS_TRANSITION(HttpStatus.CONFLICT, "현재 상태에서는 분석 요청의 상태를 변경할 수 없습니다.");

    private final HttpStatus status;
    private final String message;

    ErrorCode(HttpStatus status, String message) {
        this.status = status;
        this.message = message;
    }
}
