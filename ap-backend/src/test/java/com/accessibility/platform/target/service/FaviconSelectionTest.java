package com.accessibility.platform.target.service;

import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class FaviconSelectionTest {
    private static final String ORIGIN = "https://93.184.216.34";
    private final FaviconCache cache = new FaviconCache(null);
    private final List<String> requests = new ArrayList<>();

    @Test
    void choosesSmallestAdequateIconWithoutFetchingLargeAlternatives() throws Exception {
        var service = service("""
                <link rel="icon" href="/original.ico">
                <link rel="icon" sizes="512x512" href="/large.png">
                <link rel="icon" sizes="96x96" href="/96.png">
                <link rel="apple-touch-icon" sizes="72x72" href="/72.png">
                <link rel="icon" sizes="32x32" href="/32.png">
                """, Map.of("/72.png", png(72)));
        assertThat(service.findFaviconUrl(ORIGIN + "/page")).contains(cached(png(72)));
        assertThat(requests).containsExactly("/page", "/72.png");
    }

    @Test
    void inspectsUndeclaredSizesToUpgradeSmallIcon() throws Exception {
        var service = service("""
                <link rel="icon" href="/small.png">
                <link rel="apple-touch-icon-precomposed" href="/mobile.png">
                """, Map.of("/small.png", png(16), "/mobile.png", png(114)));
        assertThat(service.findFaviconUrl(ORIGIN + "/page")).contains(cached(png(114)));
    }

    @Test
    void rejectsOversizedBodyAndFallsBackToNextCandidate() throws Exception {
        byte[] heavy = java.util.Arrays.copyOf(png(64), 65537);
        var service = service("""
                <link rel="icon" sizes="64x64" href="/heavy.png">
                <link rel="icon" sizes="96x96" href="/96.png">
                """, Map.of("/heavy.png", heavy, "/96.png", png(96)));
        assertThat(service.findFaviconUrl(ORIGIN + "/page")).contains(cached(png(96)));
    }

    @Test
    void verifiesActualDimensionsInsteadOfTrustingDeclaredSize() throws Exception {
        var service = service("""
                <link rel="icon" sizes="64x64" href="/large.png">
                <link rel="icon" sizes="96x96" href="/96.png">
                """, Map.of("/large.png", png(256), "/96.png", png(96)));
        assertThat(service.findFaviconUrl(ORIGIN + "/page")).contains(cached(png(96)));
    }

    @Test
    void acceptsSmallUncompressedIcoAfterIgnoringObsoleteCommentedLink() throws Exception {
        // A valid 120px, 32-bit DIB with its mask is about 60KB despite its small dimensions.
        int size = 120;
        int pixelBytes = size * size * 4;
        int maskBytes = ((size + 31) / 32) * 4 * size;
        byte[] ico = new byte[22 + 40 + pixelBytes + maskBytes];
        var buffer = java.nio.ByteBuffer.wrap(ico).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        buffer.putShort(2, (short) 1).putShort(4, (short) 1);
        ico[6] = (byte) size;
        ico[7] = (byte) size;
        buffer.putShort(10, (short) 1).putShort(12, (short) 32);
        buffer.putInt(14, ico.length - 22).putInt(18, 22);
        buffer.putInt(22, 40).putInt(26, size).putInt(30, size * 2);
        buffer.putShort(34, (short) 1).putShort(36, (short) 32).putInt(42, pixelBytes);
        var service = service("""
                <link rel="apple-touch-icon" sizes="180x180" href="/mobile.png">
                <!--<link rel="icon" sizes="16x16" href="/obsolete.png">-->
                <link rel="shortcut icon" href="/active.ico">
                """, Map.of("/active.ico", ico));
        assertThat(service.findFaviconUrl(ORIGIN + "/page")).contains(cached(ico));
        assertThat(requests).containsExactly("/page", "/active.ico");
    }

    @Test
    void keepsLargestSmallIconWhenAdequateOnesAreUnavailable() throws Exception {
        var service = service("""
                <link rel="icon" sizes="64x64" href="/broken.png">
                <link rel="icon" sizes="16x16" href="/16.png">
                <link rel="icon" sizes="32x32" href="/32.png">
                """, Map.of("/broken.png", "not an image".getBytes(StandardCharsets.UTF_8),
                "/16.png", png(16), "/32.png", png(32)));
        assertThat(service.findFaviconUrl(ORIGIN + "/page")).contains(cached(png(32)));
    }

    @Test
    void boundsCandidateRequestsAndDeduplicatesLinks() throws Exception {
        var service = service("""
                <link rel="icon" href="/a"><link rel="shortcut icon" href="/a">
                <link rel="icon" href="/b"><link rel="icon" href="/c">
                <link rel="icon" href="/d"><link rel="icon" href="/e">
                """, Map.of());
        assertThat(service.findFaviconUrl(ORIGIN + "/page")).isEmpty();
        assertThat(requests).containsExactly("/page", "/a", "/b", "/c", "/d");
    }

    @Test
    void rejectsRedirectsToPrivateAddresses() throws Exception {
        var client = mock(HttpClient.class);
        when(client.sendAsync(any(HttpRequest.class), any(HttpResponse.BodyHandler.class))).thenAnswer(invocation -> {
            HttpRequest request = invocation.getArgument(0);
            requests.add(request.uri().toString());
            return java.util.concurrent.CompletableFuture.completedFuture(response(302, new byte[0], Map.of("Location", List.of("http://127.0.0.1/private"))));
        });
        assertThat(new FaviconService(client).findFaviconUrl(ORIGIN + "/page")).isEmpty();
        assertThat(requests).containsExactly(ORIGIN + "/page");
    }

    @Test
    void handlesMultipleDeclaredSizesAndMalformedSizes() {
        var service = new FaviconService();
        assertThat(service.extractFaviconUri(URI.create(ORIGIN), """
                <link rel="icon" sizes="16x16 256x256" href="/multi.ico">
                <link rel="icon" sizes="999999999999x9999999999" href="/invalid.ico">
                <link rel="icon" sizes="64X64" href="/64.png">
                """)).isEqualTo(URI.create(ORIGIN + "/64.png"));
    }

    @Test
    void readsIcoDimensionsAndRejectsTruncatedDirectories() throws Exception {
        byte[] ico = new byte[30];
        var buffer = java.nio.ByteBuffer.wrap(ico).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        buffer.putShort(2, (short) 1).putShort(4, (short) 1);
        ico[6] = 16;
        ico[7] = 16;
        buffer.putInt(14, 8).putInt(18, 22);
        assertThat(FaviconService.iconSize(ico)).isZero();
        assertThat(FaviconService.iconSize(java.util.Arrays.copyOf(ico, 20))).isZero();
        assertThat(FaviconService.iconSize("<html>Error</html>".getBytes(StandardCharsets.UTF_8))).isZero();
        assertThat(FaviconService.iconSize("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'/>"
                .getBytes(StandardCharsets.UTF_8))).isEqualTo(64);
    }

    private FaviconService service(String html, Map<String, byte[]> icons) throws Exception {
        var client = mock(HttpClient.class);
        when(client.sendAsync(any(HttpRequest.class), any(HttpResponse.BodyHandler.class))).thenAnswer(invocation -> {
            HttpRequest request = invocation.getArgument(0);
            String path = request.uri().getPath();
            requests.add(path);
            if (path.equals("/page")) return java.util.concurrent.CompletableFuture.completedFuture(response(200, html.getBytes(StandardCharsets.UTF_8),
                    Map.of("Content-Type", List.of("text/html"))));
            byte[] body = icons.get(path);
            return java.util.concurrent.CompletableFuture.completedFuture(response(body == null ? 404 : 200, body == null ? new byte[0] : body, Map.of()));
        });
        return new FaviconService(client, cache);
    }

    @SuppressWarnings("unchecked")
    private HttpResponse<byte[]> response(int status, byte[] bytes, Map<String, List<String>> headers) {
        HttpResponse<byte[]> response = mock(HttpResponse.class);
        when(response.statusCode()).thenReturn(status);
        when(response.body()).thenReturn(bytes);
        when(response.headers()).thenReturn(HttpHeaders.of(headers, (name, value) -> true));
        return response;
    }

    private String cached(byte[] bytes) throws Exception {
        return cache.store(FaviconImage.validate(bytes));
    }

    private byte[] png(int size) throws Exception {
        var output = new ByteArrayOutputStream();
        var image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        var graphics = image.createGraphics();
        graphics.setColor(new java.awt.Color(0, 0, size % 256));
        graphics.fillRect(0, 0, size, size);
        graphics.dispose();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }
}
