package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiveReportFetchServiceTest {

    @Test
    void followsRedirectOnlyAfterRevalidatingLocationAndUsesAnOriginOnlyCrossSiteReferrer() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse redirect = response(
                302,
                Map.of("Location", List.of("https://cdn.example.com/page")),
                new byte[0]
        );
        LiveReportUpstreamClient.UpstreamResponse success = response(
                200,
                Map.of("Content-Type", List.of("text/html")),
                "ok".getBytes(StandardCharsets.UTF_8)
        );
        when(client.send(any(HttpRequest.class), anyList()))
                .thenReturn(redirect)
                .thenReturn(success);
        Harness harness = harness(client, properties(1024));

        LiveReportFetchService.FetchedResource fetched = harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/start?public=1"),
                null
        );

        assertThat(fetched.finalUri()).hasToString("https://cdn.example.com/page");
        assertThat(fetched.bytes()).isEqualTo("ok".getBytes(StandardCharsets.UTF_8));
        ArgumentCaptor<HttpRequest> requests = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client, times(2)).send(requests.capture(), anyList());
        assertThat(requests.getAllValues().get(1).headers().firstValue("Referer"))
                .contains("https://example.com/");
    }

    @Test
    void sendsAnonymousResponseCookiesOnLaterSessionRequestsWithBrowserLanguageAndSafeReferrer() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse documentResponse = response(
                200,
                Map.of(
                        "Content-Type", List.of("text/html"),
                        "Set-Cookie", List.of("anonymous-session=abc123; Path=/; Secure; HttpOnly")
                ),
                "document".getBytes(StandardCharsets.UTF_8)
        );
        LiveReportUpstreamClient.UpstreamResponse stylesheetResponse = response(
                200,
                Map.of("Content-Type", List.of("text/css")),
                "body{}".getBytes(StandardCharsets.UTF_8)
        );
        when(client.send(any(HttpRequest.class), anyList()))
                .thenReturn(documentResponse)
                .thenReturn(stylesheetResponse);
        Harness harness = harness(client, properties(1024));
        URI documentUri = URI.create("https://example.com/app/index?theme=light");

        harness.service().fetch(harness.session(), documentUri, null);
        harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/assets/app.css"),
                documentUri
        );

        ArgumentCaptor<HttpRequest> requests = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client, times(2)).send(requests.capture(), anyList());
        HttpRequest first = requests.getAllValues().get(0);
        HttpRequest second = requests.getAllValues().get(1);
        assertThat(first.headers().firstValue("Cookie")).isEmpty();
        assertThat(second.headers().firstValue("Cookie")).contains("anonymous-session=abc123");
        assertThat(second.headers().firstValue("Referer"))
                .contains("https://example.com/app/index?theme=light");
        assertThat(second.headers().firstValue("Accept-Language"))
                .contains("ko-KR,ko;q=0.9,en;q=0.8");
        assertThat(second.headers().firstValue("Authorization")).isEmpty();
    }

    @Test
    void translatesCorsOriginAndNeverUsesTheCookieJarForCrossOriginReads() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(response(
                200,
                Map.of(
                        "Content-Type", List.of("text/javascript"),
                        "Access-Control-Allow-Origin", List.of("https://example.com"),
                        "Set-Cookie", List.of("cdn-state=forbidden; Secure")
                ),
                "export default 1".getBytes(StandardCharsets.UTF_8)
        ));
        Harness harness = harness(client, properties(1024));

        LiveReportFetchService.FetchedResource fetched = harness.service().fetch(
                harness.session(),
                URI.create("https://cdn.example.net/app.mjs"),
                harness.session().targetUri(),
                LiveReportRequestHeaders.defaults().withUpstreamOrigin("https://example.com")
        );

        ArgumentCaptor<HttpRequest> request = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client).send(request.capture(), anyList());
        assertThat(request.getValue().headers().firstValue("Origin")).contains("https://example.com");
        assertThat(request.getValue().headers().firstValue("Cookie")).isEmpty();
        assertThat(fetched.cors().crossOrigin()).isTrue();
        assertThat(fetched.cors().allowed()).isTrue();
        assertThat(harness.sessions().cookieHeader(
                harness.session(),
                URI.create("https://cdn.example.net/next")
        )).isEmpty();
    }

    @Test
    void appliesRedirectCookiesBeforeRequestingTheNextHop() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse redirectResponse = response(
                302,
                Map.of(
                        "Location", List.of("/home"),
                        "Set-Cookie", List.of("redirect-state=ready; Path=/; Secure")
                ),
                new byte[0]
        );
        LiveReportUpstreamClient.UpstreamResponse successResponse = response(
                200,
                Map.of("Content-Type", List.of("text/html")),
                "ok".getBytes(StandardCharsets.UTF_8)
        );
        when(client.send(any(HttpRequest.class), anyList()))
                .thenReturn(redirectResponse)
                .thenReturn(successResponse);
        Harness harness = harness(client, properties(1024));

        harness.service().fetch(harness.session(), URI.create("https://example.com/login"), null);

        ArgumentCaptor<HttpRequest> requests = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client, times(2)).send(requests.capture(), anyList());
        assertThat(requests.getAllValues().get(1).uri()).hasToString("https://example.com/home");
        assertThat(requests.getAllValues().get(1).headers().firstValue("Cookie"))
                .contains("redirect-state=ready");
        assertThat(requests.getAllValues().get(1).headers().firstValue("Referer"))
                .contains("https://example.com/login");
    }

    @Test
    void doesNotLeakCookieStateBetweenLiveSessions() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse firstResponse = response(
                200,
                Map.of("Set-Cookie", List.of("only-first=secret; Path=/; Secure")),
                new byte[0]
        );
        LiveReportUpstreamClient.UpstreamResponse secondResponse = response(200, Map.of(), new byte[0]);
        when(client.send(any(HttpRequest.class), anyList()))
                .thenReturn(firstResponse)
                .thenReturn(secondResponse);
        LiveReportProperties properties = properties(1024);
        LiveReportSessionService sessions = sessionService(properties);
        LiveReportFetchService service = new LiveReportFetchService(
                client,
                properties,
                publicUrlValidator(),
                sessions
        );
        LiveReportSessionService.LiveReportSession first = sessions.create(1L, "https://example.com/");
        LiveReportSessionService.LiveReportSession second = sessions.create(2L, "https://example.com/");

        service.fetch(first, URI.create("https://example.com/first"), null);
        service.fetch(second, URI.create("https://example.com/second"), null);

        ArgumentCaptor<HttpRequest> requests = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client, times(2)).send(requests.capture(), anyList());
        assertThat(requests.getAllValues().get(1).headers().firstValue("Cookie")).isEmpty();
    }

    @Test
    void blocksRedirectToPrivateNetworkBeforeSecondRequest() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse redirect = response(
                302,
                Map.of("Location", List.of("https://127.0.0.1/admin")),
                new byte[0]
        );
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(redirect);
        Harness harness = harness(client, properties(1024));

        assertThatThrownBy(() -> harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/start"),
                null
        ))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report redirect target was blocked");
        verify(client, times(1)).send(any(HttpRequest.class), anyList());
    }

    @Test
    void rejectsBodyThatExceedsConfiguredLimit() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse oversized = response(
                200,
                Map.of("Content-Type", List.of("text/plain")),
                new byte[6]
        );
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(oversized);
        Harness harness = harness(client, properties(5));

        assertThatThrownBy(() -> harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/large"),
                null
        ))
                .isInstanceOf(LiveReportException.class)
                .hasMessage("Live report response exceeds the configured size limit");
    }

    @Test
    void allowsOpaqueMediaAboveTheExecutableDocumentLimit() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse image = response(
                200,
                Map.of(
                        "Content-Type", List.of("image/jpeg"),
                        "Content-Length", List.of("6")
                ),
                new byte[6]
        );
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(image);
        LiveReportProperties properties = properties(5);
        properties.setMaxOpaqueResponseBytes(8);
        Harness harness = harness(client, properties);

        assertThat(harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/photo.jpg"),
                null
        ).bytes()).hasSize(6);
    }

    @Test
    void ignoresMalformedContentLengthAndStillAppliesTheReadLimit() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportUpstreamClient.UpstreamResponse successResponse = response(
                200,
                Map.of("Content-Length", List.of("not-a-number")),
                "ok".getBytes(StandardCharsets.UTF_8)
        );
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(successResponse);
        Harness harness = harness(client, properties(8));

        assertThat(harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/content"),
                null
        ).bytes()).isEqualTo("ok".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void forwardsBoundedBrowserHeadersAndPinsTheApprovedDnsAnswers() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(response(
                200,
                Map.of("Content-Type", List.of("text/plain")),
                "ok".getBytes(StandardCharsets.UTF_8)
        ));
        Harness harness = harness(client, properties(1024));

        harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/content"),
                null,
                new LiveReportRequestHeaders(
                        "text/plain, */*;q=0.1",
                        "fr-FR,fr;q=0.9",
                        "Mozilla/5.0 Browser Under Test"
                )
        );

        ArgumentCaptor<HttpRequest> request = ArgumentCaptor.forClass(HttpRequest.class);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<InetAddress>> addresses = ArgumentCaptor.forClass(List.class);
        verify(client).send(request.capture(), addresses.capture());
        assertThat(request.getValue().headers().firstValue("Accept"))
                .contains("text/plain, */*;q=0.1");
        assertThat(request.getValue().headers().firstValue("Accept-Language"))
                .contains("fr-FR,fr;q=0.9");
        assertThat(request.getValue().headers().firstValue("User-Agent"))
                .contains("Mozilla/5.0 Browser Under Test");
        assertThat(addresses.getValue()).singleElement().satisfies(address ->
                assertThat(address.getHostAddress()).isEqualTo("93.184.216.34")
        );
    }

    @Test
    void preservesNonRedirectUpstreamStatusAndBody() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(response(
                404,
                Map.of("Content-Type", List.of("text/html")),
                "<h1>Not found</h1>".getBytes(StandardCharsets.UTF_8)
        ));
        Harness harness = harness(client, properties(1024));

        LiveReportFetchService.FetchedResource fetched = harness.service().fetch(
                harness.session(),
                URI.create("https://example.com/missing"),
                null
        );

        assertThat(fetched.statusCode()).isEqualTo(404);
        assertThat(fetched.contentType()).isEqualTo("text/html");
        assertThat(new String(fetched.bytes(), StandardCharsets.UTF_8)).contains("Not found");
    }

    @Test
    void forwardsBoundedAnonymousSameOriginJsonPostWithoutBrowserCredentials() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList(), any(byte[].class))).thenReturn(response(
                200,
                Map.of("Content-Type", List.of("application/json")),
                "{\"items\":[]}".getBytes(StandardCharsets.UTF_8)
        ));
        LiveReportProperties properties = properties(1024);
        properties.setMaxRequestBodyBytes(256);
        Harness harness = harness(client, properties);
        byte[] body = "{\"page\":1}".getBytes(StandardCharsets.UTF_8);

        LiveReportFetchService.FetchedResource fetched = harness.service().fetchPost(
                harness.session(),
                URI.create("https://example.com/api/items"),
                URI.create("https://example.com/"),
                new LiveReportRequestHeaders("application/json", "ko-KR", "Browser"),
                "application/json; charset=UTF-8",
                body
        );

        ArgumentCaptor<HttpRequest> request = ArgumentCaptor.forClass(HttpRequest.class);
        ArgumentCaptor<byte[]> forwardedBody = ArgumentCaptor.forClass(byte[].class);
        verify(client).send(request.capture(), anyList(), forwardedBody.capture());
        assertThat(request.getValue().method()).isEqualTo("POST");
        assertThat(request.getValue().headers().firstValue("Content-Type"))
                .contains("application/json; charset=UTF-8");
        assertThat(request.getValue().headers().firstValue("Authorization")).isEmpty();
        assertThat(forwardedBody.getValue()).isEqualTo(body);
        assertThat(fetched.contentType()).isEqualTo("application/json");
    }

    @Test
    void bindsPostsFromDedicatedViewerRoutesToTheirMappedUpstreamOrigin() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList(), any(byte[].class))).thenReturn(response(
                200,
                Map.of("Content-Type", List.of("application/json")),
                "{\"ok\":true}".getBytes(StandardCharsets.UTF_8)
        ));
        Harness harness = harness(client, properties(1024));
        URI routedOrigin = URI.create("https://services.example.net");
        URI endpoint = URI.create("https://services.example.net/api/items");
        byte[] body = "{\"page\":1}".getBytes(StandardCharsets.UTF_8);

        LiveReportFetchService.FetchedResource fetched = harness.service().fetchPost(
                harness.session(),
                endpoint,
                URI.create("https://services.example.net/app"),
                LiveReportRequestHeaders.defaults(),
                routedOrigin,
                "application/json",
                body
        );

        ArgumentCaptor<HttpRequest> request = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client).send(request.capture(), anyList(), any(byte[].class));
        assertThat(request.getValue().method()).isEqualTo("POST");
        assertThat(request.getValue().uri()).isEqualTo(endpoint);
        assertThat(fetched.finalUri()).isEqualTo(endpoint);
    }

    @Test
    void blocksCrossOriginMultipartAndOversizedPostsBeforeNetworkAccess() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        LiveReportProperties properties = properties(1024);
        properties.setMaxRequestBodyBytes(8);
        Harness harness = harness(client, properties);

        assertThatThrownBy(() -> harness.service().fetchPost(
                harness.session(),
                URI.create("https://analytics.example.net/collect"),
                URI.create("https://example.com/"),
                LiveReportRequestHeaders.defaults(),
                "application/json",
                "{}".getBytes(StandardCharsets.UTF_8)
        )).isInstanceOf(LiveReportException.class)
                .hasMessage("Live report POST requests must remain on the document origin");
        assertThatThrownBy(() -> harness.service().fetchPost(
                harness.session(),
                URI.create("https://example.com/upload"),
                URI.create("https://example.com/"),
                LiveReportRequestHeaders.defaults(),
                "multipart/form-data; boundary=test",
                "file".getBytes(StandardCharsets.UTF_8)
        )).isInstanceOf(LiveReportException.class)
                .hasMessage("Live report POST content type is not allowed");
        assertThatThrownBy(() -> harness.service().fetchPost(
                harness.session(),
                URI.create("https://example.com/api"),
                URI.create("https://example.com/"),
                LiveReportRequestHeaders.defaults(),
                "application/json",
                new byte[9]
        )).isInstanceOf(LiveReportException.class)
                .hasMessage("Live report request exceeds the configured size limit");

        verify(client, never()).send(any(HttpRequest.class), anyList(), any(byte[].class));
    }

    @Test
    void convertsPostToGetAfter303ButDoesNotPreservePostAcrossOriginsAfter307() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList(), any(byte[].class))).thenReturn(response(
                303,
                Map.of("Location", List.of("/api/result")),
                new byte[0]
        ));
        when(client.send(any(HttpRequest.class), anyList())).thenReturn(response(
                200,
                Map.of("Content-Type", List.of("application/json")),
                "{}".getBytes(StandardCharsets.UTF_8)
        ));
        Harness harness = harness(client, properties(1024));

        harness.service().fetchPost(
                harness.session(),
                URI.create("https://example.com/api/query"),
                URI.create("https://example.com/"),
                LiveReportRequestHeaders.defaults(),
                "application/json",
                "{}".getBytes(StandardCharsets.UTF_8)
        );

        ArgumentCaptor<HttpRequest> redirectedGet = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client).send(redirectedGet.capture(), anyList());
        assertThat(redirectedGet.getValue().method()).isEqualTo("GET");
        assertThat(redirectedGet.getValue().uri()).hasToString("https://example.com/api/result");

        LiveReportUpstreamClient secondClient = mock(LiveReportUpstreamClient.class);
        when(secondClient.send(any(HttpRequest.class), anyList(), any(byte[].class))).thenReturn(response(
                307,
                Map.of("Location", List.of("https://cdn.example.net/api/result")),
                new byte[0]
        ));
        Harness secondHarness = harness(secondClient, properties(1024));
        assertThatThrownBy(() -> secondHarness.service().fetchPost(
                secondHarness.session(),
                URI.create("https://example.com/api/query"),
                URI.create("https://example.com/"),
                LiveReportRequestHeaders.defaults(),
                "application/json",
                "{}".getBytes(StandardCharsets.UTF_8)
        )).isInstanceOf(LiveReportException.class)
                .hasMessage("Live report POST redirect left the document origin");
        verify(secondClient, times(1)).send(any(HttpRequest.class), anyList(), any(byte[].class));

        LiveReportUpstreamClient thirdClient = mock(LiveReportUpstreamClient.class);
        when(thirdClient.send(any(HttpRequest.class), anyList(), any(byte[].class))).thenReturn(response(
                303,
                Map.of("Location", List.of("https://cdn.example.net/api/result")),
                new byte[0]
        ));
        Harness thirdHarness = harness(thirdClient, properties(1024));
        assertThatThrownBy(() -> thirdHarness.service().fetchPost(
                thirdHarness.session(),
                URI.create("https://example.com/api/query"),
                URI.create("https://example.com/"),
                LiveReportRequestHeaders.defaults(),
                "application/json",
                "{}".getBytes(StandardCharsets.UTF_8)
        )).isInstanceOf(LiveReportException.class)
                .hasMessage("Live report POST redirect left the document origin");
        verify(thirdClient, times(1)).send(any(HttpRequest.class), anyList(), any(byte[].class));
        verify(thirdClient, never()).send(any(HttpRequest.class), anyList());
    }

    @Test
    void preservesPostBytesAndContentTypeAcrossSameOrigin307AndAcceptsGenericNonMultipartTypes() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList(), any(byte[].class)))
                .thenReturn(response(307, Map.of("Location", List.of("/api/final")), new byte[0]))
                .thenReturn(response(200, Map.of("Content-Type", List.of("application/xml")), "<ok/>".getBytes(StandardCharsets.UTF_8)));
        Harness harness = harness(client, properties(1024));
        byte[] body = "<query/>".getBytes(StandardCharsets.UTF_8);

        harness.service().fetchPost(
                harness.session(),
                URI.create("https://example.com/api/query"),
                URI.create("https://example.com/"),
                LiveReportRequestHeaders.defaults(),
                "application/xml",
                body
        );

        ArgumentCaptor<HttpRequest> requests = ArgumentCaptor.forClass(HttpRequest.class);
        ArgumentCaptor<byte[]> bodies = ArgumentCaptor.forClass(byte[].class);
        verify(client, times(2)).send(requests.capture(), anyList(), bodies.capture());
        assertThat(requests.getAllValues()).allSatisfy(request -> {
            assertThat(request.method()).isEqualTo("POST");
            assertThat(request.headers().firstValue("Content-Type")).contains("application/xml");
        });
        assertThat(requests.getAllValues().get(1).uri()).hasToString("https://example.com/api/final");
        assertThat(bodies.getAllValues()).allSatisfy(forwarded -> assertThat(forwarded).isEqualTo(body));
    }

    @Test
    void keepsHeadAcrossRedirectsAndNeverReturnsOrChargesARepresentationBody() throws Exception {
        LiveReportUpstreamClient client = mock(LiveReportUpstreamClient.class);
        when(client.send(any(HttpRequest.class), anyList()))
                .thenReturn(response(
                        303,
                        Map.of("Location", List.of("/metadata")),
                        "redirect-body-must-not-surface".getBytes(StandardCharsets.UTF_8)
                ))
                .thenReturn(response(
                        200,
                        Map.of(
                                "Content-Type", List.of("text/html"),
                                "Content-Length", List.of("999999999")
                        ),
                        "server-body-must-not-surface".getBytes(StandardCharsets.UTF_8)
                ));
        Harness harness = harness(client, properties(8));

        LiveReportFetchService.FetchedResource fetched = harness.service().fetchHead(
                harness.session(),
                URI.create("https://example.com/start"),
                null,
                LiveReportRequestHeaders.defaults()
        );

        ArgumentCaptor<HttpRequest> requests = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client, times(2)).send(requests.capture(), anyList());
        assertThat(requests.getAllValues()).allSatisfy(request -> assertThat(request.method()).isEqualTo("HEAD"));
        assertThat(requests.getAllValues().get(1).uri()).hasToString("https://example.com/metadata");
        assertThat(fetched.finalUri()).hasToString("https://example.com/metadata");
        assertThat(fetched.contentType()).isEqualTo("text/html");
        assertThat(fetched.bytes()).isEmpty();
    }

    private Harness harness(LiveReportUpstreamClient client, LiveReportProperties properties) throws Exception {
        LiveReportSessionService sessions = sessionService(properties);
        LiveReportFetchService service = new LiveReportFetchService(
                client,
                properties,
                publicUrlValidator(),
                sessions
        );
        LiveReportSessionService.LiveReportSession session = sessions.create(31L, "https://example.com/");
        sessions.recordDocumentUri(session, session.targetUri());
        return new Harness(service, session, sessions);
    }

    private LiveReportSessionService sessionService(LiveReportProperties properties) throws Exception {
        return new LiveReportSessionService(properties, publicUrlValidator());
    }

    private LiveReportProperties properties(int maxBytes) {
        LiveReportProperties properties = new LiveReportProperties();
        properties.setRequestTimeoutSeconds(2);
        properties.setMaxRedirects(2);
        properties.setMaxResponseBytes(maxBytes);
        return properties;
    }

    private LiveReportUrlSafetyValidator publicUrlValidator() throws Exception {
        InetAddress publicAddress = InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 34});
        return new LiveReportUrlSafetyValidator(host -> {
            if (host.equals("127.0.0.1")) {
                return List.of(InetAddress.getByName(host));
            }
            return List.of(publicAddress);
        });
    }

    private LiveReportUpstreamClient.UpstreamResponse response(
            int status,
            Map<String, List<String>> headers,
            byte[] body
    ) {
        return new LiveReportUpstreamClient.UpstreamResponse(status, headers, body);
    }

    private record Harness(
            LiveReportFetchService service,
            LiveReportSessionService.LiveReportSession session,
            LiveReportSessionService sessions
    ) {
    }
}
