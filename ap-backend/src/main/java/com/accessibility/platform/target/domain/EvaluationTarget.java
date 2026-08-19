package com.accessibility.platform.target.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import com.accessibility.platform.organization.domain.Organization;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Getter
@Entity
@Table(name = "evaluation_target")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class EvaluationTarget extends BaseTimeEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "organization_id", nullable = false)
    private Organization organization;

    @Column(nullable = false, length = 100)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 30)
    private TargetType targetType;

    @Column(nullable = false, length = 500)
    private String accessUrl;

    @Column(length = 1000)
    private String faviconUrl;

    @Column(length = 1000)
    private String description;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private TargetStatus status;

    public EvaluationTarget(Organization organization, String name, TargetType targetType, String accessUrl, String description) {
        this(organization, name, targetType, accessUrl, description, null);
    }

    public EvaluationTarget(
            Organization organization,
            String name,
            TargetType targetType,
            String accessUrl,
            String description,
            String faviconUrl
    ) {
        this.organization = organization;
        this.name = name;
        this.targetType = targetType;
        this.accessUrl = accessUrl;
        this.description = description;
        this.faviconUrl = faviconUrl;
        this.status = TargetStatus.ACTIVE;
    }

    public void update(String name, TargetType targetType, String accessUrl, String description, String faviconUrl) {
        this.name = name;
        this.targetType = targetType;
        this.accessUrl = accessUrl;
        this.description = description;
        this.faviconUrl = faviconUrl;
    }

    public void updateFaviconUrl(String faviconUrl) {
        this.faviconUrl = faviconUrl;
    }

    public void deactivate() {
        this.status = TargetStatus.INACTIVE;
    }

    public void markDeleted() {
        this.status = TargetStatus.DELETED;
    }
}
