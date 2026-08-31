package com.accessibility.platform.artifact.service;

import com.accessibility.platform.artifact.exception.ArtifactValidationException;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Attribute;
import org.jsoup.nodes.DataNode;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ReplayDocumentSanitizerTest {

    private final ReplayDocumentSanitizer sanitizer = new ReplayDocumentSanitizer();

    @Test
    void removesExecutableAndNavigatingContentButPreservesPageStructure() throws Exception {
        String unsafe = """
                <!doctype html>
                <html onload="steal()" data-uni-accessibility-replay-animations-paused="false"
                      data-uni-accessibility-replay-auto-hidden-popup="true"><head>
                  <base href="https://attacker.example/">
                  <meta http-equiv="refresh" content="0;url=https://attacker.example/">
                  <meta http-equiv="Content-Security-Policy" content="default-src *">
                  <link rel="preload" href="/evil.js" as="script">
                  <link rel="stylesheet" href="/app.css">
                  <script>steal()</script>
                  <style>.hero { color: green }</style>
                </head><body>
                  <main id="main" onclick="steal()"><img src="/hero.png" onerror="steal()"></main>
                  <iframe src="https://attacker.example/" srcdoc="<script>steal()</script>"></iframe>
                  <object data="https://attacker.example/"></object><embed src="evil"><applet></applet>
                  <form action="https://attacker.example/submit" target="_top">
                    <label>Name <input id="name" value="editable"></label>
                    <label><input id="choice" type="checkbox" checked> Choice</label>
                    <select id="select"><option selected>One</option><option>Two</option></select>
                    <button formaction="https://attacker.example/" formmethod="post" formtarget="_top">Send</button>
                  </form>
                  <div id="editable" contenteditable="true">Editable locally</div>
                  <details id="details" open><summary>More</summary><p>Locally interactive content</p></details>
                  <section id="annotated-slide" data-ua-audit-carousel-id="7"
                           data-ua-audit-slide-index="1" data-ua-audit-slide-count="3">Slide</section>
                  <a id="bad" href="java&#x0A;script:steal()" ping="https://attacker.example/ping">Bad</a>
                  <a id="good" href="/details">Details</a>
                  <svg><a id="svg-link" xlink:href="https://attacker.example/svg-link"><text>SVG link</text></a></svg>
                  <div id="__uni_accessibility_replay_host" data-uni-accessibility-replay-control="spoofed">
                    <template shadowrootmode="open"><script>shadowSteal()</script><button id="inside" onclick="shadowSteal()">Inside</button></template>
                  </div>
                </body></html>
                """;

        byte[] bytes = sanitizer.sanitize(unsafe.getBytes(StandardCharsets.UTF_8), "https://example.com/final").bytes();
        Document replay = Jsoup.parse(new String(bytes, StandardCharsets.UTF_8));

        assertThat(replay.select("base")).hasSize(1);
        assertThat(replay.selectFirst("html")
                .attr("data-uni-accessibility-replay-animations-paused")).isEqualTo("true");
        assertThat(replay.selectFirst("html")
                .hasAttr("data-uni-accessibility-replay-auto-hidden-popup")).isFalse();
        assertThat(replay.selectFirst("base").attr("href")).isEqualTo("https://example.com/final");
        assertThat(replay.select("script")).hasSize(1);
        assertThat(replay.selectFirst("script").id()).isEqualTo("__uni_accessibility_replay_bridge");
        assertThat(replay.select("iframe,frame,frameset,object,embed,applet,meta[http-equiv]")).isEmpty();
        assertThat(replay.select("link")).hasSize(1);
        assertThat(replay.selectFirst("link").attr("rel")).isEqualTo("stylesheet");
        assertThat(replay.selectFirst("#main")).isNotNull();
        assertThat(replay.selectFirst("#main img").attr("src")).isEqualTo("/hero.png");
        assertThat(replay.selectFirst("#bad").hasAttr("href")).isFalse();
        assertThat(replay.selectFirst("#good").hasAttr("href")).isFalse();
        assertThat(replay.selectFirst("#good").attr("data-uni-accessibility-replay-href")).isEqualTo("/details");
        assertThat(replay.selectFirst("#svg-link").hasAttr("xlink:href")).isFalse();
        assertThat(replay.selectFirst("#svg-link").attr("data-uni-accessibility-replay-href"))
                .isEqualTo("https://attacker.example/svg-link");
        assertThat(replay.selectFirst("form").hasAttr("action")).isFalse();
        assertThat(replay.selectFirst("form button").hasAttr("formmethod")).isFalse();
        assertThat(replay.selectFirst("form button").hasAttr("formtarget")).isFalse();
        assertThat(replay.selectFirst("#name").hasAttr("disabled")).isFalse();
        assertThat(replay.selectFirst("#name").attr("value")).isEqualTo("editable");
        assertThat(replay.selectFirst("#choice").hasAttr("checked")).isTrue();
        assertThat(replay.selectFirst("#select").hasAttr("disabled")).isFalse();
        assertThat(replay.selectFirst("#editable").attr("contenteditable")).isEqualTo("true");
        assertThat(replay.selectFirst("#details").hasAttr("open")).isTrue();
        assertThat(replay.selectFirst("#annotated-slide").attributes().dataset())
                .containsEntry("ua-audit-carousel-id", "7")
                .containsEntry("ua-audit-slide-index", "1")
                .containsEntry("ua-audit-slide-count", "3");
        assertThat(replay.select("[data-uni-accessibility-replay-control],"
                + "[data-uni-accessibility-replay-disabled]")).isEmpty();
        assertThat(replay.selectFirst("#__uni_accessibility_replay_style").data())
                .doesNotContain("data-uni-accessibility-replay-control", "data-uni-accessibility-replay-disabled");
        assertThat(replay.selectFirst("template[shadowrootmode=open] #inside")).isNotNull();
        assertThat(replay.selectFirst("template[shadowrootmode=open] #inside").hasAttr("onclick")).isFalse();
        // The original page cannot pre-claim the reserved runtime host ID. The
        // trusted bridge creates that host only after the replay is loaded.
        assertThat(replay.select("#__uni_accessibility_replay_host")).isEmpty();
        assertThat(replay.selectFirst("template[shadowrootmode=open]").parent().id())
                .doesNotStartWith("__uni_accessibility_replay_");

        for (Element element : replay.getAllElements()) {
            for (Attribute attribute : element.attributes()) {
                assertThat(attribute.getKey().toLowerCase()).doesNotStartWith("on");
                assertThat(attribute.getKey().toLowerCase()).isNotEqualTo("srcdoc");
            }
        }
    }

    @Test
    void cspHashMatchesTheExactInjectedBridgeScript() throws Exception {
        byte[] bytes = sanitizer.sanitize(
                "<html><body><p>Replay</p></body></html>".getBytes(StandardCharsets.UTF_8),
                "https://example.com/"
        ).bytes();
        Document replay = Jsoup.parse(new String(bytes, StandardCharsets.UTF_8));
        String script = replay.selectFirst("#__uni_accessibility_replay_bridge").data();
        String expected = "'sha256-" + Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(script.getBytes(StandardCharsets.UTF_8))
        ) + "'";

        assertThat(sanitizer.bridgeScriptCspSource()).isEqualTo(expected);
        assertThat(script).contains(
                "source: REPLAY_SOURCE",
                "...message,",
                "documentToken: replayDocumentToken",
                "INIT_ISSUES",
                "FOCUS_ISSUE",
                "SET_MARKERS_VISIBLE",
                "REQUEST_DOCUMENT_STATE",
                "DOCUMENT_LOADING",
                "DOCUMENT_UNLOADING",
                "documentToken: replayDocumentToken",
                "LOCATOR_STATUS",
                "LINK_BLOCKED",
                "ISSUE_DETAIL_FALLBACK",
                "const MARKER_GAP = 8",
                "const MARKER_SLOT_STEP = 40",
                "const REPLAY_VIEW_SCALE_MIN = 0.01",
                "const REPLAY_VIEW_SCALE_MAX = 1",
                "const REPLAY_VISUAL_WIDTH_MAX = 16384",
                "const MARKER_GUTTER_MATCH_TOLERANCE = 0.5",
                "const POPOVER_GAP = 12",
                "const POPOVER_VIEWPORT_MARGIN = 12",
                "const POPOVER_TARGET_CLEARANCE = 6",
                "const POPOVER_PREFERRED_MAX_MARKER_DISTANCE = 48",
                "const POPOVER_DENSITIES = ['normal', 'compact', 'minimal']",
                "const POPOVER_GROUP_NARROW_WIDTHS = [320, 280, 260, 240]",
                "const POPOVER_WIDE_WIDTHS = [840, 760, 680, 600, 560]",
                "const POPOVER_MAX_LAYOUT_CANDIDATES = POPOVER_DENSITIES.length",
                "+ POPOVER_GROUP_NARROW_WIDTHS.length",
                "+ POPOVER_WIDE_WIDTHS.length",
                "const POPOVER_LEAVE_GRACE_MS = 120",
                "const POPOVER_MAX_LEAVE_GRACE_MS = 700",
                "const POPOVER_POINTER_TRAVEL_MS_PER_PX = 1.5",
                "const MAX_SEVERITY_LENGTH = 32",
                "const MAX_SEVERITY_LABEL_LENGTH = 32",
                "const MAX_CODE_LENGTH = 128",
                "const MAX_TITLE_LENGTH = 300",
                "const MAX_MESSAGE_LENGTH = 1600",
                "const MAX_TEXT_ANALYSIS_TOTAL_LENGTH = 2400",
                "const MAX_TEXT_ANALYSIS_SOURCE_LENGTH = 800",
                "const MAX_TEXT_ANALYSIS_FLAG_LENGTH = 320",
                "const MAX_TEXT_ANALYSIS_FLAGS = 12",
                "const MAX_TEXT_ANALYSIS_SUGGESTION_LENGTH = 600",
                "const MAX_TEXT_ANALYSIS_SUGGESTIONS = 4",
                "const MAX_TEXT_ANALYSIS_REVISION_LENGTH = 800",
                "const MAX_TEXT_ANALYSIS_REASON_LENGTH = 500",
                "const MAX_PATH_LENGTH = 2048",
                "const MAX_GROUP_ACCESSIBLE_LABEL_ISSUES = 4",
                "const GROUP_POPOVER_PAGE_SIZE = 4",
                "const MAX_GROUP_POPOVER_MEASUREMENT_ISSUES = 32",
                "const SELECTION_FRAGMENT_OFFSET = 3",
                "const MAX_SELECTION_FRAGMENTS = 128",
                "const MARKER_BLUE_GLASS = 'rgba(0,102,204,.94)'",
                "const MARKER_COLOR_BY_SEVERITY = Object.freeze({",
                "CRITICAL: 'rgba(122,39,26,.96)'",
                "HIGH: 'rgba(180,35,24,.96)'",
                "MEDIUM: 'rgba(181,71,8,.96)'",
                "LOW: 'rgba(2,107,63,.96)'",
                "const MARKER_SIZE = 24",
                "appearance:none",
                "display:grid",
                "place-items:center",
                "width:24px; height:24px",
                "padding:0",
                "background:transparent",
                "color:transparent",
                "const ISSUE_CATEGORY_LABELS = Object.freeze({",
                "interaction: '상호작용'",
                "const KWCAG_CATEGORY_BY_CODE = Object.freeze({",
                "const SINGLE_ISSUE_CATEGORIES = new Set([",
                "category: normalizeIssueCategory(issue.category) || classifyIssueCategory(normalized)",
                "const markerCategoryForIssues = (issues) =>",
                "const markerSeverityForIssues = (issues) =>",
                "entry.button.dataset.markerCategory = markerCategory",
                "entry.button.dataset.markerSeverity = markerSeverity.key",
                "entry.button.style.setProperty('--marker-color', markerSeverity.color)",
                "const MARKER_ICON_SHAPES = Object.freeze({",
                "const createMarkerIcon = (category) =>",
                "icon.dataset.icon = resolvedCategory",
                "for (const [tagName, attributes] of MARKER_ICON_SHAPES[resolvedCategory])",
                "const createMarkerBadge = () =>",
                "badge.className = 'marker__badge'",
                "icon.classList.add('marker__icon')",
                "'M3 7V5a2 2 0 0 1 2-2h2'",
                "['circle', { cx: '12', cy: '12', r: '3' }]",
                "const badge = createMarkerBadge()",
                "button.appendChild(badge)",
                ".marker__badge { box-sizing:border-box; display:grid; place-items:center",
                "width:20px; height:20px",
                "background:var(--marker-color,#0066cc)",
                "color:#fff",
                ".marker__icon { display:block; width:14px; height:14px",
                ".marker[hidden] { display:none !important; }",
                ".marker:hover .marker__badge { transform:scale(1.12); }",
                ".marker[data-selected='true'] .marker__badge { transform:scale(1.2)",
                "@media (prefers-reduced-motion:reduce)",
                ".marker:focus-visible { outline:3px solid #101828; outline-offset:3px; }",
                ":host::before,:host::after { content:none !important",
                ".issue-popover { all:initial",
                "width:clamp(220px,34vw,360px)",
                "max-width:calc(var(--replay-visual-width,100vw) - 24px)",
                "overflow:visible",
                "touch-action:manipulation",
                "pointer-events:auto",
                ".issue-popover[hidden] { display:none !important; }",
                ".issue-popover__group { display:block",
                ".issue-popover__group[hidden] { display:none !important; }",
                ".issue-popover__pager { display:flex",
                ".issue-popover__page-button { appearance:none",
                ".issue-popover__page-button:focus-visible",
                ".issue-popover__page-status { min-width:42px",
                ".issue-popover__issues { display:grid",
                ".issue-popover__issues[hidden] { display:none !important; }",
                ".issue-popover__issue[aria-pressed='true']",
                ".issue-popover__detail { display:block",
                ".issue-popover[data-content-scroll='true'] .issue-popover__detail",
                ".issue-popover__tag { display:inline-flex",
                "white-space:normal; overflow-wrap:anywhere; word-break:break-word",
                ".issue-popover__title { display:block",
                "text-wrap:balance; word-break:keep-all; overflow-wrap:anywhere",
                ".issue-popover__message { display:grid",
                ".issue-popover__message-section { display:grid",
                ".issue-popover__message-label { display:block",
                ".issue-popover__message-value { margin:0",
                ".issue-popover__message-list { display:grid",
                ".issue-popover__path { display:block",
                "const updateIssuePopoverSelection = (entry, issueId) =>",
                "const groupedPopoverMeasurementCandidates = (entry, selectedIssue) =>",
                "weight: JSON.stringify(issue).length",
                "const measureStableGroupedPopover = (entry, layout, reserveGroupPage = true) =>",
                "const selectedPage = issuePopoverGroupPage",
                "const measurementCandidates = groupedPopoverMeasurementCandidates(",
                "for (const { issue: candidate, index } of measurementCandidates)",
                "setIssuePopoverContent(entry, candidate.id, pageIndex)",
                "setIssuePopoverContent(entry, selectedIssue.id, selectedPage)",
                "const preservesGroupedPopover = Boolean(issuePopover && !issuePopover.hidden)",
                "issuePopover.style.height = `${documentToScreenLength(stableHeight)}px`",
                "preserveOpenPopover = false",
                "if (!preserveOpenPopover) schedulePositions()",
                "!rectanglesOverlap(markerRect, visibleViewport)",
                "const popoverRoot = issuePopover.getRootNode()",
                "const restoresPopoverFocus = issuePopover.contains(focusedElement)",
                "pinnedIssueId = null",
                "pinnedSelectionOwned = false",
                "suppressNextMarkerFocusPreview = true",
                "hideIssuePopover();",
                ".issue-popover[data-density='compact'] { padding:12px; }",
                ".issue-popover[data-density='minimal'] { padding:10px; }",
                ".issue-popover[data-density='minimal'] .issue-popover__title",
                ".issue-popover[data-density='minimal'] .issue-popover__message",
                ".issue-popover[data-layout='wide'] { display:grid",
                "grid-template-areas:'group pager' 'issues issues' 'detail detail'",
                "grid-template-columns:minmax(0,.8fr) minmax(0,2.1fr) minmax(0,1.35fr)",
                ".issue-popover[data-layout='wide'] .issue-popover__message { grid-area:message; align-self:start; margin:0; font-size:12.5px; line-height:1.5; }",
                ".issue-popover[data-layout='wide'] .issue-popover__path { grid-area:path; align-self:start; margin:0; padding:7px 8px; font-size:11px; line-height:1.45; }",
                ".issue-popover[data-layout='wide'] .issue-popover__group",
                ".issue-popover[data-layout='wide'] .issue-popover__message",
                ".issue-popover[data-layout='wide'] .issue-popover__path",
                ".issue-popover[data-presentation='external-description'] { position:fixed",
                "clip-path:inset(50%) !important",
                "pointer-events:none !important; transform:none !important",
                "@media (forced-colors:active)",
                ".selection-layer {",
                ".selection-fragment {",
                "border:var(--replay-selection-border-width,3px) solid #0066cc",
                "pointer-events:none",
                "selectionLayer.setAttribute('aria-hidden', 'true')",
                "const SLIDER_SETTLE_FRAMES = 3",
                "const MAX_CAROUSEL_SLIDES = 500",
                "data-ua-audit-carousel-id",
                "const buildAnnotatedSliderCandidates =",
                "const findSliderForTarget =",
                "const composedClosest =",
                "const carouselControlDirection =",
                "const enhanceCarouselControls =",
                ".swiper-container",
                ".main-vi-prev",
                ".main-vi-next",
                "!control.hasAttribute('aria-controls')",
                "const targetDocumentRects =",
                "Array.from(target.getClientRects())",
                "const selectionRectsForTarget =",
                "if (rects.length <= MAX_SELECTION_FRAGMENTS) return rects",
                "const updateSelectedTargetHighlight =",
                "fragment.className = 'selection-fragment'",
                "const highlightSelectedTarget =",
                "const normalizeIssue = (issue) =>",
                "const normalizeTextAnalysisList = (value, maximumItems, maximumLength, takeText) =>",
                "const normalizeTextAnalysis = (value) =>",
                "textAnalysis: normalizeTextAnalysis(issue.textAnalysis)",
                "const appendIssueMessageSection = (container, label, values, asList = false) =>",
                "const renderIssueMessage = (issue) =>",
                "container.replaceChildren()",
                "container.textContent = issue.message",
                "renderIssueMessage(issue)",
                "const popoverMessage = document.createElement('div')",
                "button.dataset.markerIndex = String(plan.firstIndex + 1)",
                "const formatIssueCodeLabel = (code) =>",
                "if (/^(?:KWCAG|WCAG)\\s+/i.test(code)) return code",
                "return /^[0-9]+(?:[.][0-9]+)+$/.test(code) ? `KWCAG ${code}` : code",
                "const seenIssueIds = new Set()",
                "seenIssueIds.has(rawIssue.id)",
                "seenIssueIds.add(rawIssue.id)",
                "const issueAccessibleLabel = (issue) =>",
                "formatIssueCodeLabel(issue.code)",
                "const markerGroups = new Set()",
                "const markerGroupKeyForIssue = (issueId) =>",
                "const markerInteractionIssue = (entry) =>",
                "let highestSeverityIssue = entry.issues[0]",
                "if (candidateRank <= highestSeverityRank) continue",
                "const markerGroupAccessibleLabel = (entry) =>",
                "const refreshMarkerGroupPresentation = (entry) =>",
                "entry.button.dataset.issueIds = entry.issues.map((issue) => String(issue.id)).join(',')",
                "const buildMarkerGroupPlans = (resolvedIssues) =>",
                "const rawGroupsByTarget = new Map()",
                "const sectorCandidatesForTarget = (target, candidateCache) =>",
                "members.size >= MIN_SECTOR_GROUP_TARGETS",
                "groupScope: 'sector'",
                "const issueTargetForEntry = (entry, issueId) =>",
                "for (const plan of buildMarkerGroupPlans(resolvedIssues))",
                "for (const issue of entry.issues) markers.set(issueKey(issue.id), entry)",
                "const rectangleDistance = (left, right) => Math.hypot(",
                "const hideIssuePopover = () =>",
                "const concealIssuePopover = () =>",
                "const postIssueDetailFallback = (issueId) =>",
                "if (issueDetailFallbackId === nextIssueId) return",
                "post({ type: 'ISSUE_DETAIL_FALLBACK', issueId: nextIssueId })",
                "const clearIssueDetailFallback = () =>",
                "const reportLocatorStatus = (issueId, status, reason = '') =>",
                "placement.position ? '' : 'NO_VISIBLE_MARKER_POSITION'",
                "const createReplayDocumentToken = () =>",
                "globalThis.crypto.getRandomValues(values)",
                "const screenToDocumentLength = (value) => value / replayViewScale",
                "const overlayTransform = (left, top) =>",
                "const applyReplayViewScale = (message, host) =>",
                "message.documentToken !== replayDocumentToken",
                "--replay-overlay-inverse-scale",
                "--replay-visual-width",
                "--replay-selection-border-width",
                "window.addEventListener('beforeunload', postDocumentUnloading, { once: true })",
                "window.addEventListener('pagehide', postDocumentUnloading, { once: true })",
                "post({ type: 'DOCUMENT_LOADING', documentToken: replayDocumentToken })",
                "post({ type: 'READY', documentToken: replayDocumentToken })",
                "if (message.type === 'REQUEST_DOCUMENT_STATE')",
                "message.type === 'SET_VIEW_SCALE'",
                "applyReplayViewScale(message, host)",
                "const positionIssuePopover = () =>",
                "const findIssuePopoverCandidate = (width, height) =>",
                "let layoutCandidateCount = 0",
                "layoutCandidateCount >= POPOVER_MAX_LAYOUT_CANDIDATES",
                "issuePopover.scrollWidth > issuePopover.clientWidth + 1",
                "issuePopover.scrollHeight > issuePopover.clientHeight + 1",
                "const showIssuePopover = (issueId, anchorElement = null) =>",
                "issuePopoverElements.issueList.replaceChildren()",
                "const activateIssueFromPopover = (issueId) =>",
                "const groupPageCount = Math.max(",
                "Math.ceil(entry.issues.length / GROUP_POPOVER_PAGE_SIZE)",
                "const pageIssues = entry.issues.slice(pageStart, pageStart + GROUP_POPOVER_PAGE_SIZE)",
                "pageIssues.forEach((candidate, index) =>",
                "summary.type = 'button'",
                "summary.setAttribute('aria-pressed', String(candidate.id === issue.id))",
                "summary.dataset.issueId = issueKey(candidate.id)",
                "activateIssueFromPopover(candidate.id)",
                "issuePopoverElements.issueList.appendChild(summary)",
                "const changeIssuePopoverGroupPage = (direction) =>",
                "issuePopoverElements.pageStatus.textContent = `${issuePopoverGroupPage + 1} / ${groupPageCount}`",
                "const expandedTargetRects = targetRects.map((rect) =>",
                "const overlapsPopoverObstacle = (rect) =>",
                "markerSpatialIndex.hasMarkerRectOverlap(rect)",
                "const targetUnion = expandedTargetRects.reduce",
                "const anchors = [anchorRect, markerRect, targetUnion]",
                "const clearUnavailableMarkerPreview = () =>",
                "const previewCleared = clearUnavailableMarkerPreview()",
                "if (overlapsPopoverObstacle(rect)) continue",
                "const markerDistance = rectangleDistance(rect, anchorRect)",
                "if (markerDistance < popoverGap - screenToDocumentLength(1)) continue",
                "candidate.markerDistance <= popoverPreferredMaxMarkerDistance",
                "let fallbackLayout = null",
                "selected.fallback.score < fallbackLayout.selected.score",
                "Math.ceil(documentToScreenLength(selected.markerDistance) * POPOVER_POINTER_TRAVEL_MS_PER_PX)",
                "score: markerDistance * 10000",
                "candidates.sort((left, right) => left.score - right.score)",
                "for (const density of POPOVER_DENSITIES)",
                "else issuePopover.dataset.density = layout.density",
                "issuePopover.dataset.layout = 'wide'",
                "const availableWidth = Math.floor(viewportRight - minLeft)",
                "for (const width of POPOVER_GROUP_NARROW_WIDTHS)",
                "for (const width of POPOVER_WIDE_WIDTHS)",
                "if (layout.width) issuePopover.style.width = `${layout.width}px`",
                "if (!selected) return false",
                "issuePopover.dataset.placement = selected.placement",
                "const presentIssuePopoverAsExternalDescription = () =>",
                "issuePopover.dataset.presentation = 'external-description'",
                "issuePopover.setAttribute('aria-hidden', 'false')",
                "postIssueDetailFallback(popoverIssueId)",
                "const findMarkerPosition =",
                "const markerPositionAvailable =",
                "firstRect.left - markerSize - markerGap",
                "firstRect.top - markerSize - markerGap",
                "firstRect.right + markerGap",
                "firstRect.bottom + markerGap",
                "rectanglesOverlap(markerRect, targetRect)",
                "const markerRectForPosition = (position) => {",
                "right: position.left + markerSize + markerHalo",
                "getComputedStyle(entry.target).direction === 'rtl'",
                "const outsideDocument =",
                "const nextMarkerSpatialIndex = createMarkerSpatialIndex()",
                "const searchCursors = new Map()",
                "const targetGeometryCache = new WeakMap()",
                "const placements = []",
                "baselineMarkerSpatialIndex.add(position)",
                "nextMarkerSpatialIndex.add(placement.position)",
                "for (const placement of placements)",
                "overlayTransform(placement.position.left, placement.position.top)",
                "issuePopover.style.transform = overlayTransform(",
                "const markerBatch = document.createDocumentFragment()",
                "button.hidden = true",
                "markerBatch.appendChild(button)",
                "shadowRoot.appendChild(markerBatch)",
                "updateSelectedTargetHighlight();",
                "positionIssuePopover();",
                "for (const root of collectReplayRoots())",
                "root.getAnimations({ subtree: true })",
                "svg.pauseAnimations()",
                "document.addEventListener('animationstart', pauseNewAnimations, true)",
                "document.addEventListener('transitionrun', pauseNewAnimations, true)",
                "document.addEventListener('scroll', () =>",
                "{ capture: true, passive: true }",
                "const observeReplayRootScroll =",
                "root.addEventListener('scroll', schedulePositions, { capture: true, passive: true })",
                "selectedTargetResizeObserver = new ResizeObserver",
                "schedulePositions(SLIDER_SETTLE_FRAMES);",
                "entry.button.isConnected && !entry.button.hidden",
                "schedulePositions(SLIDER_SETTLE_FRAMES)",
                "const AUTO_HIDDEN_POPUP_ATTRIBUTE =",
                "const autoHidePopups =",
                "const isReasonablePopup =",
                "const isApplicationShell =",
                "const hasPopupCandidateAncestor =",
                "const isComposedWithin =",
                "const suppressRootHorizontalScroll =",
                "suppressRootHorizontalScroll();",
                "const releasePageScrollLock =",
                "'cookie', 'consent', 'notice', 'toast'",
                "const fixedPopupCandidate = position === 'fixed'",
                "const dismissibleLayer =",
                "element.matches('header,nav,[role=\"banner\"],[role=\"navigation\"]')",
                "element.querySelector('main,[role=\"main\"]')",
                "element.style.setProperty('overflow-y', 'auto', 'important')",
                "element.style.setProperty('position', 'static', 'important')",
                "popup.setAttribute(AUTO_HIDDEN_POPUP_ATTRIBUTE, 'true')",
                "autoHidePopups();",
                "root instanceof ShadowRoot && root.host && root.host.id === HOST_ID",
                "const moveSafeSlider = (delta, slider) =>",
                "moveSafeSlider(carouselControlDirection(control), slider)",
                "if (issueTarget && revealSlider) revealSliderForTarget(issueTarget)",
                "const selectAndNotifyIssue = (",
                "if (skipIfSelected && issueKey(selectedIssueId) === issueKey(issueId)) return false",
                "selectIssue(issueId, moveFocus, revealSlider, preserveOpenPopover)",
                "post({ type: 'ISSUE_SELECTED', issueId })",
                "const previewIssueFromMarker = (button, issueId, pointerType = '') =>",
                "pointerType === 'touch'",
                "|| pinnedIssueId !== null",
                "|| button.hidden",
                "|| !button.isConnected",
                "const markerPreviewIsActive = (preview) =>",
                "let suppressNextMarkerFocusPreview = false",
                "const cancelMarkerPreviewClear = () =>",
                "const scheduleMarkerPreviewClear = (key, withPointerGrace) =>",
                "markerPreviewClearTimer = window.setTimeout(() =>",
                "POPOVER_LEAVE_GRACE_MS",
                "const endMarkerPreview = (issueId, source, pointerType = '') =>",
                "activeMarkerPreview.key !== key",
                "markerPreviewClearFrame = requestAnimationFrame(() =>",
                "const previewIssueId = preview.issueId",
                "preview.ownsSelection",
                "issueKey(selectedIssueId) === issueKey(previewIssueId)",
                "selectAndNotifyIssue(null, false, true, false)",
                "selectAndNotifyIssue(issueId, false, true, false)",
                "showIssuePopover(issueId)",
                "const dismissPinnedIssue = () =>",
                "button.addEventListener('pointerenter', (event) =>",
                "previewIssueFromMarker(button, interactionIssueId(), event.pointerType)",
                "button.addEventListener('pointerleave', (event) =>",
                "endMarkerPreview(interactionIssueId(), 'pointer', event.pointerType)",
                "button.addEventListener('pointercancel', (event) =>",
                "button.addEventListener('pointerdown', (event) =>",
                "button.addEventListener('focus', () =>",
                "button.matches(':focus-visible')",
                "previewIssueFromMarker(button, interactionIssueId())",
                "button.addEventListener('blur', () =>",
                "endMarkerPreview(interactionIssueId(), 'focus')",
                "selectAndNotifyIssue(activeIssueId, false, true)",
                "const opensGroupedSelector = keyboardActivation && entry.issues.length > 1",
                "if (pointerType === 'touch' || !keyboardActivation || opensGroupedSelector)",
                "pinnedIssueId = activeIssueId",
                "pinnedSelectionOwned = inheritsPreviewSelection || inheritsPinnedSelection",
                "pinnedIssueId = null",
                "pinnedSelectionOwned = false",
                "event.detail === 0 && button.matches(':focus')",
                "activeMarkerPreview.focus = true",
                "const beginIssuePopoverPreview = (source, pointerType = '') =>",
                "const keyboardActivation = event.detail === 0 && button.matches(':focus')",
                "requestAnimationFrame(() => focusIssuePopoverSelector(activeIssueId))",
                "suppressNextMarkerFocusPreview = true",
                "issuePopover.setAttribute('aria-hidden', 'true')",
                "issuePopover.setAttribute('aria-hidden', 'false')",
                "const descriptionTarget = issuePopoverDescriptionTarget || entry.button",
                "entry.button.setAttribute('aria-expanded', 'true')",
                "descriptionTarget.setAttribute('aria-describedby', issuePopover.id)",
                "issuePopover.setAttribute('role', 'tooltip')",
                "issuePopover.setAttribute('role', 'dialog')",
                "popoverPreviousPage.setAttribute('aria-label', '이전 문제 묶음 보기')",
                "popoverPageStatus.setAttribute('aria-live', 'polite')",
                "popoverNextPage.setAttribute('aria-label', '다음 문제 묶음 보기')",
                "issuePopover.addEventListener('pointerenter'",
                "issuePopover.addEventListener('pointerleave'",
                "issuePopoverElements = {",
                "document.addEventListener('pointerdown', (event) =>",
                "pinnedIssueId !== null",
                "event.target !== host",
                "const dismissActiveMarkerPreview = () =>",
                "if (dismissPinnedIssue())",
                "dismissActiveMarkerPreview()",
                "entry.button.hidden = true",
                "entry.position = null",
                "const incomingIssueId = typeof message.issueId === 'number' ? message.issueId : null",
                "incomingIssueId === null",
                "activeMarkerPreview.key !== markerGroupKeyForIssue(incomingIssueId)",
                "if (located.slider.activated && located.slider.index === located.index) return true",
                "event.source !== window.parent"
        );
        assertThat(script).containsOnlyOnce("post({ type: 'ISSUE_SELECTED', issueId });");
        assertThat(script).containsOnlyOnce(
                "post({ type: 'ISSUE_DETAIL_FALLBACK', issueId: nextIssueId });"
        );
        assertThat(script).contains("normalizedValues.join('\\n')");
        assertThat(script).contains("post({ type: 'DOCUMENT_LOADING', documentToken: replayDocumentToken });");
        assertThat(script).contains(
                ".issue-popover[data-content-scroll='true'] .issue-popover__detail { min-height:0; "
                        + "overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }"
        );
        assertThat(script).containsOnlyOnce(
                "post({ type: 'DOCUMENT_UNLOADING', documentToken: replayDocumentToken });"
        );
        assertThat(script).doesNotContain(
                "POPOVER_MAX_MARKER_DISTANCE",
                "button.textContent = String(index + 1)",
                "targetSlots",
                "slot * 22",
                "const MARKER_SIZE = 32",
                "selectedTargetStyle",
                "outlineSelectedTarget",
                "target.style.setProperty('outline'",
                "target.style.setProperty('outline-offset'",
                "dismissedSelector",
                "targetSelector",
                "SET_DISMISS_MODE",
                "UNDO_HIDDEN_ELEMENT",
                "RESET_HIDDEN_ELEMENTS",
                "dismissMode",
                "hiddenCount",
                "dismiss-preview",
                "dismissPointerMove",
                "dismissKeyDown",
                "resolveDismissTarget",
                "SET_ANIMATIONS_PLAYING",
                "SLIDER_PREVIOUS",
                "SLIDER_NEXT",
                "REPLAY_UI_STATE",
                "const MARKER_SIZE = 26",
                "width:26px; height:26px",
                "font:700 12px/1 system-ui,sans-serif",
                "return '#dc6803'",
                "markerGlowColor",
                "--marker-glow",
                ".marker[data-selected='true'] { z-index:2; box-shadow:",
                "0 0 0 3px #fff,0 0 0 6px var(--marker-color)",
                "reportReplayUiState",
                "scheduleReplayUiState",
                "uiStateFrame",
                "primarySlider",
                "detectPrimarySlider",
                "invalidateUnactivatedSliderCandidate",
                "SLIDER_AUTOPLAY_MS",
                "sliderAutoplayTimer",
                "setInterval(",
                "selectIssue(issue.id, true);",
                "animationsPlaying",
                "const anchors = [markerRect, ...targetRects]",
                "issuePopover.innerHTML",
                "insertAdjacentHTML",
                "eval(",
                "new Function",
                "document.write",
                "window.open",
                "location.href",
                "POPOVER_HEIGHT_STEP",
                "POPOVER_MIN_SCROLL_HEIGHT",
                "POPOVER_SCROLL_HEIGHTS",
                "height -= 4",
                "-webkit-line-clamp:",
                "text-overflow:clip",
                "text-overflow:ellipsis",
                "data-scrollable",
                "issue-popover-scroll-indicator",
                "scrollIssuePopoverByKey",
                "issuePopover.scrollTop",
                "issuePopover.focus({ preventScroll: true })",
                "issuePopover.tabIndex",
                "issuePopover.addEventListener('scroll'",
                "popoverFocus",
                "issuePopover.setAttribute('role', 'region')",
                "issuePopover.setAttribute('role', 'presentation')"
        );

        String bridgeStyle = replay.selectFirst("#__uni_accessibility_replay_style").data();
        assertThat(bridgeStyle).contains(
                "scrollbar-gutter: auto !important",
                "overflow-x: hidden !important",
                "@supports (overflow-x: clip)",
                "overflow-x: clip !important",
                "@supports not selector(::-webkit-scrollbar)",
                "scrollbar-width: thin !important",
                "scrollbar-color: rgba(99, 99, 102, .78) transparent !important",
                "@supports selector(::-webkit-scrollbar)",
                "html::-webkit-scrollbar",
                "width: 10px !important",
                "html::-webkit-scrollbar:horizontal",
                "height: 0 !important",
                "html::-webkit-scrollbar-thumb",
                "min-height: 48px !important",
                "border-radius: 999px !important",
                "background-clip: padding-box !important",
                "html::-webkit-scrollbar-thumb:hover",
                "html::-webkit-scrollbar-thumb:active",
                "html::-webkit-scrollbar-button",
                "display: none !important",
                "@media (forced-colors: active)",
                "scrollbar-width: auto !important",
                "scrollbar-color: auto !important",
                "#__uni_accessibility_replay_host#__uni_accessibility_replay_host",
                "#__uni_accessibility_replay_host::before",
                "content: none !important",
                "pointer-events: none !important",
                "html[data-uni-accessibility-replay-animations-paused='true'] *",
                "animation-play-state: paused !important",
                "[data-uni-accessibility-replay-auto-hidden-popup='true']",
                "display: none !important"
        ).doesNotContain("data-uni-accessibility-replay-dismiss-mode", "cursor: crosshair");
    }

    @Test
    void boundsMarkerPlacementAndSelectionWorkWithSpatialIndexes() {
        byte[] bytes = sanitizer.sanitize(
                "<html><body><main>Replay</main></body></html>".getBytes(StandardCharsets.UTF_8),
                "https://example.com/"
        ).bytes();
        Document replay = Jsoup.parse(new String(bytes, StandardCharsets.UTF_8));
        String script = replay.selectFirst("#__uni_accessibility_replay_bridge").data();

        assertThat(script).contains(
                "const createMarkerSpatialIndex = () =>",
                "const cells = new Map()",
                "for (let cellX = originCellX - 1; cellX <= originCellX + 1; cellX += 1)",
                "for (let cellY = originCellY - 1; cellY <= originCellY + 1; cellY += 1)",
                "if (spatialIndex.hasCollision(left, top)) return false",
                "const markerSearchKey =",
                "families.map((family) => [",
                "targetRects.map((rect) => [rect.left, rect.top, rect.right, rect.bottom])",
                "let cursor = searchCursors.get(searchKey)",
                "cursor = { familyIndex: 0, slot: 0, offsetIndex: 0 }",
                "const nextMarkerSpatialIndex = createMarkerSpatialIndex()",
                "markerSpatialIndex = nextMarkerSpatialIndex",
                "markerSpatialIndex.hasMarkerRectOverlap(rect)",
                "const previousEntry = markers.get(issueKey(selectedIssueId))",
                "previousEntry.button.dataset.selected = 'false'",
                "entry.button.dataset.selected = 'true'",
                "button.dataset.selected = 'false'"
        ).doesNotContain(
                "occupied.some((position)",
                "occupied.push(position)"
        );
        assertThat(script).contains(
                "const families = preferRightGutter",
                "? [rightGutter, topGutter, leftGutter, bottomGutter]",
                ": [leftGutter, topGutter, rightGutter, bottomGutter]",
                "const offsetCount = cursor.slot === 0 ? 1 : 2",
                "const verticalSlots = Math.max(1, Math.ceil((maxTop - minTop) / markerSlotStep))",
                "const horizontalSlots = Math.max(1, Math.ceil((maxLeft - minLeft) / markerSlotStep))",
                "const offset = cursor.slot === 0",
                ": (cursor.offsetIndex === 0 ? 1 : -1) * cursor.slot * markerSlotStep",
                "for (let candidate = nextMarkerCandidate(families, cursor)",
                "if (markerPositionAvailable(",
                ")) return candidate"
        );

        int popoverStart = script.indexOf("const positionIssuePopover =");
        int popoverEnd = script.indexOf("const showIssuePopover =", popoverStart);
        assertThat(popoverStart).isGreaterThanOrEqualTo(0);
        assertThat(popoverEnd).isGreaterThan(popoverStart);
        assertThat(script.substring(popoverStart, popoverEnd))
                .contains("overlapsPopoverObstacle(rect)")
                .doesNotContain("markers.values()");

        int selectionStart = script.indexOf("const selectIssue =");
        int selectionEnd = script.indexOf("const selectAndNotifyIssue =", selectionStart);
        assertThat(selectionStart).isGreaterThanOrEqualTo(0);
        assertThat(selectionEnd).isGreaterThan(selectionStart);
        assertThat(script.substring(selectionStart, selectionEnd)).doesNotContain("markers.values()");

        int positionsStart = script.indexOf("const updatePositions =");
        int placementsWriteStart = script.indexOf("for (const placement of placements)", positionsStart);
        int positionsEnd = script.indexOf("const schedulePositions =", positionsStart);
        assertThat(positionsStart).isGreaterThanOrEqualTo(0);
        assertThat(placementsWriteStart).isGreaterThan(positionsStart);
        assertThat(positionsEnd).isGreaterThan(placementsWriteStart);
        assertThat(script.substring(positionsStart, placementsWriteStart))
                .contains("readDocumentRects(entry.target)", "findMarkerPosition(")
                .doesNotContain(
                        "entry.button.hidden =",
                        "entry.button.style.transform =",
                        "entry.position ="
                );
        assertThat(script.substring(placementsWriteStart, positionsEnd)).containsSubsequence(
                "placement.entry.position = placement.position",
                "placement.entry.button.hidden = !placement.position",
                "placement.entry.button.style.transform ="
        );
    }

    @Test
    void keepsIssueMarkersClearOnlyOfResolvedCarouselControls() {
        byte[] bytes = sanitizer.sanitize(
                ("<html><body><a href=\"/next\"><span id=\"target\">Target</span></a>"
                        + "<button>Action</button><div class=\"main-vi-prev\"></div></body></html>")
                        .getBytes(StandardCharsets.UTF_8),
                "https://example.com/"
        ).bytes();
        Document replay = Jsoup.parse(new String(bytes, StandardCharsets.UTF_8));
        String script = replay.selectFirst("#__uni_accessibility_replay_bridge").data();

        assertThat(script).contains(
                "const CAROUSEL_CONTROL_CLEARANCE = 4",
                "const CAROUSEL_MARKER_RELOCATION_SLOTS = 4",
                "const CAROUSEL_CONTROL_HIT_TARGET_SIZE = 24",
                "const CAROUSEL_CONTROL_SELECTOR = [",
                "'.swiper-button-prev'",
                "'.swiper-button-next'",
                "'.slick-prev'",
                "'.slick-next'",
                "'.splide__arrow'",
                "'.main-vi-btn'",
                "'.main-vi-prev'",
                "'.main-vi-next'",
                "'[aria-controls]'",
                "const createCarouselControlObstacleIndex =",
                "for (const root of collectReplayRoots())",
                "root.querySelectorAll(CAROUSEL_CONTROL_SELECTOR)",
                "carouselControlDirection(control) === 0",
                "!resolveControlSlider(control)",
                "for (const rect of readDocumentRects(control))",
                "const centerX = (rect.left + rect.right) / 2",
                "const centerY = (rect.top + rect.bottom) / 2",
                "const hitWidth = Math.min(controlHitTargetSize, rect.width)",
                "left: centerX - hitWidth / 2 - controlClearance",
                "carouselControlObstacles && carouselControlObstacles.hasOverlap(markerRect)",
                "const documentRectCache = new WeakMap()",
                "const carouselControlObstacles = createCarouselControlObstacleIndex(",
                "const baselineMarkerSpatialIndex = createMarkerSpatialIndex()",
                "geometry.visibleTargetRects, baselineMarkerSpatialIndex, null, searchCursors",
                "const carouselCollisionPlacements = []",
                "carouselControlObstacles.hasOverlap(markerRectForPosition(placement.position))",
                "const findNearestCarouselSafeMarkerPosition = (",
                "const baselineFamilyIndex = families.findIndex((family) =>",
                "Math.abs(baseline.left - family.baseLeft) <= gutterMatchTolerance",
                "Math.abs(baseline.top - family.baseTop) <= gutterMatchTolerance",
                "familyRank: baselineFamilyIndex < 0 || familyIndex === baselineFamilyIndex ? 0 : 1",
                "left.familyRank - right.familyRank",
                "|| left.distance - right.distance",
                "|| left.order - right.order",
                "placement.position = findNearestCarouselSafeMarkerPosition("
        );
        assertThat(script).doesNotContain(
                "INTERACTIVE_CONTROL_SELECTOR",
                "createInteractiveObstacleSpatialIndex",
                "isInteractiveObstacle",
                "shouldProtectFullInteractiveRect",
                "audio[controls]",
                "video[controls]",
                "[contenteditable]",
                "left: rect.left - CAROUSEL_CONTROL_CLEARANCE",
                "right: rect.right + CAROUSEL_CONTROL_CLEARANCE"
        );

        int obstacleReadStart = script.indexOf("const carouselControlObstacles = createCarouselControlObstacleIndex(");
        int markerReadStart = script.indexOf("for (const entry of markerGroups)", obstacleReadStart);
        int placementWriteStart = script.indexOf("for (const placement of placements)", markerReadStart);
        assertThat(obstacleReadStart).isGreaterThanOrEqualTo(0);
        assertThat(markerReadStart).isGreaterThan(obstacleReadStart);
        assertThat(placementWriteStart).isGreaterThan(markerReadStart);
        assertThat(script.substring(obstacleReadStart, placementWriteStart))
                .doesNotContain("entry.button.hidden =", "entry.button.style.transform =");
    }

    @Test
    void markerGridCellCannotContainTwoAcceptedPositions() {
        int markerSlotStep = 40;
        double[] coordinates = {
                -80.25, -80, -79.999, -40.25, -40, -39.999,
                -0.25, 0, 0.001, 39.999, 40, 40.25, 79.999, 80
        };

        for (double firstLeft : coordinates) {
            for (double firstTop : coordinates) {
                for (double secondLeft : coordinates) {
                    for (double secondTop : coordinates) {
                        boolean sameCell = Math.floor(firstLeft / markerSlotStep)
                                == Math.floor(secondLeft / markerSlotStep)
                                && Math.floor(firstTop / markerSlotStep)
                                == Math.floor(secondTop / markerSlotStep);
                        if (!sameCell) continue;
                        assertThat(Math.abs(firstLeft - secondLeft)).isLessThan(markerSlotStep);
                        assertThat(Math.abs(firstTop - secondTop)).isLessThan(markerSlotStep);
                    }
                }
            }
        }
    }

    @Test
    void refreshesOnlyTheStoredBridgeRuntimeToTheCurrentVersion() {
        byte[] current = sanitizer.sanitize(
                "<html><body><main id=\"target\">Replay</main></body></html>".getBytes(StandardCharsets.UTF_8),
                "https://example.com/"
        ).bytes();
        Document legacy = Jsoup.parse(new String(current, StandardCharsets.UTF_8));
        Element legacyScript = legacy.selectFirst("#__uni_accessibility_replay_bridge");
        legacyScript.removeAttr("data-uni-accessibility-replay-bridge-sha256");
        legacyScript.empty().appendChild(new DataNode(
                legacyScript.data().replace(
                        "selectIssue(selectedIssueId, false, !issuesInitialized)",
                        "selectIssue(selectedIssueId, true, !issuesInitialized)"
                )
        ));

        byte[] refreshed = sanitizer.refreshBridge(
                legacy.outerHtml().getBytes(StandardCharsets.UTF_8)
        ).bytes();
        Document replay = Jsoup.parse(new String(refreshed, StandardCharsets.UTF_8));

        assertThat(replay.select("#__uni_accessibility_replay_style")).hasSize(1);
        assertThat(replay.select("#__uni_accessibility_replay_bridge")).hasSize(1);
        assertThat(replay.selectFirst("#__uni_accessibility_replay_bridge")
                .attr("data-uni-accessibility-replay-bridge-sha256")).hasSize(64);
        assertThat(replay.selectFirst("#__uni_accessibility_replay_bridge").data())
                .contains("selectIssue(selectedIssueId, false, !issuesInitialized)")
                .doesNotContain("selectIssue(selectedIssueId, true, !issuesInitialized)");
        assertThat(replay.selectFirst("#target").text()).isEqualTo("Replay");
        assertThat(sanitizer.bridgeStoragePrefix()).startsWith("replay-").endsWith("-");
    }

    @Test
    void rejectsNulAndMalformedUtf8() {
        assertThatThrownBy(() -> sanitizer.sanitize(
                "<p>bad\0value</p>".getBytes(StandardCharsets.UTF_8),
                "https://example.com/"
        )).isInstanceOf(ArtifactValidationException.class).hasMessageContaining("NUL");

        assertThatThrownBy(() -> sanitizer.sanitize(
                new byte[]{(byte) 0xC3, 0x28},
                "https://example.com/"
        )).isInstanceOf(ArtifactValidationException.class).hasMessageContaining("UTF-8");
    }
}
