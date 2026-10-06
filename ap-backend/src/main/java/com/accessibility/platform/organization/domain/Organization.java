package com.accessibility.platform.organization.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Getter
@Entity
@Table(
        name = "organization",
        indexes = @Index(name = "idx_organization_status", columnList = "status")
)
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Organization extends BaseTimeEntity {

    public static final String IMPORTED_NAME = "AI Module Imported";
    private static final String IMPORTED_DESCRIPTION = "AI-module imported evaluation results";

    @Column(nullable = false, columnDefinition = "boolean default false")
    private boolean systemManaged;

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 100)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 30)
    private OrganizationType type;

    @Column(length = 255)
    private String homepageUrl;

    @Column(length = 500)
    private String description;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private OrganizationStatus status;

    @Column(name = "creation_idempotency_key", length = 36, unique = true, updatable = false)
    private String creationIdempotencyKey;

    @Column(name = "creation_request_hash", length = 64, updatable = false)
    private String creationRequestHash;

    public Organization(String name, OrganizationType type, String homepageUrl, String description) {
        this(name, type, homepageUrl, description, null, null);
    }

    public Organization(String name, OrganizationType type, String homepageUrl, String description,
                        String creationIdempotencyKey, String creationRequestHash) {
        this.name = name;
        this.type = type;
        this.homepageUrl = homepageUrl;
        this.description = description;
        this.status = OrganizationStatus.ACTIVE;
        this.creationIdempotencyKey = creationIdempotencyKey;
        this.creationRequestHash = creationRequestHash;
    }

    public void update(String name, OrganizationType type, String homepageUrl, String description) {
        this.name = name;
        this.type = type;
        this.homepageUrl = homepageUrl;
        this.description = description;
    }

    public void deactivate() {
        this.status = OrganizationStatus.INACTIVE;
    }

    public static Organization importedResults() {
        Organization organization = new Organization(IMPORTED_NAME, OrganizationType.ETC, null, IMPORTED_DESCRIPTION);
        organization.systemManaged = true;
        return organization;
    }

    public boolean isSystemManaged() {
        // Recognize the untouched legacy import bucket. A renamed bucket is a
        // user project and must keep its pages and project controls.
        return systemManaged || (IMPORTED_NAME.equals(name)
                && IMPORTED_DESCRIPTION.equals(description)
                && type == OrganizationType.ETC && homepageUrl == null
                && creationIdempotencyKey == null);
    }
}
