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
    void prefersStandardIconOverAppleTouchIconAtTheSameSize() {
        URI result = faviconService.extractFaviconUri(
                URI.create("https://example.com/"),
                """
                <link rel="apple-touch-icon" sizes="64x64" href="/apple.png">
                <link href="/favicon-64.png" sizes="64x64" rel="shortcut icon">
                """
        );

        assertThat(result).isEqualTo(URI.create("https://example.com/favicon-64.png"));
    }

    @Test
    void ignoresCommentedOutIconBeforeActiveIcon() {
        URI result = faviconService.extractFaviconUri(
                URI.create("https://www.skku.edu/skku/index.do"),
                """
                <link rel="apple-touch-icon" href="/_res/skku/img/common/favicon-ios.png">
                <!--<link rel="icon" type="image/png" sizes="16x16" href="/_res/skku/img/common/favicon-16x16.png">-->
                <link rel="shortcut icon" href="/_res/skku/img/common/favicon.ico">
                """
        );

        assertThat(result).isEqualTo(URI.create("https://www.skku.edu/_res/skku/img/common/favicon.ico"));
    }

    @Test
    void ignoresIconMarkupInsideScript() {
        URI result = faviconService.extractFaviconUri(
                URI.create("https://example.com/"),
                """
                <script>const unused = '<link rel="icon" href="/unused.png">';</script>
                <link rel="icon" href="/active.ico">
                """
        );

        assertThat(result).isEqualTo(URI.create("https://example.com/active.ico"));
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
