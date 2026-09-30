package com.accessibility.platform.analysis.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

@Getter
@Entity
@Table(
        name = "issue_result",
        indexes = @Index(
                name = "idx_issue_result_analysis_severity_code",
                columnList = "analysis_result_id,severity,issue_code"
        )
)
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class IssueResult extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "analysis_result_id", nullable = false)
    private AnalysisResult analysisResult;

    @Column(nullable = false, length = 100)
    private String issueCode;

    @Column(nullable = false, length = 200)
    private String issueTitle;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private Severity severity;

    @Column(length = 500)
    private String locationPath;

    @Lob
    private String message;

    @Column(length = 100)
    private String ruleId;

    @Column(nullable = false)
    private boolean resolved;

    @Column(length = 40)
    private String locatorKind;

    @Lob
    @Convert(converter = IssueLocatorPathStepsConverter.class)
    private List<IssueLocatorPathStep> locatorPathSteps;

    private Double locatorX;
    private Double locatorY;
    private Double locatorWidth;
    private Double locatorHeight;

    @Column(length = 40)
    private String locatorCoordinateSpace;

    private Boolean locatorVisible;

    @Lob
    private String locatorHtmlSnippet;

    @Column(name = "locator_carousel_id")
    private Integer locatorCarouselId;

    @Column(name = "locator_carousel_slide_index")
    private Integer locatorCarouselSlideIndex;

    @Column(name = "locator_carousel_slide_count")
    private Integer locatorCarouselSlideCount;

    @Column(length = 20)
    private String exclusionReason;

    @Column(name = "locator_content_text", length = IssueLocatorContent.MAX_TEXT_LENGTH)
    private String locatorContentText;

    @Column(name = "locator_content_image", length = IssueLocatorContent.MAX_IMAGE_LENGTH)
    private String locatorContentImage;

    public IssueResult(AnalysisResult analysisResult, String issueCode, String issueTitle, Severity severity, String locationPath, String message) {
        this.analysisResult = analysisResult;
        this.issueCode = issueCode;
        this.issueTitle = issueTitle;
        this.severity = severity;
        this.locationPath = locationPath;
        this.message = message;
        this.resolved = false;
        this.locatorPathSteps = new ArrayList<>();
    }

    /**
     * Reasons a finding is reported but kept out of scores and issue counts:
     * AD (advertising region), DYNAMIC (content that changed between two loads)
     * and POPUP (a layer popup that covered the page and was closed before the
     * page was analyzed).
     */
    public static final Set<String> EXCLUSION_REASONS = Set.of("AD", "DYNAMIC", "POPUP");

    public static boolean isExclusionReason(String reason) {
        return reason != null && EXCLUSION_REASONS.contains(reason);
    }

    public void applyExclusion(String reason) {
        this.exclusionReason = isExclusionReason(reason) ? reason : null;
    }

    public void applyRuleId(String ruleId) {
        this.ruleId = ruleId != null && ruleId.matches("[a-z0-9][a-z0-9-]{0,99}") ? ruleId : null;
    }

    public void applyLocator(IssueLocator locator) {
        if (locator == null) {
            return;
        }
        this.locatorKind = locator.kind();
        this.locatorPathSteps = new ArrayList<>(locator.pathSteps());
        this.locatorX = locator.x();
        this.locatorY = locator.y();
        this.locatorWidth = locator.width();
        this.locatorHeight = locator.height();
        this.locatorCoordinateSpace = locator.coordinateSpace();
        this.locatorVisible = locator.visible();
        this.locatorHtmlSnippet = locator.htmlSnippet();
        IssueLocatorCarouselContext carouselContext = locator.carouselContext();
        this.locatorCarouselId = carouselContext == null ? null : carouselContext.carouselId();
        this.locatorCarouselSlideIndex = carouselContext == null ? null : carouselContext.slideIndex();
        this.locatorCarouselSlideCount = carouselContext == null ? null : carouselContext.slideCount();
        IssueLocatorContent content = locator.content();
        this.locatorContentText = content == null ? null : content.text();
        this.locatorContentImage = content == null ? null : content.image();
    }

    public void reclassify(String issueCode, String issueTitle) {
        if (issueCode == null || issueCode.isBlank() || issueTitle == null || issueTitle.isBlank()) {
            throw new IllegalArgumentException("Issue classification must include a code and title");
        }
        this.issueCode = issueCode;
        this.issueTitle = issueTitle;
    }

    public IssueLocator getLocator() {
        IssueLocatorCarouselContext carouselContext = getCarouselContext();
        boolean hasLocator = locatorKind != null
                || (locatorPathSteps != null && !locatorPathSteps.isEmpty())
                || locatorX != null
                || locatorY != null
                || locatorWidth != null
                || locatorHeight != null
                || locatorCoordinateSpace != null
                || locatorVisible != null
                || locatorHtmlSnippet != null
                || carouselContext != null
                || locatorContentText != null;
        if (!hasLocator) {
            return null;
        }
        return new IssueLocator(
                locatorKind,
                locatorPathSteps == null ? List.of() : locatorPathSteps,
                locatorX,
                locatorY,
                locatorWidth,
                locatorHeight,
                locatorCoordinateSpace,
                locatorVisible,
                locatorHtmlSnippet,
                carouselContext,
                locatorContentText == null ? null : new IssueLocatorContent(locatorContentText, locatorContentImage)
        );
    }

    private IssueLocatorCarouselContext getCarouselContext() {
        if (locatorCarouselId == null
                || locatorCarouselSlideIndex == null
                || locatorCarouselSlideCount == null
                || !IssueLocatorCarouselContext.isValid(
                        locatorCarouselId,
                        locatorCarouselSlideIndex,
                        locatorCarouselSlideCount
                )) {
            return null;
        }
        return new IssueLocatorCarouselContext(
                locatorCarouselId,
                locatorCarouselSlideIndex,
                locatorCarouselSlideCount
        );
    }
}
