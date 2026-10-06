package com.accessibility.platform.capturemetadata.service;

import com.accessibility.platform.capturemetadata.domain.EvaluationCaptureMetadata;
import com.accessibility.platform.capturemetadata.dto.EvaluationCaptureMetadataInput;
import com.accessibility.platform.capturemetadata.dto.EvaluationCaptureMetadataResponse;
import com.accessibility.platform.capturemetadata.exception.CaptureMetadataValidationException;
import com.accessibility.platform.capturemetadata.repository.EvaluationCaptureMetadataRepository;
import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.Objects;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class EvaluationCaptureMetadataService {

    private static final int MAX_URL_LENGTH = 2048;

    private final EvaluationCaptureMetadataRepository metadataRepository;
    private final EvaluationRequestRepository requestRepository;

    @Transactional
    public EvaluationCaptureMetadataResponse replace(
            EvaluationRequest request,
            EvaluationCaptureMetadataInput input,
            String resultUrl,
            String ruleAnalyzedUrl
    ) {
        validate(request, input, resultUrl, ruleAnalyzedUrl);

        EvaluationCaptureMetadata metadata = metadataRepository
                .findByEvaluationRequestId(request.getId())
                .orElse(null);
        if (metadata == null) {
            metadata = new EvaluationCaptureMetadata(
                    request,
                    input.requestedUrl(),
                    input.finalUrl(),
                    input.capturedAt(),
                    input.viewportWidthCssPx(),
                    input.viewportHeightCssPx(),
                    input.deviceScaleFactor(),
                    input.pageWidthCssPx(),
                    input.pageHeightCssPx()
            );
        } else {
            metadata.replace(
                    input.requestedUrl(),
                    input.finalUrl(),
                    input.capturedAt(),
                    input.viewportWidthCssPx(),
                    input.viewportHeightCssPx(),
                    input.deviceScaleFactor(),
                    input.pageWidthCssPx(),
                    input.pageHeightCssPx()
            );
        }

        return EvaluationCaptureMetadataResponse.from(metadataRepository.saveAndFlush(metadata));
    }

    @Transactional
    public void deleteByRequestId(Long requestId) {
        metadataRepository.findByEvaluationRequestId(requestId).ifPresent(metadata -> {
            metadataRepository.delete(metadata);
            metadataRepository.flush();
        });
    }

    public EvaluationCaptureMetadataResponse getByRequestId(Long requestId) {
        if (!requestRepository.existsById(requestId)) {
            throw new ResourceNotFoundException();
        }
        return metadataRepository.findByEvaluationRequestId(requestId)
                .map(EvaluationCaptureMetadataResponse::from)
                .orElseThrow(ResourceNotFoundException::new);
    }

    private void validate(
            EvaluationRequest request,
            EvaluationCaptureMetadataInput input,
            String resultUrl,
            String ruleAnalyzedUrl
    ) {
        URI requestedUri = parseHttpUrl(input.requestedUrl(), "requestedUrl");
        URI finalUri = parseHttpUrl(input.finalUrl(), "finalUrl");
        requireLiveDocumentUrl(finalUri);
        requireEquivalent(
                requestedUri,
                parseHttpUrl(request.getEvaluationTarget().getAccessUrl(), "request target URL"),
                "capture_metadata.requestedUrl must match the evaluation request target URL"
        );
        requireEquivalent(
                requestedUri,
                parseHttpUrl(resultUrl, "result.url"),
                "capture_metadata.requestedUrl must match result.url"
        );
        if (ruleAnalyzedUrl != null) {
            requireEquivalentNavigationObservation(
                    finalUri,
                    parseHttpUrl(ruleAnalyzedUrl, "modules.rule_based.metadata.url"),
                    "capture_metadata.finalUrl must match modules.rule_based.metadata.url"
            );
        }
        if (input.capturedAt() == null) {
            throw new CaptureMetadataValidationException("capturedAt is required");
        }
        if (input.viewportWidthCssPx() <= 0
                || input.viewportHeightCssPx() <= 0
                || input.pageWidthCssPx() <= 0
                || input.pageHeightCssPx() <= 0) {
            throw new CaptureMetadataValidationException("Capture dimensions must be positive integers");
        }
        if (!Double.isFinite(input.deviceScaleFactor())
                || input.deviceScaleFactor() < 0.1
                || input.deviceScaleFactor() > 10.0) {
            throw new CaptureMetadataValidationException("deviceScaleFactor must be finite and between 0.1 and 10.0");
        }
        if (input.pageWidthCssPx() < input.viewportWidthCssPx()
                || input.pageHeightCssPx() < input.viewportHeightCssPx()) {
            throw new CaptureMetadataValidationException(
                    "Page dimensions must be at least as large as viewport dimensions"
            );
        }
    }

    private URI parseHttpUrl(String value, String fieldName) {
        if (value == null || value.isBlank() || value.length() > MAX_URL_LENGTH) {
            throw new CaptureMetadataValidationException(
                    fieldName + " must be a non-empty HTTP(S) URL of at most " + MAX_URL_LENGTH + " characters"
            );
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (uri.getHost() == null
                    || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
                throw new CaptureMetadataValidationException(fieldName + " must be an absolute HTTP(S) URL");
            }
            return uri;
        } catch (URISyntaxException e) {
            throw new CaptureMetadataValidationException(fieldName + " must be an absolute HTTP(S) URL", e);
        }
    }

    private void requireLiveDocumentUrl(URI uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || uri.getRawUserInfo() != null
                || uri.getRawFragment() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) {
            throw new CaptureMetadataValidationException(
                    "finalUrl must use HTTPS without credentials, fragments, or a non-default port"
            );
        }
    }

    private void requireEquivalent(URI first, URI second, String message) {
        if (!semanticIdentity(first).equals(semanticIdentity(second))) {
            throw new CaptureMetadataValidationException(message);
        }
    }

    private void requireEquivalentNavigationObservation(URI first, URI second, String message) {
        if (!navigationObservationIdentity(first).equals(navigationObservationIdentity(second))) {
            throw new CaptureMetadataValidationException(message);
        }
    }

    private SemanticUrl navigationObservationIdentity(URI uri) {
        SemanticUrl identity = semanticIdentity(uri);
        // Capture metadata intentionally strips fragments because the live
        // gateway cannot launch them, while a rule result may retain the
        // browser's in-document position. Host, path, and query remain exact:
        // www.example.com and example.com can be independent origins.
        return new SemanticUrl(
                identity.scheme(),
                identity.host(),
                identity.port(),
                identity.path(),
                identity.query(),
                identity.userInfo(),
                null
        );
    }

    private SemanticUrl semanticIdentity(URI uri) {
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        int port = uri.getPort();
        if (port == -1) {
            port = "https".equals(scheme) ? 443 : 80;
        }

        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) {
            path = "/";
        } else if (path.length() > 1 && path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }

        return new SemanticUrl(
                scheme,
                uri.getHost().toLowerCase(Locale.ROOT),
                port,
                path,
                uri.getRawQuery(),
                uri.getRawUserInfo(),
                uri.getRawFragment()
        );
    }

    private record SemanticUrl(
            String scheme,
            String host,
            int port,
            String path,
            String query,
            String userInfo,
            String fragment
    ) {
        private SemanticUrl {
            Objects.requireNonNull(scheme);
            Objects.requireNonNull(host);
            Objects.requireNonNull(path);
        }
    }
}
