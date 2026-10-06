package com.accessibility.platform.analysis.domain;

/**
 * What a visual-engine finding's element showed when it was analysed: its text
 * without whitespace and the path and query of its image, if any. The live
 * report shows the marker only while the element still shows this content.
 */
public record IssueLocatorContent(
        String text,
        String image
) {
    public static final int MAX_TEXT_LENGTH = 200;
    public static final int MAX_IMAGE_LENGTH = 2_048;

    public IssueLocatorContent {
        text = text == null ? "" : text;
    }
}
