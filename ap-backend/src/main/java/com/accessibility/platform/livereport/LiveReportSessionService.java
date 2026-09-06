package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.springframework.http.HttpStatus;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.security.SecureRandom;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class LiveReportSessionService {
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final LiveReportProperties properties;
    private final LiveReportUrlSafetyValidator urlSafetyValidator;
    private final Clock clock;
    private final Map<UUID, LiveReportSession> sessions = new ConcurrentHashMap<>();
    private final Map<UUID, SessionUsage> usages = new ConcurrentHashMap<>();
    private final Map<UUID, LiveReportCookieJar> cookieJars = new ConcurrentHashMap<>();
    private final Map<UUID, URI> documentUris = new ConcurrentHashMap<>();

    @Autowired
    public LiveReportSessionService(
            LiveReportProperties properties,
            LiveReportUrlSafetyValidator urlSafetyValidator
    ) {
        this(properties, urlSafetyValidator, Clock.systemUTC());
    }

    LiveReportSessionService(
            LiveReportProperties properties,
            LiveReportUrlSafetyValidator urlSafetyValidator,
            Clock clock
    ) {
        this.properties = properties;
        this.urlSafetyValidator = urlSafetyValidator;
        this.clock = clock;
    }

    public LiveReportSession create(long requestId, String targetUrl) {
        purgeExpired();
        if (sessions.size() >= properties.getMaxSessions()) {
            throw new LiveReportException(HttpStatus.TOO_MANY_REQUESTS, "Too many live report sessions are active");
        }

        URI validatedTarget;
        try {
            validatedTarget = urlSafetyValidator.validate(targetUrl).uri();
        } catch (IllegalArgumentException e) {
            throw new LiveReportException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        }

        Instant expiresAt = clock.instant().plusSeconds(properties.getSessionTtlSeconds());
        LiveReportSession session = new LiveReportSession(
                UUID.randomUUID(),
                requestId,
                validatedTarget,
                newNonce(),
                newBridgeSecret(),
                expiresAt
        );
        sessions.put(session.id(), session);
        usages.put(session.id(), new SessionUsage(properties.getMaxConcurrentRequestsPerSession()));
        cookieJars.put(session.id(), new LiveReportCookieJar(properties, clock));
        return session;
    }

    /**
     * Extends an active viewer session without changing its identity or isolated state.
     * Keeping the id, nonce, bridge secret, cookie jar, usage budget and current document
     * URI intact lets an already-mounted iframe continue running without losing form,
     * history or scroll state.
     */
    public synchronized LiveReportSession renew(UUID sessionId, long requestId) {
        LiveReportSession current = require(sessionId);
        if (current.requestId() != requestId) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report session was not found");
        }

        LiveReportSession renewed = new LiveReportSession(
                current.id(),
                current.requestId(),
                current.targetUri(),
                current.nonce(),
                current.bridgeSecret(),
                clock.instant().plusSeconds(properties.getSessionTtlSeconds())
        );
        sessions.put(sessionId, renewed);
        return renewed;
    }

    public LiveReportSession require(UUID sessionId) {
        LiveReportSession session = sessions.get(sessionId);
        if (session == null) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report session was not found");
        }
        if (!clock.instant().isBefore(session.expiresAt())) {
            sessions.remove(sessionId, session);
            usages.remove(sessionId);
            cookieJars.remove(sessionId);
            documentUris.remove(sessionId);
            throw new LiveReportException(HttpStatus.GONE, "Live report session has expired");
        }
        return session;
    }

    public RequestLease acquireRequest(LiveReportSession session) {
        SessionUsage usage = usages.get(session.id());
        if (usage == null) {
            throw new LiveReportException(HttpStatus.GONE, "Live report session has expired");
        }
        if (usage.bytes.get() >= properties.getMaxBytesPerSession()) {
            throw budgetExceeded();
        }

        int requestNumber = usage.requests.incrementAndGet();
        if (requestNumber > properties.getMaxRequestsPerSession()) {
            throw budgetExceeded();
        }

        final boolean acquired;
        try {
            acquired = usage.concurrent.tryAcquire(
                    Math.max(0, properties.getConcurrentRequestWaitMillis()),
                    TimeUnit.MILLISECONDS
            );
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            usage.requests.decrementAndGet();
            throw new LiveReportException(
                    HttpStatus.TOO_MANY_REQUESTS,
                    "Live report concurrency wait was interrupted",
                    exception
            );
        }
        if (!acquired) {
            usage.requests.decrementAndGet();
            throw new LiveReportException(HttpStatus.TOO_MANY_REQUESTS, "Live report concurrency limit was exceeded");
        }
        return new RequestLease(usage);
    }

    public void recordResponseBytes(LiveReportSession session, long responseBytes) {
        SessionUsage usage = usages.get(session.id());
        if (usage == null) {
            throw new LiveReportException(HttpStatus.GONE, "Live report session has expired");
        }
        if (responseBytes < 0) {
            throw budgetExceeded();
        }
        if (responseBytes == 0) {
            return;
        }

        long limit = properties.getMaxBytesPerSession();
        while (true) {
            long current = usage.bytes.get();
            if (current >= limit) {
                throw budgetExceeded();
            }
            if (responseBytes > limit - current) {
                // The upstream bytes were already transferred. Saturating the
                // counter prevents an over-budget response from being retried to
                // bypass the byte cap, while avoiding overflow or a value above
                // the configured limit under concurrent completions.
                if (usage.bytes.compareAndSet(current, limit)) {
                    throw budgetExceeded();
                }
                continue;
            }
            if (usage.bytes.compareAndSet(current, current + responseBytes)) {
                return;
            }
        }
    }

    public LiveReportSession requireAuthorized(UUID sessionId, String nonce) {
        LiveReportSession session = require(sessionId);
        byte[] expected = session.nonce().getBytes(StandardCharsets.UTF_8);
        byte[] actual = nonce == null ? new byte[0] : nonce.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(expected, actual)) {
            throw new LiveReportException(HttpStatus.NOT_FOUND, "Live report session was not found");
        }
        return session;
    }

    public Optional<String> cookieHeader(LiveReportSession session, URI requestUri) {
        return requireCookieJar(session).cookieHeader(requestUri);
    }

    public void storeResponseCookies(
            LiveReportSession session,
            URI responseUri,
            List<String> setCookieHeaders
    ) {
        requireCookieJar(session).store(responseUri, setCookieHeaders);
    }

    public void recordDocumentUri(LiveReportSession session, URI documentUri) {
        require(session.id());
        if (documentUri == null || !"https".equalsIgnoreCase(documentUri.getScheme())) {
            throw new IllegalArgumentException("Live report document URI must use HTTPS");
        }
        documentUris.put(session.id(), documentUri);
    }

    public Optional<URI> documentUri(LiveReportSession session) {
        require(session.id());
        return Optional.ofNullable(documentUris.get(session.id()));
    }

    private void purgeExpired() {
        Instant now = clock.instant();
        sessions.entrySet().removeIf(entry -> {
            boolean expired = !now.isBefore(entry.getValue().expiresAt());
            if (expired) {
                usages.remove(entry.getKey());
                cookieJars.remove(entry.getKey());
                documentUris.remove(entry.getKey());
            }
            return expired;
        });
    }

    private LiveReportException budgetExceeded() {
        return new LiveReportException(HttpStatus.TOO_MANY_REQUESTS, "Live report session budget was exceeded");
    }

    private LiveReportCookieJar requireCookieJar(LiveReportSession session) {
        require(session.id());
        LiveReportCookieJar cookieJar = cookieJars.get(session.id());
        if (cookieJar == null) {
            throw new LiveReportException(HttpStatus.GONE, "Live report session has expired");
        }
        return cookieJar;
    }

    private String newNonce() {
        byte[] bytes = new byte[24];
        SECURE_RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private String newBridgeSecret() {
        byte[] bytes = new byte[32];
        SECURE_RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public record LiveReportSession(
            UUID id,
            long requestId,
            URI targetUri,
            String nonce,
            String bridgeSecret,
            Instant expiresAt
    ) {
    }

    private static final class SessionUsage {
        private final AtomicInteger requests = new AtomicInteger();
        private final Semaphore concurrent;
        private final AtomicLong bytes = new AtomicLong();

        private SessionUsage(int maxConcurrentRequests) {
            concurrent = new Semaphore(Math.max(1, maxConcurrentRequests), true);
        }
    }

    public static final class RequestLease implements AutoCloseable {
        private final SessionUsage usage;
        private final AtomicBoolean closed = new AtomicBoolean();

        private RequestLease(SessionUsage usage) {
            this.usage = usage;
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                usage.concurrent.release();
            }
        }
    }
}
