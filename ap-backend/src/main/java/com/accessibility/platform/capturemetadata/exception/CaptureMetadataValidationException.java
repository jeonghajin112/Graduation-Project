package com.accessibility.platform.capturemetadata.exception;

public class CaptureMetadataValidationException extends RuntimeException {
    public CaptureMetadataValidationException(String message) {
        super(message);
    }

    public CaptureMetadataValidationException(String message, Throwable cause) {
        super(message, cause);
    }
}
