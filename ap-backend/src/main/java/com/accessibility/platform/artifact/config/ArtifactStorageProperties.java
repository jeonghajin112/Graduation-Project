package com.accessibility.platform.artifact.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Getter
@Setter
@Component
@ConfigurationProperties(prefix = "accessibility.artifacts")
public class ArtifactStorageProperties {
    private String directory = "./data/artifacts";
    private long maxFileSizeBytes = 20L * 1024L * 1024L;
}
