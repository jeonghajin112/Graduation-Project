import assert from 'node:assert/strict';

// Check the document we are photographing, not just the parent's READY receipt.
export async function readReportFrameState(page, viewer) {
  const ready = await page.locator('.site-page-evidence-preview[aria-busy="false"][data-connection-state="ready"]').count() === 1;
  const overlay = await page.locator('.site-page-evidence-replay-overlay:visible').count() > 0;
  const content = await viewer.locator('html').evaluate(() => {
    const visible = element => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight &&
        box.right > 0 && box.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const images = [...document.images].filter(visible);
    const pendingImages = images.filter(image => !image.complete || image.naturalWidth === 0);
    const imageState = images.map(image => {
      const box = image.getBoundingClientRect();
      return [image.currentSrc || image.src, image.naturalWidth, Math.round(box.x), Math.round(box.y),
        Math.round(box.width), Math.round(box.height)];
    });
    const text = document.body?.innerText.replace(/\s+/g, ' ').trim() || '';
    return {
      documentEpoch: performance.timeOrigin,
      complete: document.readyState === 'complete' && document.fonts.status === 'loaded',
      pendingImages: pendingImages.length,
      hasContent: text.length > 20 || images.some(image => image.naturalWidth > 64),
      fingerprint: JSON.stringify([imageState, text.length, document.documentElement.scrollHeight, Math.round(scrollY)])
    };
  });
  return {...content, ready:ready && !overlay && content.complete && content.pendingImages === 0 && content.hasContent};
}

export async function waitForReportFrame(page, viewer, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let previous;
  let stable = 0;
  while (Date.now() < deadline) {
    const current = await readReportFrameState(page, viewer);
    stable = current.ready && current.documentEpoch === previous?.documentEpoch &&
      current.fingerprint === previous?.fingerprint ? stable + 1 : 0;
    if (stable >= 2) return current;
    previous = current;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  assert.fail(`Report did not settle before capture (ready=${previous?.ready}, pendingImages=${previous?.pendingImages})`);
}

export function assertSameReportFrame(before, after) {
  assert.ok(after.ready, 'The report entered loading or lost an image during capture');
  assert.equal(after.documentEpoch, before.documentEpoch, 'The viewer navigated during capture');
  assert.ok(after.fingerprint === before.fingerprint, 'Report content changed during capture');
}
