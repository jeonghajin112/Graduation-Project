package com.accessibility.platform.livereport;

import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LiveReportUrlSafetyValidatorTest {

    @Test
    void acceptsHttpsOnTheDefaultPortWhenEveryDnsAnswerIsPublic() throws Exception {
        LiveReportUrlSafetyValidator validator = validatorWith("93.184.216.34", "2606:4700::6810:85e5");

        LiveReportUrlSafetyValidator.ValidatedUrl result = validator.validate(
                "https://example.com:443/path?lang=ko"
        );

        assertThat(result.uri()).isEqualTo(URI.create("https://example.com:443/path?lang=ko"));
        assertThat(result.resolvedAddresses()).extracting(InetAddress::getHostAddress)
                .containsExactly("93.184.216.34", "2606:4700:0:0:0:0:6810:85e5");
    }

    @Test
    void rejectsNonHttpsCredentialsFragmentsAndNonStandardPorts() throws Exception {
        LiveReportUrlSafetyValidator validator = validatorWith("93.184.216.34");

        assertThatThrownBy(() -> validator.validate("http://example.com"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> validator.validate("file:///etc/passwd"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> validator.validate("https://user:secret@example.com"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> validator.validate("https://example.com/page#section"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> validator.validate("https://example.com:8443"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> validator.validate("/relative/path"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsAHostWhenAnyDnsAnswerIsNotPublic() throws Exception {
        LiveReportUrlSafetyValidator validator = validatorWith("93.184.216.34", "10.20.30.40");

        assertThatThrownBy(() -> validator.validate("https://rebinding.example/"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-public");
    }

    @Test
    void rejectsIpv4PrivateReservedAndDocumentationRanges() throws Exception {
        LiveReportUrlSafetyValidator validator = validatorWith("93.184.216.34");

        assertAddressesAreBlocked(validator,
                "0.0.0.0",
                "10.0.0.1",
                "100.64.0.1",
                "127.0.0.1",
                "169.254.169.254",
                "172.16.0.1",
                "192.0.0.1",
                "192.0.2.1",
                "192.88.99.1",
                "192.168.0.1",
                "198.18.0.1",
                "198.51.100.1",
                "203.0.113.1",
                "224.0.0.1",
                "255.255.255.255"
        );
    }

    @Test
    void rejectsIpv6LocalTransitionAndDocumentationRanges() throws Exception {
        LiveReportUrlSafetyValidator validator = validatorWith("93.184.216.34");

        assertAddressesAreBlocked(validator,
                "::",
                "::1",
                "::ffff:127.0.0.1",
                "64:ff9b::7f00:1",
                "100::1",
                "2001::1",
                "2001:db8::1",
                "2002:7f00:1::",
                "3fff::1",
                "fc00::1",
                "fe80::1",
                "ff02::1"
        );
    }

    @Test
    void failsClosedWhenDnsResolutionFailsOrReturnsNothing() {
        LiveReportUrlSafetyValidator unknownHostValidator = new LiveReportUrlSafetyValidator(host -> {
            throw new UnknownHostException(host);
        });
        LiveReportUrlSafetyValidator emptyAnswerValidator = new LiveReportUrlSafetyValidator(host -> List.of());
        LiveReportUrlSafetyValidator nullAnswerValidator = new LiveReportUrlSafetyValidator(host -> null);

        assertThatThrownBy(() -> unknownHostValidator.validate("https://missing.example"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("could not be resolved");
        assertThatThrownBy(() -> emptyAnswerValidator.validate("https://empty.example"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-public");
        assertThatThrownBy(() -> nullAnswerValidator.validate("https://null.example"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-public");
    }

    @Test
    void revalidatingAUrlDetectsAChangedDnsAnswer() throws Exception {
        Deque<List<InetAddress>> answers = new ArrayDeque<>();
        answers.add(addresses("93.184.216.34"));
        answers.add(addresses("127.0.0.1"));
        LiveReportUrlSafetyValidator validator = new LiveReportUrlSafetyValidator(host -> answers.removeFirst());

        assertThat(validator.validate("https://changes.example").resolvedAddresses()).hasSize(1);
        assertThatThrownBy(() -> validator.validate("https://changes.example"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-public");
    }

    @Test
    void redirectTargetsMustPassTheSameValidation() throws Exception {
        LiveReportUrlSafetyValidator validator = new LiveReportUrlSafetyValidator(host -> switch (host) {
            case "public.example" -> addresses("93.184.216.34");
            case "internal.example" -> addresses("169.254.169.254");
            default -> throw new UnknownHostException(host);
        });
        URI current = validator.validate("https://public.example/start").uri();

        assertThatThrownBy(() -> validator.validate(current.resolve("https://internal.example/latest")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-public");
    }

    @Test
    void returnedDnsAnswersAreImmutable() throws Exception {
        List<InetAddress> mutableAnswers = new ArrayList<>(addresses("93.184.216.34"));
        LiveReportUrlSafetyValidator validator = new LiveReportUrlSafetyValidator(host -> mutableAnswers);

        LiveReportUrlSafetyValidator.ValidatedUrl result = validator.validate("https://example.com");
        mutableAnswers.clear();

        assertThat(result.resolvedAddresses()).hasSize(1);
        assertThatThrownBy(() -> result.resolvedAddresses().clear())
                .isInstanceOf(UnsupportedOperationException.class);
    }

    private LiveReportUrlSafetyValidator validatorWith(String... addresses) throws UnknownHostException {
        List<InetAddress> resolved = addresses(addresses);
        return new LiveReportUrlSafetyValidator(host -> resolved);
    }

    private List<InetAddress> addresses(String... values) throws UnknownHostException {
        List<InetAddress> result = new ArrayList<>();
        for (String value : values) {
            result.add(InetAddress.getByName(value));
        }
        return result;
    }

    private void assertAddressesAreBlocked(
            LiveReportUrlSafetyValidator validator,
            String... values
    ) throws Exception {
        for (String value : values) {
            assertThat(validator.isPublicAddress(InetAddress.getByName(value)))
                    .as("%s must be blocked", value)
                    .isFalse();
        }
    }
}
