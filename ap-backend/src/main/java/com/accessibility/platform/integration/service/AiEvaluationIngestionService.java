package com.accessibility.platform.integration.service;

import com.accessibility.platform.analysis.domain.AnalysisResult;
import com.accessibility.platform.analysis.domain.AnalysisStatus;
import com.accessibility.platform.analysis.domain.AnalyzerType;
import com.accessibility.platform.analysis.domain.IssueResult;
import com.accessibility.platform.analysis.domain.Severity;
import com.accessibility.platform.analysis.repository.AnalysisResultRepository;
import com.accessibility.platform.analysis.repository.IssueResultRepository;
import com.accessibility.platform.artifact.service.EvaluationArtifactService;
import com.accessibility.platform.integration.dto.AiEvaluationSaveResponse;
import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.request.domain.EvaluationRequest;
import com.accessibility.platform.request.domain.EvaluationRequestStatus;
import com.accessibility.platform.request.repository.EvaluationRequestRepository;
import com.accessibility.platform.score.domain.ScoreDetail;
import com.accessibility.platform.score.domain.ScoreResult;
import com.accessibility.platform.score.repository.ScoreDetailRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetStatus;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import com.accessibility.platform.target.service.FaviconService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.net.URI;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
@RequiredArgsConstructor
@Transactional
public class AiEvaluationIngestionService {

    private static final String MODULE_ORGANIZATION_NAME = "AI Module Imported";

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final OrganizationRepository organizationRepository;
    private final EvaluationTargetRepository targetRepository;
    private final EvaluationRequestRepository requestRepository;
    private final ScoreResultRepository scoreResultRepository;
    private final ScoreDetailRepository scoreDetailRepository;
    private final AnalysisResultRepository analysisResultRepository;
    private final IssueResultRepository issueResultRepository;
    private final FaviconService faviconService;
    private final AiIssueLocatorParser issueLocatorParser;
    private final EvaluationArtifactService artifactService;

    public AiEvaluationSaveResponse save(String resultJson) {
        JsonNode result = parse(resultJson);
        String url = text(result, "url", "");

        EvaluationRequest request;
        if (result.has("request_id") && !result.get("request_id").isNull() && !result.get("request_id").asText().isBlank()) {
            Long reqId = result.get("request_id").asLong();
            request = requestRepository.findById(reqId)
                    .orElseGet(() -> requestRepository.save(new EvaluationRequest(findOrCreateTarget(url), "AI-module result_final.json import")));

            // Fail closed: results and their visual evidence must always come
            // from the same run. The scanner uploads the replacement artifact
            // after this ingestion transaction commits.
            artifactService.deleteByRequestId(reqId);

            // Clean up existing results for this request ID to allow re-runs
            List<AnalysisResult> existingAnalyses = analysisResultRepository.findByEvaluationRequestId(reqId);
            for (AnalysisResult analysis : existingAnalyses) {
                List<IssueResult> issues = issueResultRepository.findByAnalysisResultId(analysis.getId());
                issueResultRepository.deleteAll(issues);
            }
            analysisResultRepository.deleteAll(existingAnalyses);

            scoreResultRepository.findByEvaluationRequestId(reqId).ifPresent(scoreResult -> {
                List<ScoreDetail> details = scoreDetailRepository.findByScoreResultId(scoreResult.getId());
                scoreDetailRepository.deleteAll(details);
                scoreResultRepository.delete(scoreResult);
            });
        } else {
            EvaluationTarget target = findOrCreateTarget(url);
            request = requestRepository.save(new EvaluationRequest(target, "AI-module result_final.json import"));
        }
        EvaluationTarget target = request.getEvaluationTarget();

        ScoreResult scoreResult = saveScore(result, request);
        saveAnalysisResults(result, request);

        request.changeStatus(EvaluationRequestStatus.COMPLETED);

        return new AiEvaluationSaveResponse(
                request.getId(),
                "saved",
                request.getId(),
                target.getId(),
                scoreResult.getTotalScore(),
                text(result, "grade", null),
                request.getStatus()
        );
    }

    private JsonNode parse(String resultJson) {
        try {
            return objectMapper.readTree(resultJson);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Invalid AI evaluation result JSON", e);
        }
    }

