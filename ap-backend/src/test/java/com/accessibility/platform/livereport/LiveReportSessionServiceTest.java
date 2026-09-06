package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.net.URI;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LiveReportSessionServiceTest {
    private static final Instant NOW = Instant.parse("2026-09-01T12:00:00Z");

    @Test
    void createsShortLivedSessionAndRequiresItsNonce() throws Exception {
        LiveReportProperties properties = properties(300, 2);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                Clock.fixed(NOW, ZoneOffset.UTC)
        );

        LiveReportSessionService.LiveReportSession session = service.create(31L, "https://example.com/page");

        assertThat(session.requestId()).isEqualTo(31L);
        assertThat(session.targetUri()).hasToString("https://example.com/page");
        assertThat(session.expiresAt()).isEqualTo(NOW.plusSeconds(300));
        assertThat(session.nonce()).hasSizeGreaterThanOrEqualTo(32);
        assertThat(session.bridgeSecret())
                .hasSize(43)
                .matches("^[A-Za-z0-9_-]+$")
                .isNotEqualTo(session.nonce());
        LiveReportSessionService.LiveReportSession second = service.create(32L, "https://example.com/other");
        assertThat(second.bridgeSecret()).isNotEqualTo(session.bridgeSecret());
        assertThat(service.requireAuthorized(session.id(), session.nonce())).isEqualTo(session);
        assertThatThrownBy(() -> service.requireAuthorized(session.id(), "wrong"))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session was not found");
    }

    @Test
    void renewsAnActiveSessionWithoutReplacingItsIsolatedBrowserState() throws Exception {
        LiveReportProperties properties = properties(300, 2);
        MutableClock clock = new MutableClock(NOW);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                clock
        );
        LiveReportSessionService.LiveReportSession original = service.create(
                31L,
                "https://example.com/page"
        );
        URI currentDocument = URI.create("https://example.com/account/profile");
        service.recordDocumentUri(original, currentDocument);
        service.storeResponseCookies(original, currentDocument, List.of("viewer=active; Path=/; Secure"));

        clock.advance(Duration.ofSeconds(270));
        LiveReportSessionService.LiveReportSession renewed = service.renew(original.id(), 31L);

        assertThat(renewed.id()).isEqualTo(original.id());
        assertThat(renewed.nonce()).isEqualTo(original.nonce());
        assertThat(renewed.bridgeSecret()).isEqualTo(original.bridgeSecret());
        assertThat(renewed.expiresAt()).isEqualTo(NOW.plusSeconds(570));
        assertThat(service.documentUri(renewed)).contains(currentDocument);
        assertThat(service.cookieHeader(renewed, currentDocument)).contains("viewer=active");
        assertThatThrownBy(() -> service.renew(original.id(), 32L))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session was not found");
    }

    @Test
    void expiredSessionsAreRejectedAndPurgedBeforeCapacityCheck() throws Exception {
        LiveReportProperties properties = properties(0, 1);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                Clock.fixed(NOW, ZoneOffset.UTC)
        );

        LiveReportSessionService.LiveReportSession expired = service.create(1L, "https://example.com/one");

        assertThatThrownBy(() -> service.require(expired.id()))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session has expired");
        assertThat(service.create(2L, "https://example.com/two").requestId()).isEqualTo(2L);
    }

    @Test
    void enforcesPerSessionRequestByteAndConcurrencyBudgets() throws Exception {
        LiveReportProperties properties = properties(300, 2);
        properties.setMaxRequestsPerSession(2);
        properties.setMaxBytesPerSession(5);
        properties.setMaxConcurrentRequestsPerSession(1);
        properties.setConcurrentRequestWaitMillis(1);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                Clock.fixed(NOW, ZoneOffset.UTC)
        );
        LiveReportSessionService.LiveReportSession session = service.create(31L, "https://example.com/page");

        try (LiveReportSessionService.RequestLease first = service.acquireRequest(session)) {
            assertThatThrownBy(() -> service.acquireRequest(session))
                    .isInstanceOf(LiveReportException.class)
                    .hasMessage("Live report concurrency limit was exceeded");
            service.recordResponseBytes(session, 5);
        }

        assertThatThrownBy(() -> service.acquireRequest(session))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session budget was exceeded");
    }

    @Test
    void brieflyQueuesAResourceBurstUntilAnActiveRequestFinishes() throws Exception {
        LiveReportProperties properties = properties(300, 2);
        properties.setMaxRequestsPerSession(3);
        properties.setMaxConcurrentRequestsPerSession(1);
        properties.setConcurrentRequestWaitMillis(1000);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                Clock.fixed(NOW, ZoneOffset.UTC)
        );
        LiveReportSessionService.LiveReportSession session = service.create(31L, "https://example.com/page");
        java.util.concurrent.CountDownLatch started = new java.util.concurrent.CountDownLatch(1);

        try (LiveReportSessionService.RequestLease first = service.acquireRequest(session)) {
            java.util.concurrent.CompletableFuture<LiveReportSessionService.RequestLease> waiting =
                    java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                        started.countDown();
                        return service.acquireRequest(session);
                    });
            assertThat(started.await(1, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(waiting).isNotDone();
            first.close();
            try (LiveReportSessionService.RequestLease second =
                         waiting.get(1, java.util.concurrent.TimeUnit.SECONDS)) {
                assertThat(second).isNotNull();
            }
        }
    }

    @Test
    void rejectedByteChargeAtomicallyExhaustsBudgetWithoutOverflow() throws Exception {
        LiveReportProperties properties = properties(300, 1);
        properties.setMaxBytesPerSession(5);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                Clock.fixed(NOW, ZoneOffset.UTC)
        );
        LiveReportSessionService.LiveReportSession session = service.create(31L, "https://example.com/page");

        service.recordResponseBytes(session, 4);
        assertThatThrownBy(() -> service.recordResponseBytes(session, 2))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session budget was exceeded");

        // The transfer already consumed upstream resources. The counter saturates
        // at 5 (never 6), and the session cannot repeat the over-budget download.
        assertThatThrownBy(() -> service.acquireRequest(session))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session budget was exceeded");
    }

    @Test
    void expiresCookiesAndRemovesTheJarWithItsSession() throws Exception {
        LiveReportProperties properties = properties(5, 1);
        MutableClock clock = new MutableClock(NOW);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                clock
        );
        LiveReportSessionService.LiveReportSession session = service.create(31L, "https://example.com/page");
        URI uri = URI.create("https://example.com/app/data");

        service.storeResponseCookies(session, uri, List.of("short-lived=yes; Path=/; Max-Age=1; Secure"));
        assertThat(service.cookieHeader(session, uri)).contains("short-lived=yes");

        clock.advance(Duration.ofSeconds(2));
        assertThat(service.cookieHeader(session, uri)).isEmpty();

        service.storeResponseCookies(session, uri, List.of("session-state=present; Path=/; Secure"));
        clock.advance(Duration.ofSeconds(4));
        assertThatThrownBy(() -> service.require(session.id()))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session has expired");
        assertThatThrownBy(() -> service.cookieHeader(session, uri))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session was not found");

        LiveReportSessionService.LiveReportSession replacement = service.create(
                32L,
                "https://example.com/replacement"
        );
        assertThat(service.cookieHeader(replacement, uri)).isEmpty();
    }

    @Test
    void boundsCookieCountIndividualSizeAndTotalSessionBytes() throws Exception {
        LiveReportProperties properties = properties(300, 2);
        properties.setMaxCookiesPerSession(2);
        properties.setMaxCookieBytes(64);
        properties.setMaxCookieBytesPerSession(80);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                Clock.fixed(NOW, ZoneOffset.UTC)
        );
        LiveReportSessionService.LiveReportSession session = service.create(31L, "https://example.com/page");
        URI uri = URI.create("https://example.com/");

        service.storeResponseCookies(session, uri, List.of(
                "first=1; Path=/; Secure",
                "second=2; Path=/; Secure",
                "third=3; Path=/; Secure",
                "oversized=" + "x".repeat(200) + "; Path=/; Secure"
        ));

        String header = service.cookieHeader(session, uri).orElseThrow();
        assertThat(header)
                .doesNotContain("first=1")
                .contains("second=2")
                .contains("third=3")
                .doesNotContain("oversized=");
        assertThat(header.split("; ")).hasSize(2);
    }

    @Test
    void keepsFinalDocumentReferrersIsolatedPerSessionAndPurgesThemOnExpiry() throws Exception {
        LiveReportProperties properties = properties(5, 2);
        MutableClock clock = new MutableClock(NOW);
        LiveReportSessionService service = new LiveReportSessionService(
                properties,
                publicUrlValidator(),
                clock
        );
        LiveReportSessionService.LiveReportSession first = service.create(31L, "https://example.com/one");
        LiveReportSessionService.LiveReportSession second = service.create(32L, "https://example.com/two");
        URI finalUri = URI.create("https://www.example.com/final/one");

        service.recordDocumentUri(first, finalUri);

        assertThat(service.documentUri(first)).contains(finalUri);
        assertThat(service.documentUri(second)).isEmpty();
        clock.advance(Duration.ofSeconds(5));
        assertThatThrownBy(() -> service.documentUri(first))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report session has expired");
    }

    private LiveReportProperties properties(int ttlSeconds, int maxSessions) {
        LiveReportProperties properties = new LiveReportProperties();
        properties.setSessionTtlSeconds(ttlSeconds);
        properties.setMaxSessions(maxSessions);
        properties.setMaxRequestsPerSession(256);
        properties.setMaxBytesPerSession(1024);
        properties.setMaxConcurrentRequestsPerSession(8);
        return properties;
    }

    private LiveReportUrlSafetyValidator publicUrlValidator() throws Exception {
        InetAddress publicAddress = InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 34});
        return new LiveReportUrlSafetyValidator(host -> java.util.List.of(publicAddress));
    }

    private static final class MutableClock extends Clock {
        private Instant current;

        private MutableClock(Instant current) {
            this.current = current;
        }

        private void advance(Duration duration) {
            current = current.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return Clock.fixed(current, zone);
        }

        @Override
        public Instant instant() {
            return current;
        }
    }
}
