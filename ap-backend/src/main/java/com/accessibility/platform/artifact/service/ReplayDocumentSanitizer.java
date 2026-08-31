package com.accessibility.platform.artifact.service;

import com.accessibility.platform.artifact.exception.ArtifactValidationException;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Attribute;
import org.jsoup.nodes.DataNode;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.parser.Parser;
import org.springframework.stereotype.Component;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;

@Component
public class ReplayDocumentSanitizer {

    private static final String BRIDGE_HOST_ID = "__uni_accessibility_replay_host";
    private static final String BRIDGE_STYLE_ID = "__uni_accessibility_replay_style";
    private static final String BRIDGE_SCRIPT_ID = "__uni_accessibility_replay_bridge";
    private static final String BRIDGE_VERSION_ATTRIBUTE = "data-uni-accessibility-replay-bridge-sha256";
    private static final String BRIDGE_ANIMATIONS_PAUSED_ATTRIBUTE =
            "data-uni-accessibility-replay-animations-paused";
    private static final Set<String> ALWAYS_REMOVED_ATTRIBUTES = Set.of(
            "srcdoc", "ping", "download", "autofocus",
            "formaction", "formenctype", "formmethod", "formnovalidate", "formtarget", "form", "nonce"
    );
    private static final Set<String> NAVIGATION_ATTRIBUTES = Set.of("action", "target");
    private static final Set<String> URL_ATTRIBUTES = Set.of(
            "href", "src", "poster", "background", "xlink:href"
    );

    private static final String BRIDGE_STYLE = """
            html,
            body {
              scrollbar-gutter: auto !important;
              overflow-x: hidden !important;
            }
            @supports (overflow-x: clip) {
              html,
              body {
                overflow-x: clip !important;
              }
            }
            @supports not selector(::-webkit-scrollbar) {
              html,
              body {
                scrollbar-width: thin !important;
                scrollbar-color: rgba(99, 99, 102, .78) transparent !important;
              }
              @media (forced-colors: active) {
                html,
                body {
                  scrollbar-width: auto !important;
                  scrollbar-color: auto !important;
                }
              }
            }
            @supports selector(::-webkit-scrollbar) {
              html::-webkit-scrollbar,
              body::-webkit-scrollbar {
                width: 10px !important;
                height: 10px !important;
              }
              html::-webkit-scrollbar:horizontal,
              body::-webkit-scrollbar:horizontal {
                display: none !important;
                height: 0 !important;
              }
              html::-webkit-scrollbar-track,
              body::-webkit-scrollbar-track,
              html::-webkit-scrollbar-corner,
              body::-webkit-scrollbar-corner {
                background: transparent !important;
              }
              html::-webkit-scrollbar-thumb,
              body::-webkit-scrollbar-thumb {
                min-height: 48px !important;
                border: 1px solid transparent !important;
                border-radius: 999px !important;
                background: rgba(99, 99, 102, .78) !important;
                background-clip: padding-box !important;
              }
              html::-webkit-scrollbar-thumb:hover,
              body::-webkit-scrollbar-thumb:hover {
                background: rgba(72, 72, 74, .88) !important;
                background-clip: padding-box !important;
              }
              html::-webkit-scrollbar-thumb:active,
              body::-webkit-scrollbar-thumb:active {
                background: rgba(44, 44, 46, .94) !important;
                background-clip: padding-box !important;
              }
              html::-webkit-scrollbar-button,
              body::-webkit-scrollbar-button {
                display: none !important;
                width: 0 !important;
                height: 0 !important;
              }
            }
            #__uni_accessibility_replay_host {
              all: initial !important;
              position: absolute !important;
              inset: 0 auto auto 0 !important;
              width: 0 !important;
              height: 0 !important;
              overflow: visible !important;
              z-index: 2147483647 !important;
              pointer-events: none !important;
              contain: none !important;
            }
            html > #__uni_accessibility_replay_host#__uni_accessibility_replay_host#__uni_accessibility_replay_host::before,
            html > #__uni_accessibility_replay_host#__uni_accessibility_replay_host#__uni_accessibility_replay_host::after {
              content: none !important;
              display: none !important;
              pointer-events: none !important;
            }
            html[data-uni-accessibility-replay-animations-paused='true'] *,
            html[data-uni-accessibility-replay-animations-paused='true'] *::before,
            html[data-uni-accessibility-replay-animations-paused='true'] *::after {
              animation-play-state: paused !important;
            }
            [data-uni-accessibility-replay-auto-hidden-popup='true'] {
              display: none !important;
            }
            """;