    private EvaluationTarget findOrCreateTarget(String url) {
        Optional<EvaluationTarget> existingTarget = targetRepository.findAllByAccessUrlOrderByIdDesc(url).stream()
                .filter(candidate -> candidate.getStatus() != TargetStatus.DELETED)
                .findFirst();

        if (existingTarget.isPresent()) {
            EvaluationTarget target = existingTarget.get();
            if (target.getFaviconUrl() == null || target.getFaviconUrl().isBlank()) {
                faviconService.findFaviconUrl(target.getAccessUrl()).ifPresent(target::updateFaviconUrl);
            }
            return target;
        }

        Organization organization = organizationRepository.findByName(MODULE_ORGANIZATION_NAME)
                .orElseGet(() -> organizationRepository.save(new Organization(
                        MODULE_ORGANIZATION_NAME,
                        OrganizationType.ETC,
                        null,
                        "AI-module imported evaluation results"
                )));

        return targetRepository.save(new EvaluationTarget(
                organization,
                targetName(url),
                TargetType.WEB,
                url,
                "Created automatically from AI-module result_final.json",
                faviconService.findFaviconUrl(url).orElse(null)
        ));
    }

    private ScoreResult saveScore(JsonNode result, EvaluationRequest request) {
        JsonNode moduleScores = result.path("score_breakdown").path("module_scores");

        ScoreResult scoreResult = scoreResultRepository.save(new ScoreResult(
                request,
                decimal(result, "total_score"),
                decimal(moduleScores, "rule_based"),
                decimal(moduleScores, "difficulty"),
                decimal(moduleScores, "cv")
        ));

        List<ScoreDetail> details = new ArrayList<>();
        details.add(new ScoreDetail(scoreResult, "rule_based", decimal(moduleScores, "rule_based"), BigDecimal.valueOf(100), "KWCAG rule-based analyzer score"));
        details.add(new ScoreDetail(scoreResult, "difficulty", decimal(moduleScores, "difficulty"), BigDecimal.valueOf(100), "Text difficulty accessibility score"));
        details.add(new ScoreDetail(scoreResult, "cv", decimal(moduleScores, "cv"), BigDecimal.valueOf(100), "Visual contrast pass-rate score"));
        scoreDetailRepository.saveAll(details);

        return scoreResult;
    }

    private void saveAnalysisResults(JsonNode result, EvaluationRequest request) {
        JsonNode modules = result.path("modules");
        saveRuleBasedAnalysis(modules.path("rule_based"), request, analyzedAt(result));
        saveTextAnalysis(modules.path("text_difficulty"), modules.path("text_suggestions"), request, analyzedAt(result));
        saveCvAnalysis(modules.path("cv_visual"), request, analyzedAt(result));
    }

    private void saveRuleBasedAnalysis(JsonNode module, EvaluationRequest request, LocalDateTime completedAt) {
        AnalysisResult analysis = analysisResultRepository.save(new AnalysisResult(
                request,
                AnalyzerType.RULE_BASED,
                status(module),
                "violations=" + module.path("summary").path("total_violations").asInt(0)
                        + ", passes=" + module.path("summary").path("total_passes").asInt(0),
                null,
                completedAt
        ));

        List<IssueResult> issues = new ArrayList<>();
        for (JsonNode violation : module.path("violations")) {
            String code = text(violation, "kwcag_id", "RULE_BASED");
            String title = text(violation, "kwcag_name", "Rule-based accessibility issue");
            Severity severity = ruleSeverity(text(violation, "severity", "minor"));
            for (JsonNode rule : violation.path("rules")) {
                for (JsonNode node : rule.path("nodes")) {
                    IssueResult issue = new IssueResult(
                            analysis,
                            code,
                            title,
                            severity,
                            text(node, "selector", null),
                            text(rule, "help", "") + "\n" + text(node, "failure_summary", "")
                    );
                    issue.applyLocator(issueLocatorParser.fromRuleNode(node));
                    issues.add(issue);
                }
            }
        }
        issueResultRepository.saveAll(issues);
    }

