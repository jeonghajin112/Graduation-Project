package com.accessibility.platform.integration.service;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LegacyIssueStandardClassifierTest {

    @Test
    void classifiesLegacyFlagsWithoutInventingKwcagForReadingLevel() {
        String message = """
                text=복잡한 안내
                flags=["어려운 어휘 과다", "위치 참조", "link 텍스트 길이 과다"]
                suggestions=
                """;

        assertThat(LegacyIssueStandardClassifier.classifyTextMessage(message))
                .extracting(LegacyIssueStandardClassifier.Criterion::code)
                .containsExactly("WCAG 3.1.5", "5.3.3", "6.4.3");
    }

    @Test
    void leavesUnrecognisedLegacyPayloadUnclassified() {
        assertThat(LegacyIssueStandardClassifier.classifyTextMessage("text=unknown"))
                .isEmpty();
    }
}
