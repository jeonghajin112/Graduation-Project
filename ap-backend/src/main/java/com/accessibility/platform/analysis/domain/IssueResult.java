package com.accessibility.platform.analysis.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

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
    }

    public void reclassify(String issueCode, String issueTitle) {
        if (issueCode == null || issueCode.isBlank() || issueTitle == null || issueTitle.isBlank()) {
            throw new IllegalArgumentException("Issue classification must include a code and title");
        }
        this.issueCode = issueCode;
        this.issueTitle = issueTitle;
    }

    public IssueLocator getLocator() {
        boolean hasLocator = locatorKind != null
                || (locatorPathSteps != null && !locatorPathSteps.isEmpty())
                || locatorX != null
                || locatorY != null
                || locatorWidth != null
                || locatorHeight != null
                || locatorCoordinateSpace != null
                || locatorVisible != null
                || locatorHtmlSnippet != null;
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
                locatorHtmlSnippet
        );
    }
}
