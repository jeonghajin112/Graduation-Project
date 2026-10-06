package com.accessibility.platform.target.service;

import com.accessibility.platform.target.controller.FaviconController;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import javax.imageio.ImageIO;
import java.io.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class FaviconHardeningTest {
    @TempDir Path directory;

    @Test void acceptsWebpAndPersistsOnlySmallDecodedPngAcrossRestart() throws Exception {
        byte[] original = getClass().getResourceAsStream("/favicon/valid-64.webp").readAllBytes();
        FaviconImage image = FaviconImage.validate(original);
        assertThat(image).isNotNull();
        assertThat(image.extension()).isEqualTo("png");
        assertThat(image.bytes().length).isLessThanOrEqualTo(32768);
        assertThat(ImageIO.read(new ByteArrayInputStream(image.bytes())).getWidth()).isEqualTo(64);
        String path = new FaviconCache(directory.toString()).store(image);
        String key = path.substring(FaviconCache.PREFIX.length());
        var restarted = new FaviconCache(directory.toString());
        var response = new FaviconController(restarted).get(key);
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isEqualTo(image.bytes());
        assertThat(response.getHeaders().getContentLength()).isEqualTo(image.bytes().length);
        assertThat(response.getHeaders().getFirst("Content-Security-Policy")).contains("default-src 'none'");
        assertThat(restarted.read("../private.png")).isEmpty();
        Files.write(directory.resolve(key), new byte[40000]);
        assertThat(new FaviconController(restarted).get(key).getStatusCode().value()).isEqualTo(404);
        assertThat(restarted.store(image)).isEqualTo(path);
        assertThat(restarted.read(key).orElseThrow()).isEqualTo(image.bytes());
    }

    @Test void boundsPersistentCacheAcrossInstances() throws Exception {
        var cache = new FaviconCache(directory.toString());
        for (int i = 0; i < 515; i++) {
            var icon = FaviconImage.validate(("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='#" + String.format("%06x", i) + "'/></svg>").getBytes(StandardCharsets.UTF_8));
            cache.store(icon);
            if (i == 256) cache = new FaviconCache(directory.toString());
        }
        try (var files = Files.list(directory)) {
            var paths = files.toList();
            assertThat(paths).hasSize(512);
            long bytes = 0;
            for (Path path : paths) bytes += Files.size(path);
            assertThat(bytes).isLessThanOrEqualTo(16L * 1024 * 1024);
        }
    }

    @Test void rejectsTruncatedPngAndInvalidOrExternalSvg() throws Exception {
        byte[] truncated = getClass().getResourceAsStream("/favicon/truncated-64.png").readAllBytes();
        assertThatThrownBy(() -> FaviconImage.validate(truncated)).isInstanceOf(IOException.class);
        for (String svg : List.of("<svg><rect/></svg>",
                "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
                "<svg xmlns='http://www.w3.org/2000/svg'><use href='https://example.com/large.svg'/></svg>",
                "<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///private'>]><svg xmlns='http://www.w3.org/2000/svg'>&x;</svg>",
                "<svg xmlns='http://www.w3.org/2000/svg'><style>@import 'https://example.com/a.css';</style></svg>",
                "<svg xmlns='http://www.w3.org/2000/svg'><rect></svg>")) {
            assertThat(FaviconImage.validate(svg.getBytes(StandardCharsets.UTF_8))).isNull();
        }
        var valid = FaviconImage.validate("<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='blue'/></svg>"
                .getBytes(StandardCharsets.UTF_8));
        assertThat(new String(valid.bytes(), StandardCharsets.UTF_8)).contains("width=\"64\"", "height=\"64\"", "viewBox=\"0 0 120 120\"");
    }

    @Test void preservesEncodedRequestPathAndQueryAndSkipsBrokenImages() throws Exception {
        byte[] valid = getClass().getResourceAsStream("/favicon/valid-64.webp").readAllBytes();
        var client = mock(HttpClient.class);
        var requested = new ArrayList<String>();
        when(client.sendAsync(any(HttpRequest.class), any(HttpResponse.BodyHandler.class))).thenAnswer(call -> {
            HttpRequest request = call.getArgument(0);
            requested.add(request.uri().toString());
            byte[] body = switch(requested.size()) {
                case 1 -> "<link rel='icon' sizes='64x64' href='/bad.svg'><link rel='icon' sizes='96x96' href='/icon%20name.webp?v=a%2Fb#part'>".getBytes(StandardCharsets.UTF_8);
                case 2 -> "<svg/>".getBytes(StandardCharsets.UTF_8);
                default -> valid;
            };
            HttpResponse<byte[]> response = mock(HttpResponse.class);
            when(response.statusCode()).thenReturn(200);
            when(response.headers()).thenReturn(HttpHeaders.of(Map.of(), (k,v)->true));
            when(response.body()).thenReturn(body);
            return CompletableFuture.completedFuture(response);
        });
        var cache = new FaviconCache(null);
        var service = new FaviconService(client, cache);
        try {
            var result = service.findFaviconUrl("https://93.184.216.34/page").orElseThrow();
            assertThat(requested).containsExactly("https://93.184.216.34/page", "https://93.184.216.34/bad.svg",
                    "https://93.184.216.34/icon%20name.webp?v=a%2Fb");
            assertThat(cache.read(result.substring(FaviconCache.PREFIX.length()))).isPresent();
        } finally { service.close(); }
    }

    @Test void cancelsAtByteLimitAndAtTotalDeadline() throws Exception {
        var subscription = mock(Flow.Subscription.class);
        var body = new FaviconDownload.LimitedBody(32768, false);
        body.onSubscribe(subscription);
        body.onNext(List.of(ByteBuffer.wrap(new byte[32768])));
        body.onNext(List.of(ByteBuffer.wrap(new byte[1])));
        assertThat(body.getBody().toCompletableFuture()).isCompletedExceptionally();
        verify(subscription).cancel();
        var html = new FaviconDownload.LimitedBody(16, true);
        html.onSubscribe(mock(Flow.Subscription.class));
        html.onNext(List.of(ByteBuffer.wrap(new byte[32])));
        assertThat(html.getBody().toCompletableFuture().get()).hasSize(16);
        var client = mock(HttpClient.class);
        var pending = new CompletableFuture<HttpResponse<byte[]>>();
        when(client.sendAsync(any(HttpRequest.class), any(HttpResponse.BodyHandler.class))).thenReturn((CompletableFuture) pending);
        var request = HttpRequest.newBuilder(java.net.URI.create("https://example.com")).timeout(java.time.Duration.ofSeconds(5)).build();
        assertThatThrownBy(() -> FaviconDownload.get(client, request, 32, false, System.nanoTime() + 50_000_000L))
                .isInstanceOf(HttpTimeoutException.class);
        assertThat(pending).isCancelled();
    }
}