    private static final String BRIDGE_SCRIPT = String.join("",
            """
            (() => {
              'use strict';

              const PARENT_SOURCE = 'accessibility-dashboard';
              const REPLAY_SOURCE = 'accessibility-page-replay';
              const HOST_ID = '__uni_accessibility_replay_host';
              const ANIMATIONS_PAUSED_ATTRIBUTE = 'data-uni-accessibility-replay-animations-paused';
              const AUTO_HIDDEN_POPUP_ATTRIBUTE = 'data-uni-accessibility-replay-auto-hidden-popup';
              const MAX_ISSUES = 5000;
              const MARKER_BLUE_GLASS = 'rgba(0,102,204,.94)';
              const MARKER_COLOR_BY_SEVERITY = Object.freeze({
                CRITICAL: 'rgba(122,39,26,.96)',
                SERIOUS: 'rgba(180,35,24,.96)',
                HIGH: 'rgba(180,35,24,.96)',
                MODERATE: 'rgba(181,71,8,.96)',
                MEDIUM: 'rgba(181,71,8,.96)',
                MINOR: 'rgba(2,107,63,.96)',
                LOW: 'rgba(2,107,63,.96)'
              });
              const MARKER_SEVERITY_RANK = Object.freeze({
                CRITICAL: 4,
                SERIOUS: 3,
                HIGH: 3,
                MODERATE: 2,
                MEDIUM: 2,
                MINOR: 1,
                LOW: 1
              });
              const MARKER_SIZE = 24;
              const MARKER_HALO = 6;
              const MARKER_GAP = 8;
              const MARKER_SLOT_STEP = 40;
              const REPLAY_VIEW_SCALE_MIN = 0.01;
              const REPLAY_VIEW_SCALE_MAX = 1;
              const REPLAY_VISUAL_WIDTH_MAX = 16384;
              const MARKER_GUTTER_MATCH_TOLERANCE = 0.5;
              const CAROUSEL_MARKER_RELOCATION_SLOTS = 4;
              const CAROUSEL_CONTROL_HIT_TARGET_SIZE = 24;
              const CAROUSEL_CONTROL_CLEARANCE = 4;
              const CAROUSEL_CONTROL_SELECTOR = [
                '.swiper-button-prev',
                '.swiper-button-next',
                '.slick-prev',
                '.slick-next',
                '.splide__arrow',
                '.splide__arrow--prev',
                '.splide__arrow--next',
                '.main-vi-btn',
                '.main-vi-prev',
                '.main-vi-next',
                '[aria-controls]'
              ].join(',');
              const POPOVER_GAP = 12;
              const POPOVER_VIEWPORT_MARGIN = 12;
              const POPOVER_TARGET_CLEARANCE = 6;
              const POPOVER_PREFERRED_MAX_MARKER_DISTANCE = 48;
              const POPOVER_DENSITIES = ['normal', 'compact', 'minimal'];
              const POPOVER_GROUP_NARROW_WIDTHS = [320, 280, 260, 240];
              const POPOVER_WIDE_WIDTHS = [840, 760, 680, 600, 560];
              const POPOVER_MAX_LAYOUT_CANDIDATES = POPOVER_DENSITIES.length
                + POPOVER_GROUP_NARROW_WIDTHS.length
                + POPOVER_WIDE_WIDTHS.length;
              const POPOVER_LEAVE_GRACE_MS = 120;
              const POPOVER_MAX_LEAVE_GRACE_MS = 700;
              const POPOVER_POINTER_TRAVEL_MS_PER_PX = 1.5;
              const ISSUE_DOCK_ID = '__uni_accessibility_replay_issue_dock';
              const ISSUE_DOCK_PAGE_SIZE = 6;
              const ISSUE_DOCK_GAP = 6;
              const ISSUE_DOCK_VIEWPORT_MARGIN = 8;
              const MIN_SECTOR_GROUP_TARGETS = 3;
              const MAX_SECTOR_CANDIDATE_DEPTH = 10;
              const MAX_SEVERITY_LENGTH = 32;
              const MAX_SEVERITY_LABEL_LENGTH = 32;
              const MAX_CODE_LENGTH = 128;
              const MAX_TITLE_LENGTH = 300;
              const MAX_MESSAGE_LENGTH = 1600;
              const MAX_TEXT_ANALYSIS_TOTAL_LENGTH = 2400;
              const MAX_TEXT_ANALYSIS_SOURCE_LENGTH = 800;
              const MAX_TEXT_ANALYSIS_FLAG_LENGTH = 320;
              const MAX_TEXT_ANALYSIS_FLAGS = 12;
              const MAX_TEXT_ANALYSIS_SUGGESTION_LENGTH = 600;
              const MAX_TEXT_ANALYSIS_SUGGESTIONS = 4;
              const MAX_TEXT_ANALYSIS_REVISION_LENGTH = 800;
              const MAX_TEXT_ANALYSIS_REASON_LENGTH = 500;
              const MAX_PATH_LENGTH = 2048;
              const MAX_GROUP_ACCESSIBLE_LABEL_ISSUES = 4;
              const GROUP_POPOVER_PAGE_SIZE = 4;
              const MAX_GROUP_POPOVER_MEASUREMENT_ISSUES = 32;
              const SELECTION_FRAGMENT_OFFSET = 3;
              const MAX_SELECTION_FRAGMENTS = 128;
              const SLIDER_SETTLE_FRAMES = 3;
              const MAX_CAROUSEL_SLIDES = 500;
              const MAX_CAROUSEL_ID = 2147483647;
              const CAROUSEL_ID_ATTRIBUTE = 'data-ua-audit-carousel-id';
              const SLIDE_INDEX_ATTRIBUTE = 'data-ua-audit-slide-index';
              const SLIDE_COUNT_ATTRIBUTE = 'data-ua-audit-slide-count';
              const markers = new Map();
              const markerGroups = new Set();
              const reportedLocatorStatuses = new Map();
              const sliderRegistry = [];
              const motionGuardRoots = new WeakSet();
              const positionGuardRoots = new WeakSet();
              let markersVisible = true;
              let selectedIssueId = null;
              let activeMarkerPreview = null;
              let suppressNextMarkerFocusPreview = false;
              let markerPreviewClearFrame = 0;
              let markerPreviewClearTimer = 0;
              let pinnedIssueId = null;
              let pinnedSelectionOwned = false;
              let issuesInitialized = false;
              let selectedTarget = null;
              let selectionLayer = null;
              let issuePopover = null;
              let issuePopoverElements = null;
              let popoverIssueId = null;
              let issuePopoverAnchorElement = null;
              let issuePopoverDescriptionTarget = null;
              let issuePopoverGroupPage = 0;
              let popoverLeaveGraceMs = POPOVER_LEAVE_GRACE_MS;
              const issuePopoverFootprintCache = new WeakMap();
              let issueDock = null;
              let dockedEntry = null;
              let issueDockPage = 0;
              let issueDetailFallbackId = null;
              let selectedTargetResizeObserver = null;
              let positionFrame = 0;
              let positionPassesRemaining = 0;
              let markerSpatialIndex = null;
              let replayViewScale = 1;
              let replayVisualWidth = Math.max(1, window.innerWidth);

              const screenToDocumentLength = (value) => value / replayViewScale;
              const documentToScreenLength = (value) => value * replayViewScale;
              const replayMarkerSize = () => screenToDocumentLength(MARKER_SIZE);
              const replayMarkerHalo = () => screenToDocumentLength(MARKER_HALO);
              const replayMarkerGap = () => screenToDocumentLength(MARKER_GAP);
              const replayMarkerSlotStep = () => screenToDocumentLength(MARKER_SLOT_STEP);
              const overlayTransform = (left, top) =>
                `translate(${left}px, ${top}px) scale(${1 / replayViewScale})`;

              const createReplayDocumentToken = () => {
                const values = new Uint32Array(4);
                if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
                  globalThis.crypto.getRandomValues(values);
                } else {
                  for (let index = 0; index < values.length; index += 1) {
                    values[index] = Math.floor(Math.random() * 0x100000000);
                  }
                }
                return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
              };
              const replayDocumentToken = createReplayDocumentToken();
              const applyReplayViewScale = (message, host) => {
                if (!message || message.documentToken !== replayDocumentToken) return false;
                const nextScale = message.scale;
                const nextVisualWidth = message.visualWidth;
                if (typeof nextScale !== 'number'
                    || !Number.isFinite(nextScale)
                    || nextScale < REPLAY_VIEW_SCALE_MIN
                    || nextScale > REPLAY_VIEW_SCALE_MAX
                    || typeof nextVisualWidth !== 'number'
                    || !Number.isFinite(nextVisualWidth)
                    || nextVisualWidth <= 0
                    || nextVisualWidth > REPLAY_VISUAL_WIDTH_MAX) return false;
                if (Math.abs(replayViewScale - nextScale) < 0.0001
                    && Math.abs(replayVisualWidth - nextVisualWidth) < 0.1) return false;
                replayViewScale = nextScale;
                replayVisualWidth = nextVisualWidth;
                host.style.setProperty('--replay-overlay-inverse-scale', String(1 / replayViewScale));
                host.style.setProperty('--replay-visual-width', `${replayVisualWidth}px`);
                host.style.setProperty(
                  '--replay-selection-border-width',
                  `${screenToDocumentLength(SELECTION_FRAGMENT_OFFSET)}px`
                );
                return true;
              };
              const post = (message) => {
                window.parent.postMessage({
                  source: REPLAY_SOURCE,
                  ...message,
                  documentToken: replayDocumentToken
                }, '*');
              };
              const reportLocatorStatus = (issueId, status, reason = '') => {
                const key = issueKey(issueId);
                const signature = `${status}:${reason}`;
                if (reportedLocatorStatuses.get(key) === signature) return;
                reportedLocatorStatuses.set(key, signature);
                post({
                  type: 'LOCATOR_STATUS',
                  issueId,
                  status,
                  ...(reason ? { reason } : {})
                });
              };
              let documentUnloadingReported = false;
              const postDocumentUnloading = () => {
                if (documentUnloadingReported) return;
                documentUnloadingReported = true;
                post({ type: 'DOCUMENT_UNLOADING', documentToken: replayDocumentToken });
              };
              window.addEventListener('beforeunload', postDocumentUnloading, { once: true });
              window.addEventListener('pagehide', postDocumentUnloading, { once: true });
              post({ type: 'DOCUMENT_LOADING', documentToken: replayDocumentToken });

              const postIssueDetailFallback = (issueId) => {
                const nextIssueId = Number.isSafeInteger(issueId) && issueId > 0 ? issueId : null;
                if (issueDetailFallbackId === nextIssueId) return;
                issueDetailFallbackId = nextIssueId;
                post({ type: 'ISSUE_DETAIL_FALLBACK', issueId: nextIssueId });
              };

              const clearIssueDetailFallback = () => {
                postIssueDetailFallback(null);
              };

              const normalizeContext = (value) => String(value || 'DOCUMENT').toUpperCase();
              const issueKey = (id) => String(id);
              const boundedText = (value, maximum) =>
                typeof value === 'string' ? value.slice(0, maximum) : '';
              const formatIssueCodeLabel = (code) => {
                if (!code) return '';
                if (/^(?:KWCAG|WCAG)\\s+/i.test(code)) return code;
                return /^[0-9]+(?:[.][0-9]+)+$/.test(code) ? `KWCAG ${code}` : code;
              };

              const ISSUE_CATEGORY_LABELS = Object.freeze({
                visual: '시각',
                text: '텍스트',
                media: '이미지·미디어',
                navigation: '탐색·링크',
                form: '입력·폼',
                keyboard: '키보드',
                interaction: '상호작용',
                structure: '구조·의미',
                multiple: '복합',
                general: '일반'
              });
              const KWCAG_CATEGORY_BY_CODE = Object.freeze({
                '5.1.1': 'media',
                '5.2.1': 'media',
                '5.3.1': 'structure',
                '5.3.2': 'structure',
                '5.3.3': 'text',
                '5.4.1': 'visual',
                '5.4.2': 'media',
                '5.4.3': 'visual',
                '5.4.4': 'visual',
                '6.1.1': 'keyboard',
                '6.1.2': 'keyboard',
                '6.1.3': 'interaction',
                '6.1.4': 'keyboard',
                '6.2.1': 'interaction',
                '6.2.2': 'media',
                '6.3.1': 'visual',
                '6.4.1': 'keyboard',
                '6.4.2': 'structure',
                '6.4.3': 'navigation',
                '6.4.4': 'navigation',
                '6.5.1': 'interaction',
                '6.5.2': 'interaction',
                '6.5.3': 'form',
                '6.5.4': 'interaction',
                '7.1.1': 'structure',
                '7.2.1': 'interaction',
                '7.2.2': 'navigation',
                '7.3.1': 'form',
                '7.3.2': 'form',
                '7.3.3': 'form',
                '7.3.4': 'form',
                '8.1.1': 'structure',
                '8.2.1': 'structure'
              });
              const SINGLE_ISSUE_CATEGORIES = new Set([
                'visual',
                'text',
                'media',
                'navigation',
                'form',
                'keyboard',
                'interaction',
                'structure',
                'general'
              ]);
              const normalizeIssueCategory = (category) => {
                const normalized = String(category || '').trim().toLowerCase();
                return SINGLE_ISSUE_CATEGORIES.has(normalized) ? normalized : '';
              };
              const normalizeTextAnalysisList = (value, maximumItems, maximumLength, takeText) => {
                if (!Array.isArray(value)) return [];
                const normalized = [];
                const seen = new Set();
                for (const item of value) {
                  const text = takeText(item, maximumLength);
                  if (!text || seen.has(text)) continue;
                  seen.add(text);
                  normalized.push(text);
                  if (normalized.length >= maximumItems) break;
                }
                return normalized;
              };
              const normalizeTextAnalysis = (value) => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
                if (value.kind !== 'text-analysis') return null;
                let remainingLength = MAX_TEXT_ANALYSIS_TOTAL_LENGTH;
                const takeText = (textValue, maximumLength) => {
                  if (remainingLength <= 0) return '';
                  const text = boundedText(
                    textValue,
                    Math.min(maximumLength, remainingLength)
                  ).trim();
                  remainingLength -= text.length;
                  return text;
                };
                const sourceText = takeText(value.sourceText, MAX_TEXT_ANALYSIS_SOURCE_LENGTH);
                const flags = normalizeTextAnalysisList(
                  value.flags,
                  MAX_TEXT_ANALYSIS_FLAGS,
                  MAX_TEXT_ANALYSIS_FLAG_LENGTH,
                  takeText
                );
                const suggestions = normalizeTextAnalysisList(
                  value.suggestions,
                  MAX_TEXT_ANALYSIS_SUGGESTIONS,
                  MAX_TEXT_ANALYSIS_SUGGESTION_LENGTH,
                  takeText
                );
                const revisionValue = value.revision && typeof value.revision === 'object'
                  && !Array.isArray(value.revision) ? value.revision : null;
                const revisionText = revisionValue
                  ? takeText(revisionValue.text, MAX_TEXT_ANALYSIS_REVISION_LENGTH)
                  : '';
                const revisionReason = revisionValue
                  ? takeText(revisionValue.reason, MAX_TEXT_ANALYSIS_REASON_LENGTH)
                  : '';
                const revision = revisionText || revisionReason
                  ? { text: revisionText, reason: revisionReason }
                  : null;
                if (!sourceText && flags.length === 0 && suggestions.length === 0 && !revision) return null;
                return {
                  kind: 'text-analysis',
                  sourceText,
                  flags,
                  suggestions,
                  revision
                };
              };
              const normalizeIssueStandardCode = (code) => String(code || '')
                .trim()
                .toUpperCase()
                .replace(/^(?:KWCAG|WCAG)\\s+/, '');
              const classifyIssueCategory = (issue) => {
                const normalizedCode = normalizeIssueStandardCode(issue.code);
                const mappedCategory = KWCAG_CATEGORY_BY_CODE[normalizedCode];
                if (mappedCategory) return mappedCategory;
                const signature = `${issue.code || ''} ${issue.title || ''}`.toUpperCase();
                if (/(?:COLOR|CONTRAST|VISUAL|CV_|명도|대비|색상|시각|콘텐츠 간의 구분)/.test(signature)) return 'visual';
                if (/(?:IMAGE|IMG|ALT|CAPTION|VIDEO|AUDIO|MEDIA|대체 텍스트|자막|자동 재생|깜빡임|번쩍임)/.test(signature)) return 'media';
                if (/(?:LINK|NAV|BYPASS|SKIP|링크|탐색|건너뛰기|참조 위치|도움 정보)/.test(signature)) return 'navigation';
                if (/(?:FORM|INPUT|LABEL|AUTH|ERROR|레이블|입력|인증|오류 정정)/.test(signature)) return 'form';
                if (/(?:POINTER|TARGET_SIZE|GESTURE|포인터|동작기반|조작 가능|응답시간|사용자 요구)/.test(signature)) return 'interaction';
                if (/(?:KEYBOARD|FOCUS|SHORTCUT|키보드|초점|단축키)/.test(signature)) return 'keyboard';
                if (/(?:ARIA|ROLE|MARKUP|TABLE|STRUCTURE|SEMANTIC|표의 구성|선형구조|마크업|웹 애플리케이션)/.test(signature)) return 'structure';
                if (/(?:TEXT_DIFFICULTY|READING|LANG|TITLE|HEADING|TEXT|텍스트|문장|언어|제목|지시사항)/.test(signature)) return 'text';
                return 'general';
              };

              const normalizeIssue = (issue) => {
                const normalized = {
                  id: issue.id,
                  severity: boundedText(issue.severity, MAX_SEVERITY_LENGTH),
                  severityLabel: boundedText(issue.severityLabel, MAX_SEVERITY_LABEL_LENGTH),
                  code: boundedText(issue.code, MAX_CODE_LENGTH),
                  title: boundedText(issue.title, MAX_TITLE_LENGTH),
                  message: boundedText(issue.message, MAX_MESSAGE_LENGTH),
                  textAnalysis: normalizeTextAnalysis(issue.textAnalysis),
                  path: boundedText(issue.path, MAX_PATH_LENGTH),
                  pathSteps: Array.isArray(issue.pathSteps) ? issue.pathSteps : []
                };
                return {
                  ...normalized,
                  category: normalizeIssueCategory(issue.category) || classifyIssueCategory(normalized)
                };
              };

              const getPageAnimations = () => {
                const animations = new Set();
                for (const root of collectReplayRoots()) {
                  if (typeof root.getAnimations !== 'function') continue;
                  try {
                    for (const animation of root.getAnimations({ subtree: true })) animations.add(animation);
                  } catch {
                    try {
                      for (const animation of root.getAnimations()) animations.add(animation);
                    } catch { /* This root does not expose Web Animations. */ }
                  }
                }
                return Array.from(animations);
              };

              const pauseAnimationImmediately = (animation) => {
                try {
                  animation.playbackRate = 0;
                  animation.pause();
                } catch { /* A detached animation is harmless. */ }
              };

              const resolveIssue = (issue) => {
                const steps = Array.isArray(issue.pathSteps) ? issue.pathSteps : [];
                if (steps.length === 0) return { target: null, reason: 'EMPTY_PATH' };
                if (steps.some((step) => normalizeContext(step && step.context) === 'FRAME')) {
                  return { target: null, reason: 'FRAME_UNSUPPORTED' };
                }

                let root = document;
                let current = null;
                try {
                  for (const step of steps) {
                    if (!step || typeof step.selector !== 'string' || !step.selector.trim()) {
                      return { target: null, reason: 'INVALID_PATH_STEP' };
                    }
                    const context = normalizeContext(step.context);
                    if (context === 'DOCUMENT') {
                      root = document;
                    } else if (context === 'SHADOW_ROOT') {
                      if (!current || !current.shadowRoot) {
                        return { target: null, reason: 'SHADOW_ROOT_UNAVAILABLE' };
                      }
                      root = current.shadowRoot;
                    } else {
                      return { target: null, reason: 'UNSUPPORTED_CONTEXT' };
                    }
                    current = root.querySelector(step.selector);
                    if (!current) return { target: null, reason: 'SELECTOR_NOT_FOUND' };
                  }
                } catch {
                  return { target: null, reason: 'INVALID_SELECTOR' };
                }
                return { target: current, reason: null };
              };

              const targetComposedParent = (element) => {
                if (!(element instanceof Element)) return null;
                if (element.parentElement) return element.parentElement;
                const root = element.getRootNode();
                return root instanceof ShadowRoot && root.host instanceof Element ? root.host : null;
              };

              const targetDocumentRects = (target) => {
                if (!(target instanceof Element) || !target.isConnected) return [];
                const clippingAncestors = [];
                for (let current = target; current; current = targetComposedParent(current)) {
                  const style = getComputedStyle(current);
                  const opacity = Number.parseFloat(style.opacity);
                  if (current.hidden
                      || style.display === 'none'
                      || style.visibility === 'hidden'
                      || style.visibility === 'collapse'
                      || (Number.isFinite(opacity) && opacity <= 0)) return [];
                  if (current === target || current === document.documentElement || current === document.body) {
                    continue;
                  }
                  const containsPaint = String(style.contain || '').split(' ')
                    .some((token) => token === 'paint' || token === 'strict' || token === 'content');
                  const hasShapeClip = (style.clipPath && style.clipPath !== 'none')
                    || (style.webkitClipPath && style.webkitClipPath !== 'none')
                    || (style.clip && style.clip !== 'auto');
                  const clipX = containsPaint || hasShapeClip || style.overflowX !== 'visible';
                  const clipY = containsPaint || hasShapeClip || style.overflowY !== 'visible';
                  if (!clipX && !clipY) continue;
                  const bounds = current.getBoundingClientRect();
                  clippingAncestors.push({
                    clipX,
                    clipY,
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    bottom: bounds.bottom
                  });
                }

                let rects = Array.from(target.getClientRects())
                  .filter((rect) => Number.isFinite(rect.left)
                    && Number.isFinite(rect.top)
                    && Number.isFinite(rect.right)
                    && Number.isFinite(rect.bottom)
                    && rect.width > 0
                    && rect.height > 0)
                  .map((rect) => ({
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom
                  }));
                for (const clip of clippingAncestors) {
                  rects = rects.map((rect) => ({
                    left: clip.clipX ? Math.max(rect.left, clip.left) : rect.left,
                    top: clip.clipY ? Math.max(rect.top, clip.top) : rect.top,
                    right: clip.clipX ? Math.min(rect.right, clip.right) : rect.right,
                    bottom: clip.clipY ? Math.min(rect.bottom, clip.bottom) : rect.bottom
                  })).filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
                  if (rects.length === 0) return [];
                }
                return rects.map((rect) => ({
                  left: rect.left + window.scrollX,
                  top: rect.top + window.scrollY,
                  right: rect.right + window.scrollX,
                  bottom: rect.bottom + window.scrollY,
                  width: rect.right - rect.left,
                  height: rect.bottom - rect.top
                }));
              };

              const sectorCandidateDepth = (element) => {
                let depth = 0;
                for (let current = element; current; current = targetComposedParent(current)) depth += 1;
                return depth;
              };

              const sectorCandidateArea = (element) => {
                const rect = element.getBoundingClientRect();
                return Math.max(0, rect.width) * Math.max(0, rect.height);
              };

              const isSectorCandidate = (element) => {
                if (!(element instanceof Element)
                    || element === document.documentElement
                    || element === document.body
                    || element.matches('main,[role="main"]')) return false;
                const tagName = element.tagName.toLowerCase();
                const role = String(element.getAttribute('role') || '').toLowerCase();
                const labelled = Boolean(
                  element.getAttribute('aria-label')
                  || element.getAttribute('aria-labelledby')
                );
                const semanticSector = tagName === 'table'
                  || tagName === 'fieldset'
                  || role === 'grid'
                  || role === 'treegrid'
                  || role === 'listbox'
                  || (labelled && (
                    tagName === 'section'
                    || tagName === 'article'
                    || tagName === 'form'
                    || tagName === 'nav'
                    || role === 'region'
                    || role === 'group'
                  ));
                const identity = `${element.id || ''} ${typeof element.className === 'string'
                  ? element.className
                  : ''}`.toLowerCase();
                const hintedSector = /(?:^|[-_ ])(?:calendar|widget|card|panel|tile|module|board|section|box)(?:$|[-_ ])/
                  .test(identity);
                if (!semanticSector && !hintedSector) return false;

                const rect = element.getBoundingClientRect();
                if (!Number.isFinite(rect.width)
                    || !Number.isFinite(rect.height)
                    || rect.width < 72
                    || rect.height < 48) return false;
                const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
                const area = rect.width * rect.height;
                const coversMostOfViewport = rect.width > window.innerWidth * 0.78
                  && rect.height > window.innerHeight * 0.58;
                if (area > viewportArea * 0.42 || coversMostOfViewport) return false;
                if (semanticSector) return true;

                const style = getComputedStyle(element);
                const hasVisualBoundary = style.backgroundColor !== 'rgba(0, 0, 0, 0)'
                  && style.backgroundColor !== 'transparent'
                  || style.borderTopWidth !== '0px'
                  || style.borderRightWidth !== '0px'
                  || style.borderBottomWidth !== '0px'
                  || style.borderLeftWidth !== '0px'
                  || style.boxShadow !== 'none'
                  || style.borderRadius !== '0px';
                return hasVisualBoundary;
              };

              const sectorCandidatesForTarget = (target, candidateCache) => {
                const candidates = [];
                let depth = 0;
                for (let current = target; current && depth < MAX_SECTOR_CANDIDATE_DEPTH;
                    current = targetComposedParent(current), depth += 1) {
                  let isCandidate = candidateCache.get(current);
                  if (typeof isCandidate !== 'boolean') {
                    isCandidate = isSectorCandidate(current);
                    candidateCache.set(current, isCandidate);
                  }
                  if (isCandidate) candidates.push(current);
                }
                return candidates;
              };

              const buildMarkerGroupPlans = (resolvedIssues) => {
                const rawGroupsByTarget = new Map();
                const issueOrder = new Map(
                  resolvedIssues.map((resolved) => [issueKey(resolved.issue.id), resolved.index])
                );
                for (const resolved of resolvedIssues) {
                  const existing = rawGroupsByTarget.get(resolved.target);
                  if (existing) {
                    existing.issues.push(resolved.issue);
                    existing.issueTargets.set(issueKey(resolved.issue.id), resolved.target);
                    continue;
                  }
                  rawGroupsByTarget.set(resolved.target, {
                    firstIndex: resolved.index,
                    issues: [resolved.issue],
                    target: resolved.target,
                    issueTargets: new Map([[issueKey(resolved.issue.id), resolved.target]])
                  });
                }
                const rawGroups = Array.from(rawGroupsByTarget.values());
                const candidateMembers = new Map();
                const candidateCache = new WeakMap();
                for (const group of rawGroups) {
                  if (targetDocumentRects(group.target).length === 0) continue;
                  for (const candidate of sectorCandidatesForTarget(group.target, candidateCache)) {
                    const members = candidateMembers.get(candidate) || new Set();
                    members.add(group);
                    candidateMembers.set(candidate, members);
                  }
                }

                const candidates = Array.from(candidateMembers.entries())
                  .filter(([, members]) => members.size >= MIN_SECTOR_GROUP_TARGETS)
                  .sort(([left], [right]) => {
                    const depthDifference = sectorCandidateDepth(right) - sectorCandidateDepth(left);
                    return depthDifference || sectorCandidateArea(left) - sectorCandidateArea(right);
                  });
                const claimedGroups = new Set();
                const plans = [];
                for (const [candidate, memberSet] of candidates) {
                  const members = Array.from(memberSet);
                  if (members.some((group) => claimedGroups.has(group))) continue;
                  members.forEach((group) => claimedGroups.add(group));
                  const issueTargets = new Map();
                  const issues = [];
                  let firstIndex = Number.MAX_SAFE_INTEGER;
                  for (const group of members) {
                    firstIndex = Math.min(firstIndex, group.firstIndex);
                    issues.push(...group.issues);
                    for (const [issueId, target] of group.issueTargets) issueTargets.set(issueId, target);
                  }
                  issues.sort((left, right) => (
                    issueOrder.get(issueKey(left.id)) - issueOrder.get(issueKey(right.id))
                  ));
                  plans.push({
                    firstIndex,
                    groupScope: 'sector',
                    target: candidate,
                    targetCount: members.length,
                    issues,
                    issueTargets
                  });
                }
                for (const group of rawGroups) {
                  if (claimedGroups.has(group)) continue;
                  plans.push({
                    ...group,
                    groupScope: 'element',
                    targetCount: 1
                  });
                }
                return plans.sort((left, right) => left.firstIndex - right.firstIndex);
              };

              const issueTargetForEntry = (entry, issueId) => (
                entry?.issueTargets?.get(issueKey(issueId)) || entry?.target || null
              );

              const selectionRectsForTarget = (target) => {
                const rects = targetDocumentRects(target);
                if (rects.length <= MAX_SELECTION_FRAGMENTS) return rects;
                const union = rects.reduce((result, rect) => ({
                  left: Math.min(result.left, rect.left),
                  top: Math.min(result.top, rect.top),
                  right: Math.max(result.right, rect.right),
                  bottom: Math.max(result.bottom, rect.bottom)
                }), rects[0]);
                return [{
                  ...union,
                  width: union.right - union.left,
                  height: union.bottom - union.top
                }];
              };

              const clearSelectionFragments = () => {
                if (selectionLayer) selectionLayer.replaceChildren();
              };

              const updateSelectedTargetHighlight = () => {
                clearSelectionFragments();
                if (!selectionLayer || !selectedTarget || !markersVisible || !selectedTarget.isConnected) return;
                const selectionOffset = screenToDocumentLength(SELECTION_FRAGMENT_OFFSET);
                const fragmentBatch = document.createDocumentFragment();
                for (const rect of selectionRectsForTarget(selectedTarget)) {
                  const fragment = document.createElement('span');
                  fragment.className = 'selection-fragment';
                  fragment.style.transform = `translate(${rect.left - selectionOffset}px, ${rect.top - selectionOffset}px)`;
                  fragment.style.width = `${rect.width + selectionOffset * 2}px`;
                  fragment.style.height = `${rect.height + selectionOffset * 2}px`;
                  fragmentBatch.appendChild(fragment);
                }
                selectionLayer.appendChild(fragmentBatch);
              };

              const clearSelectedTarget = () => {
                if (selectedTargetResizeObserver) selectedTargetResizeObserver.disconnect();
                selectedTarget = null;
                clearSelectionFragments();
              };

              const highlightSelectedTarget = (target) => {
                clearSelectedTarget();
                if (!target || !markersVisible) return;
                selectedTarget = target;
                if (selectedTargetResizeObserver) selectedTargetResizeObserver.observe(target);
                updateSelectedTargetHighlight();
              };

              const rectanglesOverlap = (left, right) => !(
                left.right <= right.left
                || right.right <= left.left
                || left.bottom <= right.top
                || right.bottom <= left.top
              );

              const rectangleDistance = (left, right) => Math.hypot(
                Math.max(right.left - left.right, left.left - right.right, 0),
                Math.max(right.top - left.bottom, left.top - right.bottom, 0)
              );

              const issueAccessibleLabel = (issue) => [
                `${ISSUE_CATEGORY_LABELS[issue.category] || ISSUE_CATEGORY_LABELS.general} 유형`,
                issue.severityLabel || issue.severity || 'ISSUE',
                formatIssueCodeLabel(issue.code),
                issue.title || 'Accessibility issue'
              ].filter(Boolean).join('. ');

              const markerGroupKeyForIssue = (issueId) => {
                const entry = markers.get(issueKey(issueId));
                return entry ? entry.groupKey : issueKey(issueId);
              };

              const markerInteractionIssue = (entry) => {
                const selectedEntry = markers.get(issueKey(selectedIssueId));
                if (selectedEntry === entry) {
                  return entry.issues.find((issue) => issue.id === selectedIssueId) || entry.issues[0];
                }
                let highestSeverityIssue = entry.issues[0];
                let highestSeverityRank = MARKER_SEVERITY_RANK[
                  String(highestSeverityIssue?.severity || '').toUpperCase()
                ] || 0;
                for (let index = 1; index < entry.issues.length; index += 1) {
                  const candidate = entry.issues[index];
                  const candidateRank = MARKER_SEVERITY_RANK[
                    String(candidate.severity || '').toUpperCase()
                  ] || 0;
                  if (candidateRank <= highestSeverityRank) continue;
                  highestSeverityIssue = candidate;
                  highestSeverityRank = candidateRank;
                }
                return highestSeverityIssue;
              };

              const markerGroupAccessibleLabel = (entry) => {
                if (entry.issues.length === 1) return issueAccessibleLabel(entry.issues[0]);
                const visibleIssues = entry.issues.slice(0, MAX_GROUP_ACCESSIBLE_LABEL_ISSUES);
                const remaining = entry.issues.length - visibleIssues.length;
                const groupLabel = entry.groupScope === 'sector' ? '같은 영역' : '같은 요소';
                return [
                  `${groupLabel}에서 발견된 접근성 문제 ${entry.issues.length}개`,
                  entry.groupScope === 'sector' ? `대상 요소 ${entry.targetCount}개` : '',
                  ...visibleIssues.map(issueAccessibleLabel),
                  remaining > 0 ? `외 ${remaining}개` : ''
                ].filter(Boolean).join('. ');
              };

              const markerCategoryForIssues = (issues) => {
                const categories = new Set(issues.map((issue) => issue.category));
                return categories.size === 1 ? categories.values().next().value : 'multiple';
              };

              const markerSeverityForIssues = (issues) => {
                let selectedSeverity = '';
                let selectedRank = -1;
                for (const issue of issues) {
                  const severity = String(issue.severity || '').toUpperCase();
                  const rank = MARKER_SEVERITY_RANK[severity] || 0;
                  if (rank <= selectedRank) continue;
                  selectedSeverity = severity;
                  selectedRank = rank;
                }
                return {
                  key: selectedSeverity || 'DEFAULT',
                  color: MARKER_COLOR_BY_SEVERITY[selectedSeverity] || MARKER_BLUE_GLASS
                };
              };

              const refreshMarkerGroupPresentation = (entry) => {
                const markerCategory = markerCategoryForIssues(entry.issues);
                const markerSeverity = markerSeverityForIssues(entry.issues);
                entry.button.dataset.groupSize = String(entry.issues.length);
                entry.button.dataset.groupScope = entry.groupScope;
                entry.button.dataset.targetCount = String(entry.targetCount);
                entry.button.dataset.issueIds = entry.issues.map((issue) => String(issue.id)).join(',');
                entry.button.dataset.markerCategory = markerCategory;
                entry.button.dataset.markerSeverity = markerSeverity.key;
                entry.button.style.setProperty('--marker-color', markerSeverity.color);
                if (entry.issues.length > 1) {
                  entry.button.dataset.grouped = 'true';
                  entry.button.setAttribute('aria-haspopup', 'dialog');
                  entry.button.setAttribute('aria-controls', '__uni_accessibility_replay_issue_popover');
                  entry.button.setAttribute('aria-expanded', 'false');
                } else {
                  entry.button.removeAttribute('data-grouped');
                  entry.button.removeAttribute('aria-haspopup');
                  entry.button.removeAttribute('aria-controls');
                  entry.button.removeAttribute('aria-expanded');
                }
                entry.button.removeAttribute('data-dock-open');
                entry.button.setAttribute('aria-label', markerGroupAccessibleLabel(entry));
                entry.badge.replaceChildren(createMarkerIcon(markerCategory));
              };

              // A compact Lucide-style catalog keeps type glyphs consistent inside
              // replay documents without accepting SVG markup from postMessage.
              const MARKER_ICON_SHAPES = Object.freeze({
                visual: [
                  ['path', { d: 'M2.1 12a10.8 10.8 0 0 1 19.8 0 10.8 10.8 0 0 1-19.8 0' }],
                  ['circle', { cx: '12', cy: '12', r: '3' }]
                ],
                text: [
                  ['path', { d: 'M4 7V4h16v3' }],
                  ['path', { d: 'M9 20h6' }],
                  ['path', { d: 'M12 4v16' }]
                ],
                media: [
                  ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
                  ['circle', { cx: '9', cy: '9', r: '2' }],
                  ['path', { d: 'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21' }]
                ],
                navigation: [
                  ['path', { d: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1' }],
                  ['path', { d: 'M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1' }]
                ],
                form: [
                  ['rect', { x: '2', y: '6', width: '20', height: '12', rx: '2' }],
                  ['path', { d: 'M7 12h.01M12 12h.01M17 12h.01' }]
                ],
                keyboard: [
                  ['rect', { x: '3', y: '5', width: '18', height: '14', rx: '2' }],
                  ['path', { d: 'M7 9h.01M11 9h.01M15 9h2M7 13h.01M11 13h6M7 17h10' }]
                ],
                interaction: [
                  ['path', { d: 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z' }]
                ],
                structure: [
                  ['path', { d: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1' }],
                  ['path', { d: 'M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1' }]
                ],
                multiple: [
                  ['path', { d: 'm12 2 9 4.5-9 4.5-9-4.5Z' }],
                  ['path', { d: 'm3 11.5 9 4.5 9-4.5' }],
                  ['path', { d: 'm3 16.5 9 4.5 9-4.5' }]
                ],
                general: [
                  ['path', { d: 'M3 7V5a2 2 0 0 1 2-2h2' }],
                  ['path', { d: 'M17 3h2a2 2 0 0 1 2 2v2' }],
                  ['path', { d: 'M21 17v2a2 2 0 0 1-2 2h-2' }],
                  ['path', { d: 'M7 21H5a2 2 0 0 1-2-2v-2' }],
                  ['circle', { cx: '12', cy: '12', r: '3' }]
                ]
              });

              const createMarkerIcon = (category) => {
                const svgNamespace = 'http://www.w3.org/2000/svg';
                const resolvedCategory = MARKER_ICON_SHAPES[category] ? category : 'general';
                const icon = document.createElementNS(svgNamespace, 'svg');
                icon.classList.add('marker__icon');
                icon.dataset.icon = resolvedCategory;
                icon.setAttribute('viewBox', '0 0 24 24');
                icon.setAttribute('fill', 'none');
                icon.setAttribute('stroke', 'currentColor');
                icon.setAttribute('stroke-width', '2');
                icon.setAttribute('stroke-linecap', 'round');
                icon.setAttribute('stroke-linejoin', 'round');
                for (const [tagName, attributes] of MARKER_ICON_SHAPES[resolvedCategory]) {
                  const shape = document.createElementNS(svgNamespace, tagName);
                  for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
                  icon.appendChild(shape);
                }
                return icon;
              };

              const createMarkerBadge = () => {
                const badge = document.createElement('span');
                badge.className = 'marker__badge';
                badge.setAttribute('aria-hidden', 'true');
                return badge;
              };

            """,
            """

              const issueDockPageCount = (entry) => Math.max(
                1,
                Math.ceil(entry.issues.length / ISSUE_DOCK_PAGE_SIZE)
              );

              const issueDockIssueButtons = () => issueDock
                ? Array.from(issueDock.querySelectorAll('.issue-dock__item'))
                : [];

              const issueDockControls = () => issueDock
                ? Array.from(issueDock.querySelectorAll('button'))
                : [];

              const setIssueDockRovingControl = (activeControl) => {
                for (const control of issueDockControls()) {
                  control.tabIndex = control === activeControl ? 0 : -1;
                }
              };

              const refreshIssueDockSelection = () => {
                for (const button of issueDockIssueButtons()) {
                  button.setAttribute(
                    'aria-pressed',
                    String(button.dataset.issueId === issueKey(selectedIssueId))
                  );
                }
              };

              const hideIssueDock = (restoreFocus = false) => {
                const entry = dockedEntry;
                if (!entry || !issueDock) return false;
                if (issuePopoverAnchorElement && issueDock.contains(issuePopoverAnchorElement)) {
                  hideIssuePopover();
                }
                entry.button.dataset.dockOpen = 'false';
                entry.button.setAttribute('aria-expanded', 'false');
                issueDock.hidden = true;
                issueDock.style.visibility = 'hidden';
                issueDock.style.transform = 'translate(0px, 0px)';
                issueDock.removeAttribute('data-placement');
                issueDock.removeAttribute('data-group-key');
                issueDock.removeAttribute('data-page');
                issueDock.removeAttribute('data-page-count');
                issueDock.removeAttribute('data-total-issues');
                issueDock.replaceChildren();
                dockedEntry = null;
                issueDockPage = 0;
                if (restoreFocus && entry.button.isConnected && !entry.button.hidden) {
                  requestAnimationFrame(() => entry.button.focus({ preventScroll: true }));
                }
                return true;
              };

              const dismissIssueDock = (restoreFocus = false) => {
                const entry = dockedEntry;
                if (!entry) return false;
                const clearsSelectedIssue = markers.get(issueKey(selectedIssueId)) === entry;
                hideIssuePopover();
                hideIssueDock(restoreFocus);
                if (clearsSelectedIssue) selectAndNotifyIssue(null, false, true, false);
                return true;
              };

              const createIssueDockPageButton = (direction, nextPage) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'issue-dock__page-button';
                button.dataset.direction = direction;
                button.setAttribute('aria-label', direction === 'previous' ? '이전 문제 보기' : '다음 문제 보기');
                button.textContent = direction === 'previous' ? '‹' : '›';
                button.addEventListener('focus', () => setIssueDockRovingControl(button));
                button.addEventListener('click', (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!dockedEntry) return;
                  hideIssuePopover();
                  issueDockPage = nextPage;
                  renderIssueDock();
                  positionIssueDock();
                  requestAnimationFrame(() => issueDockIssueButtons()[0]?.focus({ preventScroll: true }));
                });
                return button;
              };

              const createIssueDockItem = (issue, position, total) => {
                const button = document.createElement('button');
                const severity = markerSeverityForIssues([issue]);
                button.type = 'button';
                button.className = 'issue-dock__item';
                button.dataset.issueId = issueKey(issue.id);
                button.dataset.category = issue.category;
                button.dataset.severity = severity.key;
                button.style.setProperty('--dock-item-color', severity.color);
                button.setAttribute('aria-label', `${issueAccessibleLabel(issue)}. ${position}/${total}`);
                button.setAttribute('aria-pressed', String(issueKey(selectedIssueId) === issueKey(issue.id)));
                button.dataset.position = String(position);
                button.dataset.total = String(total);
                button.addEventListener('focus', () => setIssueDockRovingControl(button));

                const badge = document.createElement('span');
                badge.className = 'issue-dock__badge';
                badge.setAttribute('aria-hidden', 'true');
                badge.appendChild(createMarkerIcon(issue.category));
                button.appendChild(badge);

                button.addEventListener('click', (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  selectAndNotifyIssue(issue.id, false, true);
                  showIssuePopover(issue.id, button);
                  refreshIssueDockSelection();
                });
                return button;
              };

              const renderIssueDock = () => {
                if (!issueDock || !dockedEntry) return;
                const pageCount = issueDockPageCount(dockedEntry);
                issueDockPage = Math.max(0, Math.min(issueDockPage, pageCount - 1));
                const start = issueDockPage * ISSUE_DOCK_PAGE_SIZE;
                const pageIssues = dockedEntry.issues.slice(start, start + ISSUE_DOCK_PAGE_SIZE);
                const fragment = document.createDocumentFragment();
                if (pageCount > 1 && issueDockPage > 0) {
                  fragment.appendChild(createIssueDockPageButton('previous', issueDockPage - 1));
                }
                pageIssues.forEach((issue, index) => {
                  fragment.appendChild(createIssueDockItem(
                    issue,
                    start + index + 1,
                    dockedEntry.issues.length
                  ));
                });
                if (pageCount > 1 && issueDockPage < pageCount - 1) {
                  fragment.appendChild(createIssueDockPageButton('next', issueDockPage + 1));
                }
                issueDock.replaceChildren(fragment);
                const selectedButton = issueDock.querySelector(
                  `.issue-dock__item[data-issue-id="${issueKey(selectedIssueId)}"]`
                );
                setIssueDockRovingControl(selectedButton || issueDockIssueButtons()[0] || issueDockControls()[0]);
                issueDock.dataset.groupKey = dockedEntry.groupKey;
                issueDock.dataset.page = String(issueDockPage + 1);
                issueDock.dataset.pageCount = String(pageCount);
                issueDock.dataset.totalIssues = String(dockedEntry.issues.length);
                issueDock.setAttribute(
                  'aria-label',
                  `같은 요소의 접근성 문제 ${dockedEntry.issues.length}개`
                );
              };

              const positionIssueDock = () => {
                if (!issueDock || !dockedEntry || issueDock.hidden || !markersVisible) return;
                const entry = dockedEntry;
                if (!entry.target.isConnected || entry.button.hidden || !entry.position) {
                  dismissIssueDock();
                  return;
                }

                issueDock.style.visibility = 'hidden';
                issueDock.style.transform = 'translate(0px, 0px)';
                const dockRect = issueDock.getBoundingClientRect();
                const width = Math.ceil(dockRect.width);
                const height = Math.ceil(dockRect.height);
                const documentElement = document.documentElement;
                const body = document.body;
                const documentWidth = Math.max(
                  window.innerWidth, documentElement.scrollWidth, body ? body.scrollWidth : 0
                );
                const documentHeight = Math.max(
                  window.innerHeight, documentElement.scrollHeight, body ? body.scrollHeight : 0
                );
                const markerSize = replayMarkerSize();
                const marker = {
                  left: entry.position.left,
                  top: entry.position.top,
                  right: entry.position.left + markerSize,
                  bottom: entry.position.top + markerSize
                };
                const visibleViewport = {
                  left: window.scrollX,
                  top: window.scrollY,
                  right: window.scrollX + window.innerWidth,
                  bottom: window.scrollY + window.innerHeight
                };
                if (!rectanglesOverlap(marker, visibleViewport)) {
                  dismissIssueDock();
                  return;
                }
                const minLeft = Math.max(
                  ISSUE_DOCK_VIEWPORT_MARGIN,
                  window.scrollX + ISSUE_DOCK_VIEWPORT_MARGIN
                );
                const minTop = Math.max(
                  ISSUE_DOCK_VIEWPORT_MARGIN,
                  window.scrollY + ISSUE_DOCK_VIEWPORT_MARGIN
                );
                const maxLeft = Math.min(
                  documentWidth - ISSUE_DOCK_VIEWPORT_MARGIN - width,
                  window.scrollX + window.innerWidth - ISSUE_DOCK_VIEWPORT_MARGIN - width
                );
                const maxTop = Math.min(
                  documentHeight - ISSUE_DOCK_VIEWPORT_MARGIN - height,
                  window.scrollY + window.innerHeight - ISSUE_DOCK_VIEWPORT_MARGIN - height
                );
                if (maxLeft < minLeft || maxTop < minTop) {
                  dismissIssueDock();
                  return;
                }
                const centerX = (marker.left + marker.right) / 2;
                const centerY = (marker.top + marker.bottom) / 2;
                const rawCandidates = [
                  { placement: 'top', left: centerX - width / 2, top: marker.top - height - ISSUE_DOCK_GAP },
                  { placement: 'bottom', left: centerX - width / 2, top: marker.bottom + ISSUE_DOCK_GAP },
                  { placement: 'right', left: marker.right + ISSUE_DOCK_GAP, top: centerY - height / 2 },
                  { placement: 'left', left: marker.left - width - ISSUE_DOCK_GAP, top: centerY - height / 2 }
                ];
                const fitting = rawCandidates.find((candidate) => (
                  candidate.left >= minLeft
                  && candidate.left <= maxLeft
                  && candidate.top >= minTop
                  && candidate.top <= maxTop
                ));
                const selected = fitting || rawCandidates[1];
                const left = Math.min(maxLeft, Math.max(minLeft, selected.left));
                const top = Math.min(maxTop, Math.max(minTop, selected.top));
                issueDock.dataset.placement = selected.placement;
                issueDock.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
                issueDock.style.visibility = 'visible';
              };

              const showIssueDock = (entry, moveFocus = false) => {
                if (!issueDock || !entry || entry.issues.length < 2 || entry.button.hidden || !markersVisible) {
                  return false;
                }
                if (dockedEntry && dockedEntry !== entry) dismissIssueDock();
                cancelMarkerPreviewClear();
                activeMarkerPreview = null;
                pinnedIssueId = null;
                pinnedSelectionOwned = false;
                hideIssuePopover();
                const selectedEntry = markers.get(issueKey(selectedIssueId));
                if (selectedEntry && selectedEntry !== entry) {
                  selectAndNotifyIssue(null, false, true, false);
                }
                dockedEntry = entry;
                const selectedIndex = entry.issues.findIndex((issue) => issue.id === selectedIssueId);
                issueDockPage = selectedIndex >= 0
                  ? Math.floor(selectedIndex / ISSUE_DOCK_PAGE_SIZE)
                  : 0;
                issueDock.hidden = false;
                entry.button.dataset.dockOpen = 'true';
                entry.button.setAttribute('aria-expanded', 'true');
                renderIssueDock();
                positionIssueDock();
                schedulePositions();
                if (moveFocus) {
                  requestAnimationFrame(() => {
                    const selectedButton = issueDock.querySelector(
                      `.issue-dock__item[data-issue-id="${issueKey(selectedIssueId)}"]`
                    );
                    (selectedButton || issueDockIssueButtons()[0])?.focus({ preventScroll: true });
                  });
                }
                return true;
              };

              const toggleIssueDock = (entry, moveFocus = false) => {
                if (dockedEntry === entry && issueDock && !issueDock.hidden) {
                  dismissIssueDock(moveFocus);
                  return false;
                }
                return showIssueDock(entry, moveFocus);
              };

              const markerPreviewIsActive = (preview) => Boolean(preview && (
                preview.pointer
                || preview.focus
                || preview.popoverPointer
              ));

              const cancelMarkerPreviewClear = () => {
                if (markerPreviewClearFrame) cancelAnimationFrame(markerPreviewClearFrame);
                if (markerPreviewClearTimer) clearTimeout(markerPreviewClearTimer);
                markerPreviewClearFrame = 0;
                markerPreviewClearTimer = 0;
              };

              const completeMarkerPreviewClear = (key) => {
                if (!activeMarkerPreview
                    || activeMarkerPreview.key !== key
                    || markerPreviewIsActive(activeMarkerPreview)) return;
                const preview = activeMarkerPreview;
                const previewIssueId = preview.issueId;
                activeMarkerPreview = null;
                if (preview.ownsSelection
                    && issueKey(selectedIssueId) === issueKey(previewIssueId)) {
                  selectAndNotifyIssue(null, false, true, false);
                } else if (issueKey(popoverIssueId) === issueKey(previewIssueId)) {
                  hideIssuePopover();
                }
              };

              const scheduleMarkerPreviewClear = (key, withPointerGrace) => {
                cancelMarkerPreviewClear();
                if (withPointerGrace) {
                  markerPreviewClearTimer = window.setTimeout(() => {
                    markerPreviewClearTimer = 0;
                    completeMarkerPreviewClear(key);
                  }, popoverLeaveGraceMs);
                  return;
                }
                markerPreviewClearFrame = requestAnimationFrame(() => {
                  markerPreviewClearFrame = 0;
                  completeMarkerPreviewClear(key);
                });
              };

              const removeIssuePopoverDescription = () => {
                if (issuePopoverDescriptionTarget
                    && issuePopover
                    && issuePopoverDescriptionTarget.getAttribute('aria-describedby') === issuePopover.id) {
                  issuePopoverDescriptionTarget.removeAttribute('aria-describedby');
                }
              };

              const concealIssuePopover = () => {
                if (!issuePopover) return;
                const entry = markers.get(issueKey(popoverIssueId));
                if (entry && entry.issues.length > 1) entry.button.setAttribute('aria-expanded', 'false');
                removeIssuePopoverDescription();
                clearIssueDetailFallback();
                issuePopover.removeAttribute('data-presentation');
                issuePopover.hidden = true;
                issuePopover.style.visibility = 'hidden';
                issuePopover.setAttribute('aria-hidden', 'true');
              };

              const hideIssuePopover = () => {
                const entry = markers.get(issueKey(popoverIssueId));
                if (entry && entry.issues.length > 1) entry.button.setAttribute('aria-expanded', 'false');
                popoverIssueId = null;
                issuePopoverGroupPage = 0;
                if (!issuePopover) return;
                removeIssuePopoverDescription();
                issuePopoverAnchorElement = null;
                issuePopoverDescriptionTarget = null;
                clearIssueDetailFallback();
                issuePopover.hidden = true;
                issuePopover.style.visibility = 'hidden';
                issuePopover.setAttribute('aria-hidden', 'true');
                issuePopover.style.transform = overlayTransform(0, 0);
                issuePopover.style.removeProperty('width');
                issuePopover.style.removeProperty('height');
                issuePopover.removeAttribute('data-presentation');
                issuePopover.removeAttribute('data-density');
                issuePopover.removeAttribute('data-layout');
                issuePopover.removeAttribute('data-grouped');
                issuePopover.removeAttribute('data-content-scroll');
                if (issuePopoverElements) {
                  issuePopoverElements.detail.removeAttribute('tabindex');
                  issuePopoverElements.detail.scrollTo({ top: 0, left: 0, behavior: 'instant' });
                }
                issuePopover.removeAttribute('data-issue-id');
                issuePopover.removeAttribute('data-placement');
                issuePopover.setAttribute('role', 'tooltip');
                issuePopover.removeAttribute('aria-label');
                popoverLeaveGraceMs = POPOVER_LEAVE_GRACE_MS;
              };

              const appendIssueMessageSection = (container, label, values, asList = false) => {
                const normalizedValues = Array.isArray(values)
                  ? values.filter((value) => typeof value === 'string' && value.length > 0)
                  : [];
                if (normalizedValues.length === 0) return;
                const section = document.createElement('div');
                section.className = 'issue-popover__message-section';
                const heading = document.createElement('span');
                heading.className = 'issue-popover__message-label';
                heading.textContent = label;
                section.appendChild(heading);
                if (asList) {
                  const list = document.createElement('ul');
                  list.className = 'issue-popover__message-list';
                  for (const value of normalizedValues) {
                    const item = document.createElement('li');
                    item.dir = 'auto';
                    item.textContent = value;
                    list.appendChild(item);
                  }
                  section.appendChild(list);
                } else {
                  const body = document.createElement('p');
                  body.className = 'issue-popover__message-value';
                  body.dir = 'auto';
                  body.textContent = normalizedValues.join('\\n');
                  section.appendChild(body);
                }
                container.appendChild(section);
              };

              const renderIssueMessage = (issue) => {
                const container = issuePopoverElements.message;
                container.replaceChildren();
                const detail = issue.textAnalysis;
                if (!detail) {
                  container.textContent = issue.message;
                  container.hidden = !issue.message;
                  return;
                }
                appendIssueMessageSection(container, '분석 문장', [detail.sourceText]);
                appendIssueMessageSection(container, '개선 필요', detail.flags, true);
                appendIssueMessageSection(container, '개선 제안', detail.suggestions, true);
                if (detail.revision) {
                  appendIssueMessageSection(container, '수정 예시', [detail.revision.text]);
                  appendIssueMessageSection(container, '수정 이유', [detail.revision.reason]);
                }
                container.hidden = container.childElementCount === 0;
              };

              const renderIssuePopoverDetail = (issue) => {
                issuePopoverElements.severity.textContent = issue.severityLabel || issue.severity || 'ISSUE';
                issuePopoverElements.severity.dataset.severity = (issue.severity || '').toUpperCase();
                issuePopoverElements.code.textContent = formatIssueCodeLabel(issue.code) || 'KWCAG';
                issuePopoverElements.title.textContent = issue.title || 'Accessibility issue';
                renderIssueMessage(issue);
                issuePopoverElements.path.textContent = issue.path;
                issuePopoverElements.path.hidden = !issue.path;
              };

              const updateIssuePopoverSelection = (entry, issueId) => {
                if (!issuePopover || !issuePopoverElements) return null;
                const issue = entry.issues.find((candidate) => candidate.id === issueId) || entry.issues[0];
                issuePopover.removeAttribute('data-content-scroll');
                issuePopoverElements.detail.removeAttribute('tabindex');
                issuePopoverElements.detail.scrollTo({ top: 0, left: 0, behavior: 'instant' });
                issuePopoverElements.issueList.querySelectorAll('.issue-popover__issue').forEach((selector) => {
                  selector.setAttribute('aria-pressed', String(selector.dataset.issueId === issueKey(issue.id)));
                });
                renderIssuePopoverDetail(issue);
                if (issuePopover.style.height
                    && issuePopover.scrollHeight > issuePopover.clientHeight + 1) {
                  issuePopover.dataset.contentScroll = 'true';
                  if (issuePopoverElements.detail.scrollHeight
                      > issuePopoverElements.detail.clientHeight + 1) {
                    issuePopoverElements.detail.tabIndex = 0;
                  }
                }
                return issue;
              };

              const focusIssuePopoverSelector = (issueId) => {
                if (!issuePopoverElements) return;
                const selector = issuePopoverElements.issueList.querySelector(
                  `.issue-popover__issue[data-issue-id="${issueKey(issueId)}"]`
                );
                if (selector instanceof HTMLElement) selector.focus({ preventScroll: true });
              };

              const activateIssueFromPopover = (issueId) => {
                const entry = markers.get(issueKey(issueId));
                if (!entry || entry.issues.length < 2) return;
                const preservesGroupedPopover = Boolean(issuePopover && !issuePopover.hidden);
                const previewOwnedSelection = Boolean(activeMarkerPreview && activeMarkerPreview.ownsSelection);
                const previousPinnedSelection = pinnedSelectionOwned;
                cancelMarkerPreviewClear();
                activeMarkerPreview = null;
                const selectionChanged = selectAndNotifyIssue(
                  issueId,
                  false,
                  true,
                  !preservesGroupedPopover,
                  preservesGroupedPopover
                );
                pinnedIssueId = issueId;
                pinnedSelectionOwned = previewOwnedSelection || previousPinnedSelection || selectionChanged;
                if (!preservesGroupedPopover) showIssuePopover(issueId);
                requestAnimationFrame(() => focusIssuePopoverSelector(issueId));
              };

              const setIssuePopoverContent = (entry, issueId, requestedGroupPage = null) => {
                if (!issuePopover || !issuePopoverElements) return;
                const issue = entry.issues.find((candidate) => candidate.id === issueId) || entry.issues[0];
                const isGrouped = entry.issues.length > 1;
                const groupLabel = entry.groupScope === 'sector' ? '같은 영역' : '같은 요소';
                issuePopoverElements.group.textContent = `${groupLabel}에서 발견된 문제 ${entry.issues.length}개`;
                issuePopoverElements.group.hidden = !isGrouped;
                if (isGrouped) {
                  issuePopover.dataset.grouped = 'true';
                  issuePopover.setAttribute('role', 'dialog');
                  issuePopover.setAttribute('aria-label', `${groupLabel}의 접근성 문제 ${entry.issues.length}개`);
                } else {
                  issuePopover.removeAttribute('data-grouped');
                  issuePopover.setAttribute('role', 'tooltip');
                  issuePopover.removeAttribute('aria-label');
                }

                const groupPageCount = Math.max(
                  1,
                  Math.ceil(entry.issues.length / GROUP_POPOVER_PAGE_SIZE)
                );
                const selectedIndex = Math.max(
                  0,
                  entry.issues.findIndex((candidate) => candidate.id === issue.id)
                );
                const selectedPage = Math.floor(selectedIndex / GROUP_POPOVER_PAGE_SIZE);
                issuePopoverGroupPage = Number.isInteger(requestedGroupPage)
                  ? Math.max(0, Math.min(requestedGroupPage, groupPageCount - 1))
                  : selectedPage;
                const pageStart = issuePopoverGroupPage * GROUP_POPOVER_PAGE_SIZE;
                const pageIssues = entry.issues.slice(pageStart, pageStart + GROUP_POPOVER_PAGE_SIZE);
                issuePopoverElements.issueList.replaceChildren();
                pageIssues.forEach((candidate, index) => {
                  const summary = document.createElement('button');
                  summary.type = 'button';
                  summary.className = 'issue-popover__issue';
                  summary.dataset.issueId = issueKey(candidate.id);
                  summary.setAttribute('aria-label', `${issueAccessibleLabel(candidate)}. ${pageStart + index + 1}/${entry.issues.length}`);
                  summary.setAttribute('aria-pressed', String(candidate.id === issue.id));

                  const meta = document.createElement('span');
                  meta.className = 'issue-popover__issue-meta';
                  const severity = document.createElement('span');
                  severity.className = 'issue-popover__issue-severity';
                  severity.dataset.severity = (candidate.severity || '').toUpperCase();
                  severity.textContent = candidate.severityLabel || candidate.severity || 'ISSUE';
                  const code = document.createElement('span');
                  code.className = 'issue-popover__issue-code';
                  code.textContent = formatIssueCodeLabel(candidate.code) || 'KWCAG';
                  meta.append(severity, code);

                  const title = document.createElement('span');
                  title.className = 'issue-popover__issue-title';
                  title.textContent = candidate.title || 'Accessibility issue';
                  summary.append(meta, title);
                  summary.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    activateIssueFromPopover(candidate.id);
                  });
                  issuePopoverElements.issueList.appendChild(summary);
                });
                issuePopoverElements.issueList.hidden = !isGrouped;
                issuePopoverElements.pager.hidden = !isGrouped || groupPageCount <= 1;
                issuePopoverElements.previousPage.disabled = issuePopoverGroupPage <= 0;
                issuePopoverElements.nextPage.disabled = issuePopoverGroupPage >= groupPageCount - 1;
                issuePopoverElements.pageStatus.textContent = `${issuePopoverGroupPage + 1} / ${groupPageCount}`;
                renderIssuePopoverDetail(issue);
              };

              const changeIssuePopoverGroupPage = (direction) => {
                if (popoverIssueId === null) return;
                const entry = markers.get(issueKey(popoverIssueId));
                if (!entry || entry.issues.length < 2) return;
                const pageCount = Math.max(1, Math.ceil(entry.issues.length / GROUP_POPOVER_PAGE_SIZE));
                const nextPage = Math.max(0, Math.min(issuePopoverGroupPage + direction, pageCount - 1));
                if (nextPage === issuePopoverGroupPage) return;
                setIssuePopoverContent(entry, popoverIssueId, nextPage);
              };

              const markerDocumentRect = (entry) => {
                if (!entry || !entry.position || entry.button.hidden) return null;
                const markerSize = replayMarkerSize();
                const markerHalo = replayMarkerHalo();
                return {
                  left: entry.position.left - markerHalo,
                  top: entry.position.top - markerHalo,
                  right: entry.position.left + markerSize + markerHalo,
                  bottom: entry.position.top + markerSize + markerHalo
                };
              };

              const elementDocumentRect = (element) => {
                if (!(element instanceof Element) || !element.isConnected) return null;
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return null;
                return {
                  left: rect.left + window.scrollX,
                  top: rect.top + window.scrollY,
                  right: rect.right + window.scrollX,
                  bottom: rect.bottom + window.scrollY
                };
              };

              const groupedPopoverMeasurementCandidates = (entry, selectedIssue) => {
                const indexedIssues = entry.issues.map((issue, index) => ({
                  issue,
                  index,
                  weight: JSON.stringify(issue).length
                }));
                if (indexedIssues.length <= MAX_GROUP_POPOVER_MEASUREMENT_ISSUES) {
                  return indexedIssues;
                }

                const selectedIndex = Math.max(0, entry.issues.indexOf(selectedIssue));
                const requiredIndices = new Set([0, selectedIndex, indexedIssues.length - 1]);
                const candidates = indexedIssues.filter(({ index }) => requiredIndices.has(index));
                const remaining = indexedIssues
                  .filter(({ index }) => !requiredIndices.has(index))
                  .sort((left, right) => right.weight - left.weight || left.index - right.index);
                candidates.push(...remaining.slice(
                  0,
                  Math.max(0, MAX_GROUP_POPOVER_MEASUREMENT_ISSUES - candidates.length)
                ));
                return candidates;
              };

              const measureStableGroupedPopover = (entry, layout, reserveGroupPage = true) => {
                issuePopover.style.removeProperty('height');
                const measured = issuePopover.getBoundingClientRect();
                if (!reserveGroupPage || entry.issues.length < 2) {
                  if (entry.issues.length > 1) {
                    issuePopover.style.height = `${documentToScreenLength(Math.ceil(measured.height))}px`;
                  }
                  return {
                    width: Math.ceil(measured.width),
                    height: Math.ceil(measured.height)
                  };
                }

                const selectedIssue = entry.issues.find((candidate) => candidate.id === popoverIssueId)
                  || entry.issues[0];
                const selectedPage = issuePopoverGroupPage;
                const measuredWidth = Math.ceil(measured.width);
                const cacheKey = [
                  layout.kind,
                  layout.density,
                  layout.width || measuredWidth,
                  measuredWidth
                ].join(':');
                let entryCache = issuePopoverFootprintCache.get(entry);
                if (!entryCache) {
                  entryCache = new Map();
                  issuePopoverFootprintCache.set(entry, entryCache);
                }
                let stableHeight = entryCache.get(cacheKey);
                if (!Number.isFinite(stableHeight)) {
                  stableHeight = 0;
                  const measurementCandidates = groupedPopoverMeasurementCandidates(
                    entry,
                    selectedIssue
                  );
                  for (const { issue: candidate, index } of measurementCandidates) {
                    const pageIndex = Math.floor(index / GROUP_POPOVER_PAGE_SIZE);
                    setIssuePopoverContent(entry, candidate.id, pageIndex);
                    stableHeight = Math.max(
                      stableHeight,
                      Math.ceil(issuePopover.getBoundingClientRect().height)
                    );
                  }
                  setIssuePopoverContent(entry, selectedIssue.id, selectedPage);
                  entryCache.set(cacheKey, stableHeight);
                }
                issuePopover.style.height = `${documentToScreenLength(stableHeight)}px`;
                const stableRect = issuePopover.getBoundingClientRect();
                return {
                  width: Math.ceil(stableRect.width),
                  height: Math.ceil(stableRect.height)
                };
              };

              const positionIssuePopover = () => {
                if (!issuePopover || popoverIssueId === null || !markersVisible) return;
                const entry = markers.get(issueKey(popoverIssueId));
                const markerRect = markerDocumentRect(entry);
                const anchorRect = elementDocumentRect(issuePopoverAnchorElement) || markerRect;
                const openDockRect = issueDock && !issueDock.hidden
                  ? elementDocumentRect(issueDock)
                  : null;
                const popoverTarget = entry ? issueTargetForEntry(entry, popoverIssueId) : null;
                const targetRects = popoverTarget ? targetDocumentRects(popoverTarget) : [];
                if (!entry || !popoverTarget?.isConnected || !markerRect || !anchorRect || targetRects.length === 0) {
                  concealIssuePopover();
                  return;
                }

                const visibleViewport = {
                  left: window.scrollX,
                  top: window.scrollY,
                  right: window.scrollX + window.innerWidth,
                  bottom: window.scrollY + window.innerHeight
                };
                if (!rectanglesOverlap(markerRect, visibleViewport)
                    && !rectanglesOverlap(anchorRect, visibleViewport)) {
                  const popoverRoot = issuePopover.getRootNode();
                  const focusedElement = popoverRoot instanceof ShadowRoot
                    ? popoverRoot.activeElement
                    : document.activeElement;
                  const restoresPopoverFocus = issuePopover.contains(focusedElement);
                  const dismissedIssueId = pinnedIssueId !== null
                    ? pinnedIssueId
                    : activeMarkerPreview?.issueId;
                  const ownsSelection = Boolean(
                    pinnedSelectionOwned
                    || (activeMarkerPreview && activeMarkerPreview.ownsSelection)
                  );
                  cancelMarkerPreviewClear();
                  activeMarkerPreview = null;
                  pinnedIssueId = null;
                  pinnedSelectionOwned = false;
                  hideIssuePopover();
                  if (ownsSelection
                      && dismissedIssueId !== null
                      && dismissedIssueId !== undefined
                      && issueKey(selectedIssueId) === issueKey(dismissedIssueId)) {
                    selectAndNotifyIssue(null, false, true, false);
                  }
                  if (restoresPopoverFocus && entry.button.isConnected && !entry.button.hidden) {
                    suppressNextMarkerFocusPreview = true;
                    requestAnimationFrame(() => entry.button.focus({ preventScroll: true }));
                  }
                  return;
                }

                issuePopover.hidden = false;
                issuePopover.style.visibility = 'hidden';
                issuePopover.style.transform = overlayTransform(0, 0);
                issuePopover.style.removeProperty('width');
                issuePopover.style.removeProperty('height');
                issuePopover.removeAttribute('data-content-scroll');
                issuePopoverElements.detail.removeAttribute('tabindex');
                issuePopoverElements.detail.scrollTo({ top: 0, left: 0, behavior: 'instant' });
                issuePopover.removeAttribute('data-presentation');
                issuePopover.removeAttribute('data-layout');
                const popoverGap = screenToDocumentLength(POPOVER_GAP);
                const popoverViewportMargin = screenToDocumentLength(POPOVER_VIEWPORT_MARGIN);
                const popoverTargetClearance = screenToDocumentLength(POPOVER_TARGET_CLEARANCE);
                const popoverPreferredMaxMarkerDistance = screenToDocumentLength(
                  POPOVER_PREFERRED_MAX_MARKER_DISTANCE
                );
                const markerSlotStep = replayMarkerSlotStep();
                const documentElement = document.documentElement;
                const body = document.body;
                const documentWidth = Math.max(
                  window.innerWidth, documentElement.scrollWidth, body ? body.scrollWidth : 0
                );
                const documentHeight = Math.max(
                  window.innerHeight, documentElement.scrollHeight, body ? body.scrollHeight : 0
                );
                const minLeft = Math.max(popoverViewportMargin, window.scrollX + popoverViewportMargin);
                const minTop = Math.max(popoverViewportMargin, window.scrollY + popoverViewportMargin);
                const viewportRight = Math.min(
                  documentWidth - popoverViewportMargin,
                  window.scrollX + window.innerWidth - popoverViewportMargin
                );
                const viewportBottom = Math.min(
                  documentHeight - popoverViewportMargin,
                  window.scrollY + window.innerHeight - popoverViewportMargin
                );

                const expandedTargetRects = targetRects.map((rect) => ({
                  left: rect.left - popoverTargetClearance,
                  top: rect.top - popoverTargetClearance,
                  right: rect.right + popoverTargetClearance,
                  bottom: rect.bottom + popoverTargetClearance
                }));
                const overlapsPopoverObstacle = (rect) => (
                  expandedTargetRects.some((targetRect) => rectanglesOverlap(rect, targetRect))
                  || Boolean(openDockRect && rectanglesOverlap(rect, openDockRect))
                  || Boolean(markerSpatialIndex && markerSpatialIndex.hasMarkerRectOverlap(rect))
                );
                const targetUnion = expandedTargetRects.reduce((union, rect) => ({
                  left: Math.min(union.left, rect.left),
                  top: Math.min(union.top, rect.top),
                  right: Math.max(union.right, rect.right),
                  bottom: Math.max(union.bottom, rect.bottom)
                }), expandedTargetRects[0]);
                const anchors = [anchorRect, markerRect, targetUnion];
                const markerCenterX = (anchorRect.left + anchorRect.right) / 2;
                const markerCenterY = (anchorRect.top + anchorRect.bottom) / 2;

                const findIssuePopoverCandidate = (width, height) => {
                  const maxLeft = viewportRight - width;
                  const maxTop = viewportBottom - height;
                  if (width <= 0 || height <= 0 || maxLeft < minLeft || maxTop < minTop) return null;
                  const candidates = [];
                  const seen = new Set();
                  anchors.forEach((anchor, anchorIndex) => {
                    const centerX = (anchor.left + anchor.right) / 2;
                    const centerY = (anchor.top + anchor.bottom) / 2;
                    const rawCandidates = [
                      { placement: 'right', axis: 'vertical', left: anchor.right + popoverGap, top: centerY - height / 2 },
                      { placement: 'left', axis: 'vertical', left: anchor.left - width - popoverGap, top: centerY - height / 2 },
                      { placement: 'bottom', axis: 'horizontal', left: centerX - width / 2, top: anchor.bottom + popoverGap },
                      { placement: 'top', axis: 'horizontal', left: centerX - width / 2, top: anchor.top - height - popoverGap }
                    ];
                    rawCandidates.forEach((candidate, directionIndex) => {
                      const slotCount = candidate.axis === 'vertical'
                        ? Math.max(1, Math.ceil((maxTop - minTop) / markerSlotStep))
                        : Math.max(1, Math.ceil((maxLeft - minLeft) / markerSlotStep));
                      for (let slot = 0; slot <= slotCount; slot += 1) {
                        const offsets = slot === 0
                          ? [0]
                          : [slot * markerSlotStep, -slot * markerSlotStep];
                        for (const offset of offsets) {
                          const rawLeft = candidate.left + (candidate.axis === 'horizontal' ? offset : 0);
                          const rawTop = candidate.top + (candidate.axis === 'vertical' ? offset : 0);
                          const left = Math.min(maxLeft, Math.max(minLeft, rawLeft));
                          const top = Math.min(maxTop, Math.max(minTop, rawTop));
                          const identity = `${Math.round(left)}:${Math.round(top)}`;
                          if (seen.has(identity)) continue;
                          seen.add(identity);
                          const rect = { left, top, right: left + width, bottom: top + height };
                          if (overlapsPopoverObstacle(rect)) continue;
                          const markerDistance = rectangleDistance(rect, anchorRect);
                          if (markerDistance < popoverGap - screenToDocumentLength(1)) continue;
                          const centerDistance = Math.hypot(
                            left + width / 2 - markerCenterX,
                            top + height / 2 - markerCenterY
                          );
                          candidates.push({
                            ...candidate,
                            left,
                            top,
                            markerDistance,
                            score: markerDistance * 10000
                              + centerDistance
                              + directionIndex * 0.25
                              + anchorIndex * 0.01
                          });
                        }
                      }
                    });
                  });
                  candidates.sort((left, right) => left.score - right.score);
                  return {
                    preferred: candidates.find((candidate) =>
                      candidate.markerDistance <= popoverPreferredMaxMarkerDistance
                    ) || null,
                    fallback: candidates[0] || null
                  };
                };

                let layoutCandidateCount = 0;
                let fallbackLayout = null;
                let naturalElementGroupLayout = null;
                const applyIssuePopoverLayout = (layout) => {
                  issuePopover.style.removeProperty('height');
                  if (layout.density === 'normal') issuePopover.removeAttribute('data-density');
                  else issuePopover.dataset.density = layout.density;
                  if (layout.kind === 'wide') issuePopover.dataset.layout = 'wide';
                  else issuePopover.removeAttribute('data-layout');
                  if (layout.width) issuePopover.style.width = `${layout.width}px`;
                  else issuePopover.style.removeProperty('width');
                };
                const placeIssuePopoverCandidate = (selected) => {
                  issuePopover.removeAttribute('data-presentation');
                  clearIssueDetailFallback();
                  popoverLeaveGraceMs = Math.min(
                    POPOVER_MAX_LEAVE_GRACE_MS,
                    Math.max(
                      POPOVER_LEAVE_GRACE_MS,
                      Math.ceil(documentToScreenLength(selected.markerDistance) * POPOVER_POINTER_TRAVEL_MS_PER_PX)
                    )
                  );
                  issuePopover.dataset.placement = selected.placement;
                  issuePopover.style.transform = overlayTransform(
                    Math.round(selected.left),
                    Math.round(selected.top)
                  );
                  issuePopover.style.visibility = 'visible';
                  issuePopover.setAttribute('aria-hidden', 'false');
                  const descriptionTarget = issuePopoverDescriptionTarget || entry.button;
                  if (entry.issues.length > 1) {
                    descriptionTarget.removeAttribute('aria-describedby');
                    entry.button.setAttribute('aria-expanded', 'true');
                  } else {
                    descriptionTarget.setAttribute('aria-describedby', issuePopover.id);
                  }
                };
                const presentIssuePopoverAsExternalDescription = () => {
                  issuePopover.style.removeProperty('width');
                  issuePopover.style.removeProperty('height');
                  issuePopover.style.transform = overlayTransform(0, 0);
                  issuePopover.removeAttribute('data-density');
                  issuePopover.removeAttribute('data-layout');
                  issuePopover.removeAttribute('data-placement');
                  issuePopover.dataset.presentation = 'external-description';
                  popoverLeaveGraceMs = POPOVER_LEAVE_GRACE_MS;
                  issuePopover.hidden = false;
                  issuePopover.style.visibility = 'visible';
                  issuePopover.setAttribute('aria-hidden', 'false');
                  const descriptionTarget = issuePopoverDescriptionTarget || entry.button;
                  if (entry.issues.length > 1) {
                    descriptionTarget.removeAttribute('aria-describedby');
                    entry.button.setAttribute('aria-expanded', 'false');
                  } else {
                    descriptionTarget.setAttribute('aria-describedby', issuePopover.id);
                  }
                  postIssueDetailFallback(popoverIssueId);
                };
                const tryCurrentIssuePopoverLayout = (layout) => {
                  if (layoutCandidateCount >= POPOVER_MAX_LAYOUT_CANDIDATES) return false;
                  layoutCandidateCount += 1;
                  if (entry.issues.length > 1) {
                    const naturalMeasured = measureStableGroupedPopover(entry, layout, false);
                    if (issuePopover.scrollWidth <= issuePopover.clientWidth + 1
                        && issuePopover.scrollHeight <= issuePopover.clientHeight + 1) {
                      const naturalCandidates = findIssuePopoverCandidate(
                        naturalMeasured.width,
                        naturalMeasured.height
                      );
                      const naturalSelected = naturalCandidates?.preferred || naturalCandidates?.fallback;
                      if (naturalSelected && (
                        !naturalElementGroupLayout
                        || Boolean(naturalCandidates.preferred) > naturalElementGroupLayout.preferred
                        || (Boolean(naturalCandidates.preferred) === naturalElementGroupLayout.preferred
                          && naturalSelected.score < naturalElementGroupLayout.selected.score)
                      )) {
                        naturalElementGroupLayout = {
                          layout,
                          selected: naturalSelected,
                          preferred: Boolean(naturalCandidates.preferred)
                        };
                      }
                    }
                  }
                  const measured = measureStableGroupedPopover(entry, layout);
                  const width = measured.width;
                  const height = measured.height;
                  if (issuePopover.scrollWidth > issuePopover.clientWidth + 1
                      || issuePopover.scrollHeight > issuePopover.clientHeight + 1) return false;
                  const selected = findIssuePopoverCandidate(width, height);
                  if (!selected) return false;
                  if (!selected.preferred) {
                    if (selected.fallback && (
                      !fallbackLayout || selected.fallback.score < fallbackLayout.selected.score
                    )) {
                      fallbackLayout = { layout, selected: selected.fallback };
                    }
                    return false;
                  }
                  placeIssuePopoverCandidate(selected.preferred);
                  return true;
                };

                for (const density of POPOVER_DENSITIES) {
                  const layout = { kind: 'vertical', density, width: null };
                  applyIssuePopoverLayout(layout);
                  if (tryCurrentIssuePopoverLayout(layout)) return;
                }

                const availableWidth = Math.floor(viewportRight - minLeft);
                if (entry.issues.length > 1) {
                  for (const width of POPOVER_GROUP_NARROW_WIDTHS) {
                    if (screenToDocumentLength(width) > availableWidth) continue;
                    const layout = { kind: 'vertical', density: 'minimal', width };
                    applyIssuePopoverLayout(layout);
                    if (tryCurrentIssuePopoverLayout(layout)) return;
                  }
                }
                for (const width of POPOVER_WIDE_WIDTHS) {
                  if (screenToDocumentLength(width) > availableWidth) continue;
                  const layout = { kind: 'wide', density: 'normal', width };
                  applyIssuePopoverLayout(layout);
                  if (tryCurrentIssuePopoverLayout(layout)) return;
                }

                if (naturalElementGroupLayout?.preferred) {
                  applyIssuePopoverLayout(naturalElementGroupLayout.layout);
                  measureStableGroupedPopover(entry, naturalElementGroupLayout.layout, false);
                  placeIssuePopoverCandidate(naturalElementGroupLayout.selected);
                  return;
                }

                if (fallbackLayout) {
                  applyIssuePopoverLayout(fallbackLayout.layout);
                  measureStableGroupedPopover(entry, fallbackLayout.layout);
                  placeIssuePopoverCandidate(fallbackLayout.selected);
                  return;
                }

                if (naturalElementGroupLayout) {
                  applyIssuePopoverLayout(naturalElementGroupLayout.layout);
                  measureStableGroupedPopover(entry, naturalElementGroupLayout.layout, false);
                  placeIssuePopoverCandidate(naturalElementGroupLayout.selected);
                  return;
                }

                issuePopover.style.removeProperty('width');
                issuePopover.removeAttribute('data-layout');
                issuePopover.removeAttribute('data-density');
                presentIssuePopoverAsExternalDescription();
              };

              const showIssuePopover = (issueId, anchorElement = null) => {
                const entry = markers.get(issueKey(issueId));
                if (!entry || entry.button.hidden || !markersVisible) {
                  hideIssuePopover();
                  return false;
                }
                removeIssuePopoverDescription();
                const explicitAnchor = anchorElement instanceof Element && anchorElement.isConnected
                  ? anchorElement
                  : null;
                issuePopoverAnchorElement = explicitAnchor;
                issuePopoverDescriptionTarget = explicitAnchor || entry.button;
                popoverIssueId = issueId;
                setIssuePopoverContent(entry, issueId);
                issuePopover.dataset.issueId = issueKey(issueId);
                positionIssuePopover();
                if (entry.issues.length > 1 && !issuePopover.hidden) {
                  entry.button.setAttribute('aria-expanded', 'true');
                }
                schedulePositions();
                return !issuePopover.hidden;
              };

              const createMarkerSpatialIndex = () => {
                const cells = new Map();
                const markerSize = replayMarkerSize();
                const markerHalo = replayMarkerHalo();
                const markerSlotStep = replayMarkerSlotStep();
                const cellCoordinate = (value) => Math.floor(value / markerSlotStep);
                const hasCollision = (left, top) => {
                  const originCellX = cellCoordinate(left);
                  const originCellY = cellCoordinate(top);
                  for (let cellX = originCellX - 1; cellX <= originCellX + 1; cellX += 1) {
                    const column = cells.get(cellX);
                    if (!column) continue;
                    for (let cellY = originCellY - 1; cellY <= originCellY + 1; cellY += 1) {
                      const position = column.get(cellY);
                      if (position
                          && Math.abs(position.left - left) < markerSlotStep
                          && Math.abs(position.top - top) < markerSlotStep) return true;
                    }
                  }
                  return false;
                };
                const hasMarkerRectOverlap = (rect) => {
                  const minCellX = cellCoordinate(rect.left - markerSize - markerHalo);
                  const maxCellX = cellCoordinate(rect.right + markerHalo);
                  const minCellY = cellCoordinate(rect.top - markerSize - markerHalo);
                  const maxCellY = cellCoordinate(rect.bottom + markerHalo);
                  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                    const column = cells.get(cellX);
                    if (!column) continue;
                    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
                      const position = column.get(cellY);
                      if (!position) continue;
                      const markerRect = {
                        left: position.left - markerHalo,
                        top: position.top - markerHalo,
                        right: position.left + markerSize + markerHalo,
                        bottom: position.top + markerSize + markerHalo
                      };
                      if (rectanglesOverlap(rect, markerRect)) return true;
                    }
                  }
                  return false;
                };
                const add = (position) => {
                  // One entry per cell is sufficient: two positions in the same
                  // MARKER_SLOT_STEP cell necessarily fail hasCollision.
                  const cellX = cellCoordinate(position.left);
                  let column = cells.get(cellX);
                  if (!column) {
                    column = new Map();
                    cells.set(cellX, column);
                  }
                  column.set(cellCoordinate(position.top), position);
                };
                return { add, hasCollision, hasMarkerRectOverlap };
              };

              const createCarouselControlObstacleIndex = (documentWidth, documentHeight,
                                                            readDocumentRects) => {
                const protectedRects = [];
                const controlHitTargetSize = screenToDocumentLength(CAROUSEL_CONTROL_HIT_TARGET_SIZE);
                const controlClearance = screenToDocumentLength(CAROUSEL_CONTROL_CLEARANCE);
                for (const root of collectReplayRoots()) {
                  for (const control of root.querySelectorAll(CAROUSEL_CONTROL_SELECTOR)) {
                    if (isBridgeElement(control)
                        || carouselControlDirection(control) === 0
                        || !resolveControlSlider(control)
                        || control.matches(':disabled')
                        || control.getAttribute('aria-disabled') === 'true'
                        || getComputedStyle(control).pointerEvents === 'none') continue;
                    for (const rect of readDocumentRects(control)) {
                      if (rect.right <= 0 || rect.left >= documentWidth
                          || rect.bottom <= 0 || rect.top >= documentHeight) continue;
                      const centerX = (rect.left + rect.right) / 2;
                      const centerY = (rect.top + rect.bottom) / 2;
                      const hitWidth = Math.min(controlHitTargetSize, rect.width);
                      const hitHeight = Math.min(controlHitTargetSize, rect.height);
                      protectedRects.push({
                        left: centerX - hitWidth / 2 - controlClearance,
                        top: centerY - hitHeight / 2 - controlClearance,
                        right: centerX + hitWidth / 2 + controlClearance,
                        bottom: centerY + hitHeight / 2 + controlClearance
                      });
                    }
                  }
                }
                return {
                  hasOverlap: (rect) => protectedRects.some(
                    (protectedRect) => rectanglesOverlap(rect, protectedRect)
                  )
                };
              };

              const markerRectForPosition = (position) => {
                const markerSize = replayMarkerSize();
                const markerHalo = replayMarkerHalo();
                return {
                  left: position.left - markerHalo,
                  top: position.top - markerHalo,
                  right: position.left + markerSize + markerHalo,
                  bottom: position.top + markerSize + markerHalo
                };
              };

              const markerPositionAvailable = (left, top, spatialIndex, carouselControlObstacles, targetRects,
                                                 minLeft, minTop, maxLeft, maxTop) => {
                if (left < minLeft || left > maxLeft || top < minTop || top > maxTop) return false;
                if (spatialIndex.hasCollision(left, top)) return false;
                const markerRect = markerRectForPosition({ left, top });
                if (carouselControlObstacles && carouselControlObstacles.hasOverlap(markerRect)) return false;
                return !targetRects.some((targetRect) => rectanglesOverlap(markerRect, targetRect));
              };

              const markerSearchKey = (targetRects, families, minLeft, minTop, maxLeft, maxTop,
                                       preferRightGutter) => JSON.stringify([
                preferRightGutter,
                minLeft,
                minTop,
                maxLeft,
                maxTop,
                families.map((family) => [
                  family.axis, family.baseLeft, family.baseTop, family.slots
                ]),
                targetRects.map((rect) => [rect.left, rect.top, rect.right, rect.bottom])
              ]);

              const nextMarkerCandidate = (families, cursor) => {
                const markerSlotStep = replayMarkerSlotStep();
                const maxSlots = families.reduce(
                  (result, family) => Math.max(result, family.slots),
                  0
                );
                while (cursor.slot <= maxSlots) {
                  if (cursor.familyIndex >= families.length) {
                    cursor.slot += 1;
                    cursor.familyIndex = 0;
                    cursor.offsetIndex = 0;
                    continue;
                  }
                  const family = families[cursor.familyIndex];
                  if (cursor.slot > family.slots) {
                    cursor.familyIndex += 1;
                    cursor.offsetIndex = 0;
                    continue;
                  }
                  const offsetCount = cursor.slot === 0 ? 1 : 2;
                  if (cursor.offsetIndex >= offsetCount) {
                    cursor.familyIndex += 1;
                    cursor.offsetIndex = 0;
                    continue;
                  }
                  const offset = cursor.slot === 0
                    ? 0
                    : (cursor.offsetIndex === 0 ? 1 : -1) * cursor.slot * markerSlotStep;
                  cursor.offsetIndex += 1;
                  return {
                    left: family.baseLeft + (family.axis === 'horizontal' ? offset : 0),
                    top: family.baseTop + (family.axis === 'vertical' ? offset : 0)
                  };
                }
                return null;
              };

              const findMarkerPosition = (targetRects, spatialIndex, carouselControlObstacles, searchCursors,
                                          minLeft, minTop, maxLeft, maxTop, preferRightGutter) => {
                if (targetRects.length === 0) return null;
                const firstRect = targetRects[0];
                const markerSize = replayMarkerSize();
                const markerGap = replayMarkerGap();
                const markerSlotStep = replayMarkerSlotStep();
                const verticalSlots = Math.max(1, Math.ceil((maxTop - minTop) / markerSlotStep));
                const horizontalSlots = Math.max(1, Math.ceil((maxLeft - minLeft) / markerSlotStep));
                const leftGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.left - markerSize - markerGap,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const rightGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.right + markerGap,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const topGutter = {
                    axis: 'horizontal',
                    baseLeft: firstRect.left,
                    baseTop: firstRect.top - markerSize - markerGap,
                    slots: horizontalSlots
                };
                const bottomGutter = {
                    axis: 'horizontal',
                    baseLeft: firstRect.left,
                    baseTop: firstRect.bottom + markerGap,
                    slots: horizontalSlots
                };
                const families = preferRightGutter
                  ? [rightGutter, topGutter, leftGutter, bottomGutter]
                  : [leftGutter, topGutter, rightGutter, bottomGutter];
                const searchKey = markerSearchKey(
                  targetRects, families, minLeft, minTop, maxLeft, maxTop, preferRightGutter
                );
                let cursor = searchCursors.get(searchKey);
                if (!cursor) {
                  cursor = { familyIndex: 0, slot: 0, offsetIndex: 0 };
                  searchCursors.set(searchKey, cursor);
                }
                // Occupancy only grows during a pass. For identical geometry,
                // every candidate before this cursor remains unavailable and the
                // previously returned candidate is now present in spatialIndex.
                // Iterate by distance ring before exhausting a single gutter so a
                // nearby top/right/bottom anchor wins over a far-away left slot.
                for (let candidate = nextMarkerCandidate(families, cursor);
                     candidate;
                     candidate = nextMarkerCandidate(families, cursor)) {
                  if (markerPositionAvailable(
                    candidate.left, candidate.top, spatialIndex, carouselControlObstacles, targetRects,
                    minLeft, minTop, maxLeft, maxTop
                  )) return candidate;
                }
                return null;
              };

              const findNearestCarouselSafeMarkerPosition = (
                baseline, targetRects, spatialIndex, carouselControlObstacles,
                minLeft, minTop, maxLeft, maxTop, preferRightGutter
              ) => {
                if (!baseline || targetRects.length === 0) return null;
                const firstRect = targetRects[0];
                const markerSize = replayMarkerSize();
                const markerGap = replayMarkerGap();
                const markerSlotStep = replayMarkerSlotStep();
                const gutterMatchTolerance = screenToDocumentLength(MARKER_GUTTER_MATCH_TOLERANCE);
                const verticalSlots = Math.min(
                  CAROUSEL_MARKER_RELOCATION_SLOTS,
                  Math.max(1, Math.ceil((maxTop - minTop) / markerSlotStep))
                );
                const horizontalSlots = Math.min(
                  CAROUSEL_MARKER_RELOCATION_SLOTS,
                  Math.max(1, Math.ceil((maxLeft - minLeft) / markerSlotStep))
                );
                const leftGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.left - markerSize - markerGap,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const rightGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.right + markerGap,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const topGutter = {
                  axis: 'horizontal',
                  baseLeft: firstRect.left,
                  baseTop: firstRect.top - markerSize - markerGap,
                  slots: horizontalSlots
                };
                const bottomGutter = {
                  axis: 'horizontal',
                  baseLeft: firstRect.left,
                  baseTop: firstRect.bottom + markerGap,
                  slots: horizontalSlots
                };
                const families = preferRightGutter
                  ? [rightGutter, topGutter, leftGutter, bottomGutter]
                  : [leftGutter, topGutter, rightGutter, bottomGutter];
                const baselineFamilyIndex = families.findIndex((family) =>
                  family.axis === 'vertical'
                    ? Math.abs(baseline.left - family.baseLeft) <= gutterMatchTolerance
                    : Math.abs(baseline.top - family.baseTop) <= gutterMatchTolerance
                );
                const candidates = [];
                const seen = new Set();
                let order = 0;
                for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
                  const family = families[familyIndex];
                  for (let slot = 0; slot <= family.slots; slot += 1) {
                    const offsets = slot === 0
                      ? [0]
                      : [slot * markerSlotStep, -slot * markerSlotStep];
                    for (const offset of offsets) {
                      const left = family.baseLeft + (family.axis === 'horizontal' ? offset : 0);
                      const top = family.baseTop + (family.axis === 'vertical' ? offset : 0);
                      const key = String(left) + ':' + String(top);
                      if (seen.has(key)) continue;
                      seen.add(key);
                      candidates.push({
                        left,
                        top,
                        familyRank: baselineFamilyIndex < 0 || familyIndex === baselineFamilyIndex ? 0 : 1,
                        distance: Math.hypot(left - baseline.left, top - baseline.top),
                        order: order++
                      });
                    }
                  }
                }
                candidates.sort((left, right) =>
                  left.familyRank - right.familyRank
                    || left.distance - right.distance
                    || left.order - right.order
                );
                for (const candidate of candidates) {
                  if (markerPositionAvailable(
                    candidate.left, candidate.top, spatialIndex, carouselControlObstacles, targetRects,
                    minLeft, minTop, maxLeft, maxTop
                  )) return { left: candidate.left, top: candidate.top };
                }
                return null;
              };

              const updatePositions = () => {
                positionFrame = 0;
                if (positionPassesRemaining > 0) positionPassesRemaining -= 1;
                const baselineMarkerSpatialIndex = createMarkerSpatialIndex();
                const searchCursors = new Map();
                const documentRectCache = new WeakMap();
                const targetGeometryCache = new WeakMap();
                const placements = [];
                const documentElement = document.documentElement;
                const body = document.body;
                const documentWidth = Math.max(window.innerWidth, documentElement.scrollWidth, body ? body.scrollWidth : 0);
                const documentHeight = Math.max(window.innerHeight, documentElement.scrollHeight, body ? body.scrollHeight : 0);
                const markerSize = replayMarkerSize();
                const markerHalo = replayMarkerHalo();
                const minLeft = Math.min(markerHalo, Math.max(0, documentWidth - markerSize));
                const minTop = Math.min(markerHalo, Math.max(0, documentHeight - markerSize));
                const maxLeft = Math.max(minLeft, documentWidth - markerSize - markerHalo);
                const maxTop = Math.max(minTop, documentHeight - markerSize - markerHalo);
                const readDocumentRects = (element) => {
                  let rects = documentRectCache.get(element);
                  if (!rects) {
                    rects = targetDocumentRects(element);
                    documentRectCache.set(element, rects);
                  }
                  return rects;
                };
                const carouselControlObstacles = createCarouselControlObstacleIndex(
                  documentWidth, documentHeight, readDocumentRects
                );
                for (const entry of markerGroups) {
                  let geometry = targetGeometryCache.get(entry.target);
                  if (!geometry) {
                    const targetRects = readDocumentRects(entry.target);
                    const outsideDocument = targetRects.length === 0 || targetRects.every((rect) =>
                      rect.right <= 0
                      || rect.left >= documentWidth
                      || rect.bottom <= 0
                      || rect.top >= documentHeight
                    );
                    geometry = {
                      outsideDocument,
                      preferRightGutter: outsideDocument
                        ? false
                        : getComputedStyle(entry.target).direction === 'rtl',
                      visibleTargetRects: targetRects.filter((rect) =>
                        rect.right > 0
                        && rect.left < documentWidth
                        && rect.bottom > 0
                        && rect.top < documentHeight
                      )
                    };
                    targetGeometryCache.set(entry.target, geometry);
                  }
                  if (!markersVisible || geometry.outsideDocument) {
                    placements.push({ entry, position: null });
                    continue;
                  }
                  const position = findMarkerPosition(
                    geometry.visibleTargetRects, baselineMarkerSpatialIndex, null, searchCursors,
                    minLeft, minTop, maxLeft, maxTop,
                    geometry.preferRightGutter
                  );
                  if (position) baselineMarkerSpatialIndex.add(position);
                  placements.push({ entry, position, geometry });
                }
                const nextMarkerSpatialIndex = createMarkerSpatialIndex();
                const carouselCollisionPlacements = [];
                for (const placement of placements) {
                  if (placement.position
                      && carouselControlObstacles.hasOverlap(markerRectForPosition(placement.position))) {
                    carouselCollisionPlacements.push(placement);
                  } else if (placement.position) {
                    nextMarkerSpatialIndex.add(placement.position);
                  }
                }
                for (const placement of carouselCollisionPlacements) {
                  placement.position = findNearestCarouselSafeMarkerPosition(
                    placement.position,
                    placement.geometry.visibleTargetRects,
                    nextMarkerSpatialIndex,
                    carouselControlObstacles,
                    minLeft,
                    minTop,
                    maxLeft,
                    maxTop,
                    placement.geometry.preferRightGutter
                  );
                  if (placement.position) nextMarkerSpatialIndex.add(placement.position);
                }
                markerSpatialIndex = nextMarkerSpatialIndex;
                for (const placement of placements) {
                  placement.entry.position = placement.position;
                  placement.entry.button.hidden = !placement.position;
                  if (placement.position) {
                    placement.entry.button.style.transform =
                      overlayTransform(placement.position.left, placement.position.top);
                  }
                  if (markersVisible) {
                    for (const issue of placement.entry.issues) {
                      reportLocatorStatus(
                        issue.id,
                        placement.position ? 'CONNECTED' : 'UNAVAILABLE',
                        placement.position ? '' : 'NO_VISIBLE_MARKER_POSITION'
                      );
                    }
                  }
                }
                const previewCleared = clearUnavailableMarkerPreview();
                positionIssueDock();
                updateSelectedTargetHighlight();
                if (!previewCleared) positionIssuePopover();
                if (positionPassesRemaining > 0) positionFrame = requestAnimationFrame(updatePositions);
              };

              const schedulePositions = (passes = 1) => {
                const requestedPasses = Math.max(1, Math.min(SLIDER_SETTLE_FRAMES, Number(passes) || 1));
                positionPassesRemaining = Math.max(positionPassesRemaining, requestedPasses);
                if (!positionFrame) positionFrame = requestAnimationFrame(updatePositions);
              };

            """,
            """

              const clearUnavailableMarkerPreview = () => {
                if (popoverIssueId === null) return false;
                const key = markerGroupKeyForIssue(popoverIssueId);
                const groupedEntry = markers.get(issueKey(popoverIssueId));
                if (groupedEntry && groupedEntry.target.isConnected && !groupedEntry.button.hidden && groupedEntry.position) return false;
                cancelMarkerPreviewClear();
                if (activeMarkerPreview && activeMarkerPreview.key === key) activeMarkerPreview = null;
                if (pinnedIssueId !== null && markerGroupKeyForIssue(pinnedIssueId) === key) {
                  pinnedIssueId = null;
                  pinnedSelectionOwned = false;
                }
                hideIssuePopover();
                if (markerGroupKeyForIssue(selectedIssueId) === key) {
                  selectAndNotifyIssue(null, false, true, false);
                }
                return true;
              };

              const selectIssue = (issueId, moveFocus, revealSlider = true, preserveOpenPopover = false) => {
                const previousEntry = markers.get(issueKey(selectedIssueId));
                const entry = markers.get(issueKey(issueId));
                if (dockedEntry && dockedEntry !== entry) {
                  hideIssuePopover();
                  hideIssueDock();
                }
                selectedIssueId = issueId;
                if (entry && dockedEntry === entry && issueDock && !issueDock.hidden) {
                  const selectedIndex = entry.issues.findIndex((issue) => issue.id === issueId);
                  const selectedPage = selectedIndex >= 0
                    ? Math.floor(selectedIndex / ISSUE_DOCK_PAGE_SIZE)
                    : issueDockPage;
                  if (selectedPage !== issueDockPage) {
                    issueDockPage = selectedPage;
                    renderIssueDock();
                    positionIssueDock();
                  }
                }
                if (previousEntry && previousEntry !== entry) {
                  previousEntry.button.dataset.selected = 'false';
                  previousEntry.button.setAttribute('aria-pressed', 'false');
                }
                if (entry) {
                  entry.button.dataset.selected = 'true';
                  entry.button.setAttribute('aria-pressed', 'true');
                }
                refreshIssueDockSelection();
                const popoverEntry = popoverIssueId === null
                  ? null
                  : markers.get(issueKey(popoverIssueId));
                if (!entry || (popoverEntry && popoverEntry !== entry)) {
                  hideIssuePopover();
                } else if (entry && popoverEntry === entry && popoverIssueId !== issueId && !issuePopover.hidden) {
                  if (preserveOpenPopover && entry.issues.length > 1) {
                    popoverIssueId = issueId;
                    updateIssuePopoverSelection(entry, issueId);
                    issuePopover.dataset.issueId = issueKey(issueId);
                  } else {
                    const dockButton = issueDock && dockedEntry === entry
                      ? issueDock.querySelector(`.issue-dock__item[data-issue-id="${issueKey(issueId)}"]`)
                      : null;
                    if (!dockButton) {
                      hideIssuePopover();
                    } else {
                      removeIssuePopoverDescription();
                      issuePopoverAnchorElement = dockButton;
                      issuePopoverDescriptionTarget = dockButton;
                      popoverIssueId = issueId;
                      setIssuePopoverContent(entry, issueId);
                      issuePopover.dataset.issueId = issueKey(issueId);
                      positionIssuePopover();
                    }
                  }
                }
                const issueTarget = entry ? issueTargetForEntry(entry, issueId) : null;
                if (issueTarget && revealSlider) revealSliderForTarget(issueTarget);
                highlightSelectedTarget(issueTarget);
                if (!entry) return;
                if (moveFocus) {
                  issueTarget?.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                  schedulePositions(SLIDER_SETTLE_FRAMES);
                  requestAnimationFrame(() => {
                    if (markersVisible && entry.button.isConnected && !entry.button.hidden) {
                      entry.button.focus({ preventScroll: true });
                    }
                  });
                  return;
                }
                if (!preserveOpenPopover) schedulePositions();
              };

              const selectAndNotifyIssue = (
                issueId,
                moveFocus,
                skipIfSelected = false,
                revealSlider = true,
                preserveOpenPopover = false
              ) => {
                if (skipIfSelected && issueKey(selectedIssueId) === issueKey(issueId)) return false;
                selectIssue(issueId, moveFocus, revealSlider, preserveOpenPopover);
                post({ type: 'ISSUE_SELECTED', issueId });
                return true;
              };

              const previewIssueFromMarker = (button, issueId, pointerType = '') => {
                if (pointerType === 'touch'
                    || pinnedIssueId !== null
                    || button.hidden
                    || !button.isConnected) return false;
                cancelMarkerPreviewClear();
                const key = markerGroupKeyForIssue(issueId);
                if (!activeMarkerPreview
                    || activeMarkerPreview.key !== key
                    || issueKey(activeMarkerPreview.issueId) !== issueKey(issueId)) {
                  activeMarkerPreview = {
                    key,
                    issueId,
                    ownsSelection: false,
                    pointer: false,
                    focus: false,
                    popoverPointer: false
                  };
                }
                if (pointerType) activeMarkerPreview.pointer = true;
                else activeMarkerPreview.focus = true;
                const changed = selectAndNotifyIssue(issueId, false, true, false);
                activeMarkerPreview.ownsSelection = activeMarkerPreview.ownsSelection || changed;
                showIssuePopover(issueId);
                return changed;
              };

              const endMarkerPreview = (issueId, source, pointerType = '') => {
                if (pointerType === 'touch' || !activeMarkerPreview) return;
                const key = markerGroupKeyForIssue(issueId);
                if (activeMarkerPreview.key !== key) return;
                activeMarkerPreview[source] = false;
                if (markerPreviewIsActive(activeMarkerPreview)
                    || markerPreviewClearFrame
                    || markerPreviewClearTimer) return;
                const pointerTransition = source === 'pointer' || source === 'popoverPointer';
                scheduleMarkerPreviewClear(key, pointerTransition);
              };

              const beginIssuePopoverPreview = (source, pointerType = '') => {
                if (pointerType === 'touch'
                    || popoverIssueId === null
                    || issuePopover.hidden
                    || pinnedIssueId !== null
                    || (issueDock && issuePopoverAnchorElement && issueDock.contains(issuePopoverAnchorElement))) return;
                const key = markerGroupKeyForIssue(popoverIssueId);
                cancelMarkerPreviewClear();
                if (!activeMarkerPreview || activeMarkerPreview.key !== key) {
                  activeMarkerPreview = {
                    key,
                    issueId: popoverIssueId,
                    ownsSelection: false,
                    pointer: false,
                    focus: false,
                    popoverPointer: false
                  };
                }
                activeMarkerPreview[source] = true;
              };

              const dismissPinnedIssue = () => {
                if (pinnedIssueId === null) return false;
                const issueId = pinnedIssueId;
                const ownsSelection = pinnedSelectionOwned;
                pinnedIssueId = null;
                pinnedSelectionOwned = false;
                activeMarkerPreview = null;
                cancelMarkerPreviewClear();
                if (ownsSelection && issueKey(selectedIssueId) === issueKey(issueId)) {
                  selectAndNotifyIssue(null, false, true, false);
                } else {
                  hideIssuePopover();
                }
                return true;
              };

              const dismissActiveMarkerPreview = () => {
                if (!activeMarkerPreview) return false;
                const preview = activeMarkerPreview;
                const issueId = preview.issueId;
                activeMarkerPreview = null;
                cancelMarkerPreviewClear();
                if (preview.ownsSelection && issueKey(selectedIssueId) === issueKey(issueId)) {
                  selectAndNotifyIssue(null, false, true, false);
                } else {
                  hideIssuePopover();
                }
                return true;
              };

              const clearMarkers = () => {
                cancelMarkerPreviewClear();
                activeMarkerPreview = null;
                pinnedIssueId = null;
                pinnedSelectionOwned = false;
                hideIssuePopover();
                hideIssueDock();
                clearSelectedTarget();
                for (const entry of markerGroups) entry.button.remove();
                markers.clear();
                markerGroups.clear();
                reportedLocatorStatuses.clear();
                markerSpatialIndex = null;
              };

              const refreshSelectedTarget = () => {
                if (!markersVisible || selectedIssueId === null || selectedTarget) return;
                const entry = markers.get(issueKey(selectedIssueId));
                const issueTarget = entry ? issueTargetForEntry(entry, selectedIssueId) : null;
                if (!issueTarget || !issueTarget.isConnected || issueTarget.getClientRects().length === 0) return;
                highlightSelectedTarget(issueTarget);
              };

              const initializeIssues = (message, shadowRoot) => {
                clearMarkers();
                markersVisible = message.markersVisible !== false;
                const issues = Array.isArray(message.issues) ? message.issues.slice(0, MAX_ISSUES) : [];
                const seenIssueIds = new Set();
                const resolvedIssues = [];
                const markerBatch = document.createDocumentFragment();
                issues.forEach((rawIssue, index) => {
                  if (!rawIssue
                      || !Number.isSafeInteger(rawIssue.id)
                      || rawIssue.id <= 0
                      || seenIssueIds.has(rawIssue.id)) return;
                  seenIssueIds.add(rawIssue.id);
                  const issue = normalizeIssue(rawIssue);
                  const resolved = resolveIssue(issue);
                  if (!resolved.target) {
                    reportLocatorStatus(issue.id, 'UNAVAILABLE', resolved.reason);
                    return;
                  }
                  resolvedIssues.push({ issue, target: resolved.target, index });
                  reportLocatorStatus(issue.id, 'CONNECTED');
                });

                for (const plan of buildMarkerGroupPlans(resolvedIssues)) {
                  const button = document.createElement('button');
                  button.type = 'button';
                  button.className = 'marker';
                  button.dataset.markerIndex = String(plan.firstIndex + 1);
                  button.hidden = true;
                  button.dataset.selected = 'false';
                  button.setAttribute('aria-pressed', 'false');
                  const badge = createMarkerBadge();
                  button.appendChild(badge);
                  const entry = {
                    groupKey: issueKey(plan.issues[0].id),
                    groupScope: plan.groupScope,
                    targetCount: plan.targetCount,
                    issues: plan.issues,
                    target: plan.target,
                    issueTargets: plan.issueTargets,
                    button,
                    badge,
                    position: null
                  };
                  const interactionIssueId = () => markerInteractionIssue(entry).id;
                  let lastPointerType = '';
                  button.addEventListener('pointerdown', (event) => {
                    lastPointerType = event.pointerType;
                  });
                  button.addEventListener('pointerenter', (event) => {
                    previewIssueFromMarker(button, interactionIssueId(), event.pointerType);
                  });
                  button.addEventListener('pointerleave', (event) => {
                    endMarkerPreview(interactionIssueId(), 'pointer', event.pointerType);
                  });
                  button.addEventListener('pointercancel', (event) => {
                    endMarkerPreview(interactionIssueId(), 'pointer', event.pointerType);
                  });
                  button.addEventListener('focus', () => {
                    if (suppressNextMarkerFocusPreview) {
                      suppressNextMarkerFocusPreview = false;
                      return;
                    }
                    if (button.matches(':focus-visible')) previewIssueFromMarker(button, interactionIssueId());
                  });
                  button.addEventListener('blur', () => {
                    endMarkerPreview(interactionIssueId(), 'focus');
                  });
                  button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const activeIssueId = interactionIssueId();
                    const pointerType = typeof event.pointerType === 'string'
                      ? event.pointerType
                      : lastPointerType;
                    const keyboardActivation = event.detail === 0 && button.matches(':focus');
                    const opensGroupedSelector = keyboardActivation && entry.issues.length > 1;
                    const inheritsPreviewSelection = Boolean(
                      activeMarkerPreview
                      && activeMarkerPreview.ownsSelection
                      && issueKey(activeMarkerPreview.issueId) === issueKey(activeIssueId)
                    );
                    const inheritsPinnedSelection = Boolean(
                      pinnedSelectionOwned
                      && issueKey(pinnedIssueId) === issueKey(activeIssueId)
                    );
                    lastPointerType = '';
                    if (pointerType === 'touch' || !keyboardActivation || opensGroupedSelector) {
                      cancelMarkerPreviewClear();
                      activeMarkerPreview = null;
                      pinnedIssueId = activeIssueId;
                      pinnedSelectionOwned = inheritsPreviewSelection || inheritsPinnedSelection;
                    } else if (keyboardActivation) {
                      pinnedIssueId = null;
                      pinnedSelectionOwned = false;
                      const key = entry.groupKey;
                      if (!activeMarkerPreview || activeMarkerPreview.key !== key) {
                        activeMarkerPreview = {
                          key,
                          issueId: activeIssueId,
                          ownsSelection: false,
                          pointer: false,
                          focus: false,
                          popoverPointer: false
                        };
                      }
                      activeMarkerPreview.focus = true;
                    }
                    const selectionChanged = selectAndNotifyIssue(activeIssueId, false, true);
                    if (activeMarkerPreview) {
                      activeMarkerPreview.ownsSelection = activeMarkerPreview.ownsSelection || selectionChanged;
                    } else if (issueKey(pinnedIssueId) === issueKey(activeIssueId)) {
                      pinnedSelectionOwned = pinnedSelectionOwned || selectionChanged;
                    }
                    showIssuePopover(activeIssueId);
                    if (opensGroupedSelector) {
                      requestAnimationFrame(() => focusIssuePopoverSelector(activeIssueId));
                    }
                  });
                  markerBatch.appendChild(button);
                  markerGroups.add(entry);
                  for (const issue of entry.issues) markers.set(issueKey(issue.id), entry);
                }
                for (const entry of markerGroups) refreshMarkerGroupPresentation(entry);
                shadowRoot.appendChild(markerBatch);
                selectedIssueId = typeof message.selectedIssueId === 'number' ? message.selectedIssueId : null;
                if (selectedIssueId !== null) selectIssue(selectedIssueId, false, !issuesInitialized);
                issuesInitialized = true;
                if (positionFrame) cancelAnimationFrame(positionFrame);
                positionFrame = 0;
                positionPassesRemaining = 0;
                updatePositions();
              };

              const findLink = (event) => {
                for (const node of event.composedPath ? event.composedPath() : []) {
                  if (node && node.tagName && (node.tagName.toLowerCase() === 'a' || node.tagName.toLowerCase() === 'area')) return node;
                }
                return null;
              };

              const blockLink = (event) => {
                const link = findLink(event);
                if (!link) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                post({ type: 'LINK_BLOCKED', href: link.getAttribute('data-uni-accessibility-replay-href') || undefined });
              };

            """,
            """
              const FRAMEWORK_WRAPPER_SELECTOR = '.swiper-wrapper,.slick-track,.splide__list';
              const FRAMEWORK_SLIDE_SELECTOR = '.swiper-slide,.slick-slide,.splide__slide';
              const CLONE_SLIDE_SELECTOR = '.swiper-slide-duplicate,.slick-cloned,.is-clone';
              const SLIDER_STATE_CLASSES = [
                'swiper-slide-active', 'swiper-slide-prev', 'swiper-slide-next',
                'swiper-slide-visible', 'swiper-slide-fully-visible',
                'slick-current', 'slick-active', 'is-active', 'is-prev', 'is-next'
              ];

              const collectReplayRoots = () => {
                const roots = [];
                const queue = [document];
                const seen = new Set();
                while (queue.length > 0) {
                  const root = queue.shift();
                  if (!root || seen.has(root)) continue;
                  seen.add(root);
                  roots.push(root);
                  for (const element of root.querySelectorAll('*')) {
                    if (element.shadowRoot && element.id !== HOST_ID) queue.push(element.shadowRoot);
                  }
                }
                return roots;
              };

              const queryReplayElements = (selector) => {
                const elements = [];
                for (const root of collectReplayRoots()) elements.push(...root.querySelectorAll(selector));
                return elements;
              };

              const observeReplayRootScroll = () => {
                for (const root of collectReplayRoots()) {
                  if (root === document || positionGuardRoots.has(root)) continue;
                  root.addEventListener('scroll', schedulePositions, { capture: true, passive: true });
                  positionGuardRoots.add(root);
                }
              };

              const composedClosest = (element, selector) => {
                let current = element instanceof Element ? element : null;
                const visited = new Set();
                while (current && !visited.has(current)) {
                  visited.add(current);
                  if (current.matches(selector)) return current;
                  if (current.parentElement) {
                    current = current.parentElement;
                    continue;
                  }
                  const root = current.getRootNode();
                  current = root instanceof ShadowRoot && root.host instanceof Element ? root.host : null;
                }
                return null;
              };

              const parseBoundedInteger = (value, minimum, maximum) => {
                const text = String(value || '');
                if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 10) return null;
                const parsed = Number(text);
                return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
              };

              const sliderKind = (wrapper) => {
                if (wrapper.matches('.swiper-wrapper')) return 'SWIPER';
                if (wrapper.matches('.slick-track')) return 'SLICK';
                if (wrapper.matches('.splide__list')) return 'SPLIDE';
                return 'ANNOTATED';
              };

              const sliderSlides = (wrapper) => {
                const children = Array.from(wrapper.children).filter((child) => child instanceof Element);
                const kind = sliderKind(wrapper);
                let managedSlides = children;
                if (kind === 'SWIPER') managedSlides = children.filter((child) => child.matches('.swiper-slide'));
                else if (kind === 'SLICK') managedSlides = children.filter((child) => child.matches('.slick-slide'));
                else if (kind === 'SPLIDE') managedSlides = children.filter((child) => child.matches('.splide__slide'));
                return {
                  managedSlides,
                  slides: managedSlides.filter((slide) => !slide.matches(CLONE_SLIDE_SELECTOR))
                };
              };

              const sliderArea = (wrapper) => {
                const rect = wrapper.getBoundingClientRect();
                return Math.max(0, rect.width) * Math.max(0, rect.height);
              };

              const isHiddenSliderCandidate = (wrapper) => {
                if (wrapper.hidden || wrapper.closest('[hidden],[aria-hidden="true"]')) return true;
                const style = getComputedStyle(wrapper);
                return style.display === 'none' || style.visibility === 'hidden' || sliderArea(wrapper) <= 0;
              };

              const buildAnnotatedSliderCandidates = () => {
                const roots = new Map();
                const selector = `[${CAROUSEL_ID_ATTRIBUTE}][${SLIDE_INDEX_ATTRIBUTE}][${SLIDE_COUNT_ATTRIBUTE}]`;
                for (const slide of queryReplayElements(selector)) {
                  if (!(slide instanceof Element) || slide.matches(CLONE_SLIDE_SELECTOR) || isBridgeElement(slide)) continue;
                  const carouselId = parseBoundedInteger(slide.getAttribute(CAROUSEL_ID_ATTRIBUTE), 1, MAX_CAROUSEL_ID);
                  const index = parseBoundedInteger(slide.getAttribute(SLIDE_INDEX_ATTRIBUTE), 0, MAX_CAROUSEL_SLIDES - 1);
                  const count = parseBoundedInteger(slide.getAttribute(SLIDE_COUNT_ATTRIBUTE), 2, MAX_CAROUSEL_SLIDES);
                  if (carouselId === null || index === null || count === null || index >= count) continue;
                  const root = slide.getRootNode();
                  if (!roots.has(root)) roots.set(root, new Map());
                  const groups = roots.get(root);
                  if (!groups.has(carouselId)) groups.set(carouselId, { carouselId, count, entries: [], invalid: false });
                  const group = groups.get(carouselId);
                  if (group.count !== count || group.entries.some((entry) => entry.index === index)) group.invalid = true;
                  group.entries.push({ slide, index });
                }

                const candidates = [];
                for (const groups of roots.values()) {
                  for (const group of groups.values()) {
                    if (group.invalid || group.entries.length !== group.count) continue;
                    group.entries.sort((left, right) => left.index - right.index);
                    if (group.entries.some((entry, index) => entry.index !== index)) continue;
                    const slides = group.entries.map((entry) => entry.slide);
                    const wrapper = slides[0].closest(FRAMEWORK_WRAPPER_SELECTOR) || slides[0].parentElement;
                    if (!wrapper || slides.some((slide) =>
                      (slide.closest(FRAMEWORK_WRAPPER_SELECTOR) || slide.parentElement) !== wrapper
                    )) continue;
                    const frameworkSlides = sliderKind(wrapper) === 'ANNOTATED'
                      ? slides
                      : sliderSlides(wrapper).managedSlides;
                    const managedSlides = Array.from(new Set([...frameworkSlides, ...slides]));
                    candidates.push({
                      wrapper,
                      managedSlides,
                      slides,
                      kind: sliderKind(wrapper),
                      annotated: true,
                      carouselId: group.carouselId,
                      score: 1_000_000_000_000 + sliderArea(wrapper) + slides.length
                    });
                  }
                }
                return candidates;
              };

              const buildFrameworkSliderCandidate = (wrapper, allowHidden = false) => {
                if (!(wrapper instanceof Element) || isBridgeElement(wrapper)) return null;
                if (!allowHidden && isHiddenSliderCandidate(wrapper)) return null;
                const { managedSlides, slides } = sliderSlides(wrapper);
                if (slides.length < 2 || slides.length > MAX_CAROUSEL_SLIDES) return null;
                return {
                  wrapper,
                  managedSlides,
                  slides,
                  kind: sliderKind(wrapper),
                  annotated: false,
                  carouselId: null,
                  score: sliderArea(wrapper) + slides.length
                };
              };

              const collectSliderCandidates = (allowHiddenFramework = false) => {
                const candidates = buildAnnotatedSliderCandidates();
                const annotatedWrappers = new Set(candidates.map((candidate) => candidate.wrapper));
                for (const wrapper of queryReplayElements(FRAMEWORK_WRAPPER_SELECTOR)) {
                  if (annotatedWrappers.has(wrapper)) continue;
                  const candidate = buildFrameworkSliderCandidate(wrapper, allowHiddenFramework);
                  if (candidate) candidates.push(candidate);
                }
                return candidates;
              };

              const findInitialSliderIndex = (slides) => {
                const activeIndex = slides.findIndex((slide) =>
                  slide.matches('.swiper-slide-active,.slick-current,.is-active')
                  || slide.getAttribute('aria-hidden') === 'false'
                );
                if (activeIndex >= 0) return activeIndex;
                const visibleIndex = slides.findIndex((slide) => {
                  if (slide.hidden) return false;
                  const style = getComputedStyle(slide);
                  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
                });
                return visibleIndex >= 0 ? visibleIndex : 0;
              };

              const materializeSlider = (candidate) => {
                let slider = sliderRegistry.find((entry) => entry.wrapper === candidate.wrapper);
                if (!slider) {
                  slider = {
                    ...candidate,
                    index: findInitialSliderIndex(candidate.slides),
                    activated: false,
                    originalWrapperStyle: null,
                    originalSlides: [],
                    activeDisplay: 'block',
                    activeOpacity: '1',
                    activeVisibility: 'visible',
                    activePointerEvents: 'auto'
                  };
                  sliderRegistry.push(slider);
                } else if (!slider.activated) {
                  Object.assign(slider, candidate);
                  slider.index = Math.min(slider.index, candidate.slides.length - 1);
                }
                return slider;
              };

              const restoreAttribute = (element, name, value) => {
                if (value === null) element.removeAttribute(name);
                else element.setAttribute(name, value);
              };

              const updateSliderStateClasses = (slider) => {
                for (const slide of slider.managedSlides) {
                  for (const className of SLIDER_STATE_CLASSES) slide.classList.remove(className);
                }
                const current = slider.slides[slider.index];
                const previous = slider.slides[(slider.index - 1 + slider.slides.length) % slider.slides.length];
                const next = slider.slides[(slider.index + 1) % slider.slides.length];
                if (slider.kind === 'SWIPER') {
                  current.classList.add('swiper-slide-active', 'swiper-slide-visible', 'swiper-slide-fully-visible');
                  previous.classList.add('swiper-slide-prev');
                  next.classList.add('swiper-slide-next');
                } else if (slider.kind === 'SLICK') {
                  current.classList.add('slick-current', 'slick-active');
                } else if (slider.kind === 'SPLIDE') {
                  current.classList.add('is-active');
                  previous.classList.add('is-prev');
                  next.classList.add('is-next');
                }
              };

              const snapshotSlider = (slider) => {
                slider.activated = true;
                slider.originalWrapperStyle = slider.wrapper.getAttribute('style');
                slider.originalSlides = slider.managedSlides.map((slide) => {
                  const style = getComputedStyle(slide);
                  return {
                    slide,
                    style: slide.getAttribute('style'),
                    className: slide.getAttribute('class'),
                    ariaHidden: slide.getAttribute('aria-hidden'),
                    ariaCurrent: slide.getAttribute('aria-current'),
                    hidden: slide.hasAttribute('hidden'),
                    display: style.display,
                    opacity: style.opacity,
                    visibility: style.visibility,
                    pointerEvents: style.pointerEvents
                  };
                });
                const activeSlide = slider.slides[slider.index];
                const activeEntry = slider.originalSlides.find((entry) => entry.slide === activeSlide);
                const visibleEntry = activeEntry && activeEntry.display !== 'none' && activeEntry.visibility !== 'hidden'
                  ? activeEntry
                  : slider.originalSlides.find((entry) => entry.display !== 'none' && entry.visibility !== 'hidden');
                if (visibleEntry) {
                  slider.activeDisplay = visibleEntry.display === 'none' ? 'block' : visibleEntry.display;
                  slider.activeOpacity = Number(visibleEntry.opacity || 1) > 0 ? visibleEntry.opacity : '1';
                  slider.activeVisibility = visibleEntry.visibility === 'hidden' ? 'visible' : visibleEntry.visibility;
                  slider.activePointerEvents = visibleEntry.pointerEvents === 'none' ? 'auto' : visibleEntry.pointerEvents;
                }
              };

              const renderSafeSlider = (slider) => {
                if (!slider) return;
                if (!slider.activated) snapshotSlider(slider);
                if (slider.originalWrapperStyle === null) slider.wrapper.removeAttribute('style');
                else slider.wrapper.setAttribute('style', slider.originalWrapperStyle);
                slider.wrapper.style.setProperty('transform', 'none', 'important');
                slider.wrapper.style.setProperty('transition', 'none', 'important');
                slider.wrapper.style.setProperty('width', '100%', 'important');

                for (const entry of slider.originalSlides) {
                  if (entry.style === null) entry.slide.removeAttribute('style');
                  else entry.slide.setAttribute('style', entry.style);
                  restoreAttribute(entry.slide, 'class', entry.className);
                  restoreAttribute(entry.slide, 'aria-hidden', entry.ariaHidden);
                  restoreAttribute(entry.slide, 'aria-current', entry.ariaCurrent);
                  if (entry.hidden) entry.slide.setAttribute('hidden', '');
                  else entry.slide.removeAttribute('hidden');
                }
                updateSliderStateClasses(slider);

                for (const slide of slider.managedSlides) {
                  const logicalIndex = slider.slides.indexOf(slide);
                  const active = logicalIndex === slider.index;
                  slide.style.setProperty('transition', 'none', 'important');
                  slide.style.setProperty('display', active ? slider.activeDisplay : 'none', 'important');
                  if (active) {
                    slide.removeAttribute('hidden');
                    slide.style.setProperty('width', '100%', 'important');
                    slide.style.setProperty('transform', 'none', 'important');
                    slide.style.setProperty('opacity', slider.activeOpacity, 'important');
                    slide.style.setProperty('visibility', slider.activeVisibility, 'important');
                    slide.style.setProperty('pointer-events', slider.activePointerEvents, 'important');
                  }
                  slide.setAttribute('aria-hidden', active ? 'false' : 'true');
                  if (entryHasAriaCurrent(slider, slide)) {
                    if (active) slide.setAttribute('aria-current', 'true');
                    else slide.removeAttribute('aria-current');
                  }
                }
                schedulePositions(SLIDER_SETTLE_FRAMES);
              };

              const entryHasAriaCurrent = (slider, slide) => slider.originalSlides.some((entry) =>
                entry.slide === slide && entry.ariaCurrent !== null
              ) || slider.originalSlides.some((entry) => entry.ariaCurrent !== null);

              const findSliderForTarget = (target) => {
                if (!(target instanceof Element)) return null;
                const annotatedSlide = composedClosest(target,
                  `[${CAROUSEL_ID_ATTRIBUTE}][${SLIDE_INDEX_ATTRIBUTE}][${SLIDE_COUNT_ATTRIBUTE}]`
                );
                if (annotatedSlide) {
                  for (const candidate of buildAnnotatedSliderCandidates()) {
                    const index = candidate.slides.indexOf(annotatedSlide);
                    if (index >= 0) return { slider: materializeSlider(candidate), index };
                  }
                }
                const frameworkSlide = composedClosest(target, FRAMEWORK_SLIDE_SELECTOR);
                if (!frameworkSlide || frameworkSlide.matches(CLONE_SLIDE_SELECTOR)) return null;
                const wrapper = composedClosest(frameworkSlide, FRAMEWORK_WRAPPER_SELECTOR);
                const candidate = wrapper ? buildFrameworkSliderCandidate(wrapper, true) : null;
                if (!candidate) return null;
                const index = candidate.slides.indexOf(frameworkSlide);
                return index >= 0 ? { slider: materializeSlider(candidate), index } : null;
              };

              const revealSliderForTarget = (target) => {
                const located = findSliderForTarget(target);
                if (!located) return false;
                if (located.slider.activated && located.slider.index === located.index) return true;
                located.slider.index = located.index;
                renderSafeSlider(located.slider);
                return true;
              };

              const moveSafeSlider = (delta, slider) => {
                if (!slider) return false;
                slider.index = (slider.index + delta + slider.slides.length) % slider.slides.length;
                renderSafeSlider(slider);
                return true;
              };

              const carouselControlDirection = (control) => {
                if (!(control instanceof Element)) return 0;
                if (control.matches('.swiper-button-prev,.slick-prev,.splide__arrow--prev')) return -1;
                if (control.matches('.swiper-button-next,.slick-next,.splide__arrow--next')) return 1;
                if (control.matches('.main-vi-prev')) return -1;
                if (control.matches('.main-vi-next')) return 1;
                if (control.matches(FRAMEWORK_SLIDE_SELECTOR)) return 0;
                if (!control.hasAttribute('aria-controls')
                    || !control.matches('button,[role="button"],a')) return 0;
                const identity = [
                  control.id,
                  control.getAttribute('class'),
                  control.getAttribute('aria-label'),
                  control.getAttribute('title'),
                  control.getAttribute('data-direction')
                ].filter(Boolean).join(' ').toLowerCase();
                const previous = /(^|[ _-])(prev|previous)([ _-]|$)/.test(identity) || identity.includes('이전');
                const next = /(^|[ _-])next([ _-]|$)/.test(identity) || identity.includes('다음');
                if (previous === next) return 0;
                return previous ? -1 : 1;
              };

              const findCarouselControl = (event) => {
                const path = event && typeof event.composedPath === 'function' ? event.composedPath() : [];
                for (const node of path) {
                  if (node instanceof Element && carouselControlDirection(node) !== 0 && !isBridgeElement(node)) return node;
                }
                return null;
              };

              const controlledElement = (control) => {
                const value = String(control.getAttribute('aria-controls') || '').trim();
                if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(value)) return null;
                const root = control.getRootNode();
                return typeof root.getElementById === 'function' ? root.getElementById(value) : null;
              };

              const resolveControlSlider = (control) => {
                const sliders = collectSliderCandidates(true).map(materializeSlider);
                if (sliders.length === 0) return null;
                const controlled = controlledElement(control);
                if (controlled) {
                  const matches = sliders.filter((slider) =>
                    slider.wrapper === controlled
                    || slider.wrapper.contains(controlled)
                    || controlled.contains(slider.wrapper)
                  );
                  if (matches.length === 1) return matches[0];
                }
                const container = composedClosest(control, '.swiper,.swiper-container,.slick-slider,.splide');
                if (container) {
                  const matches = sliders.filter((slider) => container.contains(slider.wrapper));
                  if (matches.length === 1) return matches[0];
                }
                if (!control.matches('.swiper-button-prev,.swiper-button-next,.slick-prev,.slick-next,.splide__arrow--prev,.splide__arrow--next')
                    && !control.hasAttribute('aria-controls')) return null;
                const root = control.getRootNode();
                const sameRoot = sliders.filter((slider) => slider.wrapper.getRootNode() === root);
                return sameRoot.length === 1 ? sameRoot[0] : null;
              };

              const enhanceCarouselControls = () => {
                for (const control of queryReplayElements('[class],[aria-controls]')) {
                  const direction = carouselControlDirection(control);
                  if (direction === 0 || !resolveControlSlider(control)) continue;
                  if (!control.matches('button,input,select,textarea,summary,[role="button"]')) {
                    control.setAttribute('role', 'button');
                    if (!control.hasAttribute('tabindex')) control.setAttribute('tabindex', '0');
                  }
                  if (!control.hasAttribute('aria-label')) {
                    control.setAttribute('aria-label', direction < 0 ? 'Previous slide' : 'Next slide');
                  }
                }
              };

              const activateCarouselControl = (event) => {
                const control = findCarouselControl(event);
                if (!control) return false;
                const slider = resolveControlSlider(control);
                if (!slider) return false;
                event.preventDefault();
                event.stopImmediatePropagation();
                moveSafeSlider(carouselControlDirection(control), slider);
                return true;
              };

              const carouselControlClick = (event) => {
                activateCarouselControl(event);
              };

              const carouselControlKeyDown = (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                activateCarouselControl(event);
              };

              const pauseNewAnimations = () => {
                observeReplayRootScroll();
                document.documentElement.setAttribute(ANIMATIONS_PAUSED_ATTRIBUTE, 'true');
                for (const animation of getPageAnimations()) pauseAnimationImmediately(animation);
                for (const root of collectReplayRoots()) {
                  if (!motionGuardRoots.has(root)) {
                    root.addEventListener('animationstart', pauseNewAnimations, true);
                    root.addEventListener('transitionrun', pauseNewAnimations, true);
                    motionGuardRoots.add(root);
                  }
                  for (const svg of root.querySelectorAll('svg')) {
                    try {
                      if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations();
                    } catch { /* Detached SVG roots are harmless. */ }
                  }
                }
                schedulePositions();
              };

              const isBridgeElement = (element) => {
                if (!(element instanceof Element)) return true;
                const root = element.getRootNode();
                if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot && root.host && root.host.id === HOST_ID) {
                  return true;
                }
                return element === document.documentElement
                  || element === document.body
                  || element === document.head
                  || element.id === HOST_ID
                  || Boolean(element.closest(`#${HOST_ID}`));
              };

              const isPopupLike = (element) => {
                if (!(element instanceof Element)) return false;
                if (element.matches('dialog,[role="dialog"],[aria-modal="true"],[popover]')) return true;
                const identity = `${element.id || ''} ${element.getAttribute('class') || ''}`
                  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                  .toLowerCase();
                const tokens = new Set(identity.split(/[^a-z0-9]+/).filter(Boolean));
                return [
                  'modal', 'popup', 'overlay', 'dialog', 'lightbox', 'backdrop', 'scrim',
                  'cookie', 'consent', 'notice', 'toast'
                ].some((token) => tokens.has(token))
                  || /(?:^|[^a-z0-9])(?:pop-layer|layer-popup|popup-banner)(?:$|[^a-z0-9])/.test(identity);
              };

              const isApplicationShell = (element, rect, viewportArea) => {
                const identity = String(element.id || '').toLowerCase();
                const directBodyRoot = element.parentElement === document.body
                  && ['app', 'root', '__next', 'app-root', 'application'].includes(identity);
                const containsMain = Boolean(element.querySelector('main,[role="main"]'));
                return directBodyRoot
                  || (containsMain && rect.width * rect.height >= viewportArea * 0.5);
              };

              const isReasonablePopup = (element) => {
                if (isBridgeElement(element)) return false;
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
                const area = rect.width * rect.height;
                const computedStyle = getComputedStyle(element);
                if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') return false;
                const position = computedStyle.position;
                const zIndex = Number.parseInt(computedStyle.zIndex, 10);
                const semanticPopup = element.matches('dialog,[role="dialog"],[aria-modal="true"],[popover]');
                const structuralNavigation = element.matches('header,nav,[role="banner"],[role="navigation"]');
                const containsNavigation = Boolean(element.querySelector(
                  'header,nav,[role="banner"],[role="navigation"]'
                ));
                const navigationSized = rect.height <= window.innerHeight * 0.35
                  || rect.width <= window.innerWidth * 0.35;
                if (structuralNavigation
                    || (!semanticPopup && containsNavigation && navigationSized)
                    || isApplicationShell(element, rect, viewportArea)) return false;
                const coversViewportCenter = rect.left <= window.innerWidth / 2
                  && rect.right >= window.innerWidth / 2
                  && rect.top <= window.innerHeight / 2
                  && rect.bottom >= window.innerHeight / 2;
                const fixedPopupCandidate = position === 'fixed'
                  && area >= viewportArea * 0.08
                  && Number.isFinite(zIndex)
                  && zIndex > 0
                  && coversViewportCenter;
                const dismissibleLayer = (position === 'fixed' || position === 'absolute')
                  && area >= viewportArea * 0.005
                  && Boolean(element.querySelector(
                    'button[class*="close" i],[role="button"][class*="close" i],'
                    + 'button[aria-label*="close" i],[role="button"][aria-label*="close" i],'
                    + 'button[aria-label*="닫"],[role="button"][aria-label*="닫"]'
                  ));
                if (!isPopupLike(element) && !fixedPopupCandidate && !dismissibleLayer) return false;
                if (!semanticPopup && position !== 'fixed' && position !== 'absolute' && position !== 'sticky') {
                  return Number.isFinite(zIndex) && zIndex > 0 && area >= viewportArea * 0.01;
                }
                return area <= viewportArea * 1.5
                  || position === 'fixed'
                  || position === 'absolute'
                  || position === 'sticky'
                  || semanticPopup;
              };

              const composedParentElement = (element) => {
                if (!(element instanceof Element)) return null;
                if (element.parentElement) return element.parentElement;
                const root = element.getRootNode();
                return root instanceof ShadowRoot && root.host instanceof Element ? root.host : null;
              };

              const hasPopupCandidateAncestor = (element, candidates) => {
                for (let current = composedParentElement(element); current; current = composedParentElement(current)) {
                  if (candidates.has(current)) return true;
                }
                return false;
              };

              const isComposedWithin = (element, ancestor) => {
                for (let current = element; current; current = composedParentElement(current)) {
                  if (current === ancestor) return true;
                }
                return false;
              };

              const suppressRootHorizontalScroll = () => {
                const overflowValue = CSS.supports('overflow-x', 'clip') ? 'clip' : 'hidden';
                for (const element of [document.documentElement, document.body]) {
                  if (!element) continue;
                  element.style.setProperty('overflow-x', overflowValue, 'important');
                }
              };

              const releasePageScrollLock = () => {
                for (const element of [document.documentElement, document.body]) {
                  if (!element) continue;
                  const style = getComputedStyle(element);
                  const locked = ['hidden', 'clip'].includes(style.overflow)
                    || ['hidden', 'clip'].includes(style.overflowY);
                  if (locked) {
                    element.style.setProperty('overflow-y', 'auto', 'important');
                  }
                  if (element === document.body && style.position === 'fixed') {
                    element.style.setProperty('position', 'static', 'important');
                    element.style.setProperty('inset', 'auto', 'important');
                    element.style.setProperty('width', 'auto', 'important');
                  }
                }
                suppressRootHorizontalScroll();
              };

              const autoHidePopups = () => {
                const candidates = new Set();
                for (const element of queryReplayElements(
                  'dialog,[role="dialog"],[aria-modal="true"],[popover],[id],[class]'
                )) {
                  if (isReasonablePopup(element)) candidates.add(element);
                }
                let popupSuppressed = queryReplayElements(
                  `[${AUTO_HIDDEN_POPUP_ATTRIBUTE}="true"]`
                ).length > 0;
                for (const popup of candidates) {
                  if (hasPopupCandidateAncestor(popup, candidates)) continue;
                  if (selectedTarget && isComposedWithin(selectedTarget, popup)) clearSelectedTarget();
                  popup.setAttribute(AUTO_HIDDEN_POPUP_ATTRIBUTE, 'true');
                  popup.style.setProperty('display', 'none', 'important');
                  popupSuppressed = true;
                }
                if (popupSuppressed) {
                  releasePageScrollLock();
                  refreshSelectedTarget();
                  schedulePositions();
                }
                return popupSuppressed;
              };

              const start = () => {
                suppressRootHorizontalScroll();
                const existingHost = document.getElementById(HOST_ID);
                if (existingHost) existingHost.remove();
                const host = document.createElement('div');
                host.id = HOST_ID;
                host.setAttribute('aria-label', 'Accessibility issue markers');
                host.style.cssText = 'all:initial!important;position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;pointer-events:none!important;';
                host.style.setProperty('--replay-overlay-inverse-scale', '1');
                host.style.setProperty('--replay-visual-width', `${replayVisualWidth}px`);
                host.style.setProperty('--replay-selection-border-width', `${SELECTION_FRAGMENT_OFFSET}px`);
                document.documentElement.appendChild(host);
                const shadowRoot = host.attachShadow({ mode: 'closed' });
                const style = document.createElement('style');
                style.textContent = `
                  :host::before,:host::after { content:none !important; display:none !important; pointer-events:none !important; }
                  .selection-layer { position:absolute; left:0; top:0; width:0; height:0; overflow:visible; pointer-events:none; }
                  .selection-fragment { box-sizing:border-box; position:absolute; left:0; top:0; border:var(--replay-selection-border-width,3px) solid #0066cc; pointer-events:none; transform-origin:top left; }
                  /* The marker identifies an inspectable issue, not a list position. Keep
                     the 24px hit target and show a scan glyph instead of a sequence number. */
                  .marker { appearance:none; -webkit-appearance:none; box-sizing:border-box; display:grid; place-items:center; position:absolute; left:0; top:0; width:24px; height:24px; margin:0; padding:0; border:0; border-radius:999px; background:transparent; color:transparent; cursor:pointer; pointer-events:auto; transform-origin:top left; }
                  .marker__badge { box-sizing:border-box; display:grid; place-items:center; width:20px; height:20px; border-radius:999px; background:var(--marker-color,#0066cc); color:#fff; box-shadow:0 0 0 2px rgba(255,255,255,.94),0 2px 5px rgba(16,24,40,.32); transition:transform 120ms ease,box-shadow 120ms ease; }
                  .marker__icon { display:block; width:14px; height:14px; overflow:visible; pointer-events:none; }
                  .marker[hidden] { display:none !important; }
                  .marker:hover .marker__badge { transform:scale(1.12); }
                  .marker[data-selected='true'] { z-index:2; }
                  .marker[data-selected='true'] .marker__badge { transform:scale(1.2); box-shadow:0 0 0 2px #fff,0 3px 8px rgba(16,24,40,.38); }
                  .marker:focus-visible { outline:3px solid #101828; outline-offset:3px; }
                  @media (prefers-reduced-motion:reduce) {
                    .marker__badge { transition:none; }
                    .marker:hover .marker__badge,.marker[data-selected='true'] .marker__badge { transform:none; }
                  }
                  /* Glassmorphism to match the dashboard shell. The popover floats over
                     arbitrary captures, so its surface stays mostly opaque while the
                     blur and inner highlight preserve the glass material. */
                  .issue-popover { all:initial; box-sizing:border-box; display:block; position:absolute; left:0; top:0; z-index:5; width:clamp(220px,34vw,360px); max-width:calc(var(--replay-visual-width,100vw) - 24px); overflow:visible; touch-action:manipulation; padding:14px; border:0; border-radius:14px; background:rgba(255,255,255,.92); -webkit-backdrop-filter:blur(24px) saturate(180%); backdrop-filter:blur(24px) saturate(180%); color:#101828; box-shadow:0 18px 44px rgba(16,24,40,.24), inset 0 1px 0 rgba(255,255,255,.9), inset 0 0 0 1px rgba(16,24,40,.06); font:400 13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; text-align:left; direction:ltr; unicode-bidi:isolate; overflow-wrap:anywhere; word-break:break-word; pointer-events:auto; transform-origin:top left; }
                  /* Without backdrop-filter the translucent fill alone loses contrast. */
                  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                    .issue-popover { background:#fff; }
                  }
                  /* No prefers-reduced-transparency opt-out here, matching the landing
                     header (.ua-header) which also ships glass unconditionally. Windows
                     reports that preference whenever "transparency effects" is off, which
                     would silently disable the glass for a large share of users. The 92%
                     surface remains legible without blur, and forced-colors below remains
                     the accessibility escape hatch. */
                  .issue-popover[hidden] { display:none !important; }
                  .issue-popover[data-content-scroll='true'] { display:grid; grid-template-columns:minmax(0,1fr); grid-template-areas:'group' 'pager' 'issues' 'detail'; grid-template-rows:auto auto auto minmax(0,1fr); overflow:hidden; }
                  .issue-popover[data-content-scroll='true'] > .issue-popover__group { grid-area:group; }
                  .issue-popover[data-content-scroll='true'] > .issue-popover__pager { grid-area:pager; }
                  .issue-popover[data-content-scroll='true'] > .issue-popover__issues { grid-area:issues; }
                  .issue-popover * { box-sizing:border-box; }
                  .issue-popover__group { display:block; margin:0 0 10px; color:#344054; font:700 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; }
                  .issue-popover__group[hidden] { display:none !important; }
                  .issue-popover__pager { display:flex; align-items:center; justify-content:flex-end; gap:6px; margin:-2px 0 8px; }
                  .issue-popover__pager[hidden] { display:none !important; }
                  .issue-popover__page-button { appearance:none; -webkit-appearance:none; display:grid; place-items:center; width:32px; height:32px; margin:0; padding:0; border:0; border-radius:8px; background:rgba(242,244,247,.94); color:#344054; box-shadow:inset 0 0 0 1px rgba(16,24,40,.08); font:700 16px/1 system-ui,-apple-system,"Segoe UI",sans-serif; cursor:pointer; }
                  .issue-popover__page-button:hover:not(:disabled) { background:rgba(234,236,240,.94); }
                  .issue-popover__page-button:focus-visible { outline:2px solid #0066cc; outline-offset:2px; }
                  .issue-popover__page-button:disabled { opacity:.38; cursor:default; }
                  .issue-popover__page-status { min-width:42px; color:#344054; font:700 11.5px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif; text-align:center; }
                  .issue-popover__issues { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin:0 0 12px; }
                  .issue-popover__issues[hidden] { display:none !important; }
                  .issue-popover__issue { appearance:none; -webkit-appearance:none; display:grid; min-width:0; min-height:48px; gap:4px; margin:0; padding:8px 10px; border:0; border-radius:8px; background:rgba(249,250,251,.92); color:#344054; box-shadow:inset 0 0 0 1px rgba(16,24,40,.08); font:inherit; text-align:left; cursor:pointer; }
                  .issue-popover__issue:hover { background:rgba(242,244,247,.98); }
                  .issue-popover__issue[aria-pressed='true'] { background:rgba(239,248,255,.98); box-shadow:inset 0 0 0 2px #0066cc; }
                  .issue-popover__issue:focus-visible { outline:2px solid #0066cc; outline-offset:2px; }
                  .issue-popover__issue-meta { display:flex; min-width:0; align-items:center; gap:7px; font:600 12px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif; }
                  .issue-popover__issue-severity { color:#475467; }
                  .issue-popover__issue-severity[data-severity='CRITICAL'],.issue-popover__issue-severity[data-severity='SERIOUS'],.issue-popover__issue-severity[data-severity='HIGH'] { color:#b42318; }
                  .issue-popover__issue-severity[data-severity='MODERATE'],.issue-popover__issue-severity[data-severity='MEDIUM'] { color:#b54708; }
                  .issue-popover__issue-severity[data-severity='LOW'] { color:#026b3f; }
                  .issue-popover__issue-code { min-width:0; color:#475467; overflow-wrap:anywhere; }
                  .issue-popover__issue-title { display:block; min-width:0; color:#101828; font:700 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; word-break:keep-all; overflow-wrap:anywhere; }
                  .issue-popover__detail { display:block; min-width:0; grid-area:detail; overflow:visible; }
                  .issue-popover[data-content-scroll='true'] .issue-popover__detail { min-height:0; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
                  .issue-popover[data-content-scroll='true'] .issue-popover__detail:focus-visible { outline:2px solid #0066cc; outline-offset:-2px; }
                  .issue-popover__tags { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 10px; }
                  /* Nested boxes use translucent fills so the blur never stacks. */
                  .issue-popover__tag { display:inline-flex; align-items:center; min-width:0; max-width:100%; min-height:24px; margin:0; padding:3px 8px; overflow:visible; border-radius:999px; background:rgba(242,244,247,.94); color:#344054; font:700 11.5px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
                  .issue-popover__severity[data-severity='CRITICAL'],.issue-popover__severity[data-severity='SERIOUS'],.issue-popover__severity[data-severity='HIGH'] { background:rgba(254,243,242,.82); color:#b42318; }
                  .issue-popover__severity[data-severity='MODERATE'],.issue-popover__severity[data-severity='MEDIUM'] { background:rgba(255,250,235,.82); color:#b54708; }
                  .issue-popover__severity[data-severity='LOW'] { background:rgba(236,253,243,.82); color:#026b3f; }
                  .issue-popover__title { display:block; margin:0 0 8px; overflow:visible; color:#101828; font:700 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; text-wrap:balance; word-break:keep-all; overflow-wrap:anywhere; }
                  .issue-popover__message { display:grid; gap:3px; margin:0 0 4px; overflow:visible; color:#344054; font:400 13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; white-space:normal; }
                  .issue-popover__message-section { display:grid; grid-template-columns:44px minmax(0,1fr); min-width:0; column-gap:6px; margin:0; align-items:start; }
                  .issue-popover__message-label { display:block; padding-top:2px; color:#344054; font:700 10px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif; word-break:keep-all; }
                  .issue-popover__message-value { margin:0; color:inherit; font:inherit; white-space:pre-wrap; word-break:keep-all; overflow-wrap:anywhere; }
                  .issue-popover__message-list { display:grid; gap:3px; margin:0; padding:0 0 0 16px; color:inherit; font:inherit; }
                  .issue-popover__message-list > li { margin:0; padding:0; word-break:keep-all; overflow-wrap:anywhere; }
                  .issue-popover__path { display:block; width:100%; margin:0; padding:9px 10px; overflow:visible; border:1px solid rgba(16,24,40,.1); border-radius:8px; background:rgba(248,250,252,.94); color:#1d2939; font:500 11px/1.5 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace; font-variant-ligatures:none; white-space:pre-wrap; overflow-wrap:anywhere; word-break:normal; user-select:text; }
                  .issue-popover__message[hidden],.issue-popover__path[hidden] { display:none !important; }
                  .issue-popover[data-density='compact'] { padding:12px; }
                  .issue-popover[data-density='compact'] .issue-popover__issues { margin-bottom:8px; }
                  .issue-popover[data-density='compact'] .issue-popover__tags { margin-bottom:8px; }
                  .issue-popover[data-density='compact'] .issue-popover__title { margin-bottom:7px; }
                  .issue-popover[data-density='compact'] .issue-popover__message { margin-bottom:8px; }
                  .issue-popover[data-density='compact'][data-grouped='true'] { padding:10px; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__group { margin-bottom:6px; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__issues { gap:4px; margin-bottom:6px; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__issue { min-height:0; padding:4px 6px; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__issue-meta { font-size:10px; line-height:1.3; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__issue-title { font-size:12px; line-height:1.4; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__title { margin-bottom:5px; font-size:14px; line-height:1.35; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__message { gap:5px; margin-bottom:6px; font-size:12.5px; line-height:1.45; }
                  .issue-popover[data-density='compact'][data-grouped='true'] .issue-popover__path { padding:7px 8px; font-size:10.5px; line-height:1.4; }
                  .issue-popover[data-density='minimal'] { padding:10px; }
                  .issue-popover[data-density='minimal'] .issue-popover__issues { gap:4px; margin-bottom:6px; }
                  .issue-popover[data-density='minimal'] .issue-popover__issue { min-height:0; padding:5px 7px; }
                  .issue-popover[data-density='minimal'] .issue-popover__issue-meta { font-size:10px; line-height:1.3; }
                  .issue-popover[data-density='minimal'] .issue-popover__issue-title { font-size:12px; line-height:1.4; }
                  .issue-popover[data-density='minimal'] .issue-popover__tags { gap:5px; margin-bottom:6px; }
                  .issue-popover[data-density='minimal'] .issue-popover__tag { min-height:22px; padding:2px 7px; }
                  .issue-popover[data-density='minimal'] .issue-popover__title { margin-bottom:6px; font-size:14px; line-height:1.35; }
                  .issue-popover[data-density='minimal'] .issue-popover__message { gap:4px; margin-bottom:6px; font-size:12px; line-height:1.45; }
                  .issue-popover[data-density='minimal'] .issue-popover__path { padding:7px 8px; font-size:10.5px; line-height:1.4; }
                  .issue-popover[data-layout='wide'] { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:'group pager' 'issues issues' 'detail detail'; grid-template-rows:auto auto auto; align-content:start; align-items:start; column-gap:12px; row-gap:4px; padding:8px; }
                  .issue-popover[data-layout='wide'] .issue-popover__group { grid-area:group; margin:0; font-size:11.5px; line-height:1.35; }
                  .issue-popover[data-layout='wide'] .issue-popover__pager { grid-area:pager; align-self:start; margin:0; }
                  .issue-popover[data-layout='wide'] .issue-popover__issues { grid-area:issues; margin:0; }
                  .issue-popover[data-layout='wide'] .issue-popover__detail { display:grid; grid-template-columns:minmax(0,.8fr) minmax(0,2.1fr) minmax(0,1.35fr); grid-template-areas:'tags message path' 'title message path'; grid-template-rows:auto auto; align-content:start; align-items:start; column-gap:12px; row-gap:4px; }
                  .issue-popover[data-layout='wide'][data-content-scroll='true'] { grid-template-rows:auto auto minmax(0,1fr); }
                  .issue-popover[data-layout='wide'] .issue-popover__issue { min-height:0; gap:2px; padding:5px 7px; }
                  .issue-popover[data-layout='wide'] .issue-popover__issue-meta { font-size:11px; line-height:1.25; }
                  .issue-popover[data-layout='wide'] .issue-popover__issue-title { font-size:13px; line-height:1.35; }
                  .issue-popover[data-layout='wide'] .issue-popover__tags { grid-area:tags; align-self:start; gap:5px; margin:0; }
                  .issue-popover[data-layout='wide'] .issue-popover__tag { min-height:20px; padding:2px 7px; font-size:11px; line-height:1.3; }
                  .issue-popover[data-layout='wide'] .issue-popover__title { grid-area:title; align-self:start; margin:0; font-size:15px; line-height:1.4; text-wrap:balance; }
                   .issue-popover[data-layout='wide'] .issue-popover__message { grid-area:message; align-self:start; margin:0; font-size:12.5px; line-height:1.5; }
                   .issue-popover[data-layout='wide'] .issue-popover__message-section { grid-template-columns:52px minmax(0,1fr); column-gap:7px; }
                   .issue-popover[data-layout='wide'] .issue-popover__message-label { font-size:11px; line-height:1.35; }
                   .issue-popover[data-layout='wide'] .issue-popover__path { grid-area:path; align-self:start; margin:0; padding:7px 8px; font-size:11px; line-height:1.45; }
                   .issue-popover[data-presentation='external-description'] { position:fixed; left:0; top:0; width:1px !important; max-width:1px !important; height:1px !important; margin:-1px !important; padding:0 !important; overflow:hidden !important; clip:rect(0 0 0 0) !important; clip-path:inset(50%) !important; white-space:nowrap !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; pointer-events:none !important; transform:none !important; }
                   @media (forced-colors:active) {
                    .issue-popover { border:2px solid CanvasText; background:Canvas; color:CanvasText; box-shadow:none; }
                    .issue-popover__tag,.issue-popover__issue,.issue-popover__title,.issue-popover__message,.issue-popover__path { border:1px solid CanvasText; background:Canvas; color:CanvasText; box-shadow:none; }
                    .issue-popover__message-label,.issue-popover__message-value,.issue-popover__message-list { color:CanvasText; background:Canvas; }
                    .marker__badge { background:CanvasText; color:Canvas; box-shadow:0 0 0 2px Canvas; }
                    .marker:focus-visible { outline-color:CanvasText; }
                  }
                `;
                shadowRoot.appendChild(style);
                selectionLayer = document.createElement('div');
                selectionLayer.className = 'selection-layer';
                selectionLayer.setAttribute('aria-hidden', 'true');
                shadowRoot.appendChild(selectionLayer);
                issuePopover = document.createElement('section');
                issuePopover.className = 'issue-popover';
                issuePopover.id = '__uni_accessibility_replay_issue_popover';
                issuePopover.hidden = true;
                issuePopover.setAttribute('aria-hidden', 'true');
                issuePopover.setAttribute('role', 'tooltip');
                const popoverGroup = document.createElement('p');
                popoverGroup.className = 'issue-popover__group';
                popoverGroup.hidden = true;
                const popoverPager = document.createElement('div');
                popoverPager.className = 'issue-popover__pager';
                popoverPager.hidden = true;
                const popoverPreviousPage = document.createElement('button');
                popoverPreviousPage.type = 'button';
                popoverPreviousPage.className = 'issue-popover__page-button';
                popoverPreviousPage.dataset.direction = 'previous';
                popoverPreviousPage.setAttribute('aria-label', '이전 문제 묶음 보기');
                popoverPreviousPage.textContent = '‹';
                const popoverPageStatus = document.createElement('span');
                popoverPageStatus.className = 'issue-popover__page-status';
                popoverPageStatus.setAttribute('aria-live', 'polite');
                const popoverNextPage = document.createElement('button');
                popoverNextPage.type = 'button';
                popoverNextPage.className = 'issue-popover__page-button';
                popoverNextPage.dataset.direction = 'next';
                popoverNextPage.setAttribute('aria-label', '다음 문제 묶음 보기');
                popoverNextPage.textContent = '›';
                popoverPager.append(popoverPreviousPage, popoverPageStatus, popoverNextPage);
                popoverPreviousPage.addEventListener('click', (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  changeIssuePopoverGroupPage(-1);
                });
                popoverNextPage.addEventListener('click', (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  changeIssuePopoverGroupPage(1);
                });
                const popoverIssueList = document.createElement('div');
                popoverIssueList.className = 'issue-popover__issues';
                popoverIssueList.hidden = true;
                const popoverDetail = document.createElement('div');
                popoverDetail.className = 'issue-popover__detail';
                popoverDetail.setAttribute('aria-label', '선택한 이슈 상세 내용');
                const popoverTags = document.createElement('div');
                popoverTags.className = 'issue-popover__tags';
                const popoverSeverity = document.createElement('span');
                popoverSeverity.className = 'issue-popover__tag issue-popover__severity';
                const popoverCode = document.createElement('span');
                popoverCode.className = 'issue-popover__tag issue-popover__code';
                popoverTags.append(popoverSeverity, popoverCode);
                const popoverTitle = document.createElement('p');
                popoverTitle.className = 'issue-popover__title';
                const popoverMessage = document.createElement('div');
                popoverMessage.className = 'issue-popover__message';
                const popoverPath = document.createElement('code');
                popoverPath.className = 'issue-popover__path';
                popoverDetail.append(popoverTags, popoverTitle, popoverMessage, popoverPath);
                issuePopover.append(popoverGroup, popoverPager, popoverIssueList, popoverDetail);
                issuePopoverElements = {
                  group: popoverGroup,
                  pager: popoverPager,
                  previousPage: popoverPreviousPage,
                  pageStatus: popoverPageStatus,
                  nextPage: popoverNextPage,
                  issueList: popoverIssueList,
                  detail: popoverDetail,
                  severity: popoverSeverity,
                  code: popoverCode,
                  title: popoverTitle,
                  message: popoverMessage,
                  path: popoverPath
                };
                issuePopover.addEventListener('pointerenter', (event) => {
                  beginIssuePopoverPreview('popoverPointer', event.pointerType);
                });
                issuePopover.addEventListener('pointerleave', (event) => {
                  if (popoverIssueId !== null) {
                    endMarkerPreview(popoverIssueId, 'popoverPointer', event.pointerType);
                  }
                });
                issuePopover.addEventListener('pointercancel', (event) => {
                  if (popoverIssueId !== null) {
                    endMarkerPreview(popoverIssueId, 'popoverPointer', event.pointerType);
                  }
                });
                shadowRoot.appendChild(issuePopover);
                if (window.ResizeObserver) {
                  selectedTargetResizeObserver = new ResizeObserver(() => {
                    schedulePositions();
                  });
                }

                window.addEventListener('message', (event) => {
                  if (event.source !== window.parent || !event.data || event.data.source !== PARENT_SOURCE) return;
                  const message = event.data;
                  if (message.type === 'REQUEST_DOCUMENT_STATE') {
                    post({ type: 'DOCUMENT_LOADING', documentToken: replayDocumentToken });
                    post({ type: 'READY', documentToken: replayDocumentToken });
                  } else if (message.type === 'SET_VIEW_SCALE') {
                    if (applyReplayViewScale(message, host)) {
                      schedulePositions(SLIDER_SETTLE_FRAMES);
                    }
                  } else if (message.type === 'INIT_ISSUES') {
                    initializeIssues(message, shadowRoot);
                  } else if (message.type === 'FOCUS_ISSUE') {
                    const incomingIssueId = typeof message.issueId === 'number' ? message.issueId : null;
                    if (activeMarkerPreview
                        && (incomingIssueId === null
                            || activeMarkerPreview.key !== markerGroupKeyForIssue(incomingIssueId))) return;
                    if (pinnedIssueId !== null
                        && (incomingIssueId === null
                            || issueKey(pinnedIssueId) !== issueKey(incomingIssueId))) {
                      pinnedIssueId = null;
                      pinnedSelectionOwned = false;
                    }
                    selectIssue(incomingIssueId, false);
                  } else if (message.type === 'SET_MARKERS_VISIBLE') {
                    markersVisible = message.markersVisible !== false;
                    if (!markersVisible) {
                      cancelMarkerPreviewClear();
                      activeMarkerPreview = null;
                      pinnedIssueId = null;
                      pinnedSelectionOwned = false;
                      hideIssuePopover();
                      hideIssueDock();
                      clearSelectedTarget();
                      for (const entry of markerGroups) {
                        entry.button.hidden = true;
                        entry.position = null;
                      }
                    }
                    else if (selectedIssueId !== null) {
                      const entry = markers.get(issueKey(selectedIssueId));
                      highlightSelectedTarget(entry ? issueTargetForEntry(entry, selectedIssueId) : null);
                    }
                    schedulePositions();
                  }
                });

                document.addEventListener('click', carouselControlClick, true);
                document.addEventListener('keydown', carouselControlKeyDown, true);
                document.addEventListener('pointerdown', (event) => {
                  if (dockedEntry && event.target !== host) dismissIssueDock();
                  if (pinnedIssueId !== null && event.target !== host) dismissPinnedIssue();
                }, { capture: true, passive: true });
                document.addEventListener('keydown', (event) => {
                  if (event.key !== 'Escape') return;
                  if (dockedEntry) {
                    event.preventDefault();
                    if (issuePopover && !issuePopover.hidden) hideIssuePopover();
                    else dismissIssueDock(true);
                    return;
                  }
                  const pinnedEntry = markers.get(issueKey(pinnedIssueId));
                  if (dismissPinnedIssue()) {
                    event.preventDefault();
                    if (pinnedEntry && pinnedEntry.button.isConnected && !pinnedEntry.button.hidden) {
                      suppressNextMarkerFocusPreview = true;
                      pinnedEntry.button.focus({ preventScroll: true });
                    }
                  } else {
                    dismissActiveMarkerPreview();
                  }
                });
                document.addEventListener('click', blockLink, true);
                document.addEventListener('auxclick', blockLink, true);
                document.addEventListener('submit', (event) => {
                  event.preventDefault();
                  event.stopImmediatePropagation();
                  post({ type: 'LINK_BLOCKED', href: event.target && event.target.action ? event.target.action : undefined });
                }, true);
                document.addEventListener('animationstart', pauseNewAnimations, true);
                document.addEventListener('transitionrun', pauseNewAnimations, true);
                window.addEventListener('scroll', () => {
                  schedulePositions();
                }, { passive: true });
                document.addEventListener('scroll', () => {
                  schedulePositions();
                }, { capture: true, passive: true });
                observeReplayRootScroll();
                window.addEventListener('resize', () => {
                  schedulePositions();
                }, { passive: true });
                window.addEventListener('load', () => {
                  autoHidePopups();
                  enhanceCarouselControls();
                  pauseNewAnimations();
                  schedulePositions();
                }, true);
                if (window.ResizeObserver) {
                  new ResizeObserver(() => {
                    schedulePositions();
                  }).observe(document.documentElement);
                }
                autoHidePopups();
                enhanceCarouselControls();
                pauseNewAnimations();
                post({ type: 'READY', documentToken: replayDocumentToken });
                requestAnimationFrame(() => {
                  autoHidePopups();
                  pauseNewAnimations();
                });
                if (document.fonts && document.fonts.ready) {
                  document.fonts.ready.then(() => {
                    autoHidePopups();
                    pauseNewAnimations();
                  }).catch(() => {});
                }
              };

              if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
              else start();
            })();
            """
    );

