package com.accessibility.platform.artifact.service;

import com.accessibility.platform.artifact.config.ArtifactStorageProperties;
import com.accessibility.platform.artifact.exception.ArtifactValidationException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.http.InvalidMediaTypeException;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;

@Component
@RequiredArgsConstructor
public class ArtifactFileStorage implements InitializingBean {

    private final ArtifactStorageProperties properties;
    private final ReplayDocumentSanitizer sanitizer;
    private Path canonicalRoot;

    @Override
    public void afterPropertiesSet() {
        try {
            Path configuredRoot = Path.of(properties.getDirectory()).toAbsolutePath().normalize();
            Files.createDirectories(configuredRoot);
            canonicalRoot = configuredRoot.toRealPath();
        } catch (IOException e) {
            throw new IllegalStateException("Failed to initialize artifact storage", e);
        }
    }

    public StagedArtifact stage(MultipartFile document, String finalUrl) {
        validateMultipartMetadata(document);
        byte[] sourceBytes = readBounded(document);
        ReplayDocumentSanitizer.SanitizedDocument sanitized = sanitizer.sanitize(sourceBytes, finalUrl);
        return stageBytes(sanitized.bytes());
    }

    public StagedArtifact stageBridgeRefresh(String storageKey) {
        Path source = load(storageKey);
        try {
            if (Files.size(source) > properties.getMaxFileSizeBytes()) {
                throw new ArtifactValidationException("Stored replay document exceeds the configured size limit");
            }
            return stageBytes(sanitizer.refreshBridge(Files.readAllBytes(source)).bytes());
        } catch (ArtifactValidationException e) {
            throw e;
        } catch (IOException e) {
            throw new IllegalStateException("Failed to refresh stored replay bridge", e);
        }
    }

    public boolean usesCurrentBridge(String storageKey) {
        return storageKey != null && storageKey.startsWith(sanitizer.bridgeStoragePrefix());
    }

    public String commit(StagedArtifact stagedArtifact) {
        for (int attempt = 0; attempt < 3; attempt++) {
            String storageKey = sanitizer.bridgeStoragePrefix() + UUID.randomUUID() + ".html";
            Path target = safeResolve(storageKey);
            try {
                try {
                    Files.move(stagedArtifact.path(), target, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException ignored) {
                    Files.move(stagedArtifact.path(), target);
                }
                return storageKey;
            } catch (FileAlreadyExistsException ignored) {
                // An astronomically unlikely UUID collision; generate another key.
            } catch (IOException e) {
                deletePathQuietly(stagedArtifact.path());
                throw new IllegalStateException("Failed to commit replay document", e);
            }
        }
        deletePathQuietly(stagedArtifact.path());
        throw new IllegalStateException("Failed to allocate a unique artifact storage key");
    }

    public Path load(String storageKey) {
        Path path = safeResolve(storageKey);
        try {
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                throw new NoSuchFileException(path.toString());
            }
            Path realPath = path.toRealPath();
            if (!realPath.startsWith(canonicalRoot)) {
                throw new SecurityException("Artifact path escapes the configured storage directory");
            }
            return realPath;
        } catch (IOException e) {
            throw new ArtifactContentNotFoundException("Stored artifact content was not found", e);
        }
    }

    public void deleteQuietly(String storageKey) {
        if (storageKey == null || storageKey.isBlank()) {
            return;
        }
        try {
            Files.deleteIfExists(safeResolve(storageKey));
        } catch (IOException | RuntimeException ignored) {
            // File cleanup must never roll back committed database state.
        }
    }

    private void validateMultipartMetadata(MultipartFile document) {
        if (document == null || document.isEmpty()) {
            throw new ArtifactValidationException("Replay document must not be empty");
        }
        if (document.getSize() > properties.getMaxFileSizeBytes()) {
            throw new ArtifactValidationException("Replay document exceeds the configured size limit");
        }
        try {
            MediaType contentType = MediaType.parseMediaType(document.getContentType() == null ? "" : document.getContentType());
            if (!MediaType.TEXT_HTML.isCompatibleWith(contentType)) {
                throw new ArtifactValidationException("Replay document content type must be text/html");
            }
            if (contentType.getCharset() != null && !StandardCharsets.UTF_8.equals(contentType.getCharset())) {
                throw new ArtifactValidationException("Replay document charset must be UTF-8");
            }
        } catch (InvalidMediaTypeException e) {
            throw new ArtifactValidationException("Replay document content type must be text/html", e);
        }
    }

    private byte[] readBounded(MultipartFile document) {
        try (InputStream input = document.getInputStream();
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            long total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > properties.getMaxFileSizeBytes()) {
                    throw new ArtifactValidationException("Replay document exceeds the configured size limit");
                }
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } catch (ArtifactValidationException e) {
            throw e;
        } catch (IOException e) {
            throw new IllegalStateException("Failed to read replay document", e);
        }
    }

    private String sha256(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
    }

    private StagedArtifact stageBytes(byte[] storedBytes) {
        if (storedBytes.length > properties.getMaxFileSizeBytes()) {
            throw new ArtifactValidationException("Sanitized replay document exceeds the configured size limit");
        }

        Path temporaryFile = safeResolve(".upload-" + UUID.randomUUID() + ".tmp");
        try {
            Files.write(temporaryFile, storedBytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        } catch (IOException e) {
            deletePathQuietly(temporaryFile);
            throw new IllegalStateException("Failed to stage replay document", e);
        }
        return new StagedArtifact(temporaryFile, storedBytes.length, sha256(storedBytes));
    }

    private Path safeResolve(String storageKey) {
        if (canonicalRoot == null) {
            throw new IllegalStateException("Artifact storage has not been initialized");
        }
        Path resolved = canonicalRoot.resolve(storageKey).normalize();
        if (!resolved.startsWith(canonicalRoot)) {
            throw new SecurityException("Artifact path escapes the configured storage directory");
        }
        return resolved;
    }

    private void deletePathQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
            // Best-effort cleanup for a failed upload.
        }
    }

    public record StagedArtifact(Path path, long sizeBytes, String sha256) {
    }

    public static class ArtifactContentNotFoundException extends RuntimeException {
        public ArtifactContentNotFoundException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
