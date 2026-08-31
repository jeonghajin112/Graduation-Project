/**
 * Verifies the current editorial landing surface: responsive display type,
 * 44px actions, rounded stage surface, off-black ink, 3px keyboard focus,
 * and no horizontal overflow from 320 through 4K.
 *
 * Usage: npm run test:visual
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { installDashboardApiFixture } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const outDir = process.env.OUT_DIR ?? "artifacts/design-migration/landing";
mkdirSync(outDir, { recursive: true });

const HERO_MIN_PX = 30;
const HERO_MAX_PX = 86;
const HERO_ULTRAWIDE_MAX_PX = 100;
const CONTROL_MIN_HEIGHT_PX = 44;
const STAGE_MIN_RADIUS_PX = 20;

const viewports = [
  { width: 3840, height: 2160 },
  { width: 1440, height: 900 },
  { width: 1024, height: 900 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 700 }
];

function channelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

function parseColor(value) {
  const matched = value.match(/-?[\d.]+/g);
  if (!matched || matched.length < 3) {
    throw new Error(`Cannot parse colour: ${value}`);
  }
  const numbers = matched.map(Number);
  const scale = value.startsWith("color(") ? 255 : 1;
  return numbers.slice(0, 3).map((channel) => channel * scale);
}

/** Alpha is the 4th component in both `rgba(r,g,b,a)` and `color(srgb r g b / a)`. */
function parseAlpha(value) {
  const matched = value.match(/-?[\d.]+/g);
  if (!matched || matched.length < 4) {
    return 1;
  }
  return Number(matched[3]);
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function isPureBlack(value) {
  const [r, g, b] = parseColor(value);
  return r === 0 && g === 0 && b === 0;
}

async function readLandingFacts(page) {
  return page.evaluate(() => {
    const read = (selector, keys) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const result = { height: Math.round(rect.height), width: Math.round(rect.width) };
      for (const key of keys) {
        result[key] = style[key];
      }
      return result;
    };

    const severityHigh = document.querySelector(".ua-art__state:not(.is-pass)");
    let severity = null;
    if (severityHigh) {
      const chipStyle = getComputedStyle(severityHigh);
      // The chip tint and its ancestors can both be translucent, so collect the
      // whole paint stack down to the first opaque layer and composite in Node.
      const isTransparent = (value) => !value || value === "rgba(0, 0, 0, 0)" || value === "transparent";
      const alphaOf = (value) => {
        const numbers = value.match(/-?[\d.]+/g);
        return numbers && numbers.length >= 4 ? Number(numbers[3]) : 1;
      };
      const stack = [];
      let node = severityHigh;
      while (node) {
        const value = getComputedStyle(node).backgroundColor;
        if (!isTransparent(value)) {
          stack.push(value);
          if (alphaOf(value) >= 1) break;
        }
        node = node.parentElement;
      }
      if (stack.length === 0 || alphaOf(stack[stack.length - 1]) < 1) {
        stack.push("rgb(255, 255, 255)");
      }
      severity = {
        color: chipStyle.color,
        backgroundColor: chipStyle.backgroundColor,
        backgroundStack: stack,
        fontSize: chipStyle.fontSize,
        text: severityHigh.textContent.trim()
      };
    }

    return {
      heroHeadline: read(".ua-hero__headline", ["fontSize"]),
      hero: read(".ua-hero", ["backgroundColor"]),
      principles: read(".ua-boundary", ["backgroundColor"]),
      stage: read(".ua-stage__surface", ["borderTopLeftRadius"]),
      primaryAction: read(".ua-hero__copy .ua-action", ["borderTopLeftRadius", "minHeight", "display"]),
      outlineAction: read(".ua-rail-button", ["borderTopLeftRadius", "minHeight", "display"]),
      heroLogin: read(".ua-text-action[data-login-cta]", ["borderTopLeftRadius", "minHeight", "display"]),
      severity,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
}

async function readDashboardSignature(root) {
  return root.evaluate((rootElement) => {
    const documentElement = rootElement.ownerDocument.documentElement;
    const view = rootElement.ownerDocument.defaultView;
    const rootRect = rootElement.getBoundingClientRect();
    const round = (value) => Math.round(value * 4) / 4;
    const read = (selector, styleKeys = []) => {
      const element = selector === ":scope"
        ? rootElement
        : rootElement.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const result = {
        x: round(rect.x - rootRect.x),
        y: round(rect.y - rootRect.y),
        width: round(rect.width),
        height: round(rect.height)
      };
      for (const key of styleKeys) {
        result[key] = style[key];
      }
      return result;
    };
    const cards = [...rootElement.querySelectorAll(".dashboard-project-card")];
    const selectedItems = [...rootElement.querySelectorAll('[aria-current="page"]')];

    return {
      viewport: {
        innerWidth: view?.innerWidth ?? null,
        innerHeight: view?.innerHeight ?? null,
        clientWidth: documentElement.clientWidth,
        clientHeight: documentElement.clientHeight
      },
      root: read(":scope", ["fontSize", "lineHeight", "backgroundColor"]),
      shell: read(".dashboard-shell", ["display", "flexDirection"]),
      sidebar: read("aside", [
        "position",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft"
      ]),
      accountTrigger: read(".dashboard-account-menu-trigger", ["fontSize", "columnGap"]),
      analyzeNav: read(".sidebar-nav-link", [
        "fontSize",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "borderTopLeftRadius"
      ]),
      projectRow: read(".sidebar-tree-parent-row", [
        "fontSize",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "borderTopLeftRadius"
      ]),
      main: read("main"),
      topZone: read(".dashboard-top-zone", ["paddingLeft", "paddingRight"]),
      contentZone: read(".dashboard-content-zone", ["paddingLeft", "paddingRight"]),
      projectTitle: read(".dashboard-project-title", ["fontSize", "lineHeight"]),
      projectAddButton: read(".dashboard-project-add-button", ["fontSize", "borderTopLeftRadius"]),
      grid: read(".dashboard-project-grid", ["gridTemplateColumns", "columnGap", "rowGap"]),
      card: read(".dashboard-project-card", ["paddingTop", "paddingRight", "borderTopLeftRadius"]),
      favicon: read(".dashboard-project-favicon", ["borderTopLeftRadius"]),
      cardTitle: read(".dashboard-project-card-title", ["fontSize", "lineHeight", "whiteSpace"]),
      cardMeta: read(".dashboard-project-card-meta", ["fontSize", "lineHeight"]),
      cardUrl: read(".dashboard-project-card-url", ["fontSize", "lineHeight"]),
      cardScore: read(".dashboard-project-card-score", ["fontSize", "lineHeight"]),
      cardStatus: read(".dashboard-project-card-status", ["fontSize", "lineHeight"]),
      cardWidths: cards.map((card) => round(card.getBoundingClientRect().width)),
      selectedLabels: selectedItems.map((item) => item.textContent?.trim() ?? ""),
      overflowX: documentElement.scrollWidth - documentElement.clientWidth
    };
  });
}

function readSharedDashboardLayout(signature) {
  const select = (box, keys) => {
    if (!box) return null;
    return Object.fromEntries(keys.map((key) => [key, box[key]]));
  };
  const mainOriginY = signature.main?.y ?? 0;
  const selectInMain = (box, keys) => {
    const selected = select(box, keys);
    return selected && "y" in selected
      ? { ...selected, y: selected.y - mainOriginY }
      : selected;
  };

  return {
    viewport: signature.viewport,
    root: select(signature.root, ["width", "fontSize", "lineHeight", "backgroundColor"]),
    shell: select(signature.shell, ["x", "y", "width", "display", "flexDirection"]),
    sidebar: select(signature.sidebar, [
      "x",
      "y",
      "width",
      "position",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft"
    ]),
    accountTrigger: signature.accountTrigger,
    analyzeNav: signature.analyzeNav,
    projectRow: signature.projectRow,
    main: selectInMain(signature.main, ["x", "y", "width"]),
    topZone: selectInMain(signature.topZone, [
      "x",
      "y",
      "width",
      "height",
      "paddingLeft",
      "paddingRight"
    ]),
    contentZone: selectInMain(signature.contentZone, [
      "x",
      "y",
      "width",
      "paddingLeft",
      "paddingRight"
    ]),
    projectTitle: selectInMain(signature.projectTitle, [
      "x",
      "y",
      "fontSize",
      "lineHeight"
    ]),
    projectAddButton: signature.projectAddButton,
    grid: signature.grid
      ? {
          ...selectInMain(signature.grid, ["x", "y", "width", "columnGap", "rowGap"]),
          columnWidths: signature.grid.gridTemplateColumns
            .split(/\s+/)
            .filter(Boolean)
            .map((value) => Math.round(Number.parseFloat(value) * 4) / 4)
        }
      : null,
    card: selectInMain(signature.card, [
      "x",
      "y",
      "width",
      "height",
      "paddingTop",
      "paddingRight",
      "borderTopLeftRadius"
    ]),
    cardTitle: select(signature.cardTitle, ["fontSize", "lineHeight", "whiteSpace"]),
    favicon: select(signature.favicon, ["width", "height", "borderTopLeftRadius"]),
    cardMeta: select(signature.cardMeta, ["fontSize", "lineHeight"]),
    cardUrl: select(signature.cardUrl, ["fontSize", "lineHeight"]),
    cardScore: select(signature.cardScore, ["fontSize", "lineHeight"]),
    cardStatus: select(signature.cardStatus, ["fontSize", "lineHeight"]),
    overflowX: signature.overflowX
  };
}

async function settleDocument(locator) {
  await locator.evaluate(async (element) => {
    await element.ownerDocument.fonts.ready;
    const view = element.ownerDocument.defaultView;
    await new Promise((resolve) => view?.requestAnimationFrame(() => resolve()));
    await new Promise((resolve) => view?.requestAnimationFrame(() => resolve()));
  });
}

async function readProjectFaviconPresentation(page) {
  return page.locator(".dashboard-project-favicon").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      loaded: element.dataset.faviconLoaded,
      borderTopWidth: style.borderTopWidth,
      backgroundColor: style.backgroundColor,
      fallbackIconCount: element.querySelectorAll("svg").length,
      imageCount: element.querySelectorAll("img").length
    };
  });
}

