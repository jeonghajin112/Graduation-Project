package com.accessibility.platform.common.exception;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;

class GlobalExceptionHandlerTest {
    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    void genericFailureUsesFixedJsonWithoutLeakingInternalDetails() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();

        handler.handleException(new IllegalStateException("database password is secret"), response);

        assertThat(response.getStatus()).isEqualTo(500);
        assertThat(response.getContentType()).isEqualTo("application/json;charset=UTF-8");
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(response.getContentAsString())
                .contains("\"message\":\"Unexpected server error\"")
                .doesNotContain("database password");
    }

    @Test
    void committedStreamingResponseIsNotResetOrWrittenAgain() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        response.setStatus(206);
        response.setContentType("text/html;charset=UTF-8");
        response.setCommitted(true);

        handler.handleException(new IOException("client disconnected"), response);

        assertThat(response.getStatus()).isEqualTo(206);
        assertThat(response.getContentType()).isEqualTo("text/html;charset=UTF-8");
        assertThat(response.getContentAsByteArray()).isEmpty();
    }
}
