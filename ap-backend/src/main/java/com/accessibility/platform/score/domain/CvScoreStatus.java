package com.accessibility.platform.score.domain;

/** Whether the CV score represents a measurement, an empty sample, or a failed run. */
public enum CvScoreStatus {
    SUCCESS,
    NOT_MEASURED,
    FAILED
}