async function verifyProjectFaviconPresentation(browser) {
  const faviconUrl = `${baseUrl}/__test-assets__/favicon.svg`;
  const missingFaviconUrl = `${baseUrl}/__test-assets__/missing-favicon.svg`;
  const loadedPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await loadedPage.route("**/__test-assets__/favicon.svg", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#0071e3"/></svg>'
    })
  );
  const loadedFixture = await installDashboardApiFixture(loadedPage);
  loadedFixture.target.faviconUrl = faviconUrl;
  await loadedPage.goto(`${baseUrl}/projects/${loadedFixture.organization.id}`, { waitUntil: "networkidle" });
  await loadedPage.locator('.dashboard-project-favicon[data-favicon-loaded="true"]').waitFor();
  const loaded = await readProjectFaviconPresentation(loadedPage);
  loadedFixture.assertIsolated();
  await loadedPage.close();

  const fallbackPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await fallbackPage.route("**/__test-assets__/missing-favicon.svg", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "missing" })
  );
  const fallbackFixture = await installDashboardApiFixture(fallbackPage);
  fallbackFixture.target.faviconUrl = missingFaviconUrl;
  await fallbackPage.goto(`${baseUrl}/projects/${fallbackFixture.organization.id}`, { waitUntil: "networkidle" });
  await fallbackPage.waitForFunction(() => {
    const favicon = document.querySelector('.dashboard-project-favicon[data-favicon-loaded="false"]');
    return favicon && !favicon.querySelector("img");
  });
  const fallback = await readProjectFaviconPresentation(fallbackPage);
  fallbackFixture.assertIsolated();
  await fallbackPage.close();

  assert.equal(loaded.loaded, "true", "a successfully loaded favicon must enter the loaded state");
  assert.equal(loaded.borderTopWidth, "0px", "a successfully loaded favicon must not keep its frame border");
  assert.equal(parseAlpha(loaded.backgroundColor), 0, "a successfully loaded favicon must use a transparent surface");
  assert.equal(loaded.fallbackIconCount, 0, "a successfully loaded favicon must hide the fallback icon");
  assert.equal(loaded.imageCount, 1, "a successfully loaded favicon must remain visible");

  assert.equal(fallback.loaded, "false", "a failed favicon must stay in the fallback state");
  assert.ok(
    Number.parseFloat(fallback.borderTopWidth) > 0,
    "a failed favicon must retain the fallback frame border"
  );
  assert.equal(parseAlpha(fallback.backgroundColor), 1, "a failed favicon must retain its solid fallback surface");
  assert.equal(fallback.fallbackIconCount, 1, "a failed favicon must render the target-type fallback icon");
  assert.equal(fallback.imageCount, 0, "a failed favicon image must be removed from the rendered state");

  return { loaded, fallback };
}

