package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class LiveReportOriginRouteRegistryTest {
    private static final Instant NOW = Instant.parse("2026-09-02T00:00:00Z");
    private final LiveReportSessionService sessionService = mock(LiveReportSessionService.class);
    private final LiveReportProperties properties = new LiveReportProperties();
    private final LiveReportSessionService.LiveReportSession session =
            new LiveReportSessionService.LiveReportSession(
                    UUID.fromString("6b2d884e-a7f4-4f09-9776-688d08fe8912"),
                    7L,
                    URI.create("https://example.com/app/start"),
                    "test-nonce",
                    "test-bridge-secret",
                    NOW.plusSeconds(300)
            );
    private LiveReportOriginRouteRegistry registry;

    @BeforeEach
    void setUp() {
        properties.setViewerBaseUrl("http://localhost:9090");
        properties.setGatewayBaseUrl("http://localhost:9090");
        registry = new LiveReportOriginRouteRegistry(
                sessionService,
                properties,
                Clock.fixed(NOW, ZoneOffset.UTC)
        );
        when(sessionService.requireAuthorized(session.id(), session.nonce())).thenReturn(session);
    }

    @Test
    void keepsRawPathQueryAndFragmentOnAnOpaqueDedicatedViewerOrigin() {
        URI target = URI.create("https://example.com/a/%2F/b?next=%2Fhome#section-1");

        String runtimeUrl = registry.runtimeUrl(session, target);
        URI runtime = URI.create(runtimeUrl);

        assertThat(runtime.getHost()).matches("[a-f0-9]{40}\\.localhost");
        assertThat(runtime.getPort()).isEqualTo(9090);
        assertThat(runtime.getRawPath()).isEqualTo("/a/%2F/b");
        assertThat(runtime.getRawQuery()).isEqualTo("next=%2Fhome");
        assertThat(runtime.getRawFragment()).isEqualTo("section-1");
        assertThat(runtime.getRawPath()).doesNotContain("live-reports");
        assertThat(registry.viewerWildcardSource()).isEqualTo("http://*.localhost:9090");
        assertThat(registry.gatewayOrigin()).isEqualTo("http://localhost:9090");
        assertThat(registry.dashboardOrigin()).isEqualTo("http://localhost:5173");
        assertThat(registry.dashboardFrameAncestorSources())
                .isEqualTo("http://localhost:5173 http://127.0.0.1:5173");
    }

    @Test
    void reusesOneOriginForTheSameUpstreamAndSeparatesDifferentOrigins() {
        var first = registry.routeFor(session, URI.create("https://example.com/one"));
        var same = registry.routeFor(session, URI.create("https://example.com/two"));
        var other = registry.routeFor(session, URI.create("https://cdn.example.com/asset.js"));

        assertThat(same.viewerOrigin()).isEqualTo(first.viewerOrigin());
        assertThat(other.viewerOrigin()).isNotEqualTo(first.viewerOrigin());
        assertThat(first.upstreamOrigin()).isEqualTo(URI.create("https://example.com"));
        assertThat(other.upstreamOrigin()).isEqualTo(URI.create("https://cdn.example.com"));
    }

    @Test
    void resolvesEveryViewerPathAgainstOnlyItsBoundUpstreamOrigin() {
        var route = registry.routeFor(session, URI.create("https://example.com/app/start"));

        var request = registry.requireViewerRequest(
                route.viewerOrigin().getHost(),
                "/api/items/%2Fdetail",
                "page=1&return=%2Fhome"
        );

        assertThat(request.session()).isSameAs(session);
        assertThat(request.targetUri().toASCIIString())
                .isEqualTo("https://example.com/api/items/%2Fdetail?page=1&return=%2Fhome");
        assertThat(request.upstreamOrigin()).isEqualTo(URI.create("https://example.com"));
    }

    @Test
    void acceptsASingleTrailingDnsRootDotOnARegisteredViewerHost() {
        var route = registry.routeFor(session, URI.create("https://example.com/app/start"));

        var request = registry.requireViewerRequest(
                route.viewerOrigin().getHost() + ".",
                "/app/start",
                null
        );

        assertThat(request.route().token()).isEqualTo(route.token());
        assertThat(request.targetUri()).isEqualTo(URI.create("https://example.com/app/start"));
    }

    @Test
    void rejectsInvalidRawQueriesAsBadRequests() {
        var route = registry.routeFor(session, URI.create("https://example.com/app/start"));

        assertThatThrownBy(() -> registry.requireViewerRequest(
                route.viewerOrigin().getHost(),
                "/api/items",
                "page=1#forged-fragment"
        )).isInstanceOfSatisfying(LiveReportException.class,
                exception -> assertThat(exception.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    @Test
    void aStaleSessionObjectCannotShrinkARenewedRoutesExpiration() {
        MutableClock mutableClock = new MutableClock(NOW);
        registry = new LiveReportOriginRouteRegistry(sessionService, properties, mutableClock);
        LiveReportSessionService.LiveReportSession renewed = sessionWithExpiration(NOW.plusSeconds(900));
        LiveReportSessionService.LiveReportSession stale = sessionWithExpiration(NOW.plusSeconds(120));

        var initial = registry.routeFor(session, URI.create("https://example.com/app/start"));
        registry.routeFor(renewed, URI.create("https://example.com/app/renewed"));
        registry.routeFor(stale, URI.create("https://example.com/app/stale"));

        mutableClock.setInstant(NOW.plusSeconds(600));
        registry.routeFor(renewed, URI.create("https://cdn.example.com/asset.js"));
        var afterPurge = registry.routeFor(renewed, URI.create("https://example.com/app/after-purge"));

        assertThat(afterPurge.token()).isEqualTo(initial.token());
    }

    @Test
    void rejectsUnregisteredNestedOrWrongBaseHostsUniformly() {
        var route = registry.routeFor(session, URI.create("https://example.com/app"));
        String validHost = route.viewerOrigin().getHost();

        assertThatThrownBy(() -> registry.requireViewerRequest("unknown-token.localhost", "/", null))
                .isInstanceOfSatisfying(LiveReportException.class,
                        exception -> assertThat(exception.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> registry.requireViewerRequest("nested." + validHost, "/", null))
                .isInstanceOfSatisfying(LiveReportException.class,
                        exception -> assertThat(exception.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> registry.requireViewerRequest(validHost + ".example", "/", null))
                .isInstanceOfSatisfying(LiveReportException.class,
                        exception -> assertThat(exception.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    void boundsDistinctOriginsPerSession() {
        properties.setMaxOriginsPerSession(1);
        registry = new LiveReportOriginRouteRegistry(
                sessionService,
                properties,
                Clock.fixed(NOW, ZoneOffset.UTC)
        );

        registry.routeFor(session, URI.create("https://example.com/page"));

        assertThatThrownBy(() -> registry.routeFor(session, URI.create("https://cdn.example.com/file")))
                .isInstanceOfSatisfying(LiveReportException.class,
                        exception -> assertThat(exception.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS));
    }

    @Test
    void routesBracketedPublicIpv6OriginsWithoutChangingTheirAuthority() {
        URI target = URI.create("https://[2606:4700:4700::1111]/assets/app.js?v=1");

        var route = registry.routeFor(session, target);
        URI runtime = URI.create(registry.runtimeUrl(session, target));

        assertThat(route.upstreamOrigin()).isEqualTo(URI.create("https://[2606:4700:4700::1111]"));
        assertThat(runtime.getRawPath()).isEqualTo("/assets/app.js");
        assertThat(runtime.getRawQuery()).isEqualTo("v=1");
    }

    @Test
    void rejectsConfiguredOriginsWithAnInvalidTcpPort() {
        properties.setViewerBaseUrl("https://replay.example:65536");

        assertThatThrownBy(() -> new LiveReportOriginRouteRegistry(
                sessionService,
                properties,
                Clock.fixed(NOW, ZoneOffset.UTC)
        )).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("viewer base URL");
    }

    private LiveReportSessionService.LiveReportSession sessionWithExpiration(Instant expiration) {
        return new LiveReportSessionService.LiveReportSession(
                session.id(),
                session.requestId(),
                session.targetUri(),
                session.nonce(),
                session.bridgeSecret(),
                expiration
        );
    }

    private static final class MutableClock extends Clock {
        private Instant instant;

        private MutableClock(Instant instant) {
            this.instant = instant;
        }

        void setInstant(Instant instant) {
            this.instant = instant;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return zone.equals(ZoneOffset.UTC) ? this : Clock.fixed(instant, zone);
        }

        @Override
        public Instant instant() {
            return instant;
        }
    }
}
