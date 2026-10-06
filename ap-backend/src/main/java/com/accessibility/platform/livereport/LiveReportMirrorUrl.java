package com.accessibility.platform.livereport;

import org.springframework.http.HttpStatus;

import java.net.IDN;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Deque;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Encodes an upstream HTTPS URL into a path-preserving, session-bound mirror URL.
 *
 * <p>The host is a canonical base64url path segment. The upstream raw path and raw query remain
 * in their native URL positions, so browser URL resolution for scripts, modules and stylesheets
 * stays below the same live-report session prefix.</p>
 */
final class LiveReportMirrorUrl {
    private static final int MAX_UPSTREAM_URL_LENGTH = 16_384;
    private static final int MAX_RAW_PATH_LENGTH = 32_768;
    private static final int MAX_RAW_QUERY_LENGTH = 32_768;
    private static final int MAX_HOST_TOKEN_LENGTH = 512;
    private static final Pattern HOST_TOKEN = Pattern.compile("[A-Za-z0-9_-]{1," + MAX_HOST_TOKEN_LENGTH + "}");
    private static final Pattern ENCODED_DOT = Pattern.compile("(?i)%2e");

    private LiveReportMirrorUrl() {
    }

    static String sessionPrefix(UUID sessionId, String nonce) {
        return "/api/live-reports/" + sessionId + "/mirror/" + nonce + "/";
    }

    static String toRelativeUrl(UUID sessionId, String nonce, URI targetUri) {
        URI target = requireMirrorableTarget(targetUri);
        validateTargetLength(target);
        String canonicalHost = canonicalHost(target.getHost());
        String rawPath = normalizeRawPath(target.getRawPath());
        StringBuilder mirror = new StringBuilder(sessionPrefix(sessionId, nonce))
                .append(encodeHost(canonicalHost))
                .append(rawPath);
        if (target.getRawQuery() != null) {
            validateRawQuery(target.getRawQuery());
            mirror.append('?').append(target.getRawQuery());
        }
        if (target.getRawFragment() != null) {
            mirror.append('#').append(target.getRawFragment());
        }
        return mirror.toString();
    }

    static URI decodeTarget(String hostToken, String rawPath, String rawQuery) {
        String host = decodeHost(hostToken);
        String normalizedPath = normalizeRawPath(rawPath);
        validateRawQuery(rawQuery);
        String authority = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
        String value = "https://" + authority + normalizedPath
                + (rawQuery == null ? "" : "?" + rawQuery);
        URI target;
        try {
            target = URI.create(value);
        } catch (IllegalArgumentException exception) {
            throw malformed("Live report mirror path is malformed", exception);
        }
        if (!"https".equalsIgnoreCase(target.getScheme())
                || target.getRawUserInfo() != null
                || target.getPort() != -1
                || target.getRawFragment() != null
                || target.getHost() == null
                || !canonicalHost(target.getHost()).equals(host)) {
            throw malformed("Live report mirror target is invalid", null);
        }
        validateTargetLength(target);
        return target;
    }

    static DecodedMirrorRequest decodeRequestPath(
            UUID expectedSessionId,
            String expectedNonce,
            String contextPath,
            String rawRequestPath,
            String rawQuery
    ) {
        String prefix = (contextPath == null ? "" : contextPath)
                + sessionPrefix(expectedSessionId, expectedNonce);
        if (rawRequestPath == null || !rawRequestPath.startsWith(prefix)) {
            throw malformed("Live report mirror route is invalid", null);
        }
        String remainder = rawRequestPath.substring(prefix.length());
        int pathSeparator = remainder.indexOf('/');
        if (pathSeparator <= 0) {
            throw malformed("Live report mirror host is missing", null);
        }
        String hostToken = remainder.substring(0, pathSeparator);
        String upstreamRawPath = remainder.substring(pathSeparator);
        return new DecodedMirrorRequest(
                hostToken,
                decodeTarget(hostToken, upstreamRawPath, rawQuery)
        );
    }

    private static URI requireMirrorableTarget(URI target) {
        if (target == null
                || !target.isAbsolute()
                || !"https".equalsIgnoreCase(target.getScheme())
                || target.getHost() == null
                || target.getRawUserInfo() != null
                || (target.getPort() != -1 && target.getPort() != 443)) {
            throw malformed("Only credential-free HTTPS URLs can be mirrored", null);
        }
        return target;
    }

