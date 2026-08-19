package com.accessibility.platform.artifact.service;

import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class ArtifactBridgeMigrationRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(ArtifactBridgeMigrationRunner.class);

    private final EvaluationArtifactService artifactService;

    @Override
    public void run(ApplicationArguments args) {
        int refreshed = 0;
        for (Long artifactId : artifactService.findStoredReplayBridgeRefreshCandidates()) {
            try {
                if (artifactService.refreshStoredReplayBridge(artifactId)) {
                    refreshed++;
                }
            } catch (RuntimeException exception) {
                log.warn("Stored replay artifact {} could not be upgraded and will remain unavailable", artifactId, exception);
            }
        }
        if (refreshed > 0) {
            log.info("Refreshed replay bridge in {} stored artifact(s)", refreshed);
        }
    }
}
