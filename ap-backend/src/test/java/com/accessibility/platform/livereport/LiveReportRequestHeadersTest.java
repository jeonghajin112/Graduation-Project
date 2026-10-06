package com.accessibility.platform.livereport;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LiveReportRequestHeadersTest {

    @Test
    void preservesSafeBrowserSemantics() {
        LiveReportRequestHeaders headers = new LiveReportRequestHeaders(
                "text/html,application/xhtml+xml",
                "ko-KR,ko;q=0.9,en;q=0.8",
                "Mozilla/5.0 Real Browser"
        );

        assertThat(headers.accept()).isEqualTo("text/html,application/xhtml+xml");
        assertThat(headers.acceptLanguage()).isEqualTo("ko-KR,ko;q=0.9,en;q=0.8");
        assertThat(headers.userAgent()).isEqualTo("Mozilla/5.0 Real Browser");
    }

    @Test
    void replacesControlCharactersAndOversizedValuesWithBoundedDefaults() {
        LiveReportRequestHeaders headers = new LiveReportRequestHeaders(
                "text/html\r\nAuthorization: secret",
                "x".repeat(513),
                "Browser\u0000Injected"
        );

        assertThat(headers.accept()).isEqualTo("*/*");
        assertThat(headers.acceptLanguage()).isEqualTo("ko-KR,ko;q=0.9,en;q=0.8");
        assertThat(headers.userAgent()).doesNotContain("Injected");
        assertThat(headers.userAgent().getBytes(java.nio.charset.StandardCharsets.UTF_8).length)
                .isLessThanOrEqualTo(512);
    }
}
