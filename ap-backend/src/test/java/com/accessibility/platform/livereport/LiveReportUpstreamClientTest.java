package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.http.HttpRequest;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LiveReportUpstreamClientTest {

    @Test
    void resolverReturnsOnlyTheAlreadyValidatedAddressesForTheOriginalHost() throws Exception {
        InetAddress first = InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 34});
        InetAddress second = InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 35});
        LiveReportUpstreamClient.PinnedDnsResolver resolver =
                new LiveReportUpstreamClient.PinnedDnsResolver("EXAMPLE.com", List.of(first, second));

        InetAddress[] resolved = resolver.resolve("example.COM");

        assertThat(resolved).containsExactly(first, second);
        resolved[0] = InetAddress.getLoopbackAddress();
        assertThat(resolver.resolve("example.com")).containsExactly(first, second);
        assertThat(resolver.resolveCanonicalHostname("example.com")).isEqualTo("example.com");
    }

    @Test
    void resolverFailsClosedWhenTheTransportAsksForAnotherHost() throws Exception {
        InetAddress approved = InetAddress.getByAddress(new byte[]{93, (byte) 184, (byte) 216, 34});
        LiveReportUpstreamClient.PinnedDnsResolver resolver =
                new LiveReportUpstreamClient.PinnedDnsResolver("example.com", List.of(approved));

        assertThatThrownBy(() -> resolver.resolve("internal.example"))
                .isInstanceOf(UnknownHostException.class)
                .hasMessage("Unvalidated upstream host was requested");
    }

    @Test
    void sendsARealHeadRequestAndDoesNotReadAResponseBody() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        HttpServer server = HttpServer.create(new InetSocketAddress(loopback, 0), 0);
        AtomicReference<String> observedMethod = new AtomicReference<>();
        server.createContext("/metadata", exchange -> {
            observedMethod.set(exchange.getRequestMethod());
            exchange.getResponseHeaders().add("Content-Type", "text/plain");
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();

        LiveReportProperties properties = new LiveReportProperties();
        properties.setConnectTimeoutSeconds(2);
        properties.setRequestTimeoutSeconds(2);
        properties.setMaxResponseBytes(1);
        LiveReportUpstreamClient client = new LiveReportUpstreamClient(properties);
        try {
            URI uri = URI.create("http://localhost:" + server.getAddress().getPort() + "/metadata");
            HttpRequest request = HttpRequest.newBuilder(uri)
                    .method("HEAD", HttpRequest.BodyPublishers.noBody())
                    .build();

            LiveReportUpstreamClient.UpstreamResponse response = client.send(request, List.of(loopback));

            assertThat(observedMethod.get()).isEqualTo("HEAD");
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.firstValue("Content-Type")).contains("text/plain");
            assertThat(response.body()).isEmpty();
        } finally {
            client.closeClients();
            server.stop(0);
        }
    }

    @Test
    void readsLargeOpaqueMediaWithoutRaisingTheDocumentLimit() throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        HttpServer server = HttpServer.create(new InetSocketAddress(loopback, 0), 0);
        server.createContext("/photo.jpg", exchange -> {
            byte[] body = new byte[6];
            exchange.getResponseHeaders().add("Content-Type", "image/jpeg");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();

        LiveReportProperties properties = new LiveReportProperties();
        properties.setConnectTimeoutSeconds(2);
        properties.setRequestTimeoutSeconds(2);
        properties.setMaxResponseBytes(5);
        properties.setMaxOpaqueResponseBytes(8);
        LiveReportUpstreamClient client = new LiveReportUpstreamClient(properties);
        try {
            URI imageUri = URI.create("http://localhost:" + server.getAddress().getPort() + "/photo.jpg");
            LiveReportUpstreamClient.UpstreamResponse response = client.send(
                    HttpRequest.newBuilder(imageUri).GET().build(),
                    List.of(loopback)
            );
            assertThat(response.body()).hasSize(6);
        } finally {
            client.closeClients();
            server.stop(0);
        }
    }
}