    private static String encodeHost(String canonicalHost) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(canonicalHost.getBytes(StandardCharsets.US_ASCII));
    }

    private static String decodeHost(String hostToken) {
        if (hostToken == null || !HOST_TOKEN.matcher(hostToken).matches()) {
            throw malformed("Live report mirror host token is invalid", null);
        }
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(hostToken);
        } catch (IllegalArgumentException exception) {
            throw malformed("Live report mirror host token is invalid", exception);
        }
        for (byte value : decoded) {
            if (value <= 0 || value > 0x7f) {
                throw malformed("Live report mirror host token is invalid", null);
            }
        }
        String host = canonicalHost(new String(decoded, StandardCharsets.US_ASCII));
        if (!encodeHost(host).equals(hostToken)) {
            throw malformed("Live report mirror host token is not canonical", null);
        }
        return host;
    }

    private static String canonicalHost(String rawHost) {
        if (rawHost == null || rawHost.isBlank()) {
            throw malformed("Live report mirror host is required", null);
        }
        String host = rawHost;
        if (host.length() >= 2 && host.charAt(0) == '[' && host.charAt(host.length() - 1) == ']') {
            host = host.substring(1, host.length() - 1);
        }
        if (host.indexOf(':') >= 0) {
            if (host.indexOf('%') >= 0 || !host.matches("[0-9A-Fa-f:.]+")) {
                throw malformed("Live report mirror IPv6 host is invalid", null);
            }
            return host.toLowerCase(Locale.ROOT);
        }
        try {
            String ascii = IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
            if (ascii.isBlank() || ascii.length() > 253 || ascii.contains("..")) {
                throw malformed("Live report mirror host is invalid", null);
            }
            return ascii;
        } catch (IllegalArgumentException exception) {
            throw malformed("Live report mirror host is invalid", exception);
        }
    }

    private static String normalizeRawPath(String rawPath) {
        String path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
        if (path.length() > MAX_RAW_PATH_LENGTH
                || path.charAt(0) != '/'
                || path.indexOf('\\') >= 0
                || containsControl(path)
                || path.indexOf('?') >= 0
                || path.indexOf('#') >= 0) {
            throw malformed("Live report mirror path is invalid", null);
        }

        String[] segments = path.substring(1).split("/", -1);
        Deque<String> normalized = new ArrayDeque<>();
        for (int index = 0; index < segments.length; index++) {
            String segment = segments[index];
            boolean terminal = index == segments.length - 1;
            String dotsDecoded = ENCODED_DOT.matcher(segment).replaceAll(".");
            if (dotsDecoded.equals(".")) {
                if (terminal) {
                    normalized.addLast("");
                }
                continue;
            }
            if (dotsDecoded.equals("..")) {
                if (!normalized.isEmpty()) {
                    normalized.removeLast();
                }
                if (terminal) {
                    normalized.addLast("");
                }
                continue;
            }
            // Empty segments are meaningful on some origins (/a//b is not necessarily /a/b).
            // Keep them while still resolving dot segments so the mirror is path-preserving.
            normalized.addLast(segment);
        }
        return "/" + String.join("/", normalized);
    }

    private static void validateRawQuery(String rawQuery) {
        if (rawQuery != null && (rawQuery.length() > MAX_RAW_QUERY_LENGTH
                || containsControl(rawQuery)
                || rawQuery.indexOf('#') >= 0)) {
            throw malformed("Live report mirror query is invalid", null);
        }
    }

    private static void validateTargetLength(URI target) {
        if (target.toASCIIString().length() > MAX_UPSTREAM_URL_LENGTH) {
            throw malformed("Live report mirror URL is too long", null);
        }
    }

    private static boolean containsControl(String value) {
        return value.chars().anyMatch(character -> character < 0x20 || character == 0x7f);
    }

    private static LiveReportException malformed(String message, Throwable cause) {
        return cause == null
                ? new LiveReportException(HttpStatus.BAD_REQUEST, message)
                : new LiveReportException(HttpStatus.BAD_REQUEST, message, cause);
    }

    record DecodedMirrorRequest(String hostToken, URI targetUri) {
    }
}
