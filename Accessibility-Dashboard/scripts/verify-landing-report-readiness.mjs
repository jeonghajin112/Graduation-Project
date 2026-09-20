import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForReportFrame, readReportFrameState, assertSameReportFrame } from './fixtures/landing-report-readiness.mjs';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="blue"/></svg>');
  const source = `<p>A real visible article paragraph for the recording fixture.</p><img src="${svg}">`;
  await page.setContent('<div class="site-page-evidence-preview" aria-busy="false" data-connection-state="ready"><iframe></iframe></div>');
  await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, source);
  const viewer = page.frameLocator('iframe');
  const stable = await waitForReportFrame(page, viewer);
  assertSameReportFrame(stable, await readReportFrameState(page, viewer));

  await page.locator('.site-page-evidence-preview').evaluate(element => { element.setAttribute('aria-busy','true'); });
  assert.throws(() => assertSameReportFrame(stable, {...stable, ready:false}), /entered loading/);
  await assert.rejects(waitForReportFrame(page, viewer, 150), /did not settle/);
  await page.locator('.site-page-evidence-preview').evaluate(element => { element.setAttribute('aria-busy','false'); });

  await viewer.locator('p').evaluate(element => { element.textContent = ''; });
  const missingText = await readReportFrameState(page, viewer);
  assert.throws(() => assertSameReportFrame(stable, missingText), /content changed/);
  await viewer.locator('img').evaluate(element => { element.src = 'data:image/png;base64,broken'; });
  await assert.rejects(waitForReportFrame(page, viewer, 150), /did not settle/);

  await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, source);
  const newDocument = await waitForReportFrame(page, viewer);
  assert.throws(() => assertSameReportFrame(stable, newDocument), /navigated/);
  console.log('PASS: stable frame accepted; loading, missing content, broken images and document replacement rejected');
} finally { await browser.close(); }
