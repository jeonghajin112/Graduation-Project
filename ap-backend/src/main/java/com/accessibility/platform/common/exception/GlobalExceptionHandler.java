package com.accessibility.platform.common.exception;

import com.accessibility.platform.artifact.exception.ArtifactValidationException;
import com.accessibility.platform.common.response.ApiResponse;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

@RestControllerAdvice
public class GlobalExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ApiResponse<Void>> handleBusinessException(BusinessException e) {
        return ResponseEntity
                .status(e.getErrorCode().getStatus())
                .body(ApiResponse.fail(e.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValidationException(MethodArgumentNotValidException e) {
        String message = e.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(error -> error.getField() + ": " + error.getDefaultMessage())
                .orElse("입력값이 올바르지 않습니다.");
        return ResponseEntity.badRequest().body(ApiResponse.fail(message));
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<ApiResponse<Void>> handleConstraintViolationException(ConstraintViolationException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail(e.getMessage()));
    }

    @ExceptionHandler(ArtifactValidationException.class)
    public ResponseEntity<ApiResponse<Void>> handleArtifactValidationException(ArtifactValidationException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail(e.getMessage()));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ApiResponse<Void>> handleMaxUploadSizeExceededException(MaxUploadSizeExceededException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail("Replay document exceeds the configured size limit"));
    }

    @ExceptionHandler({MissingServletRequestPartException.class, HttpMessageNotReadableException.class})
    public ResponseEntity<ApiResponse<Void>> handleMalformedRequest(Exception e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail("Required multipart data is missing or malformed"));
    }

    @ExceptionHandler(MultipartException.class)
    public ResponseEntity<ApiResponse<Void>> handleMultipartException(MultipartException e) {
        return ResponseEntity.badRequest().body(ApiResponse.fail("Multipart request is malformed"));
    }

    @ExceptionHandler(Exception.class)
    public void handleException(Exception exception, HttpServletResponse response) {
        if (response.isCommitted()) {
            log.debug("Request failed after its response was committed", exception);
            return;
        }

        log.error("Unexpected server request failure", exception);
        byte[] body = "{\"success\":false,\"data\":null,\"message\":\"Unexpected server error\"}"
                .getBytes(StandardCharsets.UTF_8);
        response.reset();
        response.setStatus(HttpStatus.INTERNAL_SERVER_ERROR.value());
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setContentLength(body.length);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        try {
            response.getOutputStream().write(body);
        } catch (IOException writeFailure) {
            log.debug("Generic error response could not be written", writeFailure);
        }
    }
}
