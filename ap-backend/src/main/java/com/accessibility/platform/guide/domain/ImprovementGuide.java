package com.accessibility.platform.guide.domain;

import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.common.entity.BaseTimeEntity;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Getter
@Entity
@Table(name = "improvement_guide")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class ImprovementGuide extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "issue_result_id", nullable = false, unique = true)
    private IssueResult issueResult;

    @Column(nullable = false, length = 500)
    private String guideTitle;

    @Lob
    @Column(nullable = false)
    private String content;

    @Column(length = 500)
    private String referenceUrl;

    public ImprovementGuide(IssueResult issueResult, String guideTitle, String content, String referenceUrl) {
        this.issueResult = issueResult;
        this.guideTitle = guideTitle;
        this.content = content;
        this.referenceUrl = referenceUrl;
    }
}
