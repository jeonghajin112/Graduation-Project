package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.net.IDN;
import java.net.URI;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Allocates an unguessable, stable browser origin for each live-session/upstream-origin pair.
 *
 * <p>The browser sees {@code <route-token>.<viewer-base-host>/<upstream-path>}. Moving the
 * capability into the hostname keeps {@code location.pathname}, root-relative assets and SPA
 * history paths intact. Different upstream origins receive different viewer origins, so the
 * proxy does not collapse the browser's same-origin boundary.</p>
 */
@Component
public class LiveReportOriginRouteRegistry {
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final Pattern ROUTE_TOKEN = Pattern.compile("[a-f0-9]{40}");

    private final LiveReportSessionService sessionService;
    private final LiveReportProperties properties;
    private final Clock clock;
    private final URI viewerBaseOrigin;
    private final URI gatewayBaseOrigin;
    private final URI dashboardBaseOrigin;
    private final String viewerBaseHost;
    private final Map<RouteKey, RouteEntry> routesByKey = new ConcurrentHashMap<>();
    private final Map<String, RouteEntry> routesByToken = new ConcurrentHashMap<>();

    @Autowired
    public LiveReportOriginRouteRegistry(
            LiveReportSessionService sessionService,
            LiveReportProperties properties
    ) {
        this(sessionService, properties, Clock.systemUTC());
    }

    LiveReportOriginRouteRegistry(
            LiveReportSessionService sessionService,
            LiveReportProperties properties,
            Clock clock
    ) {
        this.sessionService = sessionService;
        this.properties = properties;
        this.clock = clock;
        this.viewerBaseOrigin = requireConfiguredOrigin(properties.getViewerBaseUrl(), "viewer");
        this.gatewayBaseOrigin = requireConfiguredOrigin(properties.getGatewayBaseUrl(), "gateway");
        this.dashboardBaseOrigin = requireConfiguredOrigin(properties.getDashboardBaseUrl(), "dashboard");
        this.viewerBaseHost = canonicalHost(viewerBaseOrigin.getHost());
        if (isIpLiteral(viewerBaseHost)) {
            throw new IllegalArgumentException("Live report viewer base URL must use a DNS hostname");
        }
        if (properties.getMaxOriginsPerSession() <= 0) {
            throw new IllegalArgumentException("Live report max origins per session must be positive");
        }
    }

    public synchronized RoutedOrigin routeFor(
            LiveReportSessionService.LiveReportSession session,
            URI targetUri
    ) {
        URI upstreamOrigin = requireUpstreamOrigin(targetUri);
        RouteKey key = new RouteKey(session.id(), upstreamOrigin);
        RouteEntry existing = routesByKey.get(key);
        if (existing != null) {
            RouteEntry refreshed = existing.withExpiration(session.expiresAt());
            routesByKey.put(key, refreshed);
            routesByToken.put(refreshed.token(), refreshed);
            return toRoutedOrigin(refreshed);
        }

        purgeExpired();
        long originCount = routesByKey.keySet().stream()
                .filter(candidate -> candidate.sessionId().equals(session.id()))
                .count();
        if (originCount >= properties.getMaxOriginsPerSession()) {
            throw new LiveReportException(
                    HttpStatus.TOO_MANY_REQUESTS,
                    "Live report session has too many distinct origins"
            );
        }
        String token = newRouteToken();
        RouteEntry created = new RouteEntry(
                token,
                session.id(),
                session.nonce(),
                upstreamOrigin,
                session.expiresAt()
        );
        routesByKey.put(key, created);
        routesByToken.put(token, created);
        return toRoutedOrigin(created);
    }

