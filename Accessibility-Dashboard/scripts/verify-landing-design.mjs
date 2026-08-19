/**
 * Verifies the current editorial landing surface: responsive display type,
 * 44px actions, rounded stage surface, off-black ink, 3px keyboard focus,
 * and no horizontal overflow from 320 to 1440.
 *
 * Usage: BASE_URL=http://localhost:41920 node scripts/verify-landing-design.mjs
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:41920";
const outDir = process.env.OUT_DIR ?? "artifacts/design-migration/landing";

const HERO_MIN_PX = 36;
const HERO_MAX_PX = 136;
const CONTROL_MIN_HEIGHT_PX = 44;
const STAGE_MIN_RADIUS_PX = 20;

const viewports = [
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
      stage: read(".ua-stage__page", ["borderTopLeftRadius"]),
      primaryAction: read(".ua-hero__copy .ua-action", ["borderTopLeftRadius", "minHeight", "display"]),
      outlineAction: read(".ua-rail-button", ["borderTopLeftRadius", "minHeight", "display"]),
      heroLogin: read(".ua-text-action[data-login-cta]", ["borderTopLeftRadius", "minHeight", "display"]),
      eyebrow: read(".ua-hero__name", ["borderTopLeftRadius"]),
      severity,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
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

const browser = await chromium.launch({ headless: true });
const report = [];

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.locator(".ua-hero__headline").waitFor();
    await page.waitForTimeout(300);

    const facts = await readLandingFacts(page);
    const label = `${viewport.width}x${viewport.height}`;

    assert.ok(facts.heroHeadline, `${label}: hero headline missing`);
    assert.ok(facts.hero, `${label}: hero section missing`);
    assert.ok(facts.stage, `${label}: stage surface missing`);
    assert.ok(facts.primaryAction, `${label}: primary CTA missing`);

    // Responsive Korean display range from the current landing type scale.
    const heroFontSize = Number.parseFloat(facts.heroHeadline.fontSize);
    assert.ok(
      heroFontSize >= HERO_MIN_PX && heroFontSize <= HERO_MAX_PX,
      `${label}: hero ${heroFontSize}px outside ${HERO_MIN_PX}-${HERO_MAX_PX}px range`
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

    if (viewport.width === 1440 || viewport.width === 390) {
      await page.screenshot({ path: `${outDir}/after-landing-${label}.png`, fullPage: false });
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
        login: facts.heroLogin?.borderTopLeftRadius ?? null,
        eyebrowPill: facts.eyebrow?.borderTopLeftRadius ?? null
      },
      ctaHeight: {
        primary: facts.primaryAction?.height ?? null,
        outline: facts.outlineAction?.height ?? null,
        login: facts.heroLogin?.height ?? null
      },
      severity: facts.severity ? { text: facts.severity.text, ratio: severityRatio } : null,
      focus,
      overflow: facts.overflow
    });

    await page.close();
  }

  console.log(JSON.stringify({ result: "PASS", report }, null, 2));
} finally {
  writeFileSync(`${outDir}/landing-facts.json`, JSON.stringify({ report }, null, 2), "utf8");
  await browser.close();
}
