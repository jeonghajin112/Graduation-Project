package com.accessibility.platform.livereport;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class LiveReportRequestHeadersTest {

    @Test
    void preservesAcceptAndLanguageButPinsTheDesktopIdentity() {
        LiveReportRequestHeaders headers = new LiveReportRequestHeaders(
                "text/html,application/xhtml+xml",
                "ko-KR,ko;q=0.9,en;q=0.8",
                "Mozilla/5.0 Real Browser"
        );

        assertThat(headers.accept()).isEqualTo("text/html,application/xhtml+xml");
        assertThat(headers.acceptLanguage()).isEqualTo("ko-KR,ko;q=0.9,en;q=0.8");
        assertThat(headers.userAgent()).isEqualTo(LiveReportRequestHeaders.DESKTOP_USER_AGENT);
    }

    @Test
    void phoneAndTabletRequestsUseTheSameDesktopIdentityIncludingFollowUpRequests() {
        for (String agent : new String[]{
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1",
                "Mozilla/5.0 (Linux; Android 15) Chrome/146.0.0.0 Mobile Safari/537.36",
                "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148"
        }) {
            MockHttpServletRequest request = new MockHttpServletRequest();
            request.addHeader("User-Agent", agent);
            request.addHeader("Sec-CH-UA-Mobile", "?1");
            LiveReportRequestHeaders headers = LiveReportRequestHeaders.from(request);
            assertThat(headers.userAgent()).isEqualTo(LiveReportRequestHeaders.DESKTOP_USER_AGENT)
                    .contains("Windows NT").doesNotContain("Mobile", "Android", "iPhone", "iPad");
            assertThat(headers.withUpstreamOrigin("https://example.com").userAgent())
                    .isEqualTo(headers.userAgent());
        }
        assertThat(LiveReportRequestHeaders.defaults().userAgent())
                .isEqualTo(LiveReportRequestHeaders.DESKTOP_USER_AGENT);
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