    private static final String BRIDGE_SCRIPT_SHA256 = sha256Hex(BRIDGE_SCRIPT);
    private static final String BRIDGE_SCRIPT_CSP_SOURCE = sha256CspSource(BRIDGE_SCRIPT);
    private static final String REPLAY_STORAGE_SCHEMA_VERSION = "dom-replay-v1";
    private static final String BRIDGE_STORAGE_VERSION = sha256Hex(
            String.join("\0", REPLAY_STORAGE_SCHEMA_VERSION, BRIDGE_STYLE, BRIDGE_SCRIPT)
    );
    private static final String BRIDGE_STORAGE_PREFIX = "replay-" + BRIDGE_STORAGE_VERSION.substring(0, 16) + "-";

    public SanitizedDocument sanitize(byte[] sourceBytes, String finalUrl) {
        String source = decodeStrictUtf8(sourceBytes);
        if (source.indexOf('\0') >= 0) {
            throw new ArtifactValidationException("Replay document must not contain NUL characters");
        }
        if (source.isBlank()) {
            throw new ArtifactValidationException("Replay document must not be empty");
        }

        Document document = Jsoup.parse(source, finalUrl, Parser.htmlParser());
        document.outputSettings()
                .charset(StandardCharsets.UTF_8)
                .syntax(Document.OutputSettings.Syntax.html)
                .prettyPrint(false);

        document.select("script,iframe,frame,frameset,object,embed,applet,portal,fencedframe,webview").remove();
        document.select("base").remove();
        document.select("meta[http-equiv]").remove();
        document.select("link").stream()
                .filter(link -> !hasRelToken(link, "stylesheet"))
                .toList()
                .forEach(Element::remove);

        for (Element element : document.getAllElements()) {
            sanitizeAttributes(element);
            if (element.id().equals(BRIDGE_HOST_ID)
                    || element.id().equals(BRIDGE_STYLE_ID)
                    || element.id().equals(BRIDGE_SCRIPT_ID)) {
                element.removeAttr("id");
            }
        }

        document.select("a,area").forEach(link -> {
            String blockedHref = link.hasAttr("href") ? link.attr("href") : link.attr("xlink:href");
            link.removeAttr("href");
            link.removeAttr("xlink:href");
            if (!blockedHref.isBlank()) {
                link.attr("data-uni-accessibility-replay-href", bounded(blockedHref, 4096));
            }
        });

        document.select("form").forEach(form -> {
            form.removeAttr("action");
            form.removeAttr("method");
            form.removeAttr("target");
        });
        document.select("video[autoplay],audio[autoplay]").removeAttr("autoplay");

        document.head().prependElement("base").attr("href", finalUrl);
        appendCurrentBridge(document);

        byte[] sanitizedBytes = document.outerHtml().getBytes(StandardCharsets.UTF_8);
        return new SanitizedDocument(sanitizedBytes, BRIDGE_SCRIPT_CSP_SOURCE);
    }

