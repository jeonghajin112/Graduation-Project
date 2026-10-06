package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import jakarta.servlet.http.HttpServletRequest;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * A bounded, session-private, single-consumption cache for canonical redirects.
 *
 * <p>We cannot identify which concurrent browser GET followed a particular 302
 * without changing the viewer URL or depending on third-party cookies. Therefore
 * only responses explicitly safe to reuse for ANY matching GET are admitted.
 * Cookie-bearing chains, CORS requests, stale responses and unsupported Vary
 * fields never enter this store. A miss follows the ordinary validated fetch path.</p>
 */
final class LiveReportRedirectHandoffStore {
    private static final Set<String> SUPPORTED_VARY = Set.of("accept", "accept-language", "user-agent");
    private final LiveReportProperties properties;
    private final Clock clock;
    private final Map<Key, Entry> entries = new LinkedHashMap<>();
    private long retainedBytes;

    LiveReportRedirectHandoffStore(LiveReportProperties properties, Clock clock) {
        this.properties = properties;
        this.clock = clock;
    }

    synchronized void offer(
            LiveReportSessionService.LiveReportSession session,
            LiveReportFetchService.FetchedResource resource,
            Context context,
            long cookieRevision
    ) {
        purgeExpired();
        var reuse = resource.redirectReuse();
        if (context == null || reuse == null || !reuse.headers().equals(context.headers())
                || reuse.cookieRevision() != cookieRevision) {
            return;
        }
        Instant expiresAt = earliest(reuse.freshUntil(), session.expiresAt(),
                clock.instant().plusSeconds(Math.max(0, properties.getRedirectHandoffTtlSeconds())));
        if (!clock.instant().isBefore(expiresAt)) return;
        Key key = new Key(session.id(), resource.finalUri(), context, cookieRevision);
        if (entries.containsKey(key)) return;
        long bytes = resource.byteLength();
        long sessionBytes = 0;
        int sessionEntries = 0;
        for (var existing : entries.entrySet()) {
            if (existing.getKey().sessionId().equals(session.id())) {
                sessionEntries++;
                sessionBytes += existing.getValue().resource().byteLength();
            }
        }
        // Admission failure is an ordinary cache miss, never a new response/error policy.
        if (entries.size() >= Math.max(0, properties.getMaxRedirectHandoffEntries())
                || sessionEntries >= Math.max(0, properties.getMaxRedirectHandoffEntriesPerSession())
                || bytes > Math.max(0, properties.getMaxRedirectHandoffBytes()) - retainedBytes
                || bytes > Math.max(0, properties.getMaxRedirectHandoffBytesPerSession()) - sessionBytes) {
            return;
        }
        entries.put(key, new Entry(resource, expiresAt));
        retainedBytes += bytes;
    }

    synchronized Optional<LiveReportFetchService.FetchedResource> take(
            UUID sessionId, URI uri, Context context, long cookieRevision
    ) {
        purgeExpired();
        if (context == null) return Optional.empty();
        Entry entry = entries.remove(new Key(sessionId, uri, context, cookieRevision));
        if (entry == null) return Optional.empty();
        retainedBytes -= entry.resource().byteLength();
        return Optional.of(entry.resource());
    }

    synchronized void removeSession(UUID sessionId) {
        entries.entrySet().removeIf(entry -> {
            if (!entry.getKey().sessionId().equals(sessionId)) return false;
            retainedBytes -= entry.getValue().resource().byteLength();
            return true;
        });
    }

    private void purgeExpired() {
        Instant now = clock.instant();
        entries.entrySet().removeIf(entry -> {
            if (now.isBefore(entry.getValue().expiresAt())) return false;
            retainedBytes -= entry.getValue().resource().byteLength();
            return true;
        });
    }

