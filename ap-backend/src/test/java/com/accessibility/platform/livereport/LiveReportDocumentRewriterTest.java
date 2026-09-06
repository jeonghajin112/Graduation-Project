package com.accessibility.platform.livereport;

import com.accessibility.platform.livereport.config.LiveReportProperties;
import org.junit.jupiter.api.Test;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

import java.net.URI;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LiveReportDocumentRewriterTest {
    private final LiveReportProperties properties = new LiveReportProperties();
    private final LiveReportSessionService routeSessionService = org.mockito.Mockito.mock(
            LiveReportSessionService.class
    );
    private final LiveReportOriginRouteRegistry originRoutes = new LiveReportOriginRouteRegistry(
            routeSessionService,
            properties,
            Clock.fixed(Instant.parse("2026-09-01T12:00:00Z"), ZoneOffset.UTC)
    );
    private final LiveReportDocumentRewriter rewriter = new LiveReportDocumentRewriter(
            properties,
            originRoutes
    );
    private final LiveReportSessionService.LiveReportSession session = new LiveReportSessionService.LiveReportSession(
            UUID.fromString("6b2d884e-a7f4-4f09-9776-688d08fe8912"),
            7L,
            URI.create("https://www.example.com/nested/page"),
            "test-nonce",
            "test-bridge-secret",
            Instant.parse("2026-09-01T12:05:00Z")
    );

    @Test
    void rewritesRelativeAndRootResourcesAndInjectsAuthenticatedMarkerBridge() {
        String html = """
                <!doctype html><html><head>
                  <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
                  <link rel="stylesheet" href="../assets/app.css" integrity="sha256-test">
                  <style>.hero{background:url('/images/hero.png')}</style>
                </head><body>
                  <a href="/next">Next</a>
                  <img src="image.png" srcset="small.png 1x, /large.png 2x">
                  <script src="https://cdn.example.net/app.js"></script>
                </body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/nested/page"),
                "text/html;charset=UTF-8",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).doesNotContain("http-equiv=\"Content-Security-Policy\"");
        assertThat(rewritten).doesNotContain("integrity=\"sha256-test\"");
        assertThat(rewritten).contains("const gatewayOrigin = 'http://localhost:9090'");
        assertThat(rewritten).contains("const viewerBaseOrigin = 'http://localhost:9090'");
        assertThat(rewritten).contains("overflow-x: hidden !important");
        assertThat(rewritten).contains("@supports (overflow-x: clip)");
        assertThat(rewritten).contains("html::-webkit-scrollbar:horizontal");
        assertThat(rewritten).contains("border-radius: 999px !important");
        assertThat(rewritten).contains(mirror("https://www.example.com/assets/app.css"));
        assertThat(rewritten).contains(mirror("https://www.example.com/images/hero.png"));
        assertThat(rewritten).contains(mirror("https://www.example.com/nested/image.png"));
        assertThat(rewritten).contains(mirror("https://cdn.example.net/app.js"));
        assertThat(rewritten).contains("data-ap-live-bridge=\"true\"");
        assertThat(rewritten).contains("const nonce = 'test-nonce'");
        assertThat(rewritten).contains("const bridgeSecret = 'test-bridge-secret'");
        assertThat(rewritten).contains("const parentSource = 'accessibility-dashboard'");
        assertThat(rewritten).contains("const replaySource = 'accessibility-page-replay'");
        assertThat(rewritten).contains("bridgeScriptElement?.remove()");
        assertThat(rewritten).contains("nativeApply(nativeAddEventListener, globalThis, ['message', onConnectMessage, {capture:true}])");
        assertThat(rewritten).contains("source !== expectedParent || trusted !== true");
        assertThat(rewritten).contains("nativeApply(nativeStopImmediatePropagation, event, [])");
        assertThat(rewritten).contains("data.bridgeSecret !== bridgeSecret");
        assertThat(rewritten).contains("type:'ACK'");
        assertThat(rewritten).contains("type:'AVAILABLE'");
        assertThat(rewritten).contains("announceBridgeAvailability()");
        assertThat(rewritten).contains("const nativeWindowPostMessage = globalThis.postMessage");
        assertThat(rewritten).doesNotContain("Window.prototype.postMessage");
        assertThat(rewritten).contains("type:'EVENT'");
        assertThat(rewritten).contains("data.source !== parentLiveSource || data.type !== 'COMMAND'");
        assertThat(rewritten).doesNotContain("addEventListener('message', event =>");
        assertThat(rewritten).containsPattern("const documentToken = '[0-9a-f]{32}'");
        assertThat(rewritten).contains("data.type === 'INIT_ISSUES'");
        assertThat(rewritten).contains("type:'READY'");
        assertThat(rewritten).contains("if (data.type === 'REQUEST_DOCUMENT_STATE')");
        assertThat(rewritten).contains("post({type:'DOCUMENT_LOADING'})");
        assertThat(rewritten).contains("type:'DOCUMENT_HEALTH'");
        assertThat(rewritten).contains("status:meaningful ? 'MEANINGFUL' : 'EMPTY'");
        assertThat(rewritten).contains("const tag = String(element.tagName || '').toUpperCase()");
        assertThat(rewritten).contains("Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)");
        assertThat(rewritten).contains("Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)");
        assertThat(rewritten).contains("largestVisibleVisualArea >= 10000");
        assertThat(rewritten).contains("largestVisibleVisualArea:0");
        assertThat(rewritten).contains("meaningfulHealthSamples >= 1");
        assertThat(rewritten).contains("consecutiveMeaningfulSamples");
        assertThat(rewritten).contains("const NativeMutationObserver = globalThis.MutationObserver");
        assertThat(rewritten).contains("const initializeReadyDocument = () =>");
        assertThat(rewritten).contains("documentReadyObserver.observe(document.documentElement, {childList:true, subtree:true})");
        assertThat(rewritten).contains("new NativeMutationObserver");
        assertThat(rewritten).contains("document.addEventListener('click'");
        assertThat(rewritten).contains("location.assign(proxied)");
        assertThat(rewritten).contains("const storedSteps = Array.isArray(item.pathSteps) ? item.pathSteps : []");
        assertThat(rewritten).contains("typeof item.path === 'string' && item.path");
        assertThat(rewritten).contains("context === 'SHADOW_ROOT'");
        assertThat(rewritten).contains("const isBoundedCarouselContext = value =>");
        assertThat(rewritten).contains("value.slideCount <= 10000 && value.slideIndex < value.slideCount");
        assertThat(rewritten).contains("!isBoundedCarouselContext(issue.carouselContext)");
        assertThat(rewritten).contains("const reportLocatorState = (issue, state) =>");
        assertThat(rewritten).contains("status:'VISIBLE'");
        assertThat(rewritten).contains("status:'OFFSCREEN'");
        assertThat(rewritten).contains("status:'HIDDEN_STATE'");
        assertThat(rewritten).contains("status:'UNAVAILABLE'");
        assertThat(rewritten).doesNotContain("status:'CONNECTED'");
        assertThat(rewritten).contains("if (locatorStatusSignatures.get(issue.id) === signature) return");
        assertThat(rewritten).contains("const activateCarouselState = (element, context) =>");
        assertThat(rewritten).contains("slides.length !== context.slideCount");
        assertThat(rewritten).contains("slides[context.slideIndex] !== slide");
        assertThat(rewritten).contains("'.swiper-slide-duplicate', '.slick-cloned', '.splide__slide--clone', '.is-clone'");
        assertThat(rewritten).contains("truthyCarouselCloneMarker(element, 'data-clone')");
        assertThat(rewritten).contains("truthyCarouselCloneMarker(element, 'data-duplicate')");
        assertThat(rewritten).contains("carousel.allSlides.forEach(candidate =>");
        assertThat(rewritten).contains("nativeApply(nativeScrollIntoView, element");
        assertThat(rewritten).contains("reason:'CAROUSEL_RECOVERY_FAILED', recoverable:false");
        assertThat(rewritten).contains("post({type:'ISSUE_DETAIL_FALLBACK', issueId})");
        assertThat(rewritten).doesNotContain("carousel.slide.click(");
        assertThat(rewritten).doesNotContain("carousel.slide.dispatchEvent(");
        assertThat(rewritten).contains("const reconcileIssueTargets = preferredIssueId =>");
        assertThat(rewritten).contains("const resolvedElement = resolveIssue(issue).element || null");
        assertThat(rewritten).contains("if (reconcileIssueTargets(issueId)) requestVersion = focusRequestVersion");
        assertThat(rewritten).contains("const locatorStateOnlyAttributes = new Set([");
        assertThat(rewritten).contains("!locatorStateOnlyAttributes.has(String(record.attributeName || '').toLowerCase())");
        assertThat(rewritten).contains("const groups = new Map()");
        assertThat(rewritten).contains("const group = groups.get(element) || {element, issues:[]}");
        assertThat(rewritten).doesNotContain("group.element.classList.add('ap-live-target')");
        assertThat(rewritten).contains("let highlightedEntry = null");
        assertThat(rewritten).contains("highlight.className = 'ap-live-highlight'");
        assertThat(rewritten).contains(".ap-live-highlight{all:initial");
        assertThat(rewritten).contains(".ap-live-highlight__fragment{all:initial");
        assertThat(rewritten).contains("const highlightRectsForElement = element =>");
        assertThat(rewritten).contains("Array.from(element.getClientRects())");
        assertThat(rewritten).contains("const maxHighlightFragments = 128");
        assertThat(rewritten).contains("const positionHighlight = (");
        assertThat(rewritten).contains("documentLeft = globalThis.scrollX");
        assertThat(rewritten).contains("documentTop = globalThis.scrollY");
        assertThat(rewritten).contains("const setHighlightedEntry = (entry, selected = false) =>");
        assertThat(rewritten).contains("const gap = 4 * inverseScale");
        assertThat(rewritten).contains("while (highlight.childElementCount < rects.length)");
        assertThat(rewritten).contains("while (highlight.childElementCount > rects.length)");
        assertThat(rewritten).contains("const viewportAttached = highlightedEntry?.viewportAttached === true");
        assertThat(rewritten).contains("document.body?.scrollHeight || 0");
        assertThat(rewritten).contains("document.documentElement.scrollHeight");
        assertThat(rewritten).contains("fragment.style.setProperty('position', viewportAttached ? 'fixed' : 'absolute', 'important')");
        assertThat(rewritten).contains("`${Math.max(0, right - left)}px`");
        assertThat(rewritten).contains("fragment.style.setProperty('border-width', `${borderWidth}px`, 'important')");
        assertThat(rewritten).contains("layer.replaceChildren(highlight, popover)");
        assertThat(rewritten).doesNotContain("classList.remove('ap-live-target')");
        assertThat(rewritten).doesNotContain("classList.add('ap-live-target')");
        assertThat(rewritten).contains("setHighlightedEntry(entry, selected)");
        assertThat(rewritten).contains("setHighlightedEntry(null)");
        assertThat(rewritten).contains("const severityColors = Object.freeze");
        assertThat(rewritten).contains("const groupCategory = issues =>");
        assertThat(rewritten).doesNotContainIgnoringCase("bokjiro");
        assertThat(rewritten).contains("popover.className = 'ap-live-popover'");
        assertThat(rewritten).contains(".ap-live-popover__detail::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}");
        assertThat(rewritten).contains(".ap-live-popover__detail{min-height:142px;max-height:270px;overflow:auto");
        assertThat(rewritten).contains("popoverDetail.tabIndex = 0");
        assertThat(rewritten).contains("popoverDetail.setAttribute('role', 'region')");
        assertThat(rewritten).contains("popover.append(popoverToolbar, popoverDetail)");
        assertThat(rewritten).contains("popoverPager.setAttribute('role', 'group')");
        assertThat(rewritten).contains("popoverPager.setAttribute('aria-label', '같은 요소의 접근성 문제 이동')");
        assertThat(rewritten).contains("'ap-live-popover__pager-button--previous', '이전 문제', '<'");
        assertThat(rewritten).contains("'ap-live-popover__pager-button--next', '다음 문제', '>'");
        assertThat(rewritten).contains("button.setAttribute('aria-controls', 'ap-live-issue-detail')");
        assertThat(rewritten).contains("popoverPosition.setAttribute('role', 'status')");
        assertThat(rewritten).contains(".ap-live-popover__pager-button{all:initial;box-sizing:border-box;width:24px;height:24px");
        assertThat(rewritten).doesNotContain("const popoverTabs =");
        assertThat(rewritten).doesNotContain(".ap-live-popover__tab{");
        assertThat(rewritten).doesNotContain("popoverDetail.setAttribute('role', 'tabpanel')");
        assertThat(rewritten).doesNotContain("const popoverHeader =");
        assertThat(rewritten).doesNotContain("const popoverClose =");
        assertThat(rewritten).doesNotContain("popoverGroup.textContent =");
        assertThat(rewritten).doesNotContain("popoverClose.addEventListener");
        assertThat(rewritten).contains("const issueCodeLabelFor = issue =>");
        assertThat(rewritten).contains("const createSeverityBadge = issue =>");
        assertThat(rewritten).contains("const createCodeBadge = issue =>");
        assertThat(rewritten).contains("const badge = document.createElement('code')");
        assertThat(rewritten).contains("badge.className = 'ap-live-popover__severity'");
        assertThat(rewritten).contains("badge.className = 'ap-live-popover__code'");
        assertThat(rewritten).contains("? `KWCAG ${code}` : code");
        assertThat(rewritten).contains("min-height:0;max-height:min(520px");
        assertThat(rewritten).contains(".ap-live-popover__code{max-width:140px");
        assertThat(rewritten).contains(".ap-live-popover__tags{display:flex;align-items:center;justify-content:flex-start;gap:6px");
        assertThat(rewritten).contains("background:#101828;color:#fff");
        assertThat(rewritten).contains("post({type:'ISSUE_SELECTED', issueId:issue.id})");
        assertThat(rewritten).contains("popoverPrevious.disabled = !grouped || issueIndex <= 0");
        assertThat(rewritten).contains("popoverNext.disabled = !grouped || issueIndex < 0 || issueIndex >= clusterIssues.length - 1");
        assertThat(rewritten).contains("entry.marker.after(popover)");
        assertThat(rewritten).contains("event.key === 'Escape'");
        assertThat(rewritten).doesNotContain("event.key === 'ArrowRight'");
        assertThat(rewritten).contains("marker.setAttribute('aria-controls', popover.id)");
        assertThat(rewritten).contains("const position = (mode = 'full') =>");
        assertThat(rewritten).contains("const schedulePosition = (mode = 'full') =>");
        assertThat(rewritten).contains("const scheduleRootScrollPosition = () => schedulePosition('preserve-root')");
        assertThat(rewritten).contains("const scheduleCapturedScrollPosition = event =>");
        assertThat(rewritten).contains("if (target === document) return");
        assertThat(rewritten).contains("nativeApply(nativeNodeContains, layer, [target])");
        assertThat(rewritten).contains("'scroll', scheduleRootScrollPosition, {passive:true}");
        assertThat(rewritten).contains("'scroll', scheduleCapturedScrollPosition, {passive:true,capture:true}");
        assertThat(rewritten).doesNotContain("document.addEventListener('scroll', schedulePosition");
        assertThat(rewritten).contains("if (markerPositionFrame) return");
        assertThat(rewritten).contains("if (mode === 'full') pendingMarkerPositionMode = 'full'");
        assertThat(rewritten).contains("const scheduledMode = pendingMarkerPositionMode");
        assertThat(rewritten).contains("position(scheduledMode)");
        assertThat(rewritten).contains("new MutationObserver(records =>");
        assertThat(rewritten).contains("const externalRecords = records.filter(record => !layer.contains(record.target))");
        int markerObserverIndex = rewritten.indexOf("markerObserver = new NativeMutationObserver(records =>");
        int markerPreserveIndex = rewritten.indexOf("schedulePosition('preserve-root')", markerObserverIndex);
        assertThat(markerObserverIndex).isGreaterThanOrEqualTo(0).isLessThan(markerPreserveIndex);
        assertThat(rewritten).contains("healthObserver = new NativeMutationObserver(() =>");
        assertThat(rewritten).contains("startMarkerObserver()");
        assertThat(rewritten).contains("new ResizeObserver(() => schedulePosition('preserve-root'))");
        assertThat(rewritten).contains("const markerPositionTimer = setInterval");
        assertThat(rewritten).contains("schedulePosition('preserve-root')");
        assertThat(rewritten).contains("}, 1000)");
        assertThat(rewritten).contains("#ap-live-marker-layer{position:absolute;left:0;top:0;width:0;height:0;overflow:visible");
        assertThat(rewritten).doesNotContain("#ap-live-marker-layer{position:fixed");
        assertThat(rewritten).contains(".ap-live-marker[hidden]{display:none!important}");
        assertThat(rewritten).contains(".ap-live-marker:hover,.ap-live-marker:focus-visible{box-shadow:0 4px 10px rgba(16,24,40,.28)}");
        assertThat(rewritten).contains(".ap-live-marker:focus-visible{outline:2px solid #fff;outline-offset:2px}");
        assertThat(rewritten).doesNotContain("color-mix(in srgb,var(--ap-marker-color");
        assertThat(rewritten).contains("height:18px;padding:0 8px 0 7px;border:0;border-radius:999px;background:#1d1d1f");
        assertThat(rewritten).contains(".ap-live-marker.is-selected{background:#0b6ff4");
        assertThat(rewritten).contains("transform:translate(0,-50%);transform-origin:0 50%");
        assertThat(rewritten).contains("border:0;border-radius:999px;background:#ff3b30");
        assertThat(rewritten).doesNotContain("width:24px;height:24px;border:2px solid #fff");
        assertThat(rewritten).doesNotContain("border:1.5px solid #fff;border-radius:999px");
        assertThat(rewritten).contains("right:-6px;top:-6px");
        assertThat(rewritten).contains("min-width:13px;height:13px;padding:0 3px");
        assertThat(rewritten).contains("font:700 8px/1 system-ui");
        assertThat(rewritten).doesNotContain("left:calc(100% + 4px);top:50%");
        assertThat(rewritten).contains("const markerPillHeight = 18");
        assertThat(rewritten).contains("const markerCornerOverhang = 8");
        assertThat(rewritten).contains("const markerCountBadgeOverhang = 6");
        assertThat(rewritten).contains("baseLeft:targetGeometry.bounds.left - markerCornerOverhang / viewScale");
        assertThat(rewritten).contains("baseTop:firstRect.top - gap - (markerPillHeight / 2) / viewScale");
        assertThat(rewritten).contains("const transform = `translate(0, -50%) scale(${1 / viewScale})`");
        assertThat(rewritten).contains("right: left + (rightExtent + collisionPadding) * inverseScale");
        assertThat(rewritten).contains("top: top - (topExtent + collisionPadding) * inverseScale");
        assertThat(rewritten).contains("const markerEngineLabels = Object.freeze({RULE_BASED:'규칙', AI_TEXT:'텍스트', CV_VISION:'시각'})");
        assertThat(rewritten).doesNotContain("const markerIcons = Object.freeze");
        assertThat(rewritten).doesNotContain(".ap-live-marker__eye");
        assertThat(rewritten).contains("const renderMarkerLabel = (container, engine) =>");
        assertThat(rewritten).doesNotContain("renderMarkerIcon(icon, issue.category)");
        assertThat(rewritten).contains("renderMarkerLabel(markerIcon, highest?.analyzer || group.issues[0]?.analyzer)");
        assertThat(rewritten).contains("issue.analyzer.length > 16");
        assertThat(rewritten).contains("--ap-highlight-color");
        assertThat(rewritten).doesNotContain("visual:'◉'");
        assertThat(rewritten).doesNotContain("marker.textContent = markerIcons[markerCategory] || markerIcons.general");
        assertThat(rewritten).contains("const createMarkerSpatialIndex = () =>");
        assertThat(rewritten).contains("const markerTargetGap = 6");
        assertThat(rewritten).contains("const markerTargetGeometryForElement = element =>");
        assertThat(rewritten).containsPattern(
                "const markerTargetGeometryForElement = element => \\{\\s+"
                        + "const rects = highlightRectsForElement\\(element\\)"
        );
        assertThat(rewritten).contains("const markerClearsTarget =");
        assertThat(rewritten).contains("const markerProtectedTextRectsForElement =");
        assertThat(rewritten).contains("range.selectNodeContents(element)");
        assertThat(rewritten).contains("const markerProtectedTextRectBudget = 512");
        assertThat(rewritten).contains("const markerProtectedTextPerElementLimit = 32");
        assertThat(rewritten).contains("let remainingProtectedTextRects = markerProtectedTextRectBudget");
        assertThat(rewritten).contains("remainingProtectedTextRects -= measurement.protectedTextRects.length");
        assertThat(rewritten).contains("const gap = markerTargetGap / viewScale");
        assertThat(rewritten).contains("left:rect.left - gap");
        assertThat(rewritten).contains("top:rect.top - gap");
        assertThat(rewritten).contains("right:rect.right + gap");
        assertThat(rewritten).contains("bottom:rect.bottom + gap");
        assertThat(rewritten).contains("const markerLeftGutter =");
        assertThat(rewritten).contains("side:'left', axis:'vertical'");
        assertThat(rewritten).contains("baseLeft:targetGeometry.bounds.left");
        assertThat(rewritten).doesNotContain("side:'right', axis:'vertical'");
        assertThat(rewritten).doesNotContain("side:'top', axis:'horizontal'");
        assertThat(rewritten).doesNotContain("side:'bottom', axis:'horizontal'");
        // Row alignment, spacing, cluster bounds and scroll restoration are asserted
        // against this emitted bridge by verify-live-report-markers.mjs. Do not pin
        // those behaviors to the former lane solver's private variables and loops.
        assertThat(rewritten).contains("const markerPlacementFor = (");
        assertThat(rewritten).contains("const markerSearchRingLimit = 12");
        assertThat(rewritten).contains(
                "!markerClearsTarget(targetFootprint, targetGeometry.rects)) return null"
        );
        assertThat(rewritten).contains("allowTargetOverlap = false");
        assertThat(rewritten).contains("const pageLevelOverlapAllowed = pageLevelTarget");
        assertThat(rewritten).contains("&& visibleWidth * visibleHeight >= viewportArea * 0.75");
        assertThat(rewritten).contains("entry.element === document.documentElement");
        assertThat(rewritten).contains("entry.element === document.body");
        assertThat(rewritten).contains("pageFallback:true");
        assertThat(rewritten).contains("if (!ignoreProtectedText && contentSpatialIndex.overlaps(candidate.footprint)) return null");
        assertThat(rewritten).contains("if (spatialIndex.overlaps(candidate.footprint)) return null");
        assertThat(rewritten).doesNotContain(
                "placement = tryCandidate(targetRect.left, targetRect.top, {left:0, top:0})"
        );
        assertThat(rewritten).contains("viewportClamped:left !== requestedLeft || top !== requestedTop");
        int markerClampIndex = rewritten.indexOf("const candidate = clampMarkerCenter(entry, left, top)");
        int markerTargetClearanceIndex = rewritten.indexOf(
                "!markerClearsTarget(targetFootprint, targetGeometry.rects)) return null"
        );
        int markerCollisionIndex = rewritten.indexOf("if (spatialIndex.overlaps(candidate.footprint)) return null");
        assertThat(markerClampIndex).isGreaterThanOrEqualTo(0).isLessThan(markerTargetClearanceIndex);
        assertThat(markerTargetClearanceIndex).isLessThan(markerCollisionIndex);
        assertThat(rewritten).doesNotContain("if (entry.markerOffset?.side === 'left')");
        assertThat(rewritten).contains("addLaneOffset(-ring * step)");
        assertThat(rewritten).contains("addLaneOffset(ring * step)");
        assertThat(rewritten).contains("const targetVisibleInViewport = (element, rect) =>");
        assertThat(rewritten).contains("const markerPositionAnchorForElement = element =>");
        assertThat(rewritten).contains("element.assignedSlot instanceof HTMLSlotElement");
        assertThat(rewritten).contains("position === 'fixed' || position === 'sticky'");
        assertThat(rewritten).contains("const establishesFixedContainingBlock = style =>");
        assertThat(rewritten).contains("const fixedContainingBlockFor = element =>");
        assertThat(rewritten).contains("const verticalStickyIsStuck = (element, style) =>");
        assertThat(rewritten).contains("const positionAnchorUsesViewportCoordinates = (anchor, visited = new Set()) =>");
        assertThat(rewritten).contains("const outerAnchor = markerPositionAnchorForElement(composedElementParent(anchor.element))");
        assertThat(rewritten).contains("const containingBlock = fixedContainingBlockFor(anchor.element)");
        assertThat(rewritten).contains("return positionAnchorUsesViewportCoordinates(outerAnchor, visited)");
        assertThat(rewritten).contains("const markerUsesViewportCoordinates = entry =>");
        assertThat(rewritten).contains("entry.positionAnchor = markerPositionAnchorForElement(entry.element)");
        assertThat(rewritten).contains("anchor === undefined || (anchor && !anchor.element?.isConnected)");
        assertThat(rewritten).doesNotContain("innerWidth - rect.right - right");
        assertThat(rewritten).contains("rect.width > 0 && rect.height > 0");
        assertThat(rewritten).contains("rect.right > 0 && rect.bottom > 0");
        assertThat(rewritten).contains("const hidden = !placement");
        assertThat(rewritten).contains("if (marker.hidden !== hidden) marker.hidden = hidden");
        assertThat(rewritten).contains("if (openEntry === entry) closeOpenPopover = true");
        assertThat(rewritten).contains("const documentLeft = globalThis.scrollX");
        assertThat(rewritten).contains("const documentTop = globalThis.scrollY");
        assertThat(rewritten).contains("const markerViewportAttached = viewportAttached");
        assertThat(rewritten).doesNotContain(
                "const markerViewportAttached = viewportAttached || placement.viewportClamped"
        );
        assertThat(rewritten).contains("entry.markerViewportAttached = markerViewportAttached");
        assertThat(rewritten).contains("const markerLeft = placement.left + (markerViewportAttached ? 0 : documentLeft)");
        assertThat(rewritten).contains("const markerTop = placement.top + (markerViewportAttached ? 0 : documentTop)");
        assertThat(rewritten).contains("entry.markerDocumentLeft = markerLeft");
        assertThat(rewritten).contains("entry.markerDocumentTop = markerTop");
        assertThat(rewritten).contains("entry.markerAnchorDocumentRect = targetDocumentRect");
        assertThat(rewritten).contains("const markerDocumentRectsMatch = (previous, current) =>");
        assertThat(rewritten).contains("const preservePlacement = preserveRootPlacement");
        assertThat(rewritten).contains("|| entry.positionAnchor?.position === 'sticky'");
        assertThat(rewritten).contains("&& (!initiallyVisible || targetGeometry !== null)");
        assertThat(rewritten).contains("const hostRect = natural ? spatialIndex.collidingRect(natural.footprint) : null");
        assertThat(rewritten).contains("if (preservePlacement) {");
        assertThat(rewritten).contains("const hidden = !measurement.visible");
        assertThat(rewritten).contains("if (hidden) closeOpenPopover = true");
        assertThat(rewritten).contains("if (!preserveRootPlacement) entry.positionAnchor = undefined");
        assertThat(rewritten).contains("marked.forEach(entry => { entry.positionAnchor = undefined; })");
        assertThat(rewritten).contains("const position = markerViewportAttached ? 'fixed' : 'absolute'");
        assertThat(rewritten).contains("positionHighlight(documentLeft, documentTop)");
        assertThat(rewritten).contains("positionPopover(documentLeft, documentTop)");
        assertThat(rewritten).contains("requestAnimationFrame(() => positionPopover())");
        assertThat(rewritten).doesNotContain("requestAnimationFrame(positionPopover)");
        assertThat(rewritten).contains("popover.style.position = viewportAttached ? 'fixed' : 'absolute'");
        assertThat(rewritten).contains("(viewportAttached ? 0 : documentLeft)");
        assertThat(rewritten).contains("(viewportAttached ? 0 : documentTop)");
        assertThat(rewritten).contains("const measurements = marked.map(entry =>");
        assertThat(rewritten).contains("const initiallyVisible = targetVisibleInViewport(entry.element, targetRect)");
        assertThat(rewritten).contains("? markerTargetGeometryForElement(entry.element)");
        assertThat(rewritten).contains("const contentSpatialIndex = createMarkerSpatialIndex()");
        assertThat(rewritten).contains("measurement.protectedTextRects.forEach(rect => contentSpatialIndex.add(rect))");
        assertThat(rewritten).contains("if (!measurement.preservePlacement || !measurement.visible) return");
        assertThat(rewritten).contains("const placeMeasurement = measurement =>");
        assertThat(rewritten).contains("const orderedMeasurements = measurements.slice().sort((left, right) =>");
        assertThat(rewritten).contains("leftBounds.top - rightBounds.top");
        assertThat(rewritten).contains("orderedMeasurements.forEach(placeMeasurement)");
        assertThat(rewritten).doesNotContain("if (measurement.entry.markerWasVisible) placeMeasurement(measurement)");
        assertThat(rewritten).contains("measurement.targetGeometry");
        assertThat(rewritten).contains("return {...candidate, markerOffset}");
        assertThat(rewritten).contains("entry.markerOffset = placement.markerOffset");
        assertThat(rewritten).doesNotContain("left:placement.left - targetRect.left");
        assertThat(rewritten).contains("record.type === 'childList'");
        assertThat(rewritten).contains("record.type === 'attributes'");
        assertThat(rewritten).contains("entry.positionAnchor = undefined");
        assertThat(rewritten).contains("if (marker.style.left !== left) marker.style.left = left");
        assertThat(rewritten).contains("addEventListener('pagehide', event => {");
        assertThat(rewritten).contains("addEventListener('pageshow', event => {");
        assertThat(rewritten).contains("clearInterval(markerPositionTimer)");
        assertThat(rewritten).contains("cancelAnimationFrame(markerPositionFrame)");
        assertThat(rewritten).contains("const markerScrollRoots = new Set()");
        assertThat(rewritten).contains("const observeMarkerShadowScrollRoots = element =>");
        assertThat(rewritten).contains("const parent = composedElementParent(current)");
        assertThat(rewritten).contains("'scroll', scheduleCapturedScrollPosition, {passive:true,capture:true}");
        assertThat(rewritten).contains("nativeApply(nativeRemoveEventListener, root");
        assertThat(rewritten).contains("clearMarkerScrollRoots()");
        assertThat(rewritten).doesNotContain("addEventListener('beforeunload'");
        assertThat(rewritten).contains("Element.prototype.setAttribute = function(name, value)");
        assertThat(rewritten).contains("['HTMLImageElement','src']");
        assertThat(rewritten).contains("patchStringProperty('HTMLImageElement', 'srcset', 'srcset')");
        assertThat(rewritten).contains("runtimeUrlObserver?.observe(document.documentElement");
        assertThat(rewritten).contains("CSSStyleSheet.prototype.insertRule = function(rule, index)");
        assertThat(rewritten).contains("get() { return currentUpstreamBase(); }");
        assertThat(rewritten).contains("const upstreamDocument = 'https://www.example.com/nested/page'");
        assertThat(rewritten).contains("History.prototype.pushState = function(state, unused)");
        assertThat(rewritten).contains("History.prototype.replaceState = function(state, unused)");
        assertThat(rewritten).contains("window.location is intentionally not replaced");
        assertThat(rewritten).contains("HTMLFormElement.prototype.submit = function()");
        assertThat(rewritten).contains("method !== 'GET' && method !== 'HEAD'");
        assertThat(rewritten).contains("decodeSessionResource(value) || value");
        assertThat(rewritten).contains("const mirrorPrefix = `${gatewayOrigin}/api/live-reports/${sessionId}/mirror/${nonce}/`");
        assertThat(rewritten).contains("const candidate = new URL(raw)");
        assertThat(rewritten).contains("candidate.origin === location.origin");
        assertThat(rewritten).contains("const isViewerResource = value =>");
        assertThat(rewritten).contains("if (isSessionResource(raw)) return new URL(raw, location.href).href");
        assertThat(rewritten.indexOf("if (isSessionResource(raw)) return new URL(raw, location.href).href"))
                .isLessThan(rewritten.indexOf("if (explicitBlockedScheme(raw)) return null"));
        assertThat(rewritten).contains("if (raw.length > 16384) return 'data:,'");
        int runtimeCssIndex = rewritten.indexOf("const runtimeCss =");
        int trustedCssUrlIndex = rewritten.indexOf(
                "if (isSessionResource(raw)) return new URL(raw, location.href).href",
                runtimeCssIndex
        );
        int blockedCssUrlIndex = rewritten.indexOf(
                "if (explicitBlockedScheme(raw)) return 'data:,'",
                runtimeCssIndex
        );
        assertThat(trustedCssUrlIndex).isGreaterThan(runtimeCssIndex).isLessThan(blockedCssUrlIndex);
        assertThat(rewritten).contains("const replacement = isSessionResource(trimmed)");
        assertThat(rewritten).contains(": explicitBlockedScheme(trimmed) ? 'data:text/css,' : replaceUrl(trimmed)");
        assertThat(rewritten).contains("scheme === 'javascript' || scheme === 'vbscript' || scheme === 'file' || scheme === 'http'");
        assertThat(rewritten).contains("['HTMLScriptElement','src','src',true]");
        assertThat(rewritten).contains("return exposeMirror ? nativeValue : pageFacingUrl(nativeValue)");

        Document parsed = Jsoup.parse(rewritten);
        Element firstExecutableScript = parsed.selectFirst("script");
        assertThat(firstExecutableScript).isNotNull();
        assertThat(firstExecutableScript.attr("data-ap-live-bridge")).isEqualTo("true");
        assertThat(parsed.getAllElements())
                .allSatisfy(element -> assertThat(element.attributes().html()).doesNotContain("test-bridge-secret"));
    }

    @Test
    void preservesSafeFetchOptionsAndOnlyAllowsBoundedSameOriginDataPosts() {
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/page"),
                "text/html",
                "<html><body>page</body></html>".getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains("const NativeRequest = globalThis.Request");
        assertThat(rewritten).contains("const fetchInputUrl = input =>");
        assertThat(rewritten).contains("candidate.origin === location.origin && !isSessionResource(candidate.href)");
        assertThat(rewritten).contains("return `${candidate.pathname}${candidate.search}${candidate.hash}`");
        assertThat(rewritten).contains("const upstream = decodeSessionResource(inputUrl) || resolveUpstream(inputUrl)");
        assertThat(rewritten).contains("const proxied = upstream && proxyUrl(upstream)");
        assertThat(rewritten).contains("new NativeRequest(proxied, input)");
        assertThat(rewritten).contains("const configured = init === undefined ? rewritten : new NativeRequest(rewritten, init)");
        assertThat(rewritten).contains("method !== 'GET' && method !== 'HEAD' && method !== 'POST'");
        assertThat(rewritten).contains("new URL(value).origin === new URL(upstreamDocument).origin");
        assertThat(rewritten).contains("return !essence.startsWith('multipart/')");
        assertThat(rewritten).contains("configured.redirect !== 'follow'");
        assertThat(rewritten).contains("const maxPostBodyBytes = 262144");
        assertThat(rewritten).contains("total > maxPostBodyBytes");
        assertThat(rewritten).contains("X-Accessibility-Live-Transport");
        assertThat(rewritten).contains("withTransport(configured, 'fetch'");
        assertThat(rewritten).contains("normalizedMethod === 'POST' && !sameDocumentOrigin(upstream)");
        assertThat(rewritten).contains("XMLHttpRequest.prototype.send = function(body = null)");
        assertThat(rewritten).contains("isInstance(body, NativeFormData)");
        assertThat(rewritten).contains("nativeSetRequestHeader, this, [transportHeader, 'xhr']");
        assertThat(rewritten).doesNotContain("const options = {...init");
        assertThat(rewritten).doesNotContain("new NativeRequest(input)");
    }

    @Test
    void createsFreshDocumentTokenForEveryNavigationDocument() {
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/page"),
                "text/html",
                "<html><body>page</body></html>".getBytes(StandardCharsets.UTF_8)
        );

        String first = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);
        String second = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(documentToken(first)).isNotEqualTo(documentToken(second));
    }

    @Test
    void resolvesEveryDocumentUrlAndRuntimeRequestAgainstTheFirstBaseHref() {
        String html = """
                <!doctype html><html><head>
                  <base href="/app/ui/">
                  <base href="https://ignored.example.net/">
                  <meta http-equiv="refresh" content="30; url=next/page">
                  <link rel="stylesheet" href="runtime/app.css">
                  <style>.hero{background:url('images/hero.png')}</style>
                </head><body style="background:url(icons/body.svg)">
                  <a href="detail">Detail</a>
                  <img src="images/logo.png" srcset="images/small.png 1x, images/large.png 2x">
                </body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.do"),
                "text/html;charset=UTF-8",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        Document parsed = Jsoup.parse(rewritten);
        assertThat(parsed.selectFirst("base[href]").attr("href"))
                .isEqualTo(mirror("https://www.example.com/app/ui/"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/runtime/app.css"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/images/hero.png"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/icons/body.svg"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/detail"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/images/logo.png"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/images/small.png"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/images/large.png"));
        assertThat(rewritten).contains(mirror("https://www.example.com/app/ui/next/page"));
        assertThat(rewritten).contains("const upstreamBase = 'https://www.example.com/app/ui/'");
        assertThat(rewritten).contains("const hasExplicitBase = true");
        assertThat(rewritten).doesNotContain("ignored.example.net");
    }

    @Test
    void decodesEucKrHtmlFromContentTypeAndNormalizesConflictingMetaCharset() {
        Charset eucKr = Charset.forName("EUC-KR");
        String html = "<html><head><meta charset=\"UTF-8\"><meta http-equiv=\"Content-Type\" "
                + "content=\"text/html; charset=Shift_JIS\"></head><body>복지 서비스 안내</body></html>";
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/legacy/index.do"),
                "text/html; charset=EUC-KR",
                html.getBytes(eucKr)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);
        Document parsed = Jsoup.parse(rewritten);

        assertThat(parsed.body().text()).contains("복지 서비스 안내");
        assertThat(parsed.select("meta[charset]")).hasSize(1);
        assertThat(parsed.selectFirst("meta[charset]").attr("charset")).isEqualTo("UTF-8");
        assertThat(parsed.select("meta[http-equiv=Content-Type]")).isEmpty();
    }

    @Test
    void sniffsShiftJisHtmlFromMetaWhenContentTypeHasNoCharset() {
        Charset shiftJis = Charset.forName("Shift_JIS");
        String html = "<html><head><meta charset=\"Shift_JIS\"></head><body>福祉サービス案内</body></html>";
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.jp/legacy/index.html"),
                "text/html",
                html.getBytes(shiftJis)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);
        Document parsed = Jsoup.parse(rewritten);

        assertThat(parsed.body().text()).contains("福祉サービス案内");
        assertThat(parsed.select("meta[charset]")).hasSize(1);
        assertThat(parsed.selectFirst("meta[charset]").attr("charset")).isEqualTo("UTF-8");
    }

    @Test
    void sniffsUtf8BomAndEmitsOneUtf8MetaDeclaration() {
        byte[] body = "<html><body>접근성 분석</body></html>".getBytes(StandardCharsets.UTF_8);
        byte[] withBom = new byte[body.length + 3];
        withBom[0] = (byte) 0xEF;
        withBom[1] = (byte) 0xBB;
        withBom[2] = (byte) 0xBF;
        System.arraycopy(body, 0, withBom, 3, body.length);
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/utf8"),
                "text/html",
                withBom
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);
        Document parsed = Jsoup.parse(rewritten);

        assertThat(parsed.body().text()).contains("접근성 분석");
        assertThat(parsed.select("meta[charset]")).hasSize(1);
        assertThat(rewritten).doesNotStartWith("\uFEFF");
    }

    @Test
    void rewritesBaseRelativeImportMapKeysValuesAndScopesWithoutChangingBareSpecifiers() {
        String html = """
                <html><head><base href="/app/ui/">
                <script type="importmap">{
                  "imports": {
                    "./entry": "./modules/entry.js",
                    "react": "https://cdn.example.net/react.js",
                    "bare": "pkg",
                    "disabled": null
                  },
                  "scopes": {
                    "/admin/": {
                      "./feature": "../feature.js",
                      "react": "./react-admin.js"
                    }
                  }
                }</script></head><body></body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.html"),
                "text/html;charset=UTF-8",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);
        Element importMap = Jsoup.parse(rewritten).selectFirst("script[type=importmap]");
        assertThat(importMap).isNotNull();
        String json = importMap.data();

        assertThat(json).contains(mirror("https://www.example.com/app/ui/entry"));
        assertThat(json).contains(mirror("https://www.example.com/app/ui/modules/entry.js"));
        assertThat(json).contains("\"react\":\"" + mirror("https://cdn.example.net/react.js") + "\"");
        assertThat(json).contains("\"bare\":\"pkg\"");
        assertThat(json).contains("\"disabled\":null");
        assertThat(json).contains(mirror("https://www.example.com/admin/"));
        assertThat(json).contains(mirror("https://www.example.com/app/ui/feature"));
        assertThat(json).contains(mirror("https://www.example.com/app/feature.js"));
        assertThat(json).contains(mirror("https://www.example.com/app/ui/react-admin.js"));
    }

    @Test
    void leavesInvalidImportMapJsonUntouched() {
        String invalid = "{\"imports\":{\"app\":\"./app.js\",}}";
        String html = "<html><head><script type=\"importmap\">" + invalid + "</script></head></html>";
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.html"),
                "text/html;charset=UTF-8",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(Jsoup.parse(rewritten).selectFirst("script[type=importmap]").data()).isEqualTo(invalid);
        assertThat(rewritten).doesNotContain(mirror("https://www.example.com/app/app.js"));
    }

    @Test
    void allowsOnlyGetFormsThroughNativeSubmissionAndKeepsHistoryGuardsGeneric() {
        String html = """
                <html><body>
                  <form id="search" method="get" action="/search" target="_blank"><input name="q"></form>
                  <form id="mutating" method="post" action="/account"></form>
                  <form id="cross-origin" action="https://search.example.net/find">
                    <input name="q"><button name="scope" value="all" formaction="/advanced" formtarget="_top">Go</button>
                  </form>
                  <form id="unsafe" action="javascript:alert(1)"></form>
                </body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.html"),
                "text/html;charset=UTF-8",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);
        Document parsed = Jsoup.parse(rewritten);

        assertThat(parsed.selectFirst("#search").attr("action")).isEqualTo(mirror("https://www.example.com/search"));
        assertThat(parsed.selectFirst("#mutating").attr("action")).isEqualTo(mirror("https://www.example.com/account"));
        assertThat(parsed.selectFirst("#cross-origin").attr("action"))
                .isEqualTo(mirror("https://search.example.net/find"));
        assertThat(parsed.selectFirst("#cross-origin button").attr("formaction"))
                .isEqualTo(mirror("https://www.example.com/advanced"));
        assertThat(parsed.selectFirst("#unsafe").hasAttr("action")).isFalse();
        assertThat(rewritten).contains("const nativeFormSubmit = HTMLFormElement.prototype.submit");
        assertThat(rewritten).contains("const nativeFormRequestSubmit = HTMLFormElement.prototype.requestSubmit");
        assertThat(rewritten).contains("HTMLFormElement.prototype.submit = function()");
        assertThat(rewritten).contains("HTMLFormElement.prototype.requestSubmit = function(submitter)");
        assertThat(rewritten).contains("const prepareGetForm = (form, submitter = null) =>");
        assertThat(rewritten).contains("if (formMethod(form, submitter) !== 'GET') return false");
        assertThat(rewritten).contains("const destination = proxyUrl(rawAction, currentUpstreamBase())");
        assertThat(rewritten).contains("nativeSetAttribute.call(form, 'action', destination)");
        assertThat(rewritten).contains("nativeSetAttribute.call(submitter, 'formtarget', '_self')");
        assertThat(rewritten).contains("nativeSetAttribute.call(form, 'target', '_self')");
        assertThat(rewritten).contains("return nativeApply(nativeFormSubmit, this, [])");
        assertThat(rewritten).contains("return nativeApply(nativeFormRequestSubmit, this,");
        assertThat(rewritten).contains("if (prepareGetForm(form, submitter)) return");
        assertThat(rewritten).contains("Form submission is unavailable in live report mode");
        assertThat(rewritten).contains("post({type:'FORM_BLOCKED'");
        assertThat(rewritten).contains("normalized === 'post' ? 'POST' : normalized === 'dialog' ? 'DIALOG' : 'GET'");
        assertThat(rewritten).contains("const upstream = decodeSessionResource(value) || resolveUpstream(value, currentUpstreamBase())");
        assertThat(rewritten).contains("pageDocumentUrl = target.upstream");
        assertThat(rewritten).contains("patchDocumentUrlProperty('URL')");
    }

    @Test
    void guardsActionControlsWhileLeavingReadOnlyNavigationAvailable() {
        String html = """
                <html><body>
                  <a id="article-link" href="/article">Article</a>
                  <button id="tab" type="button" role="tab" aria-controls="panel">Tab</button>
                  <section id="carousel" class="swiper carousel">
                    <button id="previous-slide" type="button" class="swiper-button-prev">Previous</button>
                    <button id="next-slide" type="button" class="swiper-button-next">Next</button>
                  </section>
                  <nav class="pagination" aria-label="Pagination">
                    <button id="next-page" type="button" aria-label="Next page">2</button>
                  </nav>
                  <form id="search" method="get" action="/search">
                    <input name="q"><button id="search-submit" type="submit">Search</button>
                  </form>
                  <button id="apply" type="button">Apply</button>
                  <button id="save" type="submit">Save</button>
                  <div id="custom-action" role="button" tabindex="0">Delete</div>
                </body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.html"),
                "text/html;charset=UTF-8",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains("const actionControlSelector =");
        assertThat(rewritten).contains("const isReplayUiTarget =");
        assertThat(rewritten).contains("nativeApply(nativeNodeContains, layer, [target])");
        assertThat(rewritten).contains("nativeApply(nativeNodeContains, popover, [target])");
        assertThat(rewritten).contains("const isAllowedNavigationControl =");
        assertThat(rewritten).contains("const blockedActionControl =");
        assertThat(rewritten).contains("const guardReadOnlyInteraction =");
        assertThat(rewritten).contains("a[href]");
        assertThat(rewritten).contains("role=tab");
        assertThat(rewritten).contains("tablist");
        assertThat(rewritten).contains("carousel");
        assertThat(rewritten).contains("pagination");
        assertThat(rewritten).contains("slider");
        assertThat(rewritten).contains("formMethod(form, control) !== 'GET'");
        assertThat(rewritten).contains("'pointerdown'");
        assertThat(rewritten).contains("'pointerup'");
        assertThat(rewritten).contains("'mousedown'");
        assertThat(rewritten).contains("'mouseup'");
        assertThat(rewritten).contains("'touchstart'");
        assertThat(rewritten).contains("'touchend'");
        assertThat(rewritten).contains("'click'");
        assertThat(rewritten).contains("'dblclick'");
        assertThat(rewritten).contains("'auxclick'");
        assertThat(rewritten).contains("event.key !== 'Enter'");
        assertThat(rewritten).contains("event.key !== ' '");
        assertThat(rewritten).contains("if (trusted !== true) return");
        assertThat(rewritten).contains("nativeApply(nativePreventDefault, event, [])");
        assertThat(rewritten).contains("nativeApply(nativeStopImmediatePropagation, event, [])");

        int interactionGuardIndex = rewritten.indexOf("const guardReadOnlyInteraction =");
        int anchorNavigationIndex = rewritten.indexOf("document.addEventListener('click'");
        assertThat(interactionGuardIndex).isGreaterThanOrEqualTo(0).isLessThan(anchorNavigationIndex);
    }

    @Test
    void ignoresUnsafeOrMalformedBaseHref() {
        String html = """
                <html><head><base href="http://127.0.0.1/private/"></head>
                <body><img src="logo.png"></body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.html"),
                "text/html",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains(mirror("https://www.example.com/app/logo.png"));
        assertThat(rewritten).doesNotContain("127.0.0.1");
        assertThat(rewritten).contains("const upstreamBase = 'https://www.example.com/app/index.html'");
    }

    @Test
    void rewritesRelativeUrlsInsideExternalStylesheet() {
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://static.example.com/css/site/main.css"),
                "text/css",
                "@import '../base.css'; .icon{background:url(../../img/icon.svg)}".getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteCss(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains(".localhost:9090");
        assertThat(rewritten).contains(mirror("https://static.example.com/css/base.css"));
        assertThat(rewritten).contains(mirror("https://static.example.com/img/icon.svg"));
    }

    @Test
    void malformedLargeQuotedCssUrlDoesNotOverflowTheRegexStack() {
        String malformed = ".hero{background:url(\"" + "a".repeat(250_000) + ")}"
                + ".icon{background:url('../img/icon.svg')}";
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://static.example.com/css/main.css"),
                "text/css",
                malformed.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteCss(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains(mirror("https://static.example.com/img/icon.svg"));
        assertThat(rewritten).startsWith(".hero{background:url(\"");
    }

    @Test
    void decodesExternalCssUsingCharsetDeclarationAndEmitsUtf8() {
        Charset windows31j = Charset.forName("windows-31j");
        String css = "@charset \"windows-31j\"; .label::before{content:'日本語'} .hero{background:url('../画像.png')}";
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://static.example.com/css/main.css"),
                "text/css",
                css.getBytes(windows31j)
        );

        String rewritten = new String(rewriter.rewriteCss(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).startsWith("@charset \"UTF-8\";");
        assertThat(rewritten).contains("日本語");
        assertThat(rewritten).contains(mirror("https://static.example.com/画像.png"));
    }

    @Test
    void contentTypeCharsetTakesPrecedenceForExternalJavaScript() {
        Charset eucKr = Charset.forName("EUC-KR");
        String javascript = "const label = '동적 메뉴'; export { label };";
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://static.example.com/app.js"),
                "application/javascript; charset=EUC-KR",
                javascript.getBytes(eucKr)
        );

        String rewritten = new String(rewriter.rewriteJavaScript(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).isEqualTo(javascript);
    }

    @Test
    void handlesDataCandidatesSeparatelyFromFollowingSrcsetUrls() {
        String html = """
                <html><body><img srcset="data:image/svg+xml,%3Csvg%3E 1x, ./large.png 2x"></body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/gallery/index.html"),
                "text/html",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains("data:image/svg+xml,%3Csvg%3E 1x");
        assertThat(rewritten).contains(mirror("https://www.example.com/gallery/large.png"));
    }

    @Test
    void preservesFragmentsButRemovesExplicitlyUnsafeNetworkAndScriptAttributes() {
        String html = """
                <html><body>
                  <a id="fragment" href="#details">Details</a>
                  <a id="script" href="java\nscript:alert(1)">unsafe</a>
                  <img id="mixed" src="http://insecure.example/image.png">
                  <svg><use href="./icons.svg#search"></use></svg>
                </body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.html"),
                "text/html",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains("id=\"fragment\" href=\"#details\"");
        assertThat(rewritten).contains("id=\"script\">unsafe</a>");
        assertThat(rewritten).contains("id=\"mixed\"");
        assertThat(rewritten).doesNotContain("insecure.example");
        assertThat(rewritten).contains(mirror("https://www.example.com/app/icons.svg#search"));
        assertThat(rewritten).contains("#search");
    }

    @Test
    void failsClosedBeforeProxyUrlExpansionExceedsConfiguredOutputBudget() {
        LiveReportProperties constrained = new LiveReportProperties();
        constrained.setMaxRewrittenResponseBytes(64 * 1024);
        LiveReportDocumentRewriter constrainedRewriter = new LiveReportDocumentRewriter(
                constrained,
                originRoutes
        );
        StringBuilder html = new StringBuilder("<html><body>");
        for (int index = 0; index < 1_000; index++) {
            html.append("<img src=\"asset-").append(index).append(".png\">");
        }
        html.append("</body></html>");
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/page"),
                "text/html",
                html.toString().getBytes(StandardCharsets.UTF_8)
        );

        assertThatThrownBy(() -> constrainedRewriter.rewriteHtml(resource, session))
                .isInstanceOfSatisfying(LiveReportException.class, exception -> {
                    assertThat(exception.getStatus().value()).isEqualTo(413);
                    assertThat(exception.getMessage()).contains("rewritten response");
                });
    }

    @Test
    void rewritesOnlyUrlLikeStaticReExportAndLiteralDynamicModuleSpecifiers() {
        String javascript = """
                import "./setup.js";
                import defaults, { feature as renamed } from '../chunks/feature.js';
                export * from "/chunks/public.js";
                export { widget } from "https://cdn.example.net/widget.mjs?v=2#module";
                const lazy = import(/* webpackChunkName: "lazy" */ "./lazy.js");
                const rootLazy = import('/chunks/root-lazy.js', { with: { type: 'javascript' } });
                import framework from "react";
                export { helper } from "@scope/helpers";
                const inline = import("data:text/javascript,export default 1");
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://static.example.com/assets/app/main.mjs"),
                "text/javascript;charset=UTF-8",
                javascript.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteJavaScript(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains(".localhost:9090");
        assertThat(rewritten).contains(mirror("https://static.example.com/assets/app/setup.js"));
        assertThat(rewritten).contains(mirror("https://static.example.com/assets/chunks/feature.js"));
        assertThat(rewritten).contains(mirror("https://static.example.com/chunks/public.js"));
        assertThat(rewritten).contains(mirror("https://cdn.example.net/widget.mjs?v=2#module"));
        assertThat(rewritten).contains("#module");
        assertThat(rewritten).contains(mirror("https://static.example.com/assets/app/lazy.js"));
        assertThat(rewritten).contains(mirror("https://static.example.com/chunks/root-lazy.js"));
        assertThat(rewritten).contains("from \"react\"");
        assertThat(rewritten).contains("from \"@scope/helpers\"");
        assertThat(rewritten).contains("import(\"data:text/javascript,export default 1\")");
    }

    @Test
    void preservesCommentsArbitraryStringsTemplatesRegexPropertiesAndComputedImports() {
        String javascript = """
                // import "./comment.js";
                /* export * from "./block-comment.js"; */
                const text = "import('./ordinary-string.js')";
                const template = `export * from "./template.js"`;
                const nestedTemplate = `outer ${`inner ${"import('./nested-template.js')"}`} tail`;
                const expression = /import\\(['"]\\.\\/regex-only/;
                loader.import('./method.js');
                const object = { import: value, from: "./object-value.js" };
                const computed = import(`./${chunkName}.js`);
                const concatenated = import('./prefix-' + chunkName + '.js');
                import "./escaped\\u002dname.js";
                console.log(import.meta.url);
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://static.example.com/app/main.js"),
                "application/javascript",
                javascript.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteJavaScript(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).isEqualTo(javascript);
    }

    @Test
    void rewritesMinifiedHashedChunkImportsUsedByNuxtStyleBundles() {
        String javascript = """
                const a=()=>import("./B8H1w4Kp.js"),b=()=>import("../chunks/Cf91_a2Z.mjs"),
                c=()=>import("https://cdn.example.net/_nuxt/D-4eF0.js");export{a,b,c};
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://plus.example/_nuxt/z5J4PQQh.js"),
                "application/javascript;charset=utf-8",
                javascript.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteJavaScript(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains(mirror("https://plus.example/_nuxt/B8H1w4Kp.js"));
        assertThat(rewritten).contains(mirror("https://plus.example/chunks/Cf91_a2Z.mjs"));
        assertThat(rewritten).contains(mirror("https://cdn.example.net/_nuxt/D-4eF0.js"));
        assertThat(rewritten).doesNotContain("import(\"./B8H1w4Kp.js\")");
        assertThat(rewritten).doesNotContain("import(\"../chunks/Cf91_a2Z.mjs\")");
    }

    @Test
    void rewritesInlineJavaScriptModulesButLeavesDataScriptsUntouched() {
        String html = """
                <html><head>
                  <script type="module">import { boot } from "./boot.js"; boot();</script>
                  <script>const lazy = () => import('/chunks/lazy.js');</script>
                  <script type="application/ld+json">{"example":"import('./not-code.js')"}</script>
                </head><body></body></html>
                """;
        LiveReportFetchService.FetchedResource resource = new LiveReportFetchService.FetchedResource(
                URI.create("https://www.example.com/app/index.html"),
                "text/html;charset=UTF-8",
                html.getBytes(StandardCharsets.UTF_8)
        );

        String rewritten = new String(rewriter.rewriteHtml(resource, session), StandardCharsets.UTF_8);

        assertThat(rewritten).contains(mirror("https://www.example.com/app/boot.js"));
        assertThat(rewritten).contains(mirror("https://www.example.com/chunks/lazy.js"));
        assertThat(rewritten).contains("{\"example\":\"import('./not-code.js')\"}");
        assertThat(rewritten).doesNotContain(mirror("https://www.example.com/app/not-code.js"));
    }

    @Test
    void mirrorPathsPreserveBrowserRelativeBasesForCurrentScriptImportMetaAndCss() {
        URI scriptUri = URI.create("https://plus.example/_nuxt/assets/app/main.js?v=4");
        URI styleUri = URI.create("https://cdn.example.net/theme/dark/main.css");

        String scriptMirror = mirror(scriptUri.toString());
        String styleMirror = mirror(styleUri.toString());
        URI viewerOrigin = URI.create("https://dashboard.test");

        assertThat(viewerOrigin.resolve(scriptMirror).resolve("./runtime.js"))
                .hasToString(viewerOrigin.resolve(mirror("https://plus.example/_nuxt/assets/app/runtime.js")).toString());
        assertThat(viewerOrigin.resolve(styleMirror).resolve("../fonts/body.woff2"))
                .hasToString(viewerOrigin.resolve(mirror("https://cdn.example.net/theme/fonts/body.woff2")).toString());

        String rewrittenScript = new String(rewriter.rewriteJavaScript(
                new LiveReportFetchService.FetchedResource(scriptUri, "text/javascript", "import './runtime.js';".getBytes(StandardCharsets.UTF_8)),
                session
        ), StandardCharsets.UTF_8);
        assertThat(rewrittenScript).contains(mirror("https://plus.example/_nuxt/assets/app/runtime.js"));
    }

    private String documentToken(String html) {
        Matcher matcher = Pattern.compile("const documentToken = '([0-9a-f]{32})'").matcher(html);
        assertThat(matcher.find()).isTrue();
        return matcher.group(1);
    }

    private String mirror(String upstreamUrl) {
        return originRoutes.runtimeUrl(session, URI.create(upstreamUrl));
    }
}
