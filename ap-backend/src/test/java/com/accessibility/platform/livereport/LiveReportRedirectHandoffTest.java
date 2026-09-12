package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.head;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class LiveReportRedirectHandoffTest {
    private static final Instant NOW = Instant.parse("2026-09-12T12:00:00Z");
    private static final URI START = URI.create("https://example.com/start");
    private static final URI FINAL = URI.create("https://cdn.example.net/app/final?lang=ko%2Fen");
    private static final byte[] BODY = "<html>public response</html>".getBytes(StandardCharsets.UTF_8);

    @Test
    void viewerAndMirrorRedirectsDeliverEligibleFinalBodyOnceWithOriginalCanonicalLocationAndBudget() throws Exception {
        for (boolean viewer : List.of(true, false)) {
            LiveReportProperties properties = new LiveReportProperties();
            // A second charge of the same body would exhaust this session.
            properties.setMaxBytesPerSession(BODY.length + 1);
            Fixture fixture = new Fixture(properties, freshHeaders(), Map.of());
            String initial = fixture.url(fixture.session, START, viewer);
            String expectedFinal = fixture.url(fixture.session, FINAL, viewer);
            fixture.mvc.perform(request(initial))
                    .andExpect(status().isFound())
                    .andExpect(header().string("Location", expectedFinal))
                    .andExpect(content().bytes(new byte[0]));
            fixture.mvc.perform(request(expectedFinal))
                    .andExpect(status().isOk())
                    .andExpect(header().string("Cache-Control", "no-store"))
                    .andExpect(content().bytes(BODY));
            assertThat(fixture.finalRequests.get()).isEqualTo(1);
            assertThat(fixture.sessions.documentUri(fixture.session)).contains(FINAL);
        }
    }

    @Test
    void uncacheableStaleAndUnrepresentedVaryResponsesRetainTheSecondFetch() throws Exception {
        for (Map<String, List<String>> extra : List.of(
                Map.of("Cache-Control", List.of("no-store")),
                Map.of("Cache-Control", List.of("private, max-age=60")),
                Map.of("Cache-Control", List.of("public, no-cache, max-age=60")),
                Map.of("Cache-Control", List.of("public, max-age=0")),
                Map.of("Vary", List.of("*")),
                Map.of("Vary", List.of("Cookie")),
                Map.of("Vary", List.of("Referer")),
                Map.of("Age", List.of("60"))
        )) {
            var headers = freshHeaders();
            headers.putAll(extra);
            Fixture fixture = new Fixture(new LiveReportProperties(), headers, Map.of());
            fixture.followRedirect();
            assertThat(fixture.finalRequests.get()).as(extra.toString()).isEqualTo(2);
        }
    }

    @Test
    void cookieBearingInitialIntermediateAndFinalResponsesCannotBeReused() throws Exception {
        for (int cookieStage = 0; cookieStage < 4; cookieStage++) {
            var headers = freshHeaders();
            var redirectHeaders = new HashMap<String, List<String>>();
            if (cookieStage == 1) redirectHeaders.put("Set-Cookie", List.of("state=one; Path=/; Secure"));
            if (cookieStage == 2) headers.put("Set-Cookie", List.of("state=two; Path=/; Secure"));
            Fixture fixture = new Fixture(new LiveReportProperties(), headers, redirectHeaders);
            if (cookieStage == 0) {
                fixture.sessions.storeResponseCookies(fixture.session, START, List.of("state=initial; Path=/; Secure"));
            }
            if (cookieStage == 3) {
                fixture.sessions.storeResponseCookies(fixture.session, FINAL, List.of("state=final; Path=/; Secure"));
            }
            fixture.followRedirect();
            assertThat(fixture.finalRequests.get()).as("cookie stage %s", cookieStage).isEqualTo(2);
        }
    }

    @Test
    void contextChangesAndExplicitReloadsDoNotConsumeTheStoredResponse() throws Exception {
        for (String[] change : List.of(
                new String[]{"Accept", "text/plain"},
                new String[]{"Accept-Language", "fr-FR"},
                new String[]{"User-Agent", "different agent"},
                new String[]{"Sec-Fetch-Dest", "image"},
                new String[]{"Referer", "https://different.example/"},
                new String[]{"Cache-Control", "no-cache"},
                new String[]{"Pragma", "no-cache"},
                new String[]{"Range", "bytes=0-2"},
                new String[]{"If-None-Match", "tag"},
                new String[]{"Authorization", "Bearer synthetic-test"},
                new String[]{"Cookie", "viewer=changed"}
        )) {
            Fixture fixture = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
            String redirected = fixture.beginRedirect();
            fixture.mvc.perform(request(redirected).header(change[0], change[1])).andExpect(status().isOk());
            assertThat(fixture.finalRequests.get()).as(change[0]).isEqualTo(2);
        }
        Fixture fixture = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        String redirected = fixture.beginRedirect();
        fixture.sessions.storeResponseCookies(fixture.session, FINAL, List.of("state=changed; Path=/; Secure"));
        fixture.mvc.perform(request(redirected)).andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(2);
    }

    @Test
    void concurrentIdenticalFinalRequestsConsumeAtMostOneHandoff() throws Exception {
        Fixture fixture = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        String redirected = fixture.beginRedirect();
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var work = (java.util.concurrent.Callable<Integer>) () -> {
                ready.countDown();
                if (!start.await(5, TimeUnit.SECONDS)) throw new AssertionError("start barrier timed out");
                return fixture.mvc.perform(request(redirected)).andReturn().getResponse().getStatus();
            };
            var first = executor.submit(work);
            var second = executor.submit(work);
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(first.get(10, TimeUnit.SECONDS)).isEqualTo(200);
            assertThat(second.get(10, TimeUnit.SECONDS)).isEqualTo(200);
        }
        // One fetch produced the retained body; exactly one concurrent miss fetches again.
        assertThat(fixture.finalRequests.get()).isEqualTo(2);
        fixture.mvc.perform(request(redirected)).andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(3);
    }

    @Test
    void handoffsRemainSessionPrivateAndExpireBeforeTheyCanBeReused() throws Exception {
        Fixture fixture = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        String redirected = fixture.beginRedirect();
        var other = fixture.sessions.create(2, START.toASCIIString());
        fixture.mvc.perform(request(fixture.url(other, FINAL, true))).andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(2);
        fixture.mvc.perform(request(redirected)).andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(2);

        Fixture expired = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        String late = expired.beginRedirect();
        expired.clock.advance(Duration.ofSeconds(5));
        expired.mvc.perform(request(late)).andExpect(status().isOk());
        assertThat(expired.finalRequests.get()).isEqualTo(2);

        Fixture deadSession = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        String stale = deadSession.beginRedirect();
        deadSession.clock.advance(Duration.ofSeconds(300));
        deadSession.mvc.perform(request(stale)).andExpect(status().isGone());
        assertThat(deadSession.finalRequests.get()).isEqualTo(1);
    }

    @Test
    void memoryAndEntryAdmissionBoundsFallBackToTheNormalFetch() throws Exception {
        for (int limit = 0; limit < 4; limit++) {
            LiveReportProperties properties = new LiveReportProperties();
            switch (limit) {
                case 0 -> properties.setMaxRedirectHandoffEntries(0);
                case 1 -> properties.setMaxRedirectHandoffEntriesPerSession(0);
                case 2 -> properties.setMaxRedirectHandoffBytes(BODY.length - 1);
                case 3 -> properties.setMaxRedirectHandoffBytesPerSession(BODY.length - 1);
            }
            Fixture fixture = new Fixture(properties, freshHeaders(), Map.of());
            fixture.followRedirect();
            assertThat(fixture.finalRequests.get()).as("bound %s", limit).isEqualTo(2);
        }
    }

    @Test
    void retainedBytesAndSlotsAreReclaimedAfterConsumptionAndExpiration() throws Exception {
        for (int limit = 0; limit < 4; limit++) {
            LiveReportProperties properties = new LiveReportProperties();
            switch (limit) {
                case 0 -> properties.setMaxRedirectHandoffEntries(1);
                case 1 -> properties.setMaxRedirectHandoffEntriesPerSession(1);
                case 2 -> properties.setMaxRedirectHandoffBytes(BODY.length);
                case 3 -> properties.setMaxRedirectHandoffBytesPerSession(BODY.length);
            }
            Fixture fixture = new Fixture(properties, freshHeaders(), Map.of());
            var context = new LiveReportRedirectHandoffStore.Context(LiveReportRequestHeaders.defaults(), null, null);
            var first = reusable(FINAL);
            var second = reusable(URI.create("https://cdn.example.net/second"));
            fixture.sessions.retainRedirectResponse(fixture.session, first, context);
            fixture.sessions.retainRedirectResponse(fixture.session, second, context);
            assertThat(fixture.sessions.takeRedirectResponse(fixture.session, second.finalUri(), context)).isEmpty();
            assertThat(fixture.sessions.takeRedirectResponse(fixture.session, first.finalUri(), context)).contains(first);
            fixture.sessions.retainRedirectResponse(fixture.session, second, context);
            assertThat(fixture.sessions.takeRedirectResponse(fixture.session, second.finalUri(), context)).contains(second);
            fixture.sessions.retainRedirectResponse(fixture.session, first, context);
            fixture.clock.advance(Duration.ofSeconds(5));
            fixture.sessions.retainRedirectResponse(fixture.session, second, context);
            assertThat(fixture.sessions.takeRedirectResponse(fixture.session, second.finalUri(), context)).contains(second);
        }
    }

    @Test
    void headAndProgrammaticRequestsNeverConsumeAnOrdinaryBrowserHandoff() throws Exception {
        Fixture fixture = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        String redirected = fixture.beginRedirect();
        fixture.mvc.perform(head(URI.create(redirected))).andExpect(status().isOk()).andExpect(content().bytes(new byte[0]));
        assertThat(fixture.finalRequests.get()).isEqualTo(2);
        fixture.mvc.perform(request(redirected).header(LiveReportTransport.HEADER_NAME, "fetch"))
                .andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(3);
        fixture.mvc.perform(request(redirected).header("Origin", fixture.routes.routeFor(fixture.session, START)
                        .viewerOrigin().toASCIIString())).andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(4);
        fixture.mvc.perform(request(redirected)).andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(4);
    }

    @Test
    void originContextNeverProducesAReusableFinalResponseAndRedirectLimitsRemainEnforced() throws Exception {
        Fixture fixture = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        var cors = fixture.fetch.fetch(fixture.session, START, null,
                LiveReportRequestHeaders.defaults().withUpstreamOrigin("https://example.com"));
        assertThat(cors.redirectReuse()).isNull();
        fixture.properties.setMaxRedirects(0);
        assertThatThrownBy(() -> fixture.fetch.fetch(fixture.session, START, null))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report redirect limit was exceeded");
        assertThat(fixture.finalRequests.get()).isEqualTo(1);
    }

    @Test
    void theWholeServerSideChainStillAllowsFourRedirectsAndRejectsTheFifth() throws Exception {
        LiveReportProperties properties = new LiveReportProperties();
        LiveReportUrlSafetyValidator validator = new LiveReportUrlSafetyValidator(host ->
                List.of(InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 34})));
        var sessions = new LiveReportSessionService(properties, validator, Clock.fixed(NOW, ZoneOffset.UTC));
        var session = sessions.create(1, "https://example.com/0");
        var upstream = mock(LiveReportUpstreamClient.class);
        AtomicInteger chainLength = new AtomicInteger(4);
        AtomicInteger finalBodies = new AtomicInteger();
        when(upstream.send(any(HttpRequest.class), anyList())).thenAnswer(invocation -> {
            HttpRequest request = invocation.getArgument(0);
            int hop = Integer.parseInt(request.uri().getPath().substring(1));
            if (hop < chainLength.get()) {
                return new LiveReportUpstreamClient.UpstreamResponse(302,
                        Map.of("Location", List.of("/" + (hop + 1))), new byte[0]);
            }
            finalBodies.incrementAndGet();
            return new LiveReportUpstreamClient.UpstreamResponse(200, freshHeaders(), BODY);
        });
        var fetch = new LiveReportFetchService(upstream, properties, validator, sessions);
        assertThat(fetch.fetch(session, session.targetUri(), null).finalUri()).hasToString("https://example.com/4");
        chainLength.set(5);
        assertThatThrownBy(() -> fetch.fetch(session, session.targetUri(), null))
                .isInstanceOf(LiveReportException.class).hasMessage("Live report redirect limit was exceeded");
        assertThat(finalBodies.get()).isEqualTo(1);
    }

    @Test
    void directDocumentAndResourceAliasesDoNotSeedOrConsumeCanonicalHandoffs() throws Exception {
        Fixture fixture = new Fixture(new LiveReportProperties(), freshHeaders(), Map.of());
        String redirected = fixture.beginRedirect();
        fixture.mvc.perform(get("/api/live-reports/{session}/document", fixture.session.id())
                        .param("nonce", fixture.session.nonce())).andExpect(status().isOk());
        fixture.mvc.perform(get("/api/live-reports/{session}/resource", fixture.session.id())
                        .param("nonce", fixture.session.nonce()).param("url", FINAL.toASCIIString()))
                .andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(3);
        fixture.mvc.perform(request(redirected)).andExpect(status().isOk());
        assertThat(fixture.finalRequests.get()).isEqualTo(3);
    }

    @Test
    void freshnessUsesDateAgeAndResponseDelayAndRejectsMalformedOrUnsupportedPolicies() {
        var headers = freshHeaders();
        headers.put("Age", List.of("50"));
        var response = new LiveReportUpstreamClient.UpstreamResponse(200, headers, BODY);
        assertThat(LiveReportRedirectHandoffStore.freshUntil(response, NOW.minusSeconds(3), NOW))
                .contains(NOW.plusSeconds(7));
        assertThat(LiveReportRedirectHandoffStore.freshUntil(response, NOW, NOW.plusSeconds(60))).isEmpty();
        for (String policy : List.of("public", "public, max-age=-1", "public, max-age=one",
                "public, max-age=10, max-age=60", "public, max-age=999999999999999999999",
                "public, max-age=60, s-maxage=0", "public, max-age=60, private=\"Set-Cookie\"")) {
            var invalid = freshHeaders();
            invalid.put("Cache-Control", List.of(policy));
            assertThat(LiveReportRedirectHandoffStore.freshUntil(
                    new LiveReportUpstreamClient.UpstreamResponse(200, invalid, BODY), NOW, NOW))
                    .as(policy).isEmpty();
        }
        headers.remove("Date");
        assertThat(LiveReportRedirectHandoffStore.freshUntil(
                new LiveReportUpstreamClient.UpstreamResponse(200, headers, BODY), NOW, NOW)).isEmpty();
    }

    private static Map<String, List<String>> freshHeaders() {
        var headers = new HashMap<String, List<String>>();
        headers.put("Content-Type", List.of("text/html; charset=UTF-8"));
        headers.put("Cache-Control", List.of("public, max-age=60"));
        headers.put("Date", List.of(DateTimeFormatter.RFC_1123_DATE_TIME.format(NOW.atZone(ZoneOffset.UTC))));
        headers.put("Vary", List.of("Accept, Accept-Language, User-Agent"));
        headers.put("Access-Control-Allow-Origin", List.of("https://example.com"));
        return headers;
    }

    private static LiveReportFetchService.FetchedResource reusable(URI uri) {
        return new LiveReportFetchService.FetchedResource(200, uri, "text/html", BODY,
                LiveReportFetchService.CorsEvidence.none(),
                new LiveReportFetchService.RedirectReuse(NOW.plusSeconds(60), LiveReportRequestHeaders.defaults(), 0));
    }

    private static MockHttpServletRequestBuilder request(String url) {
        return get(URI.create(url));
    }

    private static final class Fixture {
        final MutableClock clock = new MutableClock();
        final LiveReportProperties properties;
        final LiveReportSessionService sessions;
        final LiveReportSessionService.LiveReportSession session;
        final LiveReportOriginRouteRegistry routes;
        final LiveReportFetchService fetch;
        final AtomicInteger finalRequests = new AtomicInteger();
        final MockMvc mvc;

        Fixture(LiveReportProperties properties, Map<String, List<String>> finalHeaders,
                Map<String, List<String>> extraRedirectHeaders) throws Exception {
            this.properties = properties;
            LiveReportUrlSafetyValidator validator = new LiveReportUrlSafetyValidator(host ->
                    List.of(InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 34})));
            sessions = new LiveReportSessionService(properties, validator, clock);
            session = sessions.create(1, START.toASCIIString());
            routes = new LiveReportOriginRouteRegistry(sessions, properties, clock);
            LiveReportUpstreamClient upstream = mock(LiveReportUpstreamClient.class);
            when(upstream.send(any(HttpRequest.class), anyList())).thenAnswer(invocation -> {
                HttpRequest request = invocation.getArgument(0);
                if (request.uri().equals(START)) {
                    var redirectHeaders = new HashMap<>(extraRedirectHeaders);
                    redirectHeaders.put("Location", List.of(FINAL.toASCIIString()));
                    return new LiveReportUpstreamClient.UpstreamResponse(302, redirectHeaders, new byte[0]);
                }
                assertThat(request.uri()).isEqualTo(FINAL);
                finalRequests.incrementAndGet();
                return new LiveReportUpstreamClient.UpstreamResponse(200, finalHeaders, BODY);
            });
            fetch = new LiveReportFetchService(upstream, properties, validator, sessions);
            LiveReportDocumentRewriter rewriter = mock(LiveReportDocumentRewriter.class);
            when(rewriter.rewriteHtml(any(), any())).thenAnswer(invocation ->
                    ((LiveReportFetchService.FetchedResource) invocation.getArgument(0)).bytes());
            mvc = MockMvcBuilders.standaloneSetup(new LiveReportController(
                    mock(LiveReportLaunchService.class), sessions, fetch, rewriter, properties, routes
            )).addFilters(new LiveReportViewerRoutingFilter(routes), new LiveReportTransportFilter(properties)).build();
        }

        String url(LiveReportSessionService.LiveReportSession owningSession, URI uri, boolean viewer) {
            return viewer ? routes.runtimeUrl(owningSession, uri)
                    : LiveReportMirrorUrl.toRelativeUrl(owningSession.id(), owningSession.nonce(), uri);
        }

        String beginRedirect() throws Exception {
            return mvc.perform(request(url(session, START, true))).andExpect(status().isFound())
                    .andReturn().getResponse().getHeader("Location");
        }

        void followRedirect() throws Exception {
            mvc.perform(request(beginRedirect())).andExpect(status().isOk());
        }
    }

    private static final class MutableClock extends Clock {
        private Instant now = NOW;
        void advance(Duration duration) { now = now.plus(duration); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }
}