    private void saveTextAnalysis(JsonNode difficulty, JsonNode suggestions, EvaluationRequest request, LocalDateTime completedAt) {
        JsonNode meta = difficulty.path("meta");
        AnalysisResult analysis = analysisResultRepository.save(new AnalysisResult(
                request,
                AnalyzerType.AI_TEXT,
                status(difficulty),
                "page_score=" + meta.path("page_score").asText("0")
                        + ", flagged=" + meta.path("flagged_count").asInt(0)
                        + ", suggestion_needed=" + meta.path("suggestion_needed").asInt(0),
                null,
                completedAt
        ));

        List<IssueResult> issues = new ArrayList<>();
        JsonNode results = suggestions.path("results").isArray() ? suggestions.path("results") : difficulty.path("results");
        for (JsonNode block : results) {
            if (!block.path("needs_suggestion").asBoolean(false) && block.path("flags").isEmpty()) {
                continue;
            }

            String message = buildTextIssueMessage(block);
            List<TextCriterion> criteria = textCriteria(block);

            // Compatibility for external/legacy engine payloads that do not
            // yet expose standard_issues. Do not invent a KWCAG number.
            if (criteria.isEmpty()) {
                criteria = List.of(new TextCriterion(
                        "TEXT_DIFFICULTY",
                        "분류되지 않은 텍스트 접근성 이슈",
                        null
                ));
            }

            for (TextCriterion criterion : criteria) {
                IssueResult issue = new IssueResult(
                        analysis,
                        criterion.code(),
                        criterion.title(),
                        textSeverity(criterion.priority(), block),
                        text(block, "selector", null),
                        message
                );
                issue.applyLocator(issueLocatorParser.fromTextBlock(block));
                issues.add(issue);
            }
        }
        issueResultRepository.saveAll(issues);
    }

    private void saveCvAnalysis(JsonNode module, EvaluationRequest request, LocalDateTime completedAt) {
        JsonNode summary = module.path("summary");
        AnalysisResult analysis = analysisResultRepository.save(new AnalysisResult(
                request,
                AnalyzerType.CV_VISION,
                status(module),
                "pass_rate=" + summary.path("pass_rate").asText("0")
                        + ", fail_count=" + summary.path("fail_count").asInt(0),
                null,
                completedAt
        ));

        List<IssueResult> issues = new ArrayList<>();
        for (JsonNode violation : module.path("violations")) {
            IssueResult issue = new IssueResult(
                    analysis,
                    module.path("kwcag_item").path("id").asText("5.4.3"),
                    module.path("kwcag_item").path("name").asText("텍스트 콘텐츠의 명도 대비"),
                    cvSeverity(violation.path("contrast_ratio").asDouble(0), violation.path("required_ratio").asDouble(4.5)),
                    locationPath(violation.path("location")),
                    "text=" + text(violation, "text", "")
                            + ", contrast=" + text(violation, "contrast_display", "")
                            + ", required=" + violation.path("required_ratio").asText("")
            );
            issue.applyLocator(issueLocatorParser.fromCvViolation(violation));
            issues.add(issue);
        }
        issueResultRepository.saveAll(issues);
    }

    private String buildTextIssueMessage(JsonNode block) {
        StringBuilder message = new StringBuilder();
        message.append("text=").append(text(block, "text", ""));
        message.append("\nflags=").append(block.path("flags"));
        if (block.path("suggestions").isArray()) {
            message.append("\nsuggestions=");
            for (JsonNode suggestion : block.path("suggestions")) {
                message.append(text(suggestion, "guide", "")).append(" ");
            }
        }
        if (!block.path("llm_revision").isMissingNode() && !block.path("llm_revision").isNull()) {
            message.append("\nllm_revision=").append(block.path("llm_revision"));
        }
        return message.toString();
    }

    private AnalysisStatus status(JsonNode module) {
        return "failed".equalsIgnoreCase(text(module, "status", "")) ? AnalysisStatus.FAILED : AnalysisStatus.SUCCESS;
    }

    private Severity ruleSeverity(String severity) {
        return switch (severity.toLowerCase()) {
            case "critical" -> Severity.CRITICAL;
            case "major", "serious" -> Severity.HIGH;
            case "minor" -> Severity.LOW;
            default -> Severity.MEDIUM;
        };
    }