    public synchronized RoutedRequest requireViewerRequest(String requestHost, String rawPath, String rawQuery) {
        String token = routeTokenFromHost(requestHost);
        RouteEntry entry = routesByToken.get(token);
        if (entry == null) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer route was not found");
        }
        LiveReportSessionService.LiveReportSession session;
        try {
            session = sessionService.requireAuthorized(entry.sessionId(), entry.nonce());
        } catch (LiveReportException exception) {
            remove(entry);
            throw exception;
        }
        Instant now = clock.instant();
        if (!now.isBefore(entry.expiresAt()) && !now.isBefore(session.expiresAt())) {
            remove(entry);
            throw new LiveReportException(HttpStatus.GONE, "Live report session has expired");
        }
        RouteEntry refreshed = entry.withExpiration(session.expiresAt());
        routesByKey.put(new RouteKey(entry.sessionId(), entry.upstreamOrigin()), refreshed);
        routesByToken.put(token, refreshed);
        URI target = resolveTarget(entry.upstreamOrigin(), rawPath, rawQuery);
        return new RoutedRequest(session, entry.upstreamOrigin(), target, toRoutedOrigin(refreshed));
    }

    public String runtimeUrl(
            LiveReportSessionService.LiveReportSession session,
            URI targetUri
    ) {
        RoutedOrigin route = routeFor(session, targetUri);
        return replaceOrigin(route.viewerOrigin(), targetUri).toASCIIString();
    }

    public String gatewayOrigin() {
        return gatewayBaseOrigin.toASCIIString();
    }

    public String dashboardOrigin() {
        return dashboardBaseOrigin.toASCIIString();
    }

    /**
     * Exact origins allowed to frame a top-level viewer document. Browsers treat localhost and
     * 127.0.0.1 as different origins, while Vite commonly opens either spelling during local
     * development. Add only that loopback twin automatically; production origins remain exact.
     */
    public String dashboardFrameAncestorSources() {
        String configured = dashboardBaseOrigin.toASCIIString();
        String host = canonicalHost(dashboardBaseOrigin.getHost());
        if (!host.equals("localhost") && !host.equals("127.0.0.1")) {
            return configured;
        }
        String twinHost = host.equals("localhost") ? "127.0.0.1" : "localhost";
        String port = dashboardBaseOrigin.getPort() == -1 ? "" : ":" + dashboardBaseOrigin.getPort();
        return configured + " " + dashboardBaseOrigin.getScheme() + "://" + twinHost + port;
    }

    public String viewerWildcardSource() {
        String port = viewerBaseOrigin.getPort() == -1 ? "" : ":" + viewerBaseOrigin.getPort();
        return viewerBaseOrigin.getScheme() + "://*." + viewerBaseHost + port;
    }

    boolean isViewerHost(String requestHost) {
        try {
            viewerRouteToken(requestHost);
            return true;
        } catch (LiveReportException ignored) {
            return false;
        }
    }

    boolean isViewerZoneHost(String requestHost) {
        String host;
        try {
            host = canonicalHost(requestHost);
        } catch (LiveReportException ignored) {
            return false;
        }
        String suffix = "." + viewerBaseHost;
        return host.length() > suffix.length() && host.endsWith(suffix);
    }

    String viewerRouteToken(String requestHost) {
        return routeTokenFromHost(requestHost);
    }

    URI viewerBaseOrigin() {
        return viewerBaseOrigin;
    }

    private RoutedOrigin toRoutedOrigin(RouteEntry entry) {
        String host = entry.token() + "." + viewerBaseHost;
        String port = viewerBaseOrigin.getPort() == -1 ? "" : ":" + viewerBaseOrigin.getPort();
        URI origin = URI.create(viewerBaseOrigin.getScheme() + "://" + host + port);
        return new RoutedOrigin(entry.token(), entry.upstreamOrigin(), origin);
    }

    private URI replaceOrigin(URI origin, URI target) {
        String rawPath = target.getRawPath() == null || target.getRawPath().isEmpty()
                ? "/"
                : target.getRawPath();
        validateRawLocation(rawPath, target.getRawQuery(), target.getRawFragment());
        return URI.create(origin.toASCIIString()
                + rawPath
                + (target.getRawQuery() == null ? "" : "?" + target.getRawQuery())
                + (target.getRawFragment() == null ? "" : "#" + target.getRawFragment()));
    }

    private URI resolveTarget(URI upstreamOrigin, String rawPath, String rawQuery) {
        String path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
        validateRawLocation(path, rawQuery, null);
        try {
            return URI.create(upstreamOrigin.toASCIIString()
                    + path
                    + (rawQuery == null ? "" : "?" + rawQuery));
        } catch (IllegalArgumentException exception) {
            throw new LiveReportException(
                    HttpStatus.BAD_REQUEST,
                    "Live report viewer location is invalid",
                    exception
            );
        }
    }

    private String routeTokenFromHost(String rawHost) {
        String host = canonicalHost(rawHost);
        String suffix = "." + viewerBaseHost;
        if (!host.endsWith(suffix)) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer host is invalid");
        }
        String token = host.substring(0, host.length() - suffix.length());
        if (token.indexOf('.') >= 0 || !ROUTE_TOKEN.matcher(token).matches()) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer host is invalid");
        }
        return token;
    }

    private URI requireUpstreamOrigin(URI target) {
        if (target == null || !target.isAbsolute() || !"https".equalsIgnoreCase(target.getScheme())
                || target.getHost() == null || target.getRawUserInfo() != null
                || (target.getPort() != -1 && target.getPort() != 443)) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report route target is invalid");
        }
        String host = canonicalHost(target.getHost());
        String authority = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
        return URI.create("https://" + authority);
    }

    private URI requireConfiguredOrigin(String raw, String label) {
        URI origin;
        try {
            origin = URI.create(raw == null ? "" : raw.trim());
        } catch (IllegalArgumentException exception) {
            throw new IllegalArgumentException("Live report " + label + " base URL is invalid", exception);
        }
        String path = origin.getRawPath();
        int configuredPort = origin.getPort();
        boolean localHttp = "http".equalsIgnoreCase(origin.getScheme())
                && "localhost".equalsIgnoreCase(origin.getHost());
        if (origin.getHost() == null || origin.getRawUserInfo() != null
                || origin.getRawQuery() != null || origin.getRawFragment() != null
                || configuredPort == 0 || configuredPort > 65_535
                || (path != null && !path.isEmpty() && !path.equals("/"))
                || (!"https".equalsIgnoreCase(origin.getScheme()) && !localHttp)) {
            throw new IllegalArgumentException(
                    "Live report " + label + " base URL must be an HTTPS origin (localhost HTTP is allowed for development)"
            );
        }
        String host = canonicalHost(origin.getHost());
        String port = origin.getPort() == -1 ? "" : ":" + origin.getPort();
        return URI.create(origin.getScheme().toLowerCase(Locale.ROOT) + "://" + host + port);
    }

    private String canonicalHost(String rawHost) {
        if (rawHost == null || rawHost.isBlank()) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer host is missing");
        }
        String normalizedHost = rawHost.startsWith("[") && rawHost.endsWith("]")
                ? rawHost.substring(1, rawHost.length() - 1)
                : rawHost;
        normalizedHost = normalizedHost.endsWith(".")
                ? normalizedHost.substring(0, normalizedHost.length() - 1)
                : normalizedHost;
        if (normalizedHost.isBlank() || normalizedHost.endsWith(".")) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer host is invalid");
        }
        if (normalizedHost.indexOf(':') >= 0) {
            if (normalizedHost.indexOf('%') >= 0 || !normalizedHost.matches("[0-9A-Fa-f:.]+")) {
                throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer host is invalid");
            }
            return normalizedHost.toLowerCase(Locale.ROOT);
        }
        try {
            return IDN.toASCII(normalizedHost, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException exception) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report viewer host is invalid", exception);
        }
    }

    private boolean isIpLiteral(String host) {
        return host.indexOf(':') >= 0 || host.matches("[0-9.]+");
    }

    private String newRouteToken() {
        while (true) {
            byte[] bytes = new byte[20];
            SECURE_RANDOM.nextBytes(bytes);
            String token = HexFormat.of().formatHex(bytes);
            if (routesByToken.putIfAbsent(token, new RouteEntry(
                    token,
                    new UUID(0, 0),
                    "",
                    URI.create("https://invalid.local"),
                    Instant.EPOCH
            )) == null) {
                routesByToken.remove(token);
                return token;
            }
        }
    }

    private void purgeExpired() {
        Instant now = clock.instant();
        routesByToken.values().stream()
                .filter(entry -> !now.isBefore(entry.expiresAt()))
                .toList()
                .forEach(this::remove);
    }

    private void remove(RouteEntry entry) {
        routesByToken.remove(entry.token(), entry);
        routesByKey.remove(new RouteKey(entry.sessionId(), entry.upstreamOrigin()), entry);
    }

    private boolean containsControl(String value) {
        return value != null && value.chars().anyMatch(character -> character < 0x20 || character == 0x7f);
    }

    private void validateRawLocation(String rawPath, String rawQuery, String rawFragment) {
        if (rawPath == null || rawPath.isEmpty() || rawPath.charAt(0) != '/'
                || rawPath.length() > 32_768 || rawPath.indexOf('\\') >= 0
                || rawPath.indexOf('?') >= 0 || rawPath.indexOf('#') >= 0
                || containsControl(rawPath)
                || (rawQuery != null && (rawQuery.length() > 32_768
                || rawQuery.indexOf('#') >= 0 || containsControl(rawQuery)))
                || (rawFragment != null && (rawFragment.length() > 8_192
                || containsControl(rawFragment)))) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, "Live report viewer location is invalid");
        }
    }

    private record RouteKey(UUID sessionId, URI upstreamOrigin) {
    }

    private record RouteEntry(
            String token,
            UUID sessionId,
            String nonce,
            URI upstreamOrigin,
            Instant expiresAt
    ) {
        RouteEntry withExpiration(Instant nextExpiration) {
            return nextExpiration == null || !nextExpiration.isAfter(expiresAt)
                    ? this
                    : new RouteEntry(token, sessionId, nonce, upstreamOrigin, nextExpiration);
        }
    }

    public record RoutedOrigin(String token, URI upstreamOrigin, URI viewerOrigin) {
    }

    public record RoutedRequest(
            LiveReportSessionService.LiveReportSession session,
            URI upstreamOrigin,
            URI targetUri,
            RoutedOrigin route
    ) {
    }
}
