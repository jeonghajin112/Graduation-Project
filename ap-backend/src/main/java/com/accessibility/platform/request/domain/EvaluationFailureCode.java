package com.accessibility.platform.request.domain;

/** Public failure categories. Never expose process output or credentials. */
public enum EvaluationFailureCode {
    TARGET_PAGE_UNAVAILABLE,
    PROCESS_TIMEOUT,
    INVALID_RESULT,
    ANALYSIS_FAILED
}