/**
 * Composites a paint stack ordered top-most first onto an opaque base, so the
 * measured ratio matches what a user actually sees through translucent tints.
 */
function flattenStack(stack) {
  let result = parseColor(stack[stack.length - 1]);
  for (let index = stack.length - 2; index >= 0; index -= 1) {
    const layer = stack[index];
    const alpha = parseAlpha(layer);
    const channels = parseColor(layer);
    result = channels.map((channel, position) => channel * alpha + result[position] * (1 - alpha));
  }
  return result;
}

async function verifyProductReplayOverlayScale(productPreviewRoot) {
  await productPreviewRoot
    .getByRole("button", { name: "www.hongik.ac.kr 상세 보기", exact: true })
    .click();

  const outerFrame = productPreviewRoot.locator("iframe.site-page-evidence-replay-frame");
  await outerFrame.waitFor();
  const replayFrame = productPreviewRoot.frameLocator("iframe.site-page-evidence-replay-frame");
  const marker = replayFrame.locator(".preview-marker").first();
  await marker.waitFor({ state: "visible" });

  const outerScale = Number.parseFloat(await outerFrame.getAttribute("data-replay-scale"));
  const outerVisualWidth = Number.parseFloat(
    await outerFrame.getAttribute("data-replay-visual-width")
  );
  const innerMetrics = await replayFrame.locator("html").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      inverseScale: Number.parseFloat(style.getPropertyValue("--replay-overlay-inverse-scale")),
      visualWidth: Number.parseFloat(style.getPropertyValue("--replay-visual-width"))
    };
  });
  const markerBox = await marker.boundingBox();

  assert.ok(outerScale >= 0.01 && outerScale < 1, `product replay scale must fit: ${outerScale}`);
  assert.ok(outerVisualWidth > 0, `product replay visual width must be positive: ${outerVisualWidth}`);
  assert.ok(
    Math.abs(outerScale * innerMetrics.inverseScale - 1) <= 0.01,
    `product replay overlay scale must cancel the iframe scale: ${JSON.stringify({ outerScale, ...innerMetrics })}`
  );
  assert.ok(
    Math.abs(innerMetrics.visualWidth - outerVisualWidth) <= 0.5,
    `product replay visual width must match its parent: ${JSON.stringify({ outerVisualWidth, ...innerMetrics })}`
  );
  assert.ok(markerBox, "product replay marker must be visible");
  assert.ok(Math.abs(markerBox.width - 24) <= 0.75, `product replay marker width: ${markerBox.width}px`);
  assert.ok(Math.abs(markerBox.height - 24) <= 0.75, `product replay marker height: ${markerBox.height}px`);
}