    public SanitizedDocument refreshBridge(byte[] storedBytes) {
        String source = decodeStrictUtf8(storedBytes);
        if (source.indexOf('\0') >= 0 || source.isBlank()) {
            throw new ArtifactValidationException("Stored replay document is invalid");
        }

        Document document = Jsoup.parse(source, "", Parser.htmlParser());
        document.outputSettings()
                .charset(StandardCharsets.UTF_8)
                .syntax(Document.OutputSettings.Syntax.html)
                .prettyPrint(false);
        document.select("#" + BRIDGE_HOST_ID + ",#" + BRIDGE_STYLE_ID + ",#" + BRIDGE_SCRIPT_ID).remove();
        appendCurrentBridge(document);

        byte[] refreshedBytes = document.outerHtml().getBytes(StandardCharsets.UTF_8);
        return new SanitizedDocument(refreshedBytes, BRIDGE_SCRIPT_CSP_SOURCE);
    }

    private void appendCurrentBridge(Document document) {
        Element head = document.head();
        head.select("meta[charset]").remove();
        head.prependElement("meta").attr("charset", "utf-8");
        if (head.selectFirst("base") == null) {
            throw new ArtifactValidationException("Replay document must contain a base URL");
        }
        document.selectFirst("html").attr(BRIDGE_ANIMATIONS_PAUSED_ATTRIBUTE, "true");
        Element bridgeStyle = head.appendElement("style").attr("id", BRIDGE_STYLE_ID);
        bridgeStyle.appendChild(new DataNode(BRIDGE_STYLE));

        Element bridgeScript = document.body().appendElement("script")
                .attr("id", BRIDGE_SCRIPT_ID)
                .attr(BRIDGE_VERSION_ATTRIBUTE, BRIDGE_SCRIPT_SHA256);
        bridgeScript.appendChild(new DataNode(BRIDGE_SCRIPT));
    }

