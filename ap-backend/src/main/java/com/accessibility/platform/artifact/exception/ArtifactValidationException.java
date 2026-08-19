package com.accessibility.platform.artifact.exception;

public class ArtifactValidationException extends RuntimeException {
    public ArtifactValidationException(String message) {
        super(message);
    }

    public ArtifactValidationException(String message, Throwable cause) {
        super(message, cause);
    }
}
