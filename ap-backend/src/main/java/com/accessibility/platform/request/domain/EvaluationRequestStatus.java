package com.accessibility.platform.request.domain;

public enum EvaluationRequestStatus {
    PENDING,
    IN_PROGRESS,
    COMPLETED,
    FAILED;

    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED;
    }

    public boolean canTransitionTo(EvaluationRequestStatus nextStatus) {
        if (nextStatus == null) {
            return false;
        }
        if (this == nextStatus) {
            return true;
        }
        return switch (this) {
            case PENDING -> nextStatus == IN_PROGRESS
                    || nextStatus == COMPLETED
                    || nextStatus == FAILED;
            case IN_PROGRESS -> nextStatus == COMPLETED || nextStatus == FAILED;
            case COMPLETED, FAILED -> false;
        };
    }
}
