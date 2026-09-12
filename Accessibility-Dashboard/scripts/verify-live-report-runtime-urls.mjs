import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { exportLiveReportBrowserFixture } from "./fixtures/live-report-browser-fixture.mjs";

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ap-live-runtime-urls-"));
const fixturePath = path.join(temporaryDirectory, "viewer.html");
const viewerUrl = "http://localhost/live-runtime-url-fixture";
const results = [];
const failures = [];
let browser;

try {
  const prebuiltFixture = process.env.AP_LIVE_REPORT_FIXTURE_PATH?.trim();
  if (!prebuiltFixture) await exportLiveReportBrowserFixture(fixturePath);
  const fixture = await readFile(prebuiltFixture || fixturePath, "utf8");
  browser = await chromium.launch({ headless: true });

  const runCase = async (name, verify) => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // The generated bridge can request mirror assets while rewriting them.
    // Fulfill every request here, including any original upstream URL, so this
    // regression has no external network or running-backend dependency.
    await context.route("**/*", route => route.fulfill(route.request().url() === viewerUrl
      ? { status: 200, contentType: "text/html; charset=utf-8", body: fixture }
      : { status: 204, body: "" }));
    await page.addInitScript(() => {
      const watched = new WeakMap();
      const nativeGetAttribute = Element.prototype.getAttribute;
      const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
      let counts = { reads: {}, scans: {}, mutations: 0 };
      const increment = (kind, element) => {
        const label = watched.get(element);
        if (label) counts[kind][label] = (counts[kind][label] || 0) + 1;
      };
      // Install before the bridge captures native methods. Count actual DOM
      // work on fixture-owned nodes without depending on bridge function names.
      Element.prototype.getAttribute = function (...args) {
        increment("reads", this);
        return nativeGetAttribute.apply(this, args);
      };
      Element.prototype.querySelectorAll = function (...args) {
        increment("scans", this);
        return nativeQuerySelectorAll.apply(this, args);
      };
      window.__runtimeUrlProbe = {
        watch(element, label) { watched.set(element, label); },
        raw(element, name) { return nativeGetAttribute.call(element, name); },
        reset() { counts = { reads: {}, scans: {}, mutations: 0 }; },
        snapshot() { return structuredClone(counts); },
        observe(element) {
          new MutationObserver(records => { counts.mutations += records.length; })
            .observe(element, { attributes: true, childList: true, characterData: true, subtree: true });
        },
        async flush() {
          // Cross task boundaries so browser mutation deliveries, including
          // those caused by a rewrite, finish before inspecting the result.
          for (let index = 0; index < 3; index += 1) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      };
    });
    try {
      await page.goto(viewerUrl);
      await page.evaluate(() => window.__runtimeUrlProbe.flush());
      const measurements = await verify(page);
      assert.deepEqual(errors, [], "the generated bridge must not throw");
      results.push({ name, ...measurements });
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    } finally {
      await context.close();
    }
  };

  await runCase("attribute batches do not read descendants", async page => {
    const state = await page.evaluate(async () => {
      const probe = window.__runtimeUrlProbe;
      const container = document.createElement("div");
      container.innerHTML = "<span></span>".repeat(5000);
      document.body.append(container);
      await probe.flush();
      probe.watch(container, "container");
      for (const child of container.children) probe.watch(child, "descendants");
      probe.observe(container);
      probe.reset();
      for (let index = 0; index < 30; index += 1) container.style.transform = `translateX(${index}px)`;
      await probe.flush();
      const counts = probe.snapshot();
      await probe.flush();
      return { counts, settled: probe.snapshot(), transform: container.style.transform };
    });
    assert.equal(state.counts.reads.descendants || 0, 0, "parent style changes must not inspect descendant attributes");
    assert.equal(state.counts.scans.container || 0, 0, "attribute-only updates must not scan the parent subtree");
    assert.ok((state.counts.reads.container || 0) <= 12, "30 changes to one attribute should coalesce into bounded target work");
    assert.equal(state.transform, "translateX(29px)");
    assert.deepEqual(state.settled, state.counts, "own attribute rewrites must settle");
    return { descendantAttributeReads: state.counts.reads.descendants || 0, targetAttributeReads: state.counts.reads.container || 0 };
  });

  await runCase("attribute fallback preserves final URL values and removals", async page => {
    const state = await page.evaluate(async () => {
      const probe = window.__runtimeUrlProbe;
      const host = document.createElement("div");
      host.innerHTML = '<a id="url-link" href="#initial" style="color:red"></a><img id="url-image" src="data:," srcset=""><a id="url-removed" href="#initial"></a><a id="url-blocked" href="#initial"></a><img id="url-empty" src="data:,"><div id="url-data" data="initial"></div>';
      document.body.append(host);
      await probe.flush();
      const get = id => document.getElementById(id);
      const link = get("url-link");
      const image = get("url-image");
      probe.watch(link, "link");
      probe.observe(host);
      probe.reset();
      // Attr.value bypasses the patched setAttribute/property setters and
      // therefore proves the observer fallback, rather than those interceptors.
      for (let index = 0; index < 30; index += 1) {
        link.getAttributeNode("href").value = `./link-${index}.html`;
        link.getAttributeNode("style").value = `background-image:url('./background-${index}.png')`;
      }
      image.getAttributeNode("src").value = "https://assets.example.net/images/final.png?v=2#preview";
      image.getAttributeNode("srcset").value = "data:image/svg+xml,%3Csvg%3E 1x, ../large.png 2x";
      get("url-removed").getAttributeNode("href").value = "./removed.html";
      get("url-removed").removeAttribute("href");
      get("url-blocked").getAttributeNode("href").value = "javascript:void(0)";
      get("url-empty").getAttributeNode("src").value = "";
      get("url-data").getAttributeNode("data").value = "./ordinary-data.json";
      await probe.flush();
      const counts = probe.snapshot();
      await probe.flush();
      return {
        counts, settled: probe.snapshot(),
        href: probe.raw(link, "href"), style: probe.raw(link, "style"),
        src: probe.raw(image, "src"), srcset: probe.raw(image, "srcset"),
        removed: probe.raw(get("url-removed"), "href"), blocked: probe.raw(get("url-blocked"), "href"),
        empty: probe.raw(get("url-empty"), "src"), data: probe.raw(get("url-data"), "data")
      };
    });
    assert.equal(state.href, "http://localhost/nested/link-29.html");
    assert.match(state.style, /http:\/\/localhost\/nested\/background-29\.png/);
    const mirroredImage = new URL(state.src);
    assert.notEqual(mirroredImage.origin, "https://assets.example.net");
    assert.ok(mirroredImage.pathname.endsWith("/images/final.png"));
    assert.equal(mirroredImage.search, "?v=2");
    assert.equal(mirroredImage.hash, "#preview");
    assert.equal(state.srcset, "data:image/svg+xml,%3Csvg%3E 1x, http://localhost/large.png 2x");
    assert.equal(state.removed, null);
    assert.equal(state.blocked, null);
    assert.equal(state.empty, "");
    assert.equal(state.data, "./ordinary-data.json", "non-URL data attributes retain their page meaning");
    assert.ok((state.counts.reads.link || 0) <= 24, "repeated href/style records must coalesce by target and attribute");
    assert.equal(state.counts.scans.link || 0, 0);
    assert.deepEqual(state.settled, state.counts);
    return { targetAttributeReads: state.counts.reads.link || 0 };
  });

  await runCase("overlapping added subtrees rewrite each element once", async page => {
    const state = await page.evaluate(async () => {
      const probe = window.__runtimeUrlProbe;
      const parent = document.createElement("div");
      parent.innerHTML = '<img id="url-parent-image" src="./parent.png"><section></section>';
      document.body.append(parent);
      const child = parent.lastElementChild;
      child.innerHTML = '<img id="url-nested-image" src="../nested.png"><style>.added-url{background:url("./added-style.png")}</style>';
      const image = child.firstElementChild;
      probe.watch(image, "nestedImage");
      probe.reset();
      await probe.flush();
      return {
        parent: probe.raw(parent.firstElementChild, "src"), nested: probe.raw(image, "src"),
        style: child.lastElementChild.textContent, counts: probe.snapshot()
      };
    });
    assert.equal(state.parent, "http://localhost/nested/parent.png");
    assert.equal(state.nested, "http://localhost/nested.png");
    assert.match(state.style, /http:\/\/localhost\/nested\/added-style\.png/);
    // Allow all supported attribute checks and the idempotent follow-up record,
    // while rejecting another full visit through the separately queued child.
    assert.ok((state.counts.reads.nestedImage || 0) <= 20, "overlapping additions must not repeatedly rewrite the same element");
    return { nestedElementAttributeReads: state.counts.reads.nestedImage || 0 };
  });

  await runCase("separately added roots beyond the traversal cap remain covered", async page => {
    const state = await page.evaluate(async () => {
      const probe = window.__runtimeUrlProbe;
      const parent = document.createElement("div");
      parent.innerHTML = "<span></span>".repeat(5000);
      document.body.append(parent);
      const beyondCap = document.createElement("section");
      beyondCap.innerHTML = '<img src="./beyond-cap.png">';
      parent.append(beyondCap);
      await probe.flush();
      return { src: probe.raw(beyondCap.firstElementChild, "src") };
    });
    assert.equal(state.src, "http://localhost/nested/beyond-cap.png", "a capped ancestor scan must not discard a separately queued subtree");
  });

  await runCase("style text additions and edits rewrite then settle", async page => {
    const state = await page.evaluate(async () => {
      const probe = window.__runtimeUrlProbe;
      const style = document.createElement("style");
      document.head.append(style);
      await probe.flush();
      probe.observe(style);
      probe.reset();
      style.append(document.createTextNode('.runtime-a{background:url("./appended.png")}'));
      await probe.flush();
      const appended = style.textContent;
      style.firstChild.data = '.runtime-b{background:url("../changed.png")}';
      await probe.flush();
      const changed = style.textContent;
      style.replaceChildren(document.createTextNode('.runtime-c{background:url("./replaced.png")}'));
      await probe.flush();
      const replaced = style.textContent;
      style.textContent = '.runtime-d{background:url("./setter.png")}';
      const setter = style.textContent;
      style.sheet.insertRule('.runtime-e{background:url("./rule.png")}', 1);
      const rule = style.sheet.cssRules[1].cssText;
      await probe.flush();
      const counts = probe.snapshot();
      await probe.flush();
      return { appended, changed, replaced, setter, rule, counts, settled: probe.snapshot() };
    });
    assert.match(state.appended, /http:\/\/localhost\/nested\/appended\.png/);
    assert.match(state.changed, /http:\/\/localhost\/changed\.png/);
    assert.match(state.replaced, /http:\/\/localhost\/nested\/replaced\.png/);
    assert.match(state.setter, /http:\/\/localhost\/nested\/setter\.png/);
    assert.match(state.rule, /http:\/\/localhost\/nested\/rule\.png/);
    assert.deepEqual(state.settled, state.counts, "the observer must not repeatedly replace already rewritten style text");
    return { styleMutationRecords: state.counts.mutations };
  });

  await runCase("inserted SVG URLs and namespace setters remain mirrored", async page => {
    const state = await page.evaluate(async () => {
      const probe = window.__runtimeUrlProbe;
      const host = document.createElement("div");
      host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../inserted.svg"></image><use></use></svg>';
      document.body.append(host);
      await probe.flush();
      const image = host.firstElementChild.firstElementChild;
      const use = image.nextElementSibling;
      use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "./sprite.svg#star");
      const immediate = use.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      await probe.flush();
      return { inserted: probe.raw(image, "xlink:href"), immediate, final: probe.raw(use, "xlink:href") };
    });
    assert.equal(state.inserted, "http://localhost/inserted.svg");
    assert.equal(state.immediate, "http://localhost/nested/sprite.svg#star", "setAttributeNS must still rewrite synchronously");
    assert.equal(state.final, state.immediate);
  });

  console.log(JSON.stringify({ result: failures.length ? "FAIL" : "PASS", cases: results, failures }, null, 2));
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  assert.ok(path.resolve(temporaryDirectory).startsWith(path.resolve(os.tmpdir()) + path.sep)
    && path.basename(temporaryDirectory).startsWith("ap-live-runtime-urls-"));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
