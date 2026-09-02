package com.accessibility.platform.livereport;

import org.junit.jupiter.api.Test;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LiveReportMirrorUrlTest {
    private static final UUID SESSION_ID = UUID.fromString("6b2d884e-a7f4-4f09-9776-688d08fe8912");
    private static final String NONCE = "test-nonce";

    @Test
    void roundTripsCanonicalHostRawPathAndRawQueryWhileKeepingFragmentClientSide() {
        URI upstream = URI.create("https://CDN.Example.com/assets/%ED%95%9C%EA%B8%80/app.js?v=1%2B2&lang=ko#part");

        String mirror = LiveReportMirrorUrl.toRelativeUrl(SESSION_ID, NONCE, upstream);
        URI mirrorUri = URI.create(mirror);
        LiveReportMirrorUrl.DecodedMirrorRequest decoded = LiveReportMirrorUrl.decodeRequestPath(
                SESSION_ID,
                NONCE,
                "",
                mirrorUri.getRawPath(),
                mirrorUri.getRawQuery()
        );

        assertThat(mirror).startsWith(LiveReportMirrorUrl.sessionPrefix(SESSION_ID, NONCE));
        assertThat(mirror).endsWith("/assets/%ED%95%9C%EA%B8%80/app.js?v=1%2B2&lang=ko#part");
        assertThat(decoded.targetUri()).hasToString(
                "https://cdn.example.com/assets/%ED%95%9C%EA%B8%80/app.js?v=1%2B2&lang=ko"
        );
    }

    @Test
    void normalizesLiteralAndPercentEncodedDotSegmentsWithoutEscapingTheHostPrefix() {
        URI upstream = URI.create("https://example.com/a/../%2e%2e/private/./app.js");

        String mirror = LiveReportMirrorUrl.toRelativeUrl(SESSION_ID, NONCE, upstream);
        String prefix = LiveReportMirrorUrl.sessionPrefix(SESSION_ID, NONCE);
        URI mirrorUri = URI.create(mirror);

        assertThat(mirrorUri.getRawPath()).startsWith(prefix);
        assertThat(mirrorUri.getRawPath()).endsWith("/private/app.js");
        assertThat(mirrorUri.getRawPath()).doesNotContain("/../", "%2e");
        assertThat(LiveReportMirrorUrl.decodeRequestPath(
                SESSION_ID,
                NONCE,
                "",
                mirrorUri.getRawPath(),
                null
        ).targetUri()).hasToString("https://example.com/private/app.js");
    }

    @Test
    void preservesMeaningfulEmptyPathSegmentsAndCanonicalDirectoryTrailingSlash() {
        assertThat(LiveReportMirrorUrl.toRelativeUrl(
                SESSION_ID,
                NONCE,
                URI.create("https://example.com/a//b/./asset.js")
        )).endsWith("/a//b/asset.js");
        assertThat(LiveReportMirrorUrl.toRelativeUrl(
                SESSION_ID,
                NONCE,
                URI.create("https://example.com/a/%2e")
        )).endsWith("/a/");
        assertThat(LiveReportMirrorUrl.toRelativeUrl(
                SESSION_ID,
                NONCE,
                URI.create("https://example.com//a/../b")
        )).endsWith("//b");
    }

    @Test
    void rejectsNonCanonicalHostTokensPortsUserInfoAndForgedSessionPrefixes() {
        String uppercaseHostToken = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("Example.COM".getBytes(StandardCharsets.US_ASCII));

        assertThatThrownBy(() -> LiveReportMirrorUrl.decodeTarget(uppercaseHostToken, "/app.js", null))
                .isInstanceOf(LiveReportException.class)
                .hasMessageContaining("canonical");
        assertThatThrownBy(() -> LiveReportMirrorUrl.toRelativeUrl(
                SESSION_ID,
                NONCE,
                URI.create("https://user@example.com/app.js")
        )).isInstanceOf(LiveReportException.class);
        assertThatThrownBy(() -> LiveReportMirrorUrl.toRelativeUrl(
                SESSION_ID,
                NONCE,
                URI.create("https://example.com:8443/app.js")
        )).isInstanceOf(LiveReportException.class);
        assertThat(LiveReportMirrorUrl.toRelativeUrl(
                SESSION_ID,
                NONCE,
                URI.create("https://example.com:443/app.js")
        )).isEqualTo(LiveReportMirrorUrl.toRelativeUrl(
                SESSION_ID,
                NONCE,
                URI.create("https://example.com/app.js")
        ));
        assertThatThrownBy(() -> LiveReportMirrorUrl.decodeRequestPath(
                SESSION_ID,
                NONCE,
                "",
                "/api/live-reports/00000000-0000-0000-0000-000000000000/mirror/" + NONCE
                        + "/ZXhhbXBsZS5jb20/app.js",
                null
        )).isInstanceOf(LiveReportException.class);
    }

    @Test
    void rejectsCombinedRuntimeUrlLengthBeyondTheRewriterBoundary() {
        URI oversized = URI.create("https://example.com/path?value=" + "a".repeat(16_384));

        assertThatThrownBy(() -> LiveReportMirrorUrl.toRelativeUrl(SESSION_ID, NONCE, oversized))
                .isInstanceOf(LiveReportException.class)
                .hasMessageContaining("too long");
        assertThatThrownBy(() -> LiveReportMirrorUrl.decodeTarget(
                "ZXhhbXBsZS5jb20",
                "/path",
                "value=" + "a".repeat(16_384)
        )).isInstanceOf(LiveReportException.class)
                .hasMessageContaining("too long");
    }

    @Test
    void browserRelativeResolutionKeepsModuleAndCssChunksInsideTheSameMirrorHostPath() {
        URI script = URI.create("https://plus.example/_nuxt/z5J4PQQh.js?v=1");
        URI mirroredScript = URI.create("https://viewer.example"
                + LiveReportMirrorUrl.toRelativeUrl(SESSION_ID, NONCE, script));

        URI moduleChunk = mirroredScript.resolve("./B8H1w4Kp.js");
        URI cssAsset = mirroredScript.resolve("../images/hero.webp?size=2x");

        String expectedPrefix = LiveReportMirrorUrl.sessionPrefix(SESSION_ID, NONCE);
        assertThat(moduleChunk.getRawPath()).startsWith(expectedPrefix).endsWith("/_nuxt/B8H1w4Kp.js");
        assertThat(cssAsset.getRawPath()).startsWith(expectedPrefix).endsWith("/images/hero.webp");
        assertThat(cssAsset.getRawQuery()).isEqualTo("size=2x");
        assertThat(LiveReportMirrorUrl.decodeRequestPath(
                SESSION_ID,
                NONCE,
                "",
                moduleChunk.getRawPath(),
                moduleChunk.getRawQuery()
        ).targetUri()).hasToString("https://plus.example/_nuxt/B8H1w4Kp.js");
    }
}
