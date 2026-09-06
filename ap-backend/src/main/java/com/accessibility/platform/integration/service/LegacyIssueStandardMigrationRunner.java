package com.accessibility.platform.integration.service;

import com.accessibility.platform.analysis.domain.AnalyzerType;
import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.analysis.repository.IssueResultRepository;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Component
@RequiredArgsConstructor
public class LegacyIssueStandardMigrationRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(LegacyIssueStandardMigrationRunner.class);
    private static final String LEGACY_TEXT_CODE = "TEXT_DIFFICULTY";
    private static final String LEGACY_CV_CODE = "5.3.3";

    private final IssueResultRepository issueResultRepository;

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        int migrated = 0;
        int split = 0;
        for (IssueResult issue : issueResultRepository.findStandardMigrationCandidates(
                LEGACY_TEXT_CODE,
                AnalyzerType.CV_VISION,
                LEGACY_CV_CODE
        )) {
            if (issue.getAnalysisResult().getAnalyzerType() == AnalyzerType.CV_VISION) {
                issue.reclassify("5.4.3", "텍스트 콘텐츠의 명도 대비");
                migrated++;
                continue;
            }

            List<LegacyIssueStandardClassifier.Criterion> criteria =
                    LegacyIssueStandardClassifier.classifyTextMessage(issue.getMessage());
            if (criteria.isEmpty()) {
                continue;
            }

            LegacyIssueStandardClassifier.Criterion first = criteria.getFirst();
            issue.reclassify(first.code(), first.title());
            migrated++;

            for (LegacyIssueStandardClassifier.Criterion criterion : criteria.subList(1, criteria.size())) {
                IssueResult additional = new IssueResult(
                        issue.getAnalysisResult(),
                        criterion.code(),
                        criterion.title(),
                        issue.getSeverity(),
                        issue.getLocationPath(),
                        issue.getMessage()
                );
                additional.applyLocator(issue.getLocator());
                issueResultRepository.save(additional);
                split++;
            }
        }

        if (migrated > 0 || split > 0) {
            log.info("Migrated {} legacy issue classification(s) and created {} split criterion record(s)", migrated, split);
        }
    }
}
