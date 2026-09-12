import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const project = fileURLToPath(new URL("../", import.meta.url));
const compiled = await build({
  stdin: {
    contents: `
      import React,{StrictMode,useLayoutEffect} from 'react';
      import {createRoot} from 'react-dom/client';
      import {useBatchedLocatorStates} from './src/components/dashboard/panels/site-dashboard/use-batched-locator-states';
      function App(){
        const {locatorStates,enqueueLocatorState,resetLocatorStates}=useBatchedLocatorStates();
        useLayoutEffect(()=>{
          window.queueState=enqueueLocatorState;
          window.resetStates=resetLocatorStates;
          window.snapshots.push([...locatorStates]);
        },[locatorStates,enqueueLocatorState,resetLocatorStates]);
        return <output id="states" data-count={locatorStates.size}>{JSON.stringify([...locatorStates])}</output>;
      }
      window.snapshots=[];
      const root=createRoot(document.getElementById('root'));
      window.unmount=()=>root.unmount();
      root.render(<StrictMode><App/></StrictMode>);
    `,
    resolveDir: project,
    loader: "tsx"
  },
  bundle: true, format: "esm", platform: "browser", write: false,
  alias: { "@": path.join(project, "src") }
});
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const runCase = async (name, verify) => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.fulfill(route.request().url().endsWith("/app.js")
      ? { contentType: "text/javascript", body: compiled.outputFiles[0].text }
      : { contentType: "text/html", body: '<div id="root"></div><script type="module" src="/app.js"></script>' }));
    await page.addInitScript(() => {
      const frames = new Map();
      let id = 0;
      // Simulate a paused frame scheduler; the hook's actual timer remains live.
      window.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
      window.cancelAnimationFrame = frame => frames.delete(frame);
      window.flushFrames = () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(performance.now()));
      };
      window.saveStaleFrame = () => { window.staleFrame = [...frames.values()][0]; };
    });
    try {
      await page.goto("http://localhost/locator-batch");
      await page.waitForFunction(() => typeof window.queueState === "function");
      // Let StrictMode's effect cleanup/remount finish before queueing messages.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      const metrics = await verify(page);
      assert.deepEqual(errors, []);
      results.push({ name, ...metrics });
    } finally {
      await page.close();
    }
  };
  const waitCount = (page, count) => page.locator(`#states[data-count="${count}"]`).waitFor();

  await runCase("1000 messages publish together and duplicates do not publish", async page => {
    await page.evaluate(() => {
      window.snapshots = [];
      for (let id = 1; id <= 1000; id += 1) window.queueState(id, { status: "VISIBLE" });
      window.flushFrames();
    });
    await waitCount(page, 1000);
    assert.equal(await page.evaluate(() => window.snapshots.length), 1);
    await page.evaluate(() => {
      for (let id = 1; id <= 1000; id += 1) window.queueState(id, { status: "VISIBLE" });
      window.flushFrames();
    });
    assert.equal(await page.evaluate(() => window.snapshots.length), 1);
    return { messages: 1000, publishedSnapshots: 1 };
  });

  await runCase("latest state wins and a reset fences queued callbacks", async page => {
    await page.evaluate(() => {
      window.queueState(1, { status: "OFFSCREEN" });
      window.saveStaleFrame();
      window.resetStates();
      window.queueState(2, { status: "VISIBLE" });
      window.queueState(2, { status: "HIDDEN_STATE", reason: "CAROUSEL_HIDDEN", recoverable: true });
      window.staleFrame(performance.now());
    });
    assert.equal(await page.locator("#states").getAttribute("data-count"), "0");
    await page.evaluate(() => window.flushFrames());
    await waitCount(page, 1);
    assert.deepEqual(JSON.parse(await page.locator("#states").textContent()), [
      [2, { status: "HIDDEN_STATE", reason: "CAROUSEL_HIDDEN", recoverable: true }]
    ]);
    await page.evaluate(() => window.resetStates());
    await waitCount(page, 0);
  });

  await runCase("timer publishes when animation frames are suspended", async page => {
    await page.evaluate(() => window.queueState(9, { status: "VISIBLE" }));
    await waitCount(page, 1);
    assert.deepEqual(JSON.parse(await page.locator("#states").textContent()), [[9, { status: "VISIBLE" }]]);
  });

  await runCase("unmount discards pending messages", async page => {
    await page.evaluate(() => {
      window.queueState(9, { status: "VISIBLE" });
      window.saveStaleFrame();
      window.snapshots = [];
      window.unmount();
      window.staleFrame(performance.now());
      window.flushFrames();
    });
    assert.equal(await page.locator("#states").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.snapshots), []);
  });
  console.log(JSON.stringify({ result: "PASS", cases: results }, null, 2));
} finally {
  await browser.close();
}
