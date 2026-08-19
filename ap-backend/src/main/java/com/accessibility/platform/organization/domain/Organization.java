package com.accessibility.platform.organization.domain;

import com.accessibility.platform.common.entity.BaseTimeEntity;
import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

@Getter
@Entity
@Table(name = "organization")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Organization extends BaseTimeEntity {

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

    public Organization(String name, OrganizationType type, String homepageUrl, String description) {
        this.name = name;
        this.type = type;
        this.homepageUrl = homepageUrl;
        this.description = description;
        this.status = OrganizationStatus.ACTIVE;
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
}