    static Context requestContext(HttpServletRequest request, LiveReportRequestHeaders headers) {
        if (!"GET".equalsIgnoreCase(request.getMethod()) || LiveReportTransport.isProgrammatic(request)
                || headers.upstreamOrigin() != null) return null;
        // A reload, conditional request, credentials or partial response requires a fresh fetch.
        for (String name : List.of("Origin", "Authorization", "Cookie", "Cache-Control", "Pragma", "Range",
                "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since", "If-Range")) {
            if (request.getHeader(name) != null) return null;
        }
        String destination = request.getHeader("Sec-Fetch-Dest");
        String referrer = request.getHeader("Referer");
        if (!bounded(destination, 128) || !bounded(referrer, 8192)) return null;
        return new Context(headers, destination, referrer);
    }

    /** Explicit public freshness only; no heuristic caching and no unrepresented Vary inputs. */
    static Optional<Instant> freshUntil(
            LiveReportUpstreamClient.UpstreamResponse response, Instant requestStarted, Instant receivedAt
    ) {
        if (response.statusCode() != 200 || !response.allValues("Set-Cookie").isEmpty()) return Optional.empty();
        Map<String, String> directives = new HashMap<>();
        for (String field : response.allValues("Cache-Control")) {
            for (String part : field.split(",")) {
                String[] directive = part.strip().split("=", 2);
                String name = directive[0].toLowerCase(Locale.ROOT);
                if (name.isEmpty() || directives.putIfAbsent(name, directive.length == 2 ? directive[1].strip() : "") != null) {
                    return Optional.empty();
                }
            }
        }
        if (!"".equals(directives.get("public")) || directives.containsKey("no-store")
                || directives.containsKey("no-cache") || directives.containsKey("private")) return Optional.empty();
        for (String field : response.allValues("Vary")) {
            for (String name : field.split(",", -1)) {
                if (!SUPPORTED_VARY.contains(name.strip().toLowerCase(Locale.ROOT))) return Optional.empty();
            }
        }
        try {
            long maxAge = seconds(directives.get("max-age"));
            if (directives.containsKey("s-maxage")) maxAge = Math.min(maxAge, seconds(directives.get("s-maxage")));
            List<String> dates = response.allValues("Date");
            List<String> ages = response.allValues("Age");
            if (dates.size() != 1 || ages.size() > 1) return Optional.empty();
            Instant date = ZonedDateTime.parse(dates.getFirst(), DateTimeFormatter.RFC_1123_DATE_TIME).toInstant();
            long ageMillis = ages.isEmpty() ? 0 : Math.multiplyExact(seconds(ages.getFirst()), 1000);
            long responseDelay = Math.max(0, Duration.between(requestStarted, receivedAt).toMillis());
            long apparentAge = Math.max(0, Duration.between(date, receivedAt).toMillis());
            long currentAge = Math.max(apparentAge, Math.addExact(ageMillis, responseDelay));
            long remaining = Math.subtractExact(Math.multiplyExact(maxAge, 1000), currentAge);
            return remaining <= 0 ? Optional.empty() : Optional.of(receivedAt.plusMillis(remaining));
        } catch (RuntimeException invalidFreshness) {
            return Optional.empty();
        }
    }

    private static long seconds(String raw) {
        if (raw == null || !raw.matches("(?:[0-9]+|\"[0-9]+\")")) throw new IllegalArgumentException();
        return Long.parseLong(raw.replace("\"", ""));
    }

    private static boolean bounded(String value, int maximum) {
        return value == null || (value.length() <= maximum
                && value.chars().noneMatch(character -> character < 0x20 || character == 0x7f));
    }

    private static Instant earliest(Instant first, Instant second, Instant third) {
        Instant result = first.isBefore(second) ? first : second;
        return result.isBefore(third) ? result : third;
    }

    record Context(LiveReportRequestHeaders headers, String destination, String referrer) { }
    private record Key(UUID sessionId, URI uri, Context context, long cookieRevision) { }
    private record Entry(LiveReportFetchService.FetchedResource resource, Instant expiresAt) { }
}
