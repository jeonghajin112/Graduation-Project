package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;

import java.net.HttpCookie;
import java.net.IDN;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * A deliberately small, in-memory cookie jar owned by one live-report session.
 *
 * <p>The viewer never forwards browser credentials. Only cookies created by anonymous upstream
 * responses inside this jar are replayed, and the jar disappears with its live-report session.</p>
 */
final class LiveReportCookieJar {
    private static final Pattern COOKIE_NAME = Pattern.compile("[!#$%&'*+\\-.^_`|~0-9A-Za-z]+");
    private static final Pattern COOKIE_VALUE = Pattern.compile("[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]*");
    private static final List<DateTimeFormatter> EXPIRES_FORMATTERS = List.of(
            DateTimeFormatter.RFC_1123_DATE_TIME,
            DateTimeFormatter.ofPattern("EEE, dd-MMM-yyyy HH:mm:ss zzz", Locale.US),
            DateTimeFormatter.ofPattern("EEE MMM d HH:mm:ss yyyy", Locale.US)
    );

    private final Clock clock;
    private final int maxCookieCount;
    private final int maxCookieBytes;
    private final int maxTotalBytes;
    private final Map<CookieKey, StoredCookie> cookies = new LinkedHashMap<>();
    private long sequence;
    private int totalBytes;

    LiveReportCookieJar(LiveReportProperties properties, Clock clock) {
        this.clock = clock;
        this.maxCookieCount = Math.max(0, properties.getMaxCookiesPerSession());
        this.maxCookieBytes = Math.max(0, properties.getMaxCookieBytes());
        this.maxTotalBytes = Math.max(0, properties.getMaxCookieBytesPerSession());
    }

    synchronized void store(URI responseUri, List<String> setCookieHeaders) {
        if (maxCookieCount == 0 || maxCookieBytes == 0 || maxTotalBytes == 0 || setCookieHeaders == null) {
            return;
        }
        evictExpired();
        for (String header : setCookieHeaders) {
            parse(responseUri, header).ifPresent(this::put);
        }
    }

    synchronized Optional<String> cookieHeader(URI requestUri) {
        evictExpired();
        String host = canonicalHost(requestUri);
        if (host == null) {
            return Optional.empty();
        }
        String path = requestPath(requestUri);
        boolean secure = "https".equalsIgnoreCase(requestUri.getScheme());

        List<StoredCookie> matches = cookies.values().stream()
                .filter(cookie -> (!cookie.secure() || secure)
                        && domainMatches(cookie, host)
                        && pathMatches(cookie.path(), path))
                .sorted(Comparator.comparingInt((StoredCookie cookie) -> cookie.path().length()).reversed()
                        .thenComparingLong(StoredCookie::sequence))
                .toList();
        if (matches.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(matches.stream()
                .map(cookie -> cookie.name() + "=" + cookie.value())
                .reduce((left, right) -> left + "; " + right)
                .orElseThrow());
    }

    synchronized int size() {
        evictExpired();
        return cookies.size();
    }

    synchronized int totalBytes() {
        evictExpired();
        return totalBytes;
    }

    private Optional<StoredCookie> parse(URI responseUri, String header) {
        if (header == null || header.isBlank() || utf8Length(header) > maxCookieBytes * 2L) {
            return Optional.empty();
        }
        String responseHost = canonicalHost(responseUri);
        if (responseHost == null || !"https".equalsIgnoreCase(responseUri.getScheme())) {
            return Optional.empty();
        }

        final HttpCookie parsed;
        try {
            List<HttpCookie> parsedCookies = HttpCookie.parse(header);
            if (parsedCookies.size() != 1) {
                return Optional.empty();
            }
            parsed = parsedCookies.getFirst();
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }

        String name = parsed.getName();
        String value = unquote(parsed.getValue());
        if (!COOKIE_NAME.matcher(name).matches() || !COOKIE_VALUE.matcher(value).matches()) {
            return Optional.empty();
        }

        boolean hostOnly = parsed.getDomain() == null || parsed.getDomain().isBlank();
        String domain = hostOnly ? responseHost : canonicalDomain(parsed.getDomain());
        if (domain == null || !acceptedDomain(responseHost, domain, hostOnly)) {
            return Optional.empty();
        }

        String path = parsed.getPath();
        if (path == null || path.isBlank() || !path.startsWith("/")) {
            path = defaultPath(responseUri);
        }
        if (containsControl(path)) {
            return Optional.empty();
        }

        Instant now = clock.instant();
        Optional<Instant> expiresAt = expiration(header, parsed, now);
        CookieKey key = new CookieKey(name, domain, path);
        if (parsed.getMaxAge() == 0 || expiresAt.filter(expiry -> !expiry.isAfter(now)).isPresent()) {
            remove(key);
            return Optional.empty();
        }

        StoredCookie cookie = new StoredCookie(
                key,
                name,
                value,
                domain,
                path,
                hostOnly,
                parsed.getSecure(),
                expiresAt.orElse(null),
                ++sequence,
                cookieBytes(name, value, domain, path)
        );
        return cookie.bytes() <= maxCookieBytes && cookie.bytes() <= maxTotalBytes
                ? Optional.of(cookie)
                : Optional.empty();
    }

    private Optional<Instant> expiration(String header, HttpCookie cookie, Instant now) {
        String maxAge = attribute(header, "max-age");
        if (maxAge != null) {
            try {
                long seconds = Long.parseLong(maxAge.trim());
                if (seconds <= 0) {
                    return Optional.of(now);
                }
                return Optional.of(now.plusSeconds(seconds));
            } catch (ArithmeticException | DateTimeException | NumberFormatException ignored) {
                return Optional.empty();
            }
        }

        String expires = attribute(header, "expires");
        if (expires != null) {
            for (DateTimeFormatter formatter : EXPIRES_FORMATTERS) {
                try {
                    return Optional.of(ZonedDateTime.parse(expires.trim(), formatter).toInstant());
                } catch (DateTimeParseException ignored) {
                    // Try the next browser-compatible legacy date format.
                }
            }
        }

        if (cookie.getMaxAge() >= 0) {
            try {
                return Optional.of(now.plusSeconds(cookie.getMaxAge()));
            } catch (ArithmeticException | DateTimeException ignored) {
                return Optional.empty();
            }
        }
        return Optional.empty();
    }

    private void put(StoredCookie cookie) {
        remove(cookie.key());
        while (!cookies.isEmpty()
                && (cookies.size() >= maxCookieCount || totalBytes + cookie.bytes() > maxTotalBytes)) {
            Iterator<Map.Entry<CookieKey, StoredCookie>> iterator = cookies.entrySet().iterator();
            Map.Entry<CookieKey, StoredCookie> eldest = iterator.next();
            totalBytes -= eldest.getValue().bytes();
            iterator.remove();
        }
        if (cookies.size() < maxCookieCount && totalBytes + cookie.bytes() <= maxTotalBytes) {
            cookies.put(cookie.key(), cookie);
            totalBytes += cookie.bytes();
        }
    }

    private void evictExpired() {
        Instant now = clock.instant();
        Iterator<Map.Entry<CookieKey, StoredCookie>> iterator = cookies.entrySet().iterator();
        while (iterator.hasNext()) {
            StoredCookie cookie = iterator.next().getValue();
            if (cookie.expiresAt() != null && !cookie.expiresAt().isAfter(now)) {
                totalBytes -= cookie.bytes();
                iterator.remove();
            }
        }
    }

    private void remove(CookieKey key) {
        StoredCookie removed = cookies.remove(key);
        if (removed != null) {
            totalBytes -= removed.bytes();
        }
    }

    private boolean acceptedDomain(String responseHost, String domain, boolean hostOnly) {
        if (hostOnly || responseHost.equals(domain)) {
            return responseHost.equals(domain);
        }
        if (isIpLiteral(responseHost) || domain.indexOf('.') < 0) {
            return false;
        }
        return responseHost.endsWith("." + domain);
    }

    private boolean domainMatches(StoredCookie cookie, String requestHost) {
        return cookie.hostOnly()
                ? requestHost.equals(cookie.domain())
                : requestHost.equals(cookie.domain()) || requestHost.endsWith("." + cookie.domain());
    }

    private boolean pathMatches(String cookiePath, String requestPath) {
        if (requestPath.equals(cookiePath)) {
            return true;
        }
        if (!requestPath.startsWith(cookiePath)) {
            return false;
        }
        return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length()) == '/';
    }

