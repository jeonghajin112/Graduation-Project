package com.accessibility.platform.target.service;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class FaviconStreamingTest {
    @Test
    void stalledIconBodyIsCancelledBeforeTheWholeLookupDeadline() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var enteredIcon = new CountDownLatch(1);
        var releaseBody = new CountDownLatch(1);
        server.createContext("/page", exchange -> {
            byte[] html = "<link rel='icon' href='/icon.png' sizes='64x64'>".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html");
            exchange.sendResponseHeaders(200, html.length);
            exchange.getResponseBody().write(html);
            exchange.close();
        });
        server.createContext("/icon.png", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "image/png");
            exchange.sendResponseHeaders(200, 100);
            exchange.getResponseBody().write(137);
            exchange.getResponseBody().flush();
            enteredIcon.countDown();
            try { releaseBody.await(12, TimeUnit.SECONDS); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            exchange.close();
        });
        var serverThreads = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(serverThreads);
        server.start();
        var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
                .followRedirects(HttpClient.Redirect.NEVER).build();
        var service = new FaviconService(client) {
            @Override boolean isPublicHttpUri(URI uri) {
                // Test-only loopback fixture permission, not a change to application safety checks.
                return uri.getHost().equals("127.0.0.1") && uri.getPort() == server.getAddress().getPort();
            }
        };
        var executor = Executors.newSingleThreadExecutor();
        var task = executor.submit(() -> service.findFaviconUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/page"));
        try {
            assertThat(enteredIcon.await(3, TimeUnit.SECONDS)).isTrue();
            long started = System.nanoTime();
            assertThat(task.get(6500, TimeUnit.MILLISECONDS)).isEmpty();
            assertThat(Duration.ofNanos(System.nanoTime() - started).toMillis()).isLessThan(6500);

        } finally {
            releaseBody.countDown();
            task.cancel(true);
            server.stop(0);
            executor.shutdownNow();
            service.close();
            serverThreads.shutdownNow();
            client.close();
        }
    }
}
