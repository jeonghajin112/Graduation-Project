package com.accessibility.platform.livereport;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class LiveReportViewerConnectorIntegrationTest {
    private static final UUID SESSION_ID =
            UUID.fromString("6b2d884e-a7f4-4f09-9776-688d08fe8912");
    private static final String TRANSPORT_HEADER = "X-Accessibility-Live-Transport";
    private static final URI ENCODED_TARGET =
            URI.create("https://example.com/api/items/%2Fdetail?page=1&return=%2Fhome");

    @LocalServerPort
    int port;

    @Autowired
    LiveReportOriginRouteRegistry originRoutes;

    @MockitoBean
    LiveReportSessionService sessionService;

    @MockitoBean
    LiveReportFetchService fetchService;

    private final AtomicReference<URI> fetchedTarget = new AtomicReference<>();
    private LiveReportSessionService.LiveReportSession session;
    private String viewerHost;

    @BeforeEach
    void setUp() {
        fetchedTarget.set(null);
        session = new LiveReportSessionService.LiveReportSession(
                SESSION_ID,
                7L,
                ENCODED_TARGET,
                "test-nonce",
                "test-bridge-secret",
                Instant.now().plusSeconds(300)
        );
        viewerHost = originRoutes.routeFor(session, ENCODED_TARGET).viewerOrigin().getHost();

        when(sessionService.requireAuthorized(session.id(), session.nonce())).thenReturn(session);
        when(sessionService.documentUri(session)).thenReturn(Optional.empty());
        when(sessionService.acquireRequest(session))
                .thenReturn(mock(LiveReportSessionService.RequestLease.class));
        when(fetchService.fetch(
                eq(session),
                any(URI.class),
                nullable(URI.class),
                any(LiveReportRequestHeaders.class)
        )).thenAnswer(invocation -> {
            URI target = invocation.getArgument(1);
            fetchedTarget.set(target);
            return new LiveReportFetchService.FetchedResource(
                    200,
                    target,
                    "text/plain",
                    "ok".getBytes(StandardCharsets.UTF_8)
            );
        });
        when(fetchService.fetchPreflight(
                eq(session),
                any(URI.class),
                any(LiveReportRequestHeaders.class),
                any(String.class),
                nullable(String.class)
        )).thenAnswer(invocation -> new LiveReportFetchService.FetchedResource(
                204,
                invocation.getArgument(1),
                "application/octet-stream",
                new byte[0],
                new LiveReportFetchService.CorsEvidence(true, true, true)
        ));
    }

    @Test
    void preservesEncodedSolidusThroughTheRealTomcatConnectorAndViewerRoute() throws Exception {
        RawHttpResponse response = exchangeRaw(
                "GET",
                "/api/items/%2Fdetail?page=1&return=%2Fhome",
                viewerHost
        );

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).isEqualTo("ok");
        assertThat(fetchedTarget.get()).isEqualTo(ENCODED_TARGET);
        assertThat(fetchedTarget.get().getRawPath()).isEqualTo("/api/items/%2Fdetail");
        assertThat(fetchedTarget.get().getRawQuery()).isEqualTo("page=1&return=%2Fhome");
    }

    @Test
    void continuesToRejectEncodedReverseSolidusAtTheConnector() throws Exception {
        RawHttpResponse response = exchangeRaw("GET", "/api/items/%5Cdetail", viewerHost);

        assertThat(response.statusCode()).isEqualTo(400);
        assertThat(fetchedTarget.get()).isNull();
    }

    @Test
    void rejectsEncodedSolidusOnTheControlPlaneHostBeforeMvcRouting() throws Exception {
        RawHttpResponse response = exchangeRaw(
                "GET",
                "/api/results/requests/%2F7",
                "localhost"
        );

        assertThat(response.statusCode()).isEqualTo(400);
        assertThat(response.header("Cache-Control")).contains("no-store");
        assertThat(fetchedTarget.get()).isNull();
    }

    @Test
    void malformedViewerZoneHostStillFailsClosedInTheViewerRouter() throws Exception {
        RawHttpResponse response = exchangeRaw(
                "GET",
                "/api/results/requests/%2F7",
                "not-a-route.localhost"
        );

        assertThat(response.statusCode()).isEqualTo(404);
        assertThat(response.header("Cache-Control")).contains("no-store");
        assertThat(fetchedTarget.get()).isNull();
    }

    @Test
    void permitsCredentiallessViewerPreflightOnlyForTheLiveReportMirrorGateway() throws Exception {
        String viewerOrigin = "http://" + viewerHost + ":9090";
        HttpResponse<String> allowed = preflight(
                "/api/live-reports/" + session.id()
                        + "/mirror/" + session.nonce() + "/ZXhhbXBsZS5jb20/data",
                viewerOrigin
        );

        assertThat(allowed.statusCode()).isEqualTo(204);
        assertThat(allowed.headers().firstValue(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN))
                .contains(viewerOrigin);
        assertThat(allowed.headers().firstValue(HttpHeaders.ACCESS_CONTROL_ALLOW_HEADERS))
                .hasValueSatisfying(value -> assertThat(value).containsIgnoringCase(TRANSPORT_HEADER));
        assertThat(allowed.headers().firstValue(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS)).isEmpty();

        HttpResponse<String> unrelatedApi = preflight(
                "/api/results/requests/7/live-session",
                viewerOrigin
        );
        assertThat(unrelatedApi.statusCode()).isEqualTo(403);
        assertThat(unrelatedApi.headers().firstValue(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isEmpty();
    }

    @Test
    void doesNotGrantAnActualGatewayReadWhenUpstreamDidNotAllowCors() throws Exception {
        String viewerOrigin = "http://" + viewerHost + ":9090";
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/live-reports/"
                        + session.id() + "/mirror/" + session.nonce()
                        + "/ZXhhbXBsZS5jb20/data"))
                .header(HttpHeaders.ORIGIN, viewerOrigin)
                .header(TRANSPORT_HEADER, "fetch")
                .GET()
                .build();

        HttpResponse<String> response = HttpClient.newHttpClient()
                .send(request, HttpResponse.BodyHandlers.ofString());

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isEmpty();
    }

    private RawHttpResponse exchangeRaw(String method, String requestTarget, String host) throws IOException {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 5_000);
            socket.setSoTimeout(5_000);
            String request = method + " " + requestTarget + " HTTP/1.1\r\n"
                    + "Host: " + host + ":" + port + "\r\n"
                    + "Connection: close\r\n"
                    + "\r\n";
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().flush();

            String rawResponse = new String(
                    socket.getInputStream().readAllBytes(),
                    StandardCharsets.ISO_8859_1
            );
            int firstSpace = rawResponse.indexOf(' ');
            int secondSpace = rawResponse.indexOf(' ', firstSpace + 1);
            int bodyStart = rawResponse.indexOf("\r\n\r\n");
            assertThat(firstSpace).isPositive();
            assertThat(secondSpace).isGreaterThan(firstSpace);
            assertThat(bodyStart).isNotNegative();
            return new RawHttpResponse(
                    Integer.parseInt(rawResponse.substring(firstSpace + 1, secondSpace)),
                    rawResponse.substring(0, bodyStart),
                    rawResponse.substring(bodyStart + 4)
            );
        }
    }

    private HttpResponse<String> preflight(String path, String origin) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + path))
                .header(HttpHeaders.ORIGIN, origin)
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET")
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, TRANSPORT_HEADER)
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                .build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    }

    private record RawHttpResponse(int statusCode, String headers, String body) {
        Optional<String> header(String name) {
            return headers.lines()
                    .map(String::trim)
                    .filter(line -> line.regionMatches(true, 0, name + ":", 0, name.length() + 1))
                    .map(line -> line.substring(name.length() + 1).trim())
                    .findFirst();
        }
    }
}
