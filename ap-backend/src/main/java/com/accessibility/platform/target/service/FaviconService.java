package com.accessibility.platform.target.service;

import lombok.extern.slf4j.Slf4j;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Element;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import jakarta.annotation.PreDestroy;

import java.io.IOException;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.*;
import java.util.function.Consumer;

@Slf4j
@Service
public class FaviconService {

    private static final int MAX_REDIRECTS = 4;
    private static final int MAX_HTML_BYTES = 256 * 1024;
    private static final int TARGET_ICON_SIZE = 64;
    private static final int MAX_ICON_SIZE = 128;
    // Small ICOs can contain uncompressed pixels: SKKU's 120px icon is ~60KB.
    // Keep the dimension limit as well as a bounded download allowance.
    private static final int MAX_ICON_BYTES = 64 * 1024;
    private static final int MAX_ICON_REQUESTS = 4;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);
    private static final Pattern CHARSET_PATTERN = Pattern.compile(
            "charset\\s*=\\s*[\"']?([^\\s;\"']+)",
            Pattern.CASE_INSENSITIVE
    );

    private final HttpClient httpClient;
    private final FaviconCache cache;
    private final ExecutorService lookups = new ThreadPoolExecutor(0, 4, 30, TimeUnit.SECONDS,
            new SynchronousQueue<>(), Thread.ofPlatform().daemon().name("favicon-lookup-", 0).factory());
    private static final Duration LOOKUP_TIMEOUT = Duration.ofSeconds(10);

    public FaviconService() {
        this(new FaviconCache(null));
    }

    @Autowired
    public FaviconService(FaviconCache cache) {
        this(HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(3))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build(), cache);
    }

    FaviconService(HttpClient httpClient) {
        this(httpClient, new FaviconCache(null));
    }

    FaviconService(HttpClient httpClient, FaviconCache cache) {
        this.httpClient = httpClient;
        this.cache = cache;
    }

    @PreDestroy
    public void close() { lookups.shutdownNow(); }

    /**
     * Reads a public web page and caches a small decoded favicon, returning its local API path.
     * Failure is deliberately non-fatal because a favicon is optional metadata.
     */
    /** Whether the dashboard can show this stored favicon without fetching it again. */
    public boolean hasServableFavicon(String faviconUrl) {
        return cache.isServable(faviconUrl);
    }

    public Optional<String> findFaviconUrl(String pageUrl) {
        Future<Optional<String>> lookup;
        long deadline = System.nanoTime() + LOOKUP_TIMEOUT.toNanos();
        try { lookup = lookups.submit(() -> lookup(pageUrl, deadline)); }
        catch (RejectedExecutionException busy) { return Optional.empty(); }
        try { return lookup.get(LOOKUP_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS); }
        catch (InterruptedException interrupted) {
            lookup.cancel(true);
            Thread.currentThread().interrupt();
        } catch (TimeoutException timeout) { lookup.cancel(true); }
        catch (ExecutionException failed) { log.debug("Favicon lookup failed", failed.getCause()); }
        return Optional.empty();
    }

    /**
     * Looks up a favicon without blocking the caller. The same deadline as
     * {@link #findFaviconUrl} bounds the fetch, and a busy pool skips it.
     */
    public void findFaviconUrlInBackground(String pageUrl, Consumer<String> onFound) {
        long deadline = System.nanoTime() + LOOKUP_TIMEOUT.toNanos();
        try {
            lookups.execute(() -> {
                try { lookup(pageUrl, deadline).ifPresent(onFound); }
                catch (RuntimeException e) { log.debug("Could not store favicon for {}: {}", pageUrl, e.getMessage()); }
            });
        } catch (RejectedExecutionException busy) {
            log.debug("Favicon lookup skipped for {}: lookup pool is busy", pageUrl);
        }
    }

    private Optional<String> lookup(String pageUrl, long deadline) {
        URI initialUri = parseHttpUri(pageUrl).orElse(null);
        if (initialUri == null || !isPublicHttpUri(initialUri)) {
            return Optional.empty();
        }

        try {
            HtmlPage page = fetchHtml(initialUri, deadline);
            if (page == null) {
                return Optional.empty();
            }

            return findVerifiedIcon(page, deadline);
        } catch (IOException e) {
            log.debug("Could not fetch favicon metadata from {}: {}", pageUrl, e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.debug("Favicon lookup was interrupted for {}", pageUrl);
        } catch (RuntimeException e) {
            log.debug("Could not resolve favicon for {}: {}", pageUrl, e.getMessage());
        }
        return Optional.empty();
    }

    URI extractFaviconUri(URI pageUri, String html) {
        return faviconCandidates(pageUri, html).stream()
                .findFirst().map(FaviconCandidate::uri).orElse(null);
    }

    private List<FaviconCandidate> faviconCandidates(URI pageUri, String html) {
        List<FaviconCandidate> candidates = new ArrayList<>();
        for (Element link : Jsoup.parse(html).select("link[rel][href]")) {
            String rel = link.attr("rel").toLowerCase(Locale.ROOT);
            String href = link.attr("href");
            int priority = priority(rel);

            if (priority >= 0 && href != null && !href.isBlank()) {
                resolveHttpUri(pageUri, href).ifPresent(uri ->
                        candidates.add(new FaviconCandidate(uri, priority, declaredSize(link.attr("sizes")), candidates.size()))
                );
            }
        }

        URI fallback = defaultFaviconUri(pageUri);
        if (fallback != null && candidates.stream().noneMatch(candidate -> candidate.uri().equals(fallback))) {
            candidates.add(new FaviconCandidate(fallback, 2, 0, candidates.size()));
        }
        return candidates.stream().filter(candidate -> candidate.size() <= MAX_ICON_SIZE)
                .sorted(Comparator.comparingInt((FaviconCandidate candidate) -> sizeRank(candidate.size()))
                        .thenComparingInt(FaviconCandidate::priority).thenComparingInt(FaviconCandidate::order))
                .toList();
    }

    // Prefer the smallest adequate icon, then unknown dimensions, then smaller fallbacks.
    private static int sizeRank(int size) {
        if (size >= TARGET_ICON_SIZE) return size - TARGET_ICON_SIZE;
        if (size == 0) return MAX_ICON_SIZE;
        return MAX_ICON_SIZE * 2 - size;
    }

    private static int declaredSize(String sizes) {
        int largest = 0;
        for (String token : sizes.toLowerCase(Locale.ROOT).trim().split("\\s+")) {
            if (token.equals("any")) return TARGET_ICON_SIZE;
            if (!token.matches("[0-9]{1,6}x[0-9]{1,6}")) continue;
            String[] dimensions = token.split("x");
            int width = Integer.parseInt(dimensions[0]);
            int height = Integer.parseInt(dimensions[1]);
            if (width > 0 && height > 0) largest = Math.max(largest, Math.max(width, height));
        }
        return largest;
    }

    private Optional<String> findVerifiedIcon(HtmlPage page, long deadline) throws InterruptedException, IOException {
        FaviconImage smallerFallback = null;
        int fallbackSize = 0;
        int attempts = 0;
        var visited = new java.util.HashSet<URI>();
        for (FaviconCandidate candidate : faviconCandidates(page.uri(), page.html())) {
            if (System.nanoTime() >= deadline || Thread.currentThread().isInterrupted()) break;
            URI uri = withoutFragment(candidate.uri());
            if (!visited.add(uri)) continue;
            if (attempts++ >= MAX_ICON_REQUESTS) break;
            try {
                IconFile icon = fetchIcon(uri, deadline);
                if (icon == null) continue;
                FaviconImage image = FaviconImage.validate(icon.bytes());
                if (image == null) continue;
                int size = image.size();
                if (size >= TARGET_ICON_SIZE) return Optional.of(cache.store(image));
                if (size > fallbackSize) {
                    smallerFallback = image;
                    fallbackSize = size;
                }
            } catch (IOException | RuntimeException ignored) {
                // A broken or oversized candidate must not hide another usable icon.
            }
        }
        return smallerFallback == null ? Optional.empty() : Optional.of(cache.store(smallerFallback));
    }

    private IconFile fetchIcon(URI initialUri, long deadline) throws IOException, InterruptedException {
        URI uri = initialUri;
        for (int redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            if (!isPublicHttpUri(uri)) return null;
            var request = HttpRequest.newBuilder(uri).timeout(REQUEST_TIMEOUT)
                    .header("Accept", "image/*")
                    .header("User-Agent", "Mozilla/5.0 (compatible; Accessibility-Dashboard/1.0)")
                    .GET().build();
            var response = FaviconDownload.get(httpClient, request, MAX_ICON_BYTES, false, deadline);
                if (isRedirect(response.statusCode())) {
                    String location = response.headers().firstValue("Location").orElse(null);
                    if (location == null || redirects == MAX_REDIRECTS) return null;
                    uri = uri.resolve(location);
                    continue;
                }
                if (response.statusCode() < 200 || response.statusCode() >= 300
                        || response.headers().firstValueAsLong("Content-Length").orElse(0) > MAX_ICON_BYTES) return null;
                byte[] bytes = response.body();
                return bytes.length > MAX_ICON_BYTES ? null : new IconFile(withoutFragment(uri), bytes);
        }
        return null;
    }

    static int iconSize(byte[] bytes) {
        try {
            FaviconImage image = FaviconImage.validate(bytes);
            return image == null ? 0 : image.size();
        } catch (IOException | RuntimeException invalid) { return 0; }
    }

    boolean isPublicHttpUri(URI uri) {
        if (uri == null
                || uri.getHost() == null
                || uri.getRawUserInfo() != null
                || !isHttpScheme(uri.getScheme())) {
            return false;
        }

        try {
            InetAddress[] addresses = InetAddress.getAllByName(uri.getHost());
            if (addresses.length == 0) {
                return false;
            }
            for (InetAddress address : addresses) {
                if (!isPublicAddress(address)) {
                    return false;
                }
            }
            return true;
        } catch (UnknownHostException e) {
            return false;
        }
    }

    private HtmlPage fetchHtml(URI initialUri, long deadline) throws IOException, InterruptedException {
        URI currentUri = initialUri;

        for (int redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
            if (!isPublicHttpUri(currentUri)) {
                return null;
            }

            HttpRequest request = HttpRequest.newBuilder(currentUri)
                    .timeout(REQUEST_TIMEOUT)
                    .header("Accept", "text/html,application/xhtml+xml")
                    .header("User-Agent", "Mozilla/5.0 (compatible; Accessibility-Dashboard/1.0)")
                    .GET()
                    .build();

            HttpResponse<byte[]> response = FaviconDownload.get(httpClient, request, MAX_HTML_BYTES, true, deadline);
                if (isRedirect(response.statusCode())) {
                    String location = response.headers().firstValue("Location").orElse(null);
                    if (location == null || redirectCount == MAX_REDIRECTS) {
                        return null;
                    }
                    currentUri = currentUri.resolve(location);
                    continue;
                }

                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    return null;
                }

                String contentType = response.headers().firstValue("Content-Type").orElse("");
                if (!contentType.isBlank()
                        && !contentType.toLowerCase(Locale.ROOT).contains("text/html")
                        && !contentType.toLowerCase(Locale.ROOT).contains("application/xhtml+xml")) {
                    return null;
                }

                byte[] bytes = response.body();
                if (bytes.length > MAX_HTML_BYTES) {
                    byte[] truncated = new byte[MAX_HTML_BYTES];
                    System.arraycopy(bytes, 0, truncated, 0, MAX_HTML_BYTES);
                    bytes = truncated;
                }
                return new HtmlPage(currentUri, new String(bytes, charset(contentType)));
        }
        return null;
    }

    private Optional<URI> parseHttpUri(String value) {
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        try {
            URI uri = new URI(value.trim());
            return isHttpScheme(uri.getScheme()) ? Optional.of(uri) : Optional.empty();
        } catch (URISyntaxException e) {
            return Optional.empty();
        }
    }

    private Optional<URI> resolveHttpUri(URI pageUri, String href) {
        try {
            URI resolved = pageUri.resolve(href.trim());
            return isHttpScheme(resolved.getScheme()) && resolved.getHost() != null
                    ? Optional.of(resolved)
                    : Optional.empty();
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    private int priority(String rel) {
        List<String> tokens = List.of(rel.trim().split("\\s+"));
        if (tokens.contains("icon")) {
            return 0;
        }
        if (tokens.contains("apple-touch-icon") || tokens.contains("apple-touch-icon-precomposed")) {
            return 1;
        }
        return -1;
    }

    private URI defaultFaviconUri(URI pageUri) {
        try {
            return new URI(
                    pageUri.getScheme(),
                    null,
                    pageUri.getHost(),
                    pageUri.getPort(),
                    "/favicon.ico",
                    null,
                    null
            );
        } catch (URISyntaxException e) {
            return null;
        }
    }

    private URI withoutFragment(URI uri) {
        String raw = uri.toString();
        int fragment = raw.indexOf('#');
        return fragment < 0 ? uri : URI.create(raw.substring(0, fragment));
    }

    private Charset charset(String contentType) {
        Matcher matcher = CHARSET_PATTERN.matcher(contentType);
        if (matcher.find()) {
            try {
                return Charset.forName(matcher.group(1));
            } catch (IllegalArgumentException ignored) {
                // Fall through to UTF-8.
            }
        }
        return StandardCharsets.UTF_8;
    }

    private boolean isRedirect(int statusCode) {
        return statusCode == 301
                || statusCode == 302
                || statusCode == 303
                || statusCode == 307
                || statusCode == 308;
    }

    private boolean isHttpScheme(String scheme) {
        return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    }

    private boolean isPublicAddress(InetAddress address) {
        if (address.isAnyLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return false;
        }

        byte[] bytes = address.getAddress();
        if (address instanceof Inet4Address) {
            int first = Byte.toUnsignedInt(bytes[0]);
            int second = Byte.toUnsignedInt(bytes[1]);
            int third = Byte.toUnsignedInt(bytes[2]);

            return first != 0
                    && !(first == 100 && second >= 64 && second <= 127)
                    && !(first == 192 && second == 0 && (third == 0 || third == 2))
                    && !(first == 198 && (second == 18 || second == 19))
                    && !(first == 198 && second == 51 && third == 100)
                    && !(first == 203 && second == 0 && third == 113)
                    && first < 240;
        }

        if (address instanceof Inet6Address) {
            int first = Byte.toUnsignedInt(bytes[0]);
            return (first & 0xfe) != 0xfc;
        }
        return false;
    }

    private record HtmlPage(URI uri, String html) {
    }

    private record FaviconCandidate(URI uri, int priority, int size, int order) {
    }

    private record IconFile(URI uri, byte[] bytes) {
    }
}
