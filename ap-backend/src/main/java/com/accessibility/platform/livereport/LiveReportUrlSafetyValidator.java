package com.accessibility.platform.livereport;

import org.springframework.stereotype.Component;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.List;

/**
 * Validates every URL that the live report gateway is about to request.
 *
 * <p>The validation result includes the DNS answers observed during the check.
 * Callers must not treat this class as DNS pinning: a transport that resolves the
 * host again can still race this check. The gateway must either connect to one of
 * {@link ValidatedUrl#resolvedAddresses()} or enforce the same address policy at
 * the browser/container egress boundary.</p>
 */
@Component
public class LiveReportUrlSafetyValidator {

    private final HostResolver hostResolver;

    public LiveReportUrlSafetyValidator() {
        this(host -> Arrays.asList(InetAddress.getAllByName(host)));
    }

    LiveReportUrlSafetyValidator(HostResolver hostResolver) {
        this.hostResolver = hostResolver;
    }

    public ValidatedUrl validate(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) {
            throw unsafe("URL is required");
        }

        try {
            return validate(new URI(rawUrl.trim()));
        } catch (URISyntaxException exception) {
            throw unsafe("URL is malformed");
        }
    }

    /**
     * Applies the complete policy to an initial URL or a resolved redirect URL.
     * Redirect handlers must call this method for every Location hop.
     */
    public ValidatedUrl validate(URI uri) {
        if (uri == null || !uri.isAbsolute()) {
            throw unsafe("URL must be absolute");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            throw unsafe("Only HTTPS URLs are allowed");
        }
        if (uri.getRawUserInfo() != null) {
            throw unsafe("URL credentials are not allowed");
        }
        if (uri.getRawFragment() != null) {
            throw unsafe("URL fragments are not allowed");
        }
        if (uri.getPort() != -1 && uri.getPort() != 443) {
            throw unsafe("Only the default HTTPS port is allowed");
        }

        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw unsafe("URL host is required");
        }

        String resolverHost = stripIpv6Brackets(host);
        List<InetAddress> resolvedAddresses;
        try {
            List<InetAddress> answers = hostResolver.resolve(resolverHost);
            resolvedAddresses = answers == null ? List.of() : List.copyOf(answers);
        } catch (UnknownHostException exception) {
            throw unsafe("URL host could not be resolved");
        }

        if (resolvedAddresses.isEmpty() || resolvedAddresses.stream().anyMatch(address -> !isPublicAddress(address))) {
            throw unsafe("URL host resolves to a non-public address");
        }

        return new ValidatedUrl(uri, resolvedAddresses);
    }

    boolean isPublicAddress(InetAddress address) {
        if (address == null
                || address.isAnyLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return false;
        }

        byte[] bytes = address.getAddress();
        if (address instanceof Inet4Address) {
            return isPublicIpv4(bytes);
        }
        if (address instanceof Inet6Address) {
            return isPublicIpv6(bytes);
        }
        return false;
    }

    private boolean isPublicIpv4(byte[] bytes) {
        int first = unsigned(bytes[0]);
        int second = unsigned(bytes[1]);
        int third = unsigned(bytes[2]);

        return first != 0
                && first != 10
                && first != 127
                && !(first == 100 && second >= 64 && second <= 127)
                && !(first == 169 && second == 254)
                && !(first == 172 && second >= 16 && second <= 31)
                && !(first == 192 && second == 0 && third == 0)
                && !(first == 192 && second == 0 && third == 2)
                && !(first == 192 && second == 88 && third == 99)
                && !(first == 192 && second == 168)
                && !(first == 198 && (second == 18 || second == 19))
                && !(first == 198 && second == 51 && third == 100)
                && !(first == 203 && second == 0 && third == 113)
                && first < 224;
    }

    private boolean isPublicIpv6(byte[] bytes) {
        // Current globally routable unicast space is 2000::/3. Keeping the
        // allow-list narrow also blocks IPv4-compatible/NAT64 addresses that
        // could otherwise tunnel a request to an IPv4 private address.
        if ((unsigned(bytes[0]) & 0xe0) != 0x20) {
            return false;
        }

        // IETF protocol assignments and transition mechanisms (2001::/23),
        // documentation (2001:db8::/32 and 3fff::/20), and 6to4 (2002::/16)
        // must not be used as live report destinations.
        return !(unsigned(bytes[0]) == 0x20
                    && unsigned(bytes[1]) == 0x01
                    && (unsigned(bytes[2]) & 0xfe) == 0)
                && !(unsigned(bytes[0]) == 0x20
                    && unsigned(bytes[1]) == 0x01
                    && unsigned(bytes[2]) == 0x0d
                    && unsigned(bytes[3]) == 0xb8)
                && !(unsigned(bytes[0]) == 0x20 && unsigned(bytes[1]) == 0x02)
                && !(unsigned(bytes[0]) == 0x3f
                    && unsigned(bytes[1]) == 0xff
                    && (unsigned(bytes[2]) & 0xf0) == 0);
    }

    private int unsigned(byte value) {
        return Byte.toUnsignedInt(value);
    }

    private String stripIpv6Brackets(String host) {
        if (host.length() >= 2 && host.charAt(0) == '[' && host.charAt(host.length() - 1) == ']') {
            return host.substring(1, host.length() - 1);
        }
        return host;
    }

    private IllegalArgumentException unsafe(String message) {
        return new IllegalArgumentException(message);
    }

    @FunctionalInterface
    interface HostResolver {
        List<InetAddress> resolve(String host) throws UnknownHostException;
    }

    public record ValidatedUrl(URI uri, List<InetAddress> resolvedAddresses) {
        public ValidatedUrl {
            resolvedAddresses = List.copyOf(resolvedAddresses);
        }
    }
}
