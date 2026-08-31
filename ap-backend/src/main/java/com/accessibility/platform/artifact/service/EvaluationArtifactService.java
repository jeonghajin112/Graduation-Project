package com.accessibility.platform.artifact.service;

import com.accessibility.platform.artifact.domain.EvaluationArtifact;
import com.accessibility.platform.artifact.domain.CaptureMode;
import com.accessibility.platform.artifact.dto.EvaluationArtifactMetadataRequest;
import com.accessibility.platform.artifact.dto.EvaluationArtifactResponse;
import com.accessibility.platform.artifact.exception.ArtifactValidationException;
import com.accessibility.platform.artifact.repository.EvaluationArtifactRepository;
import com.accessibility.platform.common.exception.ResourceNotFoundException;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Path;
import java.util.List;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class EvaluationArtifactService {

    private final EvaluationArtifactRepository artifactRepository;
    private final EvaluationRequestRepository requestRepository;
    private final ArtifactFileStorage fileStorage;

    @Transactional
    public EvaluationArtifactResponse replace(
            Long requestId,
            EvaluationArtifactMetadataRequest metadata,
            MultipartFile document
    ) {
        EvaluationRequest request = requestRepository.findByIdForUpdate(requestId)
                .orElseThrow(ResourceNotFoundException::new);
        validateMetadata(metadata);

        ArtifactFileStorage.StagedArtifact stagedArtifact = fileStorage.stage(document, metadata.finalUrl());

        String newStorageKey = fileStorage.commit(stagedArtifact);
        try {
            EvaluationArtifact artifact = artifactRepository.findByEvaluationRequestId(requestId).orElse(null);
            String oldStorageKey = artifact == null ? null : artifact.getStorageKey();
            if (artifact == null) {
                artifact = new EvaluationArtifact(
                        request,
                        newStorageKey,
                        "text/html",
                        stagedArtifact.sizeBytes(),
                        stagedArtifact.sha256(),
                        metadata.requestedUrl(),
                        metadata.finalUrl(),
                        metadata.capturedAt(),
                        metadata.viewportWidthCssPx(),
                        metadata.viewportHeightCssPx(),
                        metadata.deviceScaleFactor(),
                        metadata.pageWidthCssPx(),
                        metadata.pageHeightCssPx(),
                        metadata.captureMode()
                );
            } else {
                artifact.replace(
                        newStorageKey,
                        "text/html",
                        stagedArtifact.sizeBytes(),
                        stagedArtifact.sha256(),
                        metadata.requestedUrl(),
                        metadata.finalUrl(),
                        metadata.capturedAt(),
                        metadata.viewportWidthCssPx(),
                        metadata.viewportHeightCssPx(),
                        metadata.deviceScaleFactor(),
                        metadata.pageWidthCssPx(),
                        metadata.pageHeightCssPx(),
                        metadata.captureMode()
                );
            }

            EvaluationArtifact saved = artifactRepository.saveAndFlush(artifact);
            registerFileCleanup(newStorageKey, oldStorageKey);
            return EvaluationArtifactResponse.from(saved);
        } catch (RuntimeException e) {
            fileStorage.deleteQuietly(newStorageKey);
            throw e;
        }
    }

    public EvaluationArtifactResponse getByRequestId(Long requestId) {
        if (!requestRepository.existsById(requestId)) {
            throw new ResourceNotFoundException();
        }
        return artifactRepository.findByEvaluationRequestId(requestId)
                .filter(this::isReplayArtifact)
                .filter(artifact -> fileStorage.usesCurrentBridge(artifact.getStorageKey()))
                .map(EvaluationArtifactResponse::from)
                .orElseThrow(ResourceNotFoundException::new);
    }

    public List<Long> findStoredReplayBridgeRefreshCandidates() {
        return artifactRepository.findAll().stream()
                .filter(this::isReplayArtifact)
                .filter(artifact -> !fileStorage.usesCurrentBridge(artifact.getStorageKey()))
                .map(EvaluationArtifact::getId)
                .toList();
    }

    @Transactional
    public boolean refreshStoredReplayBridge(Long artifactId) {
        EvaluationArtifact artifact = artifactRepository.findById(artifactId)
                .filter(this::isReplayArtifact)
                .orElseThrow(ResourceNotFoundException::new);
        if (fileStorage.usesCurrentBridge(artifact.getStorageKey())) {
            return false;
        }

        String oldStorageKey = artifact.getStorageKey();
        ArtifactFileStorage.StagedArtifact stagedArtifact = fileStorage.stageBridgeRefresh(oldStorageKey);
        String newStorageKey = fileStorage.commit(stagedArtifact);
        try {
            artifact.replace(
                    newStorageKey,
                    artifact.getContentType(),
                    stagedArtifact.sizeBytes(),
                    stagedArtifact.sha256(),
                    artifact.getRequestedUrl(),
                    artifact.getFinalUrl(),
                    artifact.getCapturedAt(),
                    artifact.getViewportWidthCssPx(),
                    artifact.getViewportHeightCssPx(),
                    artifact.getDeviceScaleFactor(),
                    artifact.getPageWidthCssPx(),
                    artifact.getPageHeightCssPx(),
                    artifact.getCaptureMode()
            );
            artifactRepository.saveAndFlush(artifact);
            registerFileCleanup(newStorageKey, oldStorageKey);
            return true;
        } catch (RuntimeException e) {
            fileStorage.deleteQuietly(newStorageKey);
            throw e;
        }
    }

    @Transactional
    public void deleteByRequestId(Long requestId) {
        artifactRepository.findByEvaluationRequestId(requestId).ifPresent(artifact -> {
            String storageKey = artifact.getStorageKey();
            artifactRepository.delete(artifact);
            artifactRepository.flush();
            registerFileCleanup(null, storageKey);
        });
    }

    public ArtifactContent getContent(Long artifactId) {
        EvaluationArtifact artifact = artifactRepository.findById(artifactId)
                .filter(this::isReplayArtifact)
                .filter(candidate -> fileStorage.usesCurrentBridge(candidate.getStorageKey()))
                .orElseThrow(ResourceNotFoundException::new);
        Path path;
        try {
            path = fileStorage.load(artifact.getStorageKey());
        } catch (ArtifactFileStorage.ArtifactContentNotFoundException e) {
            throw new ResourceNotFoundException();
        }
        return new ArtifactContent(
                new FileSystemResource(path),
                artifact.getContentType(),
                artifact.getSizeBytes(),
                artifact.getSha256()
        );
    }

    private void validateMetadata(EvaluationArtifactMetadataRequest metadata) {
        validateHttpUrl(metadata.requestedUrl(), "requestedUrl");
        validateHttpUrl(metadata.finalUrl(), "finalUrl");
        if (metadata.captureMode() != CaptureMode.DOM_REPLAY) {
            throw new ArtifactValidationException("captureMode must be DOM_REPLAY");
        }
        if (!Double.isFinite(metadata.deviceScaleFactor())) {
            throw new ArtifactValidationException("deviceScaleFactor must be finite");
        }
        if (metadata.pageWidthCssPx() < metadata.viewportWidthCssPx()
                || metadata.pageHeightCssPx() < metadata.viewportHeightCssPx()) {
            throw new ArtifactValidationException("Page dimensions must be at least as large as viewport dimensions");
        }
    }

    private boolean isReplayArtifact(EvaluationArtifact artifact) {
        return artifact.getCaptureMode() == CaptureMode.DOM_REPLAY
                && "text/html".equalsIgnoreCase(artifact.getContentType())
                && artifact.getStorageKey() != null
                && artifact.getStorageKey().endsWith(".html");
    }

    private void validateHttpUrl(String value, String fieldName) {
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (uri.getHost() == null
                    || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
                throw new ArtifactValidationException(fieldName + " must be an absolute HTTP(S) URL");
            }
        } catch (URISyntaxException e) {
            throw new ArtifactValidationException(fieldName + " must be an absolute HTTP(S) URL", e);
        }
    }

    private void registerFileCleanup(String newStorageKey, String oldStorageKey) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            fileStorage.deleteQuietly(oldStorageKey);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                fileStorage.deleteQuietly(oldStorageKey);
            }

            @Override
            public void afterCompletion(int status) {
                if (status != TransactionSynchronization.STATUS_COMMITTED) {
                    fileStorage.deleteQuietly(newStorageKey);
                }
            }
        });
    }

    public record ArtifactContent(Resource resource, String contentType, long sizeBytes, String sha256) {
    }
}
