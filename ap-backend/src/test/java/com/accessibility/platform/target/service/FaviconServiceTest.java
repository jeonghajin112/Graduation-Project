package com.accessibility.platform.target.service;

import org.junit.jupiter.api.Test;

import java.net.URI;

import static org.assertj.core.api.Assertions.assertThat;

class FaviconServiceTest {

    private final FaviconService faviconService = new FaviconService();

    @Test
    void resolvesRelativeIconAgainstPageUrl() {
        URI result = faviconService.extractFaviconUri(
                URI.create("https://example.com/docs/page"),
                """
                <html>
                  <head>
                    <link rel="icon" href="../assets/favicon.svg">
                  </head>
                </html>
                """
        );

        assertThat(result).isEqualTo(URI.create("https://example.com/assets/favicon.svg"));
    }

    @Test
    void prefersStandardIconOverAppleTouchIcon() {
        URI result = faviconService.extractFaviconUri(
                URI.create("https://example.com/"),
                """
                <link rel="apple-touch-icon" href="/apple.png">
                <link href="/favicon-32.png" sizes="32x32" rel="shortcut icon">
                """
        );

        assertThat(result).isEqualTo(URI.create("https://example.com/favicon-32.png"));
    }

    @Test
    void fallsBackToOriginFavicon() {
        URI result = faviconService.extractFaviconUri(
                URI.create("https://example.com/nested/page?query=1"),
                "<html><head><title>No icon</title></head></html>"
        );

        assertThat(result).isEqualTo(URI.create("https://example.com/favicon.ico"));
    }

    @Test
    void ignoresUnsafeIconSchemes() {
        URI result = faviconService.extractFaviconUri(
                URI.create("https://example.com/"),
                """
                <link rel="icon" href="data:image/svg+xml;base64,abc">
                <link rel="icon" href="javascript:alert(1)">
                """
        );

        assertThat(result).isEqualTo(URI.create("https://example.com/favicon.ico"));
    }

    @Test
    void blocksPrivateAndLoopbackTargets() {
        assertThat(faviconService.isPublicHttpUri(URI.create("http://127.0.0.1/favicon.ico"))).isFalse();
        assertThat(faviconService.isPublicHttpUri(URI.create("http://192.168.0.10/favicon.ico"))).isFalse();
        assertThat(faviconService.isPublicHttpUri(URI.create("file:///tmp/favicon.ico"))).isFalse();
    }
}
