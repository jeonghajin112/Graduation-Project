package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Test-only exporter used by the frontend Playwright live-report regression.
 * Keeping generation here makes the browser test execute the exact bridge
 * emitted by {@link LiveReportDocumentRewriter}, rather than parsing or copying
 * its private Java text blocks.
 */
public class LiveReportBrowserFixtureExporterTest {
    public static void main(String[] args) throws Exception {
        new LiveReportBrowserFixtureExporterTest().exportRewrittenFixture();
    }

    @Test
    void exportsRewrittenLiveReportForBrowserRegression() throws Exception {
        String outputValue = System.getenv("AP_LIVE_REPORT_FIXTURE_OUTPUT");
        assumeTrue(outputValue != null && !outputValue.isBlank());
        exportRewrittenFixture();
    }

    private void exportRewrittenFixture() throws Exception {
        String outputValue = System.getenv("AP_LIVE_REPORT_FIXTURE_OUTPUT");
        if (outputValue == null || outputValue.isBlank()) {
            throw new IllegalStateException("AP_LIVE_REPORT_FIXTURE_OUTPUT is required");
        }

        LiveReportProperties properties = new LiveReportProperties();
        LiveReportSessionService routeSessionService = org.mockito.Mockito.mock(
                LiveReportSessionService.class
        );
        LiveReportOriginRouteRegistry originRoutes = new LiveReportOriginRouteRegistry(
                routeSessionService,
                properties,
                Clock.fixed(Instant.parse("2026-09-01T12:00:00Z"), ZoneOffset.UTC)
        );
        LiveReportDocumentRewriter rewriter = new LiveReportDocumentRewriter(properties, originRoutes);
        LiveReportSessionService.LiveReportSession session = new LiveReportSessionService.LiveReportSession(
                UUID.fromString("6b2d884e-a7f4-4f09-9776-688d08fe8912"),
                7L,
                URI.create("https://www.example.com/nested/page"),
                "test-nonce",
                "test-bridge-secret",
                Instant.parse("2026-09-01T12:05:00Z")
        );
        String source = """
                <!doctype html>
                <html lang="ko">
                  <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width,initial-scale=1">
                    <title>Live report browser fixture</title>
                    <style>
                      * { box-sizing: border-box; }
                      body { margin: 0; min-height: 1200px; font: 16px/1.5 system-ui, sans-serif; }
                      main { width: 720px; padding: 56px; }
                      #group-target, #nearby-target { width: 360px; min-height: 72px; padding: 18px; border: 1px solid #ccd2dc; }
                      #nearby-target { margin-top: 5px; }
                      .actions { display: flex; gap: 12px; margin-top: 36px; }
                    </style>
                  </head>
                  <body>
                    <main>
                      <section id="group-target">같은 요소에서 세 가지 접근성 문제가 발견된 긴 텍스트입니다.</section>
                      <section id="nearby-target">인접한 요소의 마커는 앞선 마커와 겹치지 않아야 합니다.</section>
                      <div class="actions">
                        <button id="purchase" type="button" onclick="window.actionClicks += 1">구매하기</button>
                        <div class="carousel" aria-roledescription="carousel">
                          <button id="next-slide" type="button" aria-label="다음 슬라이드" onclick="window.slideClicks += 1">다음</button>
                        </div>
                      </div>
                    </main>
                    <script>
                      window.actionClicks = 0;
                      window.slideClicks = 0;
                    </script>
                  </body>
                </html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/nested/page"),
                "text/html;charset=UTF-8",
                source.getBytes(StandardCharsets.UTF_8)
        );

        byte[] rewritten = rewriter.rewriteHtml(resource, session);
        Path output = Path.of(outputValue).toAbsolutePath().normalize();
        if (output.getParent() != null) {
            Files.createDirectories(output.getParent());
        }
        Files.write(output, rewritten);
    }
}
