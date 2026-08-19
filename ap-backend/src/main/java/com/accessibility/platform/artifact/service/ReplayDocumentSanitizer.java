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
              const MARKER_SIZE = 24;
              const MARKER_HALO = 6;
              const MARKER_GAP = 8;
              const MARKER_SLOT_STEP = 40;
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
              const POPOVER_MAX_MARKER_DISTANCE = MARKER_SLOT_STEP + POPOVER_GAP;
              const POPOVER_DENSITIES = ['normal', 'compact', 'minimal'];
              const POPOVER_WIDE_WIDTHS = [840, 760, 680, 600, 560];
              const POPOVER_MAX_LAYOUT_CANDIDATES = POPOVER_DENSITIES.length + POPOVER_WIDE_WIDTHS.length;
              const POPOVER_LEAVE_GRACE_MS = 120;
              const MAX_SEVERITY_LENGTH = 32;
              const MAX_SEVERITY_LABEL_LENGTH = 32;
              const MAX_CODE_LENGTH = 128;
              const MAX_TITLE_LENGTH = 300;
              const MAX_MESSAGE_LENGTH = 1600;
              const MAX_PATH_LENGTH = 2048;
              const SELECTION_FRAGMENT_OFFSET = 3;
              const MAX_SELECTION_FRAGMENTS = 128;
              const SLIDER_SETTLE_FRAMES = 3;
              const MAX_CAROUSEL_SLIDES = 500;
              const MAX_CAROUSEL_ID = 2147483647;
              const CAROUSEL_ID_ATTRIBUTE = 'data-ua-audit-carousel-id';
              const SLIDE_INDEX_ATTRIBUTE = 'data-ua-audit-slide-index';
              const SLIDE_COUNT_ATTRIBUTE = 'data-ua-audit-slide-count';
              const markers = new Map();
              const sliderRegistry = [];
              const motionGuardRoots = new WeakSet();
              const positionGuardRoots = new WeakSet();
              let markersVisible = true;
              let selectedIssueId = null;
              let activeMarkerPreview = null;
              let markerPreviewClearFrame = 0;
              let markerPreviewClearTimer = 0;
              let touchPinnedIssueId = null;
              let issuesInitialized = false;
              let selectedTarget = null;
              let selectionLayer = null;
              let issuePopover = null;
              let issuePopoverElements = null;
              let popoverIssueId = null;
              let issueDetailFallbackId = null;
              let selectedTargetResizeObserver = null;
              let positionFrame = 0;
              let positionPassesRemaining = 0;
              let markerSpatialIndex = null;

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
              const post = (message) => {
                window.parent.postMessage({
                  source: REPLAY_SOURCE,
                  ...message,
                  documentToken: replayDocumentToken
                }, '*');
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

              const normalizeIssue = (issue) => ({
                id: issue.id,
                severity: boundedText(issue.severity, MAX_SEVERITY_LENGTH),
                severityLabel: boundedText(issue.severityLabel, MAX_SEVERITY_LABEL_LENGTH),
                code: boundedText(issue.code, MAX_CODE_LENGTH),
                title: boundedText(issue.title, MAX_TITLE_LENGTH),
                message: boundedText(issue.message, MAX_MESSAGE_LENGTH),
                path: boundedText(issue.path, MAX_PATH_LENGTH),
                pathSteps: Array.isArray(issue.pathSteps) ? issue.pathSteps : []
              });

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

              const markerColor = (severity) => {
                const value = String(severity || '').toUpperCase();
                if (value === 'CRITICAL') return '#b42318';
                if (value === 'SERIOUS' || value === 'HIGH') return '#d92d20';
                if (value === 'MODERATE' || value === 'MEDIUM') return '#b54708';
                return '#175cd3';
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
                const fragmentBatch = document.createDocumentFragment();
                for (const rect of selectionRectsForTarget(selectedTarget)) {
                  const fragment = document.createElement('span');
                  fragment.className = 'selection-fragment';
                  fragment.style.transform = `translate(${rect.left - SELECTION_FRAGMENT_OFFSET}px, ${rect.top - SELECTION_FRAGMENT_OFFSET}px)`;
                  fragment.style.width = `${rect.width + SELECTION_FRAGMENT_OFFSET * 2}px`;
                  fragment.style.height = `${rect.height + SELECTION_FRAGMENT_OFFSET * 2}px`;
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
                issue.severityLabel || issue.severity || 'ISSUE',
                issue.code ? `KWCAG ${issue.code}` : '',
                issue.title || 'Accessibility issue'
              ].filter(Boolean).join('. ');

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
                activeMarkerPreview = null;
                if (issueKey(selectedIssueId) !== key) return;
                selectAndNotifyIssue(null, false, true, false);
              };

              const scheduleMarkerPreviewClear = (key, withPointerGrace) => {
                cancelMarkerPreviewClear();
                if (withPointerGrace) {
                  markerPreviewClearTimer = window.setTimeout(() => {
                    markerPreviewClearTimer = 0;
                    completeMarkerPreviewClear(key);
                  }, POPOVER_LEAVE_GRACE_MS);
                  return;
                }
                markerPreviewClearFrame = requestAnimationFrame(() => {
                  markerPreviewClearFrame = 0;
                  completeMarkerPreviewClear(key);
                });
              };

              const removeIssuePopoverDescription = (issueId) => {
                const entry = markers.get(issueKey(issueId));
                if (entry && issuePopover && entry.button.getAttribute('aria-describedby') === issuePopover.id) {
                  entry.button.removeAttribute('aria-describedby');
                }
              };

              const concealIssuePopover = () => {
                if (!issuePopover) return;
                removeIssuePopoverDescription(popoverIssueId);
                clearIssueDetailFallback();
                issuePopover.removeAttribute('data-presentation');
                issuePopover.hidden = true;
                issuePopover.style.visibility = 'hidden';
                issuePopover.setAttribute('aria-hidden', 'true');
              };

              const hideIssuePopover = () => {
                const hiddenIssueId = popoverIssueId;
                popoverIssueId = null;
                if (!issuePopover) return;
                removeIssuePopoverDescription(hiddenIssueId);
                clearIssueDetailFallback();
                issuePopover.hidden = true;
                issuePopover.style.visibility = 'hidden';
                issuePopover.setAttribute('aria-hidden', 'true');
                issuePopover.style.transform = 'translate(0px, 0px)';
                issuePopover.style.removeProperty('width');
                issuePopover.removeAttribute('data-presentation');
                issuePopover.removeAttribute('data-density');
                issuePopover.removeAttribute('data-layout');
                issuePopover.removeAttribute('data-issue-id');
                issuePopover.removeAttribute('data-placement');
              };

              const setIssuePopoverContent = (issue) => {
                if (!issuePopover || !issuePopoverElements) return;
                issuePopoverElements.severity.textContent = issue.severityLabel || issue.severity || 'ISSUE';
                issuePopoverElements.severity.dataset.severity = issue.severity.toUpperCase();
                issuePopoverElements.code.textContent = issue.code ? `KWCAG ${issue.code}` : 'KWCAG';
                issuePopoverElements.title.textContent = issue.title || 'Accessibility issue';
                issuePopoverElements.message.textContent = issue.message;
                issuePopoverElements.message.hidden = !issue.message;
                issuePopoverElements.path.textContent = issue.path;
                issuePopoverElements.path.hidden = !issue.path;
              };

              const markerDocumentRect = (entry) => {
                if (!entry || !entry.position || entry.button.hidden) return null;
                return {
                  left: entry.position.left - MARKER_HALO,
                  top: entry.position.top - MARKER_HALO,
                  right: entry.position.left + MARKER_SIZE + MARKER_HALO,
                  bottom: entry.position.top + MARKER_SIZE + MARKER_HALO
                };
              };

              const positionIssuePopover = () => {
                if (!issuePopover || popoverIssueId === null || !markersVisible) return;
                const entry = markers.get(issueKey(popoverIssueId));
                const markerRect = markerDocumentRect(entry);
                const targetRects = entry ? targetDocumentRects(entry.target) : [];
                if (!entry || !entry.target.isConnected || !markerRect || targetRects.length === 0) {
                  concealIssuePopover();
                  return;
                }

                issuePopover.hidden = false;
                issuePopover.style.visibility = 'hidden';
                issuePopover.style.transform = 'translate(0px, 0px)';
                issuePopover.style.removeProperty('width');
                issuePopover.removeAttribute('data-presentation');
                issuePopover.removeAttribute('data-layout');
                const documentElement = document.documentElement;
                const body = document.body;
                const documentWidth = Math.max(
                  window.innerWidth, documentElement.scrollWidth, body ? body.scrollWidth : 0
                );
                const documentHeight = Math.max(
                  window.innerHeight, documentElement.scrollHeight, body ? body.scrollHeight : 0
                );
                const minLeft = Math.max(POPOVER_VIEWPORT_MARGIN, window.scrollX + POPOVER_VIEWPORT_MARGIN);
                const minTop = Math.max(POPOVER_VIEWPORT_MARGIN, window.scrollY + POPOVER_VIEWPORT_MARGIN);
                const viewportRight = Math.min(
                  documentWidth - POPOVER_VIEWPORT_MARGIN,
                  window.scrollX + window.innerWidth - POPOVER_VIEWPORT_MARGIN
                );
                const viewportBottom = Math.min(
                  documentHeight - POPOVER_VIEWPORT_MARGIN,
                  window.scrollY + window.innerHeight - POPOVER_VIEWPORT_MARGIN
                );

                const expandedTargetRects = targetRects.map((rect) => ({
                  left: rect.left - POPOVER_TARGET_CLEARANCE,
                  top: rect.top - POPOVER_TARGET_CLEARANCE,
                  right: rect.right + POPOVER_TARGET_CLEARANCE,
                  bottom: rect.bottom + POPOVER_TARGET_CLEARANCE
                }));
                const overlapsPopoverObstacle = (rect) => (
                  expandedTargetRects.some((targetRect) => rectanglesOverlap(rect, targetRect))
                  || Boolean(markerSpatialIndex && markerSpatialIndex.hasMarkerRectOverlap(rect))
                );
                const targetUnion = expandedTargetRects.reduce((union, rect) => ({
                  left: Math.min(union.left, rect.left),
                  top: Math.min(union.top, rect.top),
                  right: Math.max(union.right, rect.right),
                  bottom: Math.max(union.bottom, rect.bottom)
                }), expandedTargetRects[0]);
                const anchors = [markerRect, targetUnion];
                const markerCenterX = (markerRect.left + markerRect.right) / 2;
                const markerCenterY = (markerRect.top + markerRect.bottom) / 2;

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
                      { placement: 'right', axis: 'vertical', left: anchor.right + POPOVER_GAP, top: centerY - height / 2 },
                      { placement: 'left', axis: 'vertical', left: anchor.left - width - POPOVER_GAP, top: centerY - height / 2 },
                      { placement: 'bottom', axis: 'horizontal', left: centerX - width / 2, top: anchor.bottom + POPOVER_GAP },
                      { placement: 'top', axis: 'horizontal', left: centerX - width / 2, top: anchor.top - height - POPOVER_GAP }
                    ];
                    rawCandidates.forEach((candidate, directionIndex) => {
                      const slotCount = candidate.axis === 'vertical'
                        ? Math.max(1, Math.ceil((maxTop - minTop) / MARKER_SLOT_STEP))
                        : Math.max(1, Math.ceil((maxLeft - minLeft) / MARKER_SLOT_STEP));
                      for (let slot = 0; slot <= slotCount; slot += 1) {
                        const offsets = slot === 0
                          ? [0]
                          : [slot * MARKER_SLOT_STEP, -slot * MARKER_SLOT_STEP];
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
                          const markerDistance = rectangleDistance(rect, markerRect);
                          if (markerDistance < POPOVER_GAP - 1
                              || markerDistance > POPOVER_MAX_MARKER_DISTANCE) continue;
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
                      candidate.markerDistance <= POPOVER_PREFERRED_MAX_MARKER_DISTANCE
                    ) || null,
                    fallback: candidates[0] || null
                  };
                };

                let layoutCandidateCount = 0;
                let fallbackLayout = null;
                const applyIssuePopoverLayout = (layout) => {
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
                  issuePopover.dataset.placement = selected.placement;
                  issuePopover.style.transform = `translate(${Math.round(selected.left)}px, ${Math.round(selected.top)}px)`;
                  issuePopover.style.visibility = 'visible';
                  issuePopover.setAttribute('aria-hidden', 'false');
                  entry.button.setAttribute('aria-describedby', issuePopover.id);
                };
                const presentIssuePopoverAsExternalDescription = () => {
                  issuePopover.style.removeProperty('width');
                  issuePopover.style.transform = 'translate(0px, 0px)';
                  issuePopover.removeAttribute('data-density');
                  issuePopover.removeAttribute('data-layout');
                  issuePopover.removeAttribute('data-placement');
                  issuePopover.dataset.presentation = 'external-description';
                  issuePopover.hidden = false;
                  issuePopover.style.visibility = 'visible';
                  issuePopover.setAttribute('aria-hidden', 'false');
                  entry.button.setAttribute('aria-describedby', issuePopover.id);
                  postIssueDetailFallback(entry.issue.id);
                };
                const tryCurrentIssuePopoverLayout = (layout) => {
                  if (layoutCandidateCount >= POPOVER_MAX_LAYOUT_CANDIDATES) return false;
                  layoutCandidateCount += 1;
                  const measured = issuePopover.getBoundingClientRect();
                  const width = Math.ceil(measured.width);
                  const height = Math.ceil(measured.height);
                  if (issuePopover.scrollWidth > issuePopover.clientWidth + 1
                      || issuePopover.scrollHeight > issuePopover.clientHeight + 1) return false;
                  const selected = findIssuePopoverCandidate(width, height);
                  if (!selected) return false;
                  if (!selected.preferred) {
                    if (!fallbackLayout && selected.fallback) {
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
                for (const width of POPOVER_WIDE_WIDTHS) {
                  if (width > availableWidth) continue;
                  const layout = { kind: 'wide', density: 'normal', width };
                  applyIssuePopoverLayout(layout);
                  if (tryCurrentIssuePopoverLayout(layout)) return;
                }

                if (fallbackLayout) {
                  applyIssuePopoverLayout(fallbackLayout.layout);
                  placeIssuePopoverCandidate(fallbackLayout.selected);
                  return;
                }

                issuePopover.style.removeProperty('width');
                issuePopover.removeAttribute('data-layout');
                issuePopover.removeAttribute('data-density');
                presentIssuePopoverAsExternalDescription();
              };

              const showIssuePopover = (issueId) => {
                const entry = markers.get(issueKey(issueId));
                if (!entry || entry.button.hidden || !markersVisible) {
                  hideIssuePopover();
                  return false;
                }
                popoverIssueId = issueId;
                setIssuePopoverContent(entry.issue);
                issuePopover.dataset.issueId = issueKey(issueId);
                positionIssuePopover();
                schedulePositions();
                return !issuePopover.hidden;
              };

              const createMarkerSpatialIndex = () => {
                const cells = new Map();
                const cellCoordinate = (value) => Math.floor(value / MARKER_SLOT_STEP);
                const hasCollision = (left, top) => {
                  const originCellX = cellCoordinate(left);
                  const originCellY = cellCoordinate(top);
                  for (let cellX = originCellX - 1; cellX <= originCellX + 1; cellX += 1) {
                    const column = cells.get(cellX);
                    if (!column) continue;
                    for (let cellY = originCellY - 1; cellY <= originCellY + 1; cellY += 1) {
                      const position = column.get(cellY);
                      if (position
                          && Math.abs(position.left - left) < MARKER_SLOT_STEP
                          && Math.abs(position.top - top) < MARKER_SLOT_STEP) return true;
                    }
                  }
                  return false;
                };
                const hasMarkerRectOverlap = (rect) => {
                  const minCellX = cellCoordinate(rect.left - MARKER_SIZE - MARKER_HALO);
                  const maxCellX = cellCoordinate(rect.right + MARKER_HALO);
                  const minCellY = cellCoordinate(rect.top - MARKER_SIZE - MARKER_HALO);
                  const maxCellY = cellCoordinate(rect.bottom + MARKER_HALO);
                  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                    const column = cells.get(cellX);
                    if (!column) continue;
                    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
                      const position = column.get(cellY);
                      if (!position) continue;
                      const markerRect = {
                        left: position.left - MARKER_HALO,
                        top: position.top - MARKER_HALO,
                        right: position.left + MARKER_SIZE + MARKER_HALO,
                        bottom: position.top + MARKER_SIZE + MARKER_HALO
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
                      const hitWidth = Math.min(CAROUSEL_CONTROL_HIT_TARGET_SIZE, rect.width);
                      const hitHeight = Math.min(CAROUSEL_CONTROL_HIT_TARGET_SIZE, rect.height);
                      protectedRects.push({
                        left: centerX - hitWidth / 2 - CAROUSEL_CONTROL_CLEARANCE,
                        top: centerY - hitHeight / 2 - CAROUSEL_CONTROL_CLEARANCE,
                        right: centerX + hitWidth / 2 + CAROUSEL_CONTROL_CLEARANCE,
                        bottom: centerY + hitHeight / 2 + CAROUSEL_CONTROL_CLEARANCE
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

              const markerRectForPosition = (position) => ({
                left: position.left - MARKER_HALO,
                top: position.top - MARKER_HALO,
                right: position.left + MARKER_SIZE + MARKER_HALO,
                bottom: position.top + MARKER_SIZE + MARKER_HALO
              });

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
                while (cursor.familyIndex < families.length) {
                  const family = families[cursor.familyIndex];
                  if (cursor.slot > family.slots) {
                    cursor.familyIndex += 1;
                    cursor.slot = 0;
                    cursor.offsetIndex = 0;
                    continue;
                  }
                  const offsetCount = cursor.slot === 0 ? 1 : 2;
                  if (cursor.offsetIndex >= offsetCount) {
                    cursor.slot += 1;
                    cursor.offsetIndex = 0;
                    continue;
                  }
                  const offset = cursor.slot === 0
                    ? 0
                    : (cursor.offsetIndex === 0 ? 1 : -1) * cursor.slot * MARKER_SLOT_STEP;
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
                const verticalSlots = Math.max(1, Math.ceil((maxTop - minTop) / MARKER_SLOT_STEP));
                const horizontalSlots = Math.max(1, Math.ceil((maxLeft - minLeft) / MARKER_SLOT_STEP));
                const leftGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.left - MARKER_SIZE - MARKER_GAP,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const rightGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.right + MARKER_GAP,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const topGutter = {
                    axis: 'horizontal',
                    baseLeft: firstRect.left,
                    baseTop: firstRect.top - MARKER_SIZE - MARKER_GAP,
                    slots: horizontalSlots
                };
                const bottomGutter = {
                    axis: 'horizontal',
                    baseLeft: firstRect.left,
                    baseTop: firstRect.bottom + MARKER_GAP,
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
                const verticalSlots = Math.min(
                  CAROUSEL_MARKER_RELOCATION_SLOTS,
                  Math.max(1, Math.ceil((maxTop - minTop) / MARKER_SLOT_STEP))
                );
                const horizontalSlots = Math.min(
                  CAROUSEL_MARKER_RELOCATION_SLOTS,
                  Math.max(1, Math.ceil((maxLeft - minLeft) / MARKER_SLOT_STEP))
                );
                const leftGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.left - MARKER_SIZE - MARKER_GAP,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const rightGutter = {
                  axis: 'vertical',
                  baseLeft: firstRect.right + MARKER_GAP,
                  baseTop: firstRect.top,
                  slots: verticalSlots
                };
                const topGutter = {
                  axis: 'horizontal',
                  baseLeft: firstRect.left,
                  baseTop: firstRect.top - MARKER_SIZE - MARKER_GAP,
                  slots: horizontalSlots
                };
                const bottomGutter = {
                  axis: 'horizontal',
                  baseLeft: firstRect.left,
                  baseTop: firstRect.bottom + MARKER_GAP,
                  slots: horizontalSlots
                };
                const families = preferRightGutter
                  ? [rightGutter, topGutter, leftGutter, bottomGutter]
                  : [leftGutter, topGutter, rightGutter, bottomGutter];
                const baselineFamilyIndex = families.findIndex((family) =>
                  family.axis === 'vertical'
                    ? Math.abs(baseline.left - family.baseLeft) <= MARKER_GUTTER_MATCH_TOLERANCE
                    : Math.abs(baseline.top - family.baseTop) <= MARKER_GUTTER_MATCH_TOLERANCE
                );
                const candidates = [];
                const seen = new Set();
                let order = 0;
                for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
                  const family = families[familyIndex];
                  for (let slot = 0; slot <= family.slots; slot += 1) {
                    const offsets = slot === 0
                      ? [0]
                      : [slot * MARKER_SLOT_STEP, -slot * MARKER_SLOT_STEP];
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
                const minLeft = Math.min(MARKER_HALO, Math.max(0, documentWidth - MARKER_SIZE));
                const minTop = Math.min(MARKER_HALO, Math.max(0, documentHeight - MARKER_SIZE));
                const maxLeft = Math.max(minLeft, documentWidth - MARKER_SIZE - MARKER_HALO);
                const maxTop = Math.max(minTop, documentHeight - MARKER_SIZE - MARKER_HALO);
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
                for (const entry of markers.values()) {
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
                      `translate(${placement.position.left}px, ${placement.position.top}px)`;
                  }
                }
                const previewCleared = clearUnavailableMarkerPreview();
                updateSelectedTargetHighlight();
                if (!previewCleared) positionIssuePopover();
                if (positionPassesRemaining > 0) positionFrame = requestAnimationFrame(updatePositions);
              };

              const schedulePositions = (passes = 1) => {
                const requestedPasses = Math.max(1, Math.min(SLIDER_SETTLE_FRAMES, Number(passes) || 1));
                positionPassesRemaining = Math.max(positionPassesRemaining, requestedPasses);
                if (!positionFrame) positionFrame = requestAnimationFrame(updatePositions);
              };

              const clearUnavailableMarkerPreview = () => {
                if (popoverIssueId === null) return false;
                const key = issueKey(popoverIssueId);
                const entry = markers.get(key);
                if (entry && entry.target.isConnected && !entry.button.hidden && entry.position) return false;
                cancelMarkerPreviewClear();
                if (activeMarkerPreview && activeMarkerPreview.key === key) activeMarkerPreview = null;
                if (touchPinnedIssueId !== null && issueKey(touchPinnedIssueId) === key) {
                  touchPinnedIssueId = null;
                }
                hideIssuePopover();
                if (issueKey(selectedIssueId) === key) {
                  selectAndNotifyIssue(null, false, true, false);
                }
                return true;
              };

              const selectIssue = (issueId, moveFocus, revealSlider = true) => {
                const previousEntry = markers.get(issueKey(selectedIssueId));
                const entry = markers.get(issueKey(issueId));
                selectedIssueId = issueId;
                if (previousEntry && previousEntry !== entry) {
                  previousEntry.button.dataset.selected = 'false';
                  previousEntry.button.setAttribute('aria-pressed', 'false');
                }
                if (entry) {
                  entry.button.dataset.selected = 'true';
                  entry.button.setAttribute('aria-pressed', 'true');
                }
                if (!entry || (popoverIssueId !== null && issueKey(popoverIssueId) !== issueKey(issueId))) {
                  hideIssuePopover();
                }
                if (entry && revealSlider) revealSliderForTarget(entry.target);
                highlightSelectedTarget(entry ? entry.target : null);
                if (!entry) return;
                if (moveFocus) {
                  entry.target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                  schedulePositions(SLIDER_SETTLE_FRAMES);
                  requestAnimationFrame(() => {
                    if (markersVisible && entry.button.isConnected && !entry.button.hidden) {
                      entry.button.focus({ preventScroll: true });
                    }
                  });
                  return;
                }
                schedulePositions();
              };

              const selectAndNotifyIssue = (issueId, moveFocus, skipIfSelected = false, revealSlider = true) => {
                if (skipIfSelected && issueKey(selectedIssueId) === issueKey(issueId)) return false;
                selectIssue(issueId, moveFocus, revealSlider);
                post({ type: 'ISSUE_SELECTED', issueId });
                return true;
              };

              const previewIssueFromMarker = (button, issueId, pointerType = '') => {
                if (pointerType === 'touch' || button.hidden || !button.isConnected) return false;
                cancelMarkerPreviewClear();
                touchPinnedIssueId = null;
                const key = issueKey(issueId);
                if (!activeMarkerPreview || activeMarkerPreview.key !== key) {
                  activeMarkerPreview = {
                    key,
                    pointer: false,
                    focus: false,
                    popoverPointer: false
                  };
                }
                if (pointerType) activeMarkerPreview.pointer = true;
                else activeMarkerPreview.focus = true;
                const changed = selectAndNotifyIssue(issueId, false, true, false);
                showIssuePopover(issueId);
                return changed;
              };

              const endMarkerPreview = (issueId, source, pointerType = '') => {
                if (pointerType === 'touch' || !activeMarkerPreview) return;
                const key = issueKey(issueId);
                if (activeMarkerPreview.key !== key) return;
                activeMarkerPreview[source] = false;
                if (markerPreviewIsActive(activeMarkerPreview)
                    || markerPreviewClearFrame
                    || markerPreviewClearTimer) return;
                const pointerTransition = source === 'pointer' || source === 'popoverPointer';
                scheduleMarkerPreviewClear(key, pointerTransition);
              };

              const beginIssuePopoverPreview = (source, pointerType = '') => {
                if (pointerType === 'touch' || popoverIssueId === null || issuePopover.hidden) return;
                const key = issueKey(popoverIssueId);
                cancelMarkerPreviewClear();
                if (!activeMarkerPreview || activeMarkerPreview.key !== key) {
                  activeMarkerPreview = {
                    key,
                    pointer: false,
                    focus: false,
                    popoverPointer: false
                  };
                }
                activeMarkerPreview[source] = true;
              };

              const dismissTouchPinnedIssue = () => {
                if (touchPinnedIssueId === null) return false;
                const key = issueKey(touchPinnedIssueId);
                touchPinnedIssueId = null;
                activeMarkerPreview = null;
                cancelMarkerPreviewClear();
                if (issueKey(selectedIssueId) === key) {
                  selectAndNotifyIssue(null, false, true, false);
                } else {
                  hideIssuePopover();
                }
                return true;
              };

              const dismissActiveMarkerPreview = () => {
                if (!activeMarkerPreview) return false;
                const key = activeMarkerPreview.key;
                activeMarkerPreview = null;
                cancelMarkerPreviewClear();
                if (issueKey(selectedIssueId) === key) {
                  selectAndNotifyIssue(null, false, true, false);
                } else {
                  hideIssuePopover();
                }
                return true;
              };

              const clearMarkers = () => {
                cancelMarkerPreviewClear();
                activeMarkerPreview = null;
                touchPinnedIssueId = null;
                hideIssuePopover();
                clearSelectedTarget();
                for (const entry of markers.values()) entry.button.remove();
                markers.clear();
                markerSpatialIndex = null;
              };

              const refreshSelectedTarget = () => {
                if (!markersVisible || selectedIssueId === null || selectedTarget) return;
                const entry = markers.get(issueKey(selectedIssueId));
                if (!entry || !entry.target.isConnected || entry.target.getClientRects().length === 0) return;
                highlightSelectedTarget(entry.target);
              };

              const initializeIssues = (message, shadowRoot) => {
                clearMarkers();
                markersVisible = message.markersVisible !== false;
                const issues = Array.isArray(message.issues) ? message.issues.slice(0, MAX_ISSUES) : [];
                const seenIssueIds = new Set();
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
                    post({ type: 'LOCATOR_STATUS', issueId: issue.id, status: 'UNAVAILABLE', reason: resolved.reason });
                    return;
                  }

                  const button = document.createElement('button');
                  button.type = 'button';
                  button.className = 'marker';
                  button.textContent = String(index + 1);
                  button.style.setProperty('--marker-color', markerColor(issue.severity));
                  button.hidden = true;
                  button.dataset.selected = 'false';
                  button.setAttribute('aria-label', issueAccessibleLabel(issue));
                  button.setAttribute('aria-pressed', 'false');
                  let lastPointerType = '';
                  button.addEventListener('pointerdown', (event) => {
                    lastPointerType = event.pointerType;
                  });
                  button.addEventListener('pointerenter', (event) => {
                    previewIssueFromMarker(button, issue.id, event.pointerType);
                  });
                  button.addEventListener('pointerleave', (event) => {
                    endMarkerPreview(issue.id, 'pointer', event.pointerType);
                  });
                  button.addEventListener('pointercancel', (event) => {
                    endMarkerPreview(issue.id, 'pointer', event.pointerType);
                  });
                  button.addEventListener('focus', () => {
                    if (button.matches(':focus-visible')) previewIssueFromMarker(button, issue.id);
                  });
                  button.addEventListener('blur', () => {
                    endMarkerPreview(issue.id, 'focus');
                  });
                  button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const pointerType = typeof event.pointerType === 'string'
                      ? event.pointerType
                      : lastPointerType;
                    const keyboardActivation = event.detail === 0 && button.matches(':focus');
                    lastPointerType = '';
                    if (pointerType === 'touch') {
                      cancelMarkerPreviewClear();
                      activeMarkerPreview = null;
                      touchPinnedIssueId = issue.id;
                    } else if (keyboardActivation) {
                      const key = issueKey(issue.id);
                      if (!activeMarkerPreview || activeMarkerPreview.key !== key) {
                        activeMarkerPreview = {
                          key,
                          pointer: false,
                          focus: false,
                          popoverPointer: false
                        };
                      }
                      activeMarkerPreview.focus = true;
                    }
                    selectAndNotifyIssue(issue.id, false, true);
                    showIssuePopover(issue.id);
                  });
                  markerBatch.appendChild(button);
                  markers.set(issueKey(issue.id), { issue, target: resolved.target, button, position: null });
                  post({ type: 'LOCATOR_STATUS', issueId: issue.id, status: 'CONNECTED' });
                });
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

              const releasePageScrollLock = () => {
                for (const element of [document.documentElement, document.body]) {
                  if (!element) continue;
                  const style = getComputedStyle(element);
                  const locked = ['hidden', 'clip'].includes(style.overflow)
                    || ['hidden', 'clip'].includes(style.overflowY);
                  if (locked) {
                    element.style.setProperty('overflow', 'auto', 'important');
                    element.style.setProperty('overflow-y', 'auto', 'important');
                  }
                  if (element === document.body && style.position === 'fixed') {
                    element.style.setProperty('position', 'static', 'important');
                    element.style.setProperty('inset', 'auto', 'important');
                    element.style.setProperty('width', 'auto', 'important');
                  }
                }
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
                const existingHost = document.getElementById(HOST_ID);
                if (existingHost) existingHost.remove();
                const host = document.createElement('div');
                host.id = HOST_ID;
                host.setAttribute('aria-label', 'Accessibility issue markers');
                host.style.cssText = 'all:initial!important;position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;pointer-events:none!important;';
                document.documentElement.appendChild(host);
                const shadowRoot = host.attachShadow({ mode: 'closed' });
                const style = document.createElement('style');
                style.textContent = `
                  :host::before,:host::after { content:none !important; display:none !important; pointer-events:none !important; }
                  .selection-layer { position:absolute; left:0; top:0; width:0; height:0; overflow:visible; pointer-events:none; }
                  .selection-fragment { box-sizing:border-box; position:absolute; left:0; top:0; border:3px solid #e5484d; pointer-events:none; transform-origin:top left; }
                  .marker { appearance:none; -webkit-appearance:none; box-sizing:border-box; display:grid; place-items:center; position:absolute; left:0; top:0; width:24px; height:24px; margin:0; padding:0; border:2px solid white; border-radius:999px; background:var(--marker-color); color:white; font:700 11px/1 system-ui,sans-serif; font-variant-numeric:tabular-nums; text-align:center; direction:ltr; unicode-bidi:isolate; box-shadow:0 2px 8px rgba(0,0,0,.35); cursor:pointer; pointer-events:auto; transform-origin:top left; }
                  .marker[hidden] { display:none !important; }
                  .marker[data-selected='true'] { z-index:2; }
                  .marker:focus-visible { outline:3px solid #101828; outline-offset:3px; }
                  .issue-popover { all:initial; box-sizing:border-box; display:block; position:absolute; left:0; top:0; z-index:3; width:clamp(220px,34vw,360px); max-width:calc(100vw - 24px); overflow:visible; touch-action:manipulation; padding:14px; border:1px solid #d0d5dd; border-radius:12px; background:#fff; color:#101828; box-shadow:0 12px 32px rgba(16,24,40,.2); font:400 13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; text-align:left; direction:ltr; unicode-bidi:isolate; overflow-wrap:anywhere; word-break:break-word; pointer-events:auto; transform-origin:top left; }
                  .issue-popover[hidden] { display:none !important; }
                  .issue-popover * { box-sizing:border-box; }
                  .issue-popover__tags { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 10px; }
                  .issue-popover__tag { display:inline-flex; align-items:center; min-width:0; max-width:100%; min-height:24px; margin:0; padding:3px 8px; overflow:visible; border-radius:999px; background:#f2f4f7; color:#344054; font:700 11px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
                  .issue-popover__severity[data-severity='CRITICAL'],.issue-popover__severity[data-severity='SERIOUS'],.issue-popover__severity[data-severity='HIGH'] { background:#fef3f2; color:#b42318; }
                  .issue-popover__severity[data-severity='MODERATE'],.issue-popover__severity[data-severity='MEDIUM'] { background:#fffaeb; color:#b54708; }
                  .issue-popover__severity[data-severity='LOW'] { background:#ecfdf3; color:#027a48; }
                  .issue-popover__title { display:block; margin:0 0 8px; overflow:visible; color:#101828; font:700 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; text-wrap:balance; word-break:keep-all; overflow-wrap:anywhere; }
                  .issue-popover__message { display:block; margin:0 0 10px; overflow:visible; color:#475467; font:400 13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; white-space:normal; }
                  .issue-popover__path { display:block; width:100%; margin:0; padding:9px 10px; overflow:visible; border-radius:8px; background:#f9fafb; color:#344054; font:400 11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
                  .issue-popover__message[hidden],.issue-popover__path[hidden] { display:none !important; }
                  .issue-popover[data-density='compact'] { padding:12px; }
                  .issue-popover[data-density='compact'] .issue-popover__tags { margin-bottom:8px; }
                  .issue-popover[data-density='compact'] .issue-popover__title { margin-bottom:7px; }
                  .issue-popover[data-density='compact'] .issue-popover__message { margin-bottom:8px; }
                  .issue-popover[data-density='minimal'] { padding:10px; }
                  .issue-popover[data-density='minimal'] .issue-popover__tags { gap:5px; margin-bottom:6px; }
                  .issue-popover[data-density='minimal'] .issue-popover__tag { min-height:22px; padding:2px 7px; }
                  .issue-popover[data-density='minimal'] .issue-popover__title { margin-bottom:6px; font-size:14px; line-height:1.35; }
                  .issue-popover[data-density='minimal'] .issue-popover__message { margin-bottom:6px; font-size:12px; line-height:1.45; }
                  .issue-popover[data-density='minimal'] .issue-popover__path { padding:7px 8px; font-size:10.5px; line-height:1.4; }
                  .issue-popover[data-layout='wide'] { display:grid; grid-template-columns:minmax(0,.8fr) minmax(0,2fr) minmax(0,1.2fr); grid-template-areas:'tags message path' 'title message path'; grid-template-rows:auto auto; align-items:start; column-gap:10px; row-gap:6px; padding:10px; }
                  .issue-popover[data-layout='wide'] .issue-popover__tags { grid-area:tags; align-self:start; gap:4px; margin:0; }
                  .issue-popover[data-layout='wide'] .issue-popover__tag { min-height:20px; padding:2px 6px; font-size:10px; line-height:1.25; }
                  .issue-popover[data-layout='wide'] .issue-popover__title { grid-area:title; align-self:start; margin:0; font-size:14px; line-height:1.35; text-wrap:balance; }
                   .issue-popover[data-layout='wide'] .issue-popover__message { grid-area:message; align-self:start; margin:0; font-size:11.5px; line-height:1.35; }
                   .issue-popover[data-layout='wide'] .issue-popover__path { grid-area:path; align-self:start; margin:0; padding:7px 8px; font-size:10px; line-height:1.35; }
                   .issue-popover[data-presentation='external-description'] { position:fixed; left:0; top:0; width:1px !important; max-width:1px !important; height:1px !important; margin:-1px !important; padding:0 !important; overflow:hidden !important; clip:rect(0 0 0 0) !important; clip-path:inset(50%) !important; white-space:nowrap !important; border:0 !important; border-radius:0 !important; box-shadow:none !important; pointer-events:none !important; transform:none !important; }
                   @media (forced-colors:active) {
                    .issue-popover { border:2px solid CanvasText; background:Canvas; color:CanvasText; box-shadow:none; }
                    .issue-popover__tag,.issue-popover__title,.issue-popover__message,.issue-popover__path { border:1px solid CanvasText; background:Canvas; color:CanvasText; }
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
                const popoverTags = document.createElement('div');
                popoverTags.className = 'issue-popover__tags';
                const popoverSeverity = document.createElement('span');
                popoverSeverity.className = 'issue-popover__tag issue-popover__severity';
                const popoverCode = document.createElement('span');
                popoverCode.className = 'issue-popover__tag issue-popover__code';
                popoverTags.append(popoverSeverity, popoverCode);
                const popoverTitle = document.createElement('p');
                popoverTitle.className = 'issue-popover__title';
                const popoverMessage = document.createElement('p');
                popoverMessage.className = 'issue-popover__message';
                const popoverPath = document.createElement('code');
                popoverPath.className = 'issue-popover__path';
                issuePopover.append(popoverTags, popoverTitle, popoverMessage, popoverPath);
                issuePopoverElements = {
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
                  } else if (message.type === 'INIT_ISSUES') {
                    initializeIssues(message, shadowRoot);
                  } else if (message.type === 'FOCUS_ISSUE') {
                    const incomingIssueId = typeof message.issueId === 'number' ? message.issueId : null;
                    if (activeMarkerPreview
                        && (incomingIssueId === null
                            || activeMarkerPreview.key !== issueKey(incomingIssueId))) return;
                    if (touchPinnedIssueId !== null
                        && (incomingIssueId === null
                            || issueKey(touchPinnedIssueId) !== issueKey(incomingIssueId))) {
                      touchPinnedIssueId = null;
                    }
                    selectIssue(incomingIssueId, false);
                  } else if (message.type === 'SET_MARKERS_VISIBLE') {
                    markersVisible = message.markersVisible !== false;
                    if (!markersVisible) {
                      cancelMarkerPreviewClear();
                      activeMarkerPreview = null;
                      touchPinnedIssueId = null;
                      hideIssuePopover();
                      clearSelectedTarget();
                      for (const entry of markers.values()) {
                        entry.button.hidden = true;
                        entry.position = null;
                      }
                    }
                    else if (selectedIssueId !== null) {
                      const entry = markers.get(issueKey(selectedIssueId));
                      highlightSelectedTarget(entry ? entry.target : null);
                    }
                    schedulePositions();
                  }
                });

                document.addEventListener('click', carouselControlClick, true);
                document.addEventListener('keydown', carouselControlKeyDown, true);
                document.addEventListener('pointerdown', (event) => {
                  if (event.pointerType === 'touch'
                      && touchPinnedIssueId !== null
                      && event.target !== host) dismissTouchPinnedIssue();
                }, { capture: true, passive: true });
                document.addEventListener('keydown', (event) => {
                  if (event.key !== 'Escape') return;
                  if (!dismissTouchPinnedIssue()) dismissActiveMarkerPreview();
                }, true);
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
