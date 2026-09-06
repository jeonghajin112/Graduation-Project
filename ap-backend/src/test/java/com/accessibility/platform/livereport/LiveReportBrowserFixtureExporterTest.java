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
                      body { margin: 0; min-height: 2200px; font: 16px/1.5 system-ui, sans-serif; }
                      main { width: 720px; padding: 56px; }
                      #group-target, #nearby-target { width: 360px; min-height: 72px; padding: 18px; border: 1px solid #ccd2dc; }
                      #nearby-target { margin-top: 5px; }
                      .dense-target { width: 360px; min-height: 22px; margin-top: 2px; padding: 1px 8px; border: 1px solid #ccd2dc; }
                      #dense-target-1 { margin-top: 28px; }
                      #nested-target { width: 360px; margin-top: 28px; }
                      #nested-link { display: block; min-height: 38px; padding: 7px 8px; border: 1px solid #ccd2dc; }
                      #dynamic-target-host { width: 360px; margin-top: 28px; }
                      #replaceable-target, #late-mounted-target { min-height: 38px; padding: 7px 8px; border: 1px solid #ccd2dc; }
                      .actions { display: flex; gap: 12px; margin-top: 36px; }
                      #state-carousel { width: 360px; margin-top: 36px; overflow: hidden; border: 1px solid #ccd2dc; }
                      #state-carousel .swiper-wrapper { display: flex; width: 100%; }
                      #state-carousel .swiper-slide { flex: 0 0 100%; min-height: 72px; padding: 18px; }
                      #hidden-state-target { min-height: 36px; }
                      #hidden-without-context { display: none; }
                      #offscreen-target { width: 360px; min-height: 72px; margin-top: 900px; padding: 18px; border: 1px solid #ccd2dc; }
                      #announcement-popup:not([hidden]) { position: fixed; inset: 80px 100px auto 180px; z-index: 10000; padding: 24px; background: white; border: 2px solid #333; }
                      svg { display: none !important; width: 2px !important; height: 2px !important; opacity: 0 !important; }
                      svg * { visibility: hidden !important; opacity: 0 !important; fill: none !important; stroke: none !important; }
                    </style>
                  </head>
                  <body>
                    <main>
                      <section id="group-target">같은 요소에서 세 가지 접근성 문제가 발견된 긴 텍스트입니다.</section>
                      <section id="nearby-target">인접한 요소의 마커는 앞선 마커와 겹치지 않아야 합니다.</section>
                      <section class="dense-target" id="dense-target-1">조밀한 첫 번째 대상</section>
                      <section class="dense-target" id="dense-target-2">조밀한 두 번째 대상</section>
                      <section class="dense-target" id="dense-target-3">조밀한 세 번째 대상</section>
                      <p id="nested-target"><a id="nested-link" href="#nested">같은 화면 위치를 공유하는 중첩 대상</a></p>
                      <div id="dynamic-target-host">
                        <section id="replaceable-target" data-generation="initial" onclick="window.dynamicActionClicks += 1">교체 전 동적 대상</section>
                      </div>
                      <div class="actions">
                        <button id="purchase" type="button" onclick="window.actionClicks += 1">구매하기</button>
                        <div class="carousel" aria-roledescription="carousel">
                          <button id="next-slide" type="button" aria-label="다음 슬라이드" onclick="window.slideClicks += 1">다음</button>
                        </div>
                      </div>
                      <section id="state-carousel" class="swiper" aria-roledescription="carousel">
                        <div class="swiper-wrapper">
                          <article id="state-clone-class" class="swiper-slide is-clone">클래스 복제 슬라이드</article>
                          <article id="state-clone-duplicate" class="swiper-slide" data-duplicate>속성 복제 슬라이드</article>
                          <article id="state-clone-marker" class="swiper-slide" data-clone>빈 값 복제 슬라이드</article>
                          <article id="state-clone-extension" class="swiper-slide" data-cloned>확장 복제 슬라이드</article>
                          <article id="visible-state-slide" class="swiper-slide" aria-hidden="false">현재 보이는 슬라이드</article>
                          <article id="hidden-state-slide" class="swiper-slide" hidden aria-hidden="true" inert style="display:none">
                            <button id="hidden-state-target" type="button" onclick="window.slideClicks += 100">숨은 슬라이드 대상</button>
                          </article>
                        </div>
                      </section>
                      <section id="hidden-without-context">복구 정보가 없는 숨은 대상</section>
                      <section id="offscreen-target">초기 뷰포트 아래에 있는 대상</section>
                    </main>
                    <div id="announcement-popup" role="dialog" aria-modal="true" aria-label="서비스 점검 안내" hidden>
                      <div class="modal-wrap"><div class="modal-dialog">
                        <h2>서비스 점검 안내</h2>
                        <button id="popup-close-icon" type="button" class="btn-close-modal close-modal"><span>닫기</span></button>
                        <div class="modal-footer"><div class="func-wrap"><div class="btn-wrap">
                          <button id="popup-close-footer" type="button" class="btn tertiary close-modal"> 닫기 </button>
                        </div></div></div>
                        <button id="popup-purchase" type="button" onclick="window.actionClicks += 1">구매하기</button>
                        <button id="popup-save-close" type="button" onclick="window.actionClicks += 1">저장 후 닫기</button>
                        <form method="post">
                          <button id="popup-submit" type="submit" onclick="window.actionClicks += 1">닫기</button>
                          <button id="popup-reset" type="reset" onclick="window.actionClicks += 1">닫기</button>
                        </form>
                      </div></div>
                    </div>
                    <script>
                      window.actionClicks = 0;
                      window.slideClicks = 0;
                      window.dynamicActionClicks = 0;
                      window.popupDismissals = 0;
                      document.querySelectorAll('#announcement-popup .close-modal').forEach(button => {
                        button.addEventListener('click', () => {
                          window.popupDismissals += 1;
                          document.getElementById('announcement-popup').hidden = true;
                        });
                      });
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