    private String defaultPath(URI uri) {
        String path = requestPath(uri);
        int lastSlash = path.lastIndexOf('/');
        return lastSlash <= 0 ? "/" : path.substring(0, lastSlash);
    }

    private String requestPath(URI uri) {
        String path = uri.getRawPath();
        return path == null || path.isEmpty() ? "/" : path;
    }

    private String canonicalHost(URI uri) {
        return canonicalDomain(uri == null ? null : uri.getHost());
    }

    private String canonicalDomain(String rawDomain) {
        if (rawDomain == null || rawDomain.isBlank()) {
            return null;
        }
        String domain = rawDomain.trim().toLowerCase(Locale.ROOT);
        while (domain.startsWith(".")) {
            domain = domain.substring(1);
        }
        if (domain.startsWith("[") && domain.endsWith("]")) {
            domain = domain.substring(1, domain.length() - 1);
        }
        if (domain.isBlank() || domain.endsWith(".") || containsControl(domain)) {
            return null;
        }
        if (domain.contains(":")) {
            return domain.matches("[0-9a-f:]+") ? domain : null;
        }
        try {
            return IDN.toASCII(domain, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private boolean isIpLiteral(String host) {
        if (host.contains(":")) {
            return true;
        }
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) {
            return false;
        }
        for (String part : parts) {
            try {
                if (part.isBlank() || Integer.parseInt(part) > 255) {
                    return false;
                }
            } catch (NumberFormatException ignored) {
                return false;
            }
        }
        return true;
    }

    private String attribute(String header, String wantedName) {
        String[] segments = header.split(";", -1);
        for (int index = 1; index < segments.length; index++) {
            String segment = segments[index].trim();
            int equals = segment.indexOf('=');
            String name = equals < 0 ? segment : segment.substring(0, equals).trim();
            if (name.equalsIgnoreCase(wantedName)) {
                return equals < 0 ? "" : segment.substring(equals + 1).trim();
            }
        }
        return null;
    }

    private String unquote(String value) {
        if (value != null && value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            return value.substring(1, value.length() - 1);
        }
        return value == null ? "" : value;
    }

    private boolean containsControl(String value) {
        return value.chars().anyMatch(character -> character <= 0x1f || character == 0x7f);
    }

    private int cookieBytes(String name, String value, String domain, String path) {
        return utf8Length(name) + utf8Length(value) + utf8Length(domain) + utf8Length(path) + 3;
    }

    private int utf8Length(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    private record CookieKey(String name, String domain, String path) {
    }

    private record StoredCookie(
            CookieKey key,
            String name,
            String value,
            String domain,
            String path,
            boolean hostOnly,
            boolean secure,
            Instant expiresAt,
            long sequence,
            int bytes
    ) {
    }
}