    public String bridgeScriptCspSource() {
        return BRIDGE_SCRIPT_CSP_SOURCE;
    }

    public String bridgeStoragePrefix() {
        return BRIDGE_STORAGE_PREFIX;
    }

    private void sanitizeAttributes(Element element) {
        for (Attribute attribute : new ArrayList<>(element.attributes().asList())) {
            String key = attribute.getKey();
            String normalizedKey = key.toLowerCase(Locale.ROOT);
            if (normalizedKey.startsWith("on")
                    || normalizedKey.startsWith("data-uni-accessibility-replay-")
                    || ALWAYS_REMOVED_ATTRIBUTES.contains(normalizedKey)
                    || NAVIGATION_ATTRIBUTES.contains(normalizedKey)) {
                element.removeAttr(key);
                continue;
            }
            if (URL_ATTRIBUTES.contains(normalizedKey) && isDangerousUrl(attribute.getValue())) {
                element.removeAttr(key);
            }
        }
    }

    private boolean isDangerousUrl(String value) {
        String normalized = value == null ? "" : value.replaceAll("[\\x00-\\x20]+", "").toLowerCase(Locale.ROOT);
        return normalized.startsWith("javascript:")
                || normalized.startsWith("vbscript:")
                || normalized.startsWith("file:")
                || normalized.startsWith("filesystem:")
                || normalized.startsWith("about:")
                || normalized.startsWith("chrome:")
                || normalized.startsWith("resource:")
                || normalized.startsWith("data:text/html")
                || normalized.startsWith("data:image/svg+xml");
    }

    private static boolean hasRelToken(Element link, String expected) {
        for (String token : link.attr("rel").toLowerCase(Locale.ROOT).split("\\s+")) {
            if (token.equals(expected)) {
                return true;
            }
        }
        return false;
    }

    private String bounded(String value, int maxLength) {
        return value.length() <= maxLength ? value : value.substring(0, maxLength);
    }

    private String decodeStrictUtf8(byte[] bytes) {
        try {
            String value = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
            return value.startsWith("\uFEFF") ? value.substring(1) : value;
        } catch (CharacterCodingException e) {
            throw new ArtifactValidationException("Replay document must be valid UTF-8", e);
        }
    }

    private static String sha256CspSource(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return "'sha256-" + Base64.getEncoder().encodeToString(digest) + "'";
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
    }

    private static String sha256Hex(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
    }

    public record SanitizedDocument(byte[] bytes, String scriptCspSource) {
        public SanitizedDocument {
            bytes = bytes.clone();
        }

        @Override
        public byte[] bytes() {
            return bytes.clone();
        }
    }
}
