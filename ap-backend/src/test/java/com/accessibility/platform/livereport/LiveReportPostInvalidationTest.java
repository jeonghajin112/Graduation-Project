package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.io.IOException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class LiveReportPostInvalidationTest {
  @ParameterizedTest
  @ValueSource(booleans = {false, true})
  void cookieFreePostMustInvalidateRetainedGetEvenWhenItsResponseIsLost(boolean responseLost) throws Exception {
    Instant now = Instant.parse("2026-09-12T12:00:00Z");
    URI start = URI.create("https://example.com/start");
    URI item = URI.create("https://example.com/item");
    var properties = new LiveReportProperties();
    var validator = new LiveReportUrlSafetyValidator(host ->
      List.of(InetAddress.getByAddress(new byte[]{93, (byte)184, (byte)216, 34})));
    var clock = Clock.fixed(now, ZoneOffset.UTC);
    var sessions = new LiveReportSessionService(properties, validator, clock);
    var session = sessions.create(1, start.toString());
    sessions.recordDocumentUri(session, start);
    var routes = new LiveReportOriginRouteRegistry(sessions, properties, clock);
    var upstream = mock(LiveReportUpstreamClient.class);
    var version = new AtomicInteger(1);
    var gets = new AtomicInteger();
    when(upstream.send(any(HttpRequest.class), anyList())).thenAnswer(invocation -> {
      HttpRequest request = invocation.getArgument(0);
      if (request.uri().equals(start)) return new LiveReportUpstreamClient.UpstreamResponse(302,
        Map.of("Location", List.of(item.toString())), new byte[0]);
      gets.incrementAndGet();
      return new LiveReportUpstreamClient.UpstreamResponse(200,
        Map.of("Content-Type", List.of("text/html"),
          "Cache-Control", List.of("public, max-age=60"),
          "Date", List.of(DateTimeFormatter.RFC_1123_DATE_TIME.format(now.atZone(ZoneOffset.UTC)))),
        ("<html>version="+version.get()+"</html>").getBytes(StandardCharsets.UTF_8));
    });
    when(upstream.send(any(HttpRequest.class), anyList(), any(byte[].class))).thenAnswer(invocation -> {
      HttpRequest request = invocation.getArgument(0);
      assertThat(request.uri()).isEqualTo(item);
      assertThat(request.method()).isEqualTo("POST");
      version.incrementAndGet();
      if (responseLost) throw new IOException("Response lost after commit");
      return new LiveReportUpstreamClient.UpstreamResponse(204, Map.of(), new byte[0]);
    });
    var fetch = new LiveReportFetchService(upstream, properties, validator, sessions);
    var rewriter = mock(LiveReportDocumentRewriter.class);
    when(rewriter.rewriteHtml(any(), any())).thenAnswer(invocation ->
      ((LiveReportFetchService.FetchedResource)invocation.getArgument(0)).bytes());
    MockMvc mvc = MockMvcBuilders.standaloneSetup(new LiveReportController(
      mock(LiveReportLaunchService.class), sessions, fetch, rewriter, properties, routes))
      .addFilters(new LiveReportViewerRoutingFilter(routes), new LiveReportTransportFilter(properties)).build();
    var location = mvc.perform(get(URI.create(routes.runtimeUrl(session, start))))
      .andExpect(status().isFound()).andReturn().getResponse().getHeader("Location");
    long revision = sessions.cookieRevision(session);
    var request = post(URI.create(location)).header(LiveReportTransport.HEADER_NAME, "fetch")
      .contentType("text/plain").content("update");
    if (responseLost) {
      mvc.perform(request).andExpect(status().isBadGateway());
    } else {
      mvc.perform(request).andExpect(status().isNoContent());
    }
    assertThat(sessions.cookieRevision(session)).isEqualTo(revision + 2);
    var response = mvc.perform(get(URI.create(location))).andExpect(status().isOk())
      .andReturn().getResponse().getContentAsString();
    assertThat(response).contains("version=2");
    assertThat(gets.get()).isEqualTo(2);
  }
}
