package com.accessibility.platform.analysis.domain;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class IssueLocatorPathStepsConverterTest {

    private final IssueLocatorPathStepsConverter converter = new IssueLocatorPathStepsConverter();

    @Test
    void roundTripsStructuredPathSteps() {
        List<IssueLocatorPathStep> steps = List.of(
                new IssueLocatorPathStep("document", "iframe#checkout", "https://example.com"),
                new IssueLocatorPathStep("iframe", "button.pay", "https://pay.example.com")
        );

        String json = converter.convertToDatabaseColumn(steps);

        assertThat(converter.convertToEntityAttribute(json)).containsExactlyElementsOf(steps);
    }
}
