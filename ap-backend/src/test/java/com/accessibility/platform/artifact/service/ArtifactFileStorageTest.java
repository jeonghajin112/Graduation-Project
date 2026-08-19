package com.accessibility.platform.artifact.service;

import com.accessibility.platform.artifact.config.ArtifactStorageProperties;
import com.accessibility.platform.artifact.exception.ArtifactValidationException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ArtifactFileStorageTest {

    @TempDir
    Path temporaryDirectory;

    private ArtifactFileStorage storage;

    @BeforeEach
    void setUp() {
        ArtifactStorageProperties properties = new ArtifactStorageProperties();
        properties.setDirectory(temporaryDirectory.toString());
        properties.setMaxFileSizeBytes(1024 * 1024);
        storage = new ArtifactFileStorage(properties, new ReplayDocumentSanitizer());
        storage.afterPropertiesSet();
    }

    @Test
    void sanitizesAndCommitsUtf8HtmlInsideConfiguredRoot() throws Exception {
        MockMultipartFile upload = html("""
                <!doctype html><html><head><title>Replay</title></head>
                <body><main id="content" onclick="alert(1)">Hello</main><script>alert(1)</script></body></html>
                """);

        ArtifactFileStorage.StagedArtifact staged = storage.stage(upload, "https://example.com/final");
        String storageKey = storage.commit(staged);
        Path stored = storage.load(storageKey);
        String storedHtml = Files.readString(stored, StandardCharsets.UTF_8);

        assertThat(storageKey).endsWith(".html");
        assertThat(staged.sha256()).hasSize(64);
        assertThat(storedHtml).contains("<main id=\"content\">Hello</main>");
        assertThat(storedHtml).doesNotContain("onclick=", "alert(1)");
        assertThat(storedHtml).contains("accessibility-page-replay", "<base href=\"https://example.com/final\">");
        assertThat(stored).startsWith(temporaryDirectory.toRealPath());
    }

    @Test
    void rejectsWrongMimeCharsetAndMalformedUtf8() {
        MockMultipartFile wrongMime = new MockMultipartFile(
                "document", "page.html", "image/png", "<html></html>".getBytes(StandardCharsets.UTF_8)
        );
        MockMultipartFile wrongCharset = new MockMultipartFile(
                "document", "page.html", "text/html;charset=EUC-KR", "<html></html>".getBytes(StandardCharsets.UTF_8)
        );
        MockMultipartFile malformedUtf8 = new MockMultipartFile(
                "document", "page.html", "text/html;charset=utf-8", new byte[]{(byte) 0xC3, 0x28}
        );

        assertThatThrownBy(() -> storage.stage(wrongMime, "https://example.com/"))
                .isInstanceOf(ArtifactValidationException.class)
                .hasMessageContaining("text/html");
        assertThatThrownBy(() -> storage.stage(wrongCharset, "https://example.com/"))
                .isInstanceOf(ArtifactValidationException.class)
                .hasMessageContaining("UTF-8");
        assertThatThrownBy(() -> storage.stage(malformedUtf8, "https://example.com/"))
                .isInstanceOf(ArtifactValidationException.class)
                .hasMessageContaining("valid UTF-8");
    }

    @Test
    void rejectsPathTraversalOnRead() {
        assertThatThrownBy(() -> storage.load("../outside.html"))
                .isInstanceOf(SecurityException.class);
    }

    private MockMultipartFile html(String value) {
        return new MockMultipartFile(
                "document",
                "page.html",
                "text/html;charset=utf-8",
                value.getBytes(StandardCharsets.UTF_8)
        );
    }
}
