package com.accessibility.platform.livereport;

import lombok.Getter;
import org.springframework.http.HttpStatus;

@Getter
public class LiveReportException extends RuntimeException {
    private final HttpStatus status;

    public LiveReportException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public LiveReportException(HttpStatus status, String message, Throwable cause) {
        super(message, cause);
        this.status = status;
    }
}
