package com.accessibility.platform.integration.service;

import com.accessibility.platform.organization.domain.Organization;
import com.accessibility.platform.organization.domain.OrganizationType;
import com.accessibility.platform.organization.repository.OrganizationRepository;
import com.accessibility.platform.score.repository.ScoreResultRepository;
import com.accessibility.platform.target.domain.EvaluationTarget;
import com.accessibility.platform.target.domain.TargetType;
import com.accessibility.platform.target.repository.EvaluationTargetRepository;
import com.accessibility.platform.target.service.FaviconService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:h2:mem:analysis-callback-test;DB_CLOSE_DELAY=-1",
        "server.address=127.0.0.1",
        "server.servlet.context-path=/callback-test",
        "accessibility.ai.api-base-url=",
        "API_BASE_URL="
})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AiEvaluationCallbackIntegrationTest {
    @Autowired Environment environment;
    @Autowired OrganizationRepository organizationRepository;
    @Autowired EvaluationTargetRepository targetRepository;
    @Autowired ScoreResultRepository scoreResultRepository;
    @MockitoSpyBean AiEvaluationRunnerService runner;
    @MockitoBean FaviconService faviconService;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    void quickAndProjectAnalysisSaveResultsUsingTheChildProcessCallbackAddress() throws Exception {
        // Exercise real HTTP controllers and persistence without launching paid
        // analyzers or visiting an external website in the regression test.
        doNothing().when(runner).runEvaluationAsync(anyLong(), anyString());
        when(faviconService.findFaviconUrl(anyString())).thenReturn(Optional.empty());
        Organization organization = organizationRepository.save(new Organization(
                "Callback regression", OrganizationType.ETC, null, null));
        String targetUrl = "https://example.test/callback";
        EvaluationTarget target = targetRepository.save(new EvaluationTarget(
                organization, "Callback target", TargetType.WEB, targetUrl, null,
                "https://example.test/favicon.ico"));

        int port = environment.getRequiredProperty("local.server.port", Integer.class);
        String origin = "http://127.0.0.1:" + port + "/callback-test";
        String callback = runner.createAnalysisProcess(List.of("unused"), new File("."))
                .environment().get("API_BASE_URL");
        assertThat(callback).isEqualTo(origin + "/api/v1");

        try (HttpClient client = HttpClient.newHttpClient()) {
            for (boolean quickAnalysis : List.of(true, false)) {
                String requestedUrl = quickAnalysis ? targetUrl + "/new-page" : targetUrl;
                String endpoint = quickAnalysis ? "/api/requests/evaluate" : "/api/requests";
                String payload = quickAnalysis ? "{\"url\":\"" + requestedUrl + "\"}"
                        : "{\"evaluationTargetId\":" + target.getId() + ",\"requestNote\":\"test\"}";
                JsonNode created = post(client, origin + endpoint, payload);
                assertThat(created.path("success").asBoolean()).isTrue();
                long requestId = created.path("data").path("id").asLong();
                assertThat(requestId).isPositive();
                verify(runner).runEvaluationAsync(requestId, requestedUrl);

                post(client, callback + "/evaluations", """
                        {"url":"%s","request_id":%d,"total_score":88,
                         "score_breakdown":{"module_scores":{"rule_based":88}}}
                        """.formatted(requestedUrl, requestId));

                HttpResponse<String> response = client.send(HttpRequest.newBuilder(
                        URI.create(origin + "/api/requests/" + requestId))
                        .timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);
                assertThat(json.readTree(response.body()).path("data").path("status").asText())
                        .isEqualTo("COMPLETED");
                assertThat(scoreResultRepository.findByEvaluationRequestId(requestId)).isPresent();
            }
        }
    }

    private JsonNode post(HttpClient client, String url, String payload) throws Exception {
        HttpResponse<String> response = client.send(HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return json.readTree(response.body());
    }
}