    private List<TextCriterion> textCriteria(JsonNode block) {
        JsonNode standardIssues = block.path("standard_issues");
        if (!standardIssues.isArray()) {
            return List.of();
        }

        Map<String, TextCriterion> criteria = new LinkedHashMap<>();
        for (JsonNode standardIssue : standardIssues) {
            String priority = text(standardIssue, "priority", null);
            JsonNode kwcagItems = standardIssue.path("kwcag_items");
            if (kwcagItems.isArray() && !kwcagItems.isEmpty()) {
                for (JsonNode item : kwcagItems) {
                    String code = text(item, "id", null);
                    if (code != null && !code.isBlank()) {
                        mergeTextCriterion(criteria, new TextCriterion(
                                code,
                                text(item, "name", "KWCAG " + code),
                                priority
                        ));
                    }
                }
                continue;
            }

            JsonNode wcag = standardIssue.path("wcag");
            String wcagId = text(wcag, "id", null);
            if (wcagId != null && !wcagId.isBlank()) {
                String code = "WCAG " + wcagId;
                mergeTextCriterion(criteria, new TextCriterion(
                        code,
                        text(wcag, "name", "WCAG " + wcagId),
                        priority
                ));
            }
        }
        return List.copyOf(criteria.values());
    }

    private void mergeTextCriterion(Map<String, TextCriterion> criteria, TextCriterion candidate) {
        criteria.merge(candidate.code(), candidate, (existing, incoming) ->
                textPriorityRank(incoming.priority()) > textPriorityRank(existing.priority())
                        ? incoming
                        : existing
        );
    }

    private int textPriorityRank(String priority) {
        if (priority == null) {
            return 0;
        }
        return switch (priority.toLowerCase()) {
            case "high" -> 3;
            case "medium" -> 2;
            case "low" -> 1;
            default -> 0;
        };
    }

    private Severity textSeverity(String priority, JsonNode block) {
        if (priority != null) {
            return switch (priority.toLowerCase()) {
                case "high" -> Severity.HIGH;
                case "medium" -> Severity.MEDIUM;
                case "low" -> Severity.LOW;
                default -> textSeverity(block);
            };
        }
        return textSeverity(block);
    }

    private Severity textSeverity(JsonNode block) {
        double score = block.path("difficulty_score").asDouble(0);
        if (score >= 70) {
            return Severity.HIGH;
        }
        if (score >= 40) {
            return Severity.MEDIUM;
        }
        return Severity.LOW;
    }

    private record TextCriterion(String code, String title, String priority) {
    }

    private Severity cvSeverity(double ratio, double requiredRatio) {
        if (requiredRatio <= 0 || ratio <= 0) {
            return Severity.HIGH;
        }
        double coverage = ratio / requiredRatio;
        if (coverage < 0.5) {
            return Severity.HIGH;
        }
        if (coverage < 0.85) {
            return Severity.MEDIUM;
        }
        return Severity.LOW;
    }

    private BigDecimal decimal(JsonNode node, String fieldName) {
        return BigDecimal.valueOf(node.path(fieldName).asDouble(0));
    }

    private String text(JsonNode node, String fieldName, String defaultValue) {
        JsonNode value = node.path(fieldName);
        if (value.isMissingNode() || value.isNull()) {
            return defaultValue;
        }
        return value.asText(defaultValue);
    }

    private LocalDateTime analyzedAt(JsonNode result) {
        String analyzedAt = text(result, "analyzed_at", null);
        if (analyzedAt == null || analyzedAt.isBlank()) {
            return LocalDateTime.now();
        }
        return LocalDateTime.parse(analyzedAt);
    }

    private String targetName(String url) {
        if (url == null || url.isBlank()) {
            return "AI Module Evaluation Target";
        }
        try {
            String host = URI.create(url).getHost();
            return host == null || host.isBlank() ? url : host;
        } catch (IllegalArgumentException e) {
            return url;
        }
    }

    private String locationPath(JsonNode location) {
        if (location.isMissingNode() || location.isNull()) {
            return null;
        }
        return "x=" + location.path("x").asText("")
                + ", y=" + location.path("y").asText("")
                + ", width=" + location.path("width").asText("")
                + ", height=" + location.path("height").asText("");
    }
}