const browser = await chromium.launch({ headless: true });
const report = [];
let faviconPresentation = null;

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    let unexpectedApiRequestCount = 0;
    await page.route("**/api/**", async (route) => {
      unexpectedApiRequestCount += 1;
      await route.abort("blockedbyclient");
    });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.locator(".ua-hero__headline").waitFor();
    const productPreviewRoot = page
      .frameLocator(".ua-stage__frame")
      .locator('[data-dashboard-product-preview="true"]');
    await productPreviewRoot.waitFor();
    await settleDocument(productPreviewRoot);

    const facts = await readLandingFacts(page);
    const label = `${viewport.width}x${viewport.height}`;
    const frameViewport = await page.locator(".ua-stage__frame").evaluate((frame) => ({
      width: frame.clientWidth,
      height: frame.clientHeight
    }));
    const embeddedDashboard = await readDashboardSignature(productPreviewRoot);
    const referencePage = await browser.newPage({
      viewport: frameViewport,
      reducedMotion: "reduce"
    });
    const referenceFixture = await installDashboardApiFixture(referencePage);
    await referencePage.goto(
      `${baseUrl}/projects/${referenceFixture.organization.id}`,
      { waitUntil: "networkidle" }
    );
    const actualDashboardRoot = referencePage.locator(".bridge-dashboard");
    await actualDashboardRoot.waitFor();
    await actualDashboardRoot.locator(".dashboard-project-grid").waitFor();
    await settleDocument(actualDashboardRoot);
    const referenceDashboard = await readDashboardSignature(actualDashboardRoot);
    referenceFixture.assertIsolated();
    await referencePage.close();

    const productPreview = {
      cardCount: embeddedDashboard.cardWidths.length,
      cardWidths: embeddedDashboard.cardWidths,
      columnCount: embeddedDashboard.grid?.gridTemplateColumns.split(/\s+/).filter(Boolean).length ?? 0,
      gridWidth: embeddedDashboard.grid?.width ?? 0,
      titleWhiteSpace: embeddedDashboard.cardTitle?.whiteSpace ?? null
    };

    assert.ok(facts.heroHeadline, `${label}: hero headline missing`);
    assert.ok(facts.hero, `${label}: hero section missing`);
    assert.ok(facts.stage, `${label}: stage surface missing`);
    assert.ok(facts.primaryAction, `${label}: primary CTA missing`);
    assert.ok(productPreview.cardCount > 0, `${label}: product preview missing`);
    assert.deepEqual(
      readSharedDashboardLayout(embeddedDashboard),
      readSharedDashboardLayout(referenceDashboard),
      `${label}: embedded dashboard layout differs from the live project route at ${frameViewport.width}x${frameViewport.height}`
    );
    assert.equal(
      unexpectedApiRequestCount,
      0,
      `${label}: the read-only product preview unexpectedly requested a live API`
    );

    // Responsive Korean display range from the current landing type scale.
    const heroFontSize = Number.parseFloat(facts.heroHeadline.fontSize);
    const heroMaxPx = viewport.width >= 3840 ? HERO_ULTRAWIDE_MAX_PX : HERO_MAX_PX;
    assert.ok(
      heroFontSize >= HERO_MIN_PX && heroFontSize <= heroMaxPx,
      `${label}: hero ${heroFontSize}px outside ${HERO_MIN_PX}-${heroMaxPx}px range`
    );

    // Off-black, not pure black.
    assert.ok(!isPureBlack(facts.hero.backgroundColor), `${label}: hero uses pure black`);
    if (facts.principles) {
      assert.ok(!isPureBlack(facts.principles.backgroundColor), `${label}: principles uses pure black`);
    }

    // The current card token is 20px on compact screens and grows on desktop.
    assert.ok(
      Number.parseFloat(facts.stage.borderTopLeftRadius) >= STAGE_MIN_RADIUS_PX,
      `${label}: stage radius ${facts.stage.borderTopLeftRadius} below ${STAGE_MIN_RADIUS_PX}px`
    );

    // All interactive landing actions meet the 44px target size floor.
    for (const [name, control] of [
      ["primary", facts.primaryAction],
      ["outline", facts.outlineAction],
      ["login", facts.heroLogin]
    ]) {
      if (!control || control.display === "none" || control.height === 0) continue;
      assert.ok(
        control.height >= CONTROL_MIN_HEIGHT_PX,
        `${label}: ${name} CTA height ${control.height}px below ${CONTROL_MIN_HEIGHT_PX}px`
      );
    }

    // Severity label must clear AA for its text size.
    let severityRatio = null;
    if (facts.severity) {
      const chipBackground = flattenStack(facts.severity.backgroundStack);
      severityRatio = Number(contrastRatio(parseColor(facts.severity.color), chipBackground).toFixed(2));
      assert.ok(
        severityRatio >= 4.5,
        `${label}: severity "${facts.severity.text}" contrast ${severityRatio} < 4.5 ` +
          `(color=${facts.severity.color} stack=${facts.severity.backgroundStack.join(" | ")})`
      );
    }

    // 3px action focus with the current 3px separation from the control.
    const focus = await page.evaluate(() => {
      const cta = document.querySelector(".ua-hero__copy .ua-action");
      if (!cta) return null;
      cta.focus();
      const style = getComputedStyle(cta);
      return { width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle };
    });
    if (focus) {
      assert.equal(focus.width, "3px", `${label}: focus ring ${focus.width} !== 3px`);
      assert.equal(focus.offset, "3px", `${label}: focus offset ${focus.offset} !== 3px`);
    }

    assert.ok(facts.overflow <= 0, `${label}: horizontal overflow ${facts.overflow}px`);
    assert.equal(
      productPreview.titleWhiteSpace,
      "nowrap",
      `${label}: landing typography leaked into the product card title`
    );

    if (viewport.width >= 768) {
      assert.ok(
        Math.min(...productPreview.cardWidths) >= 240,
        `${label}: product cards are too narrow (${productPreview.cardWidths.join(", ")}px)`
      );
    }

    if (viewport.width === 3840) {
      assert.ok(
        productPreview.columnCount >= 3,
        `${label}: product grid did not expand for its ${frameViewport.width}px internal viewport`
      );
      assert.ok(
        productPreview.cardCount >= productPreview.columnCount,
        `${label}: project preview must fill its first card row`
      );
      const accountTrigger = productPreviewRoot.locator(".dashboard-account-menu-trigger");
      await accountTrigger.click();
      const accountMenu = productPreviewRoot.locator(".dashboard-account-menu");
      await accountMenu.waitFor();
      const accountMenuMetrics = await accountMenu.evaluate((menu) => {
        const item = menu.querySelector(".dashboard-account-menu-item");
        const icon = item?.querySelector("svg");
        if (!item || !icon) return null;
        return {
          width: Math.round(menu.getBoundingClientRect().width),
          itemFontSize: Number.parseFloat(getComputedStyle(item).fontSize),
          iconWidth: Math.round(icon.getBoundingClientRect().width)
        };
      });
      assert.ok(accountMenuMetrics, `${label}: account dropdown metrics missing`);
      assert.ok(
        accountMenuMetrics.width <= 240,
        `${label}: account dropdown is too wide (${accountMenuMetrics.width}px)`
      );
      assert.ok(
        accountMenuMetrics.itemFontSize <= 16,
        `${label}: account dropdown text is too large (${accountMenuMetrics.itemFontSize}px)`
      );
      assert.ok(
        accountMenuMetrics.iconWidth <= 20,
        `${label}: account dropdown icon is too large (${accountMenuMetrics.iconWidth}px)`
      );
      await page.locator(".ua-stage").screenshot({ path: `${outDir}/after-account-menu-${label}.png` });
      await accountTrigger.click();
      await page.locator(".ua-stage").screenshot({ path: `${outDir}/after-product-preview-${label}.png` });
    }

    if (viewport.width === 1440 || viewport.width === 390) {
      await page.screenshot({ path: `${outDir}/after-landing-${label}.png`, fullPage: false });
    }
    if (viewport.width === 1440) {
      await verifyProductReplayOverlayScale(productPreviewRoot);
    }

    report.push({
      viewport: label,
      heroFontSize,
      heroBackground: facts.hero.backgroundColor,
      principlesBackground: facts.principles?.backgroundColor ?? null,
      stageRadius: facts.stage.borderTopLeftRadius,
      ctaRadius: {
        primary: facts.primaryAction?.borderTopLeftRadius ?? null,
        outline: facts.outlineAction?.borderTopLeftRadius ?? null,
        login: facts.heroLogin?.borderTopLeftRadius ?? null
      },
      ctaHeight: {
        primary: facts.primaryAction?.height ?? null,
        outline: facts.outlineAction?.height ?? null,
        login: facts.heroLogin?.height ?? null
      },
      severity: facts.severity ? { text: facts.severity.text, ratio: severityRatio } : null,
      productPreview,
      dashboardParity: {
        frameViewport,
        matched: true
      },
      focus,
      overflow: facts.overflow
    });

    await page.close();
  }

  faviconPresentation = await verifyProjectFaviconPresentation(browser);
  console.log(JSON.stringify({ result: "PASS", report, faviconPresentation }, null, 2));
} finally {
  writeFileSync(
    `${outDir}/landing-facts.json`,
    JSON.stringify({ report, faviconPresentation }, null, 2),
    "utf8"
  );
  await browser.close();
}
