import assert from "node:assert/strict";

// Exercise native Tab traversal, not programmatic focus alone: in particular,
// the browser must be able to leave the viewer in both directions.
export async function verifyLiveReportKeyboardNavigation(page, frame, createIssue, rewrittenHtml) {
  await page.evaluate(() => {
    for (const id of ["before-viewer", "after-viewer"]) {
      const button = document.createElement("button");
      button.id = id;
      button.textContent = id;
      const viewer = document.querySelector("#viewer");
      if (id === "before-viewer") viewer.before(button);
      else viewer.after(button);
    }
    const viewer = document.querySelector('#viewer');
    viewer.tabIndex = -1;
    for (const direction of ['forward', 'backward']) {
      const guard = document.createElement('button');
      guard.id = `guard-${direction}`;
      guard.textContent = 'Report markers';
      guard.onfocus = () => window.__sendLiveCommand({
        source: 'accessibility-dashboard', type: 'FOCUS_REPORT_UI', direction
      });
      if (direction === 'forward') viewer.before(guard); else viewer.after(guard);
    }
  });
  await frame.locator("body").evaluate(body => {
    body.innerHTML = `<main>
      <a id="source-first" href="#source" tabindex="1">Source link</a>
      <input aria-label="Source input"><select aria-label="Source select"><option>One</option></select>
      <textarea aria-label="Source text"></textarea><div contenteditable="true">Editable</div>
      <details><summary>Source disclosure</summary>Contents</details>
      <div style="height:30px;overflow:auto"><div style="height:120px">Scrollable</div></div>
      <div id="open-shadow"></div><div id="closed-shadow"></div>
      <iframe title="Source frame" srcdoc="<button>Nested source button</button>"></iframe>
      <button id="source-slide" aria-label="다음 슬라이드">Next slide</button>
      <p id="keyboard-target-1">First issue target</p>
      <p id="keyboard-target-2" style="margin-top:60px">Second issue target</p>
    </main>`;
    window.scrollTo(0, 0);
    window.keyboardSourceTabs = 0;
    window.keyboardSourceClicks = 0;
    document.querySelector("#source-slide").onclick = () => { window.keyboardSourceClicks += 1; };
    for (const mode of ["open", "closed"]) {
      document.querySelector(`#${mode}-shadow`).attachShadow({ mode, delegatesFocus: true })
        .innerHTML = '<button tabindex="2">Shadow source button</button>';
    }
    window.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      window.keyboardSourceTabs += 1;
      event.preventDefault();
      document.querySelector("#source-first").focus();
    });
  });

  const setIssues = async issues => {
    await page.evaluate(issues => window.__sendLiveCommand({
      source: "accessibility-dashboard", type: "INIT_ISSUES", issues,
      selectedIssueId: null, markersVisible: true
    }), issues);
  };
  await setIssues([
    createIssue(901, "#keyboard-target-1", "First keyboard issue", "HIGH", "rule", "5.1.1"),
    createIssue(902, "#keyboard-target-1", "Grouped keyboard issue", "LOW", "rule", "5.1.1"),
    createIssue(903, "#keyboard-target-2", "Second keyboard issue", "LOW", "rule", "5.1.1")
  ]);
  await frame.locator('.ap-live-marker[data-issue-id="903"]').waitFor({ state: "visible" });

  const restoration = await frame.locator('#source-first').evaluate(element => new Promise(resolve => {
    let callbacks = 0;
    let cutoff = false;
    const observer = new MutationObserver(() => {
      if (++callbacks > 100) { cutoff = true; observer.disconnect(); return; }
      if (element.getAttribute('tabindex') !== '0') element.setAttribute('tabindex', '0');
    });
    observer.observe(element, { attributes: true, attributeFilter: ['tabindex'] });
    element.setAttribute('tabindex', '0');
    setTimeout(() => {
      observer.disconnect();
      requestAnimationFrame(() => resolve({ callbacks, cutoff, tabIndex: element.tabIndex }));
    }, 25);
  }));
  assert.equal(restoration.cutoff, false, 'source focus restoration must not compete with the bridge');
  assert.equal(restoration.tabIndex, 0, 'source focus attributes must remain owned by the source page');

  const walk = async (key, start, finish, expectMarkers) => {
    await page.locator(`#${start}`).focus();
    const visited = [];
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press(key);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => !document.activeElement.id.startsWith('guard-'));
      const parentFocus = await page.evaluate(() => document.activeElement.id);
      if (parentFocus === finish) {
        if (expectMarkers) {
          assert.ok(visited.includes("marker:901"), `${key} must reach the grouped issue marker`);
          assert.ok(visited.includes("marker:903"), `${key} must reach the second issue marker`);
        }
        return visited;
      }
      assert.equal(parentFocus, "viewer", `${key} step ${step} must traverse the iframe before leaving it; visited ${visited.join(',')}`);
      const focused = await frame.locator("html").evaluate(() => {
        const active = document.activeElement;
        if (active === document.body || active === document.documentElement) return "document";
        if (active.matches(".ap-live-marker")) return `marker:${active.dataset.issueId}`;
        if (active.closest("#ap-live-issue-popover")) return "popover";
        return `source:${active.outerHTML.slice(0, 140)}`;
      });
      assert.ok(!focused.startsWith("source:"), `${key} reached an upstream page element: ${focused}`);
      visited.push(focused);
    }
    assert.fail(`${key} trapped focus inside the viewer: ${visited.join(", ")}`);
  };

  const forward = await walk("Tab", "before-viewer", "after-viewer", true);
  assert.ok(forward.includes("popover"), "issue pager/detail controls must remain keyboard-accessible");
  await walk("Shift+Tab", "after-viewer", "before-viewer", true);

  // A page can re-enable existing controls or insert entire new tab scopes later.
  await frame.locator("body").evaluate(body => {
    document.querySelector("#source-first").tabIndex = 1;
    document.querySelector("input").removeAttribute("tabindex");
    const late = document.createElement("div");
    late.innerHTML = '<button tabindex="3">Late source button</button><div contenteditable>Late editor</div>';
    body.append(late);
    late.attachShadow({ mode: "closed" }).innerHTML = '<input aria-label="Late shadow input">';
  });
  await walk("Tab", "before-viewer", "after-viewer", true);
  await walk("Shift+Tab", "after-viewer", "before-viewer", true);

  await frame.locator('#source-slide').click();
  assert.equal(await frame.locator('body').evaluate(() => window.keyboardSourceClicks), 1,
    "allowed source-page mouse navigation must remain available");
  // Even when the mouse puts focus on a source control, Tab must return to report controls.
  await page.keyboard.press("Tab");
  assert.equal(await frame.locator('body').evaluate(() => document.activeElement.matches('.ap-live-marker')), true);
  await page.keyboard.press("Escape");
  assert.equal(await frame.locator('body').evaluate(() => document.activeElement.matches('.ap-live-marker')), true);
  assert.equal(await frame.locator('.ap-live-popover').isVisible(), false);
  assert.equal(await frame.locator('body').evaluate(() => window.keyboardSourceTabs), 0,
    "upstream Tab handlers must not redirect focus or trap it in source menus");

  // Start from mouse focus inside each nested scope, not just from the parent.
  await frame.locator('body').evaluate(body => {
    const host = document.createElement('div');
    host.id = 'mouse-scopes';
    host.innerHTML = '<div id="mouse-open"></div><div id="mouse-closed"></div>' +
      '<iframe id="mouse-nested" title="Nested mouse controls" srcdoc="<input aria-label=First><input aria-label=Second>"></iframe>';
    body.prepend(host);
    for (const mode of ['open', 'closed']) {
      const root = document.getElementById(`mouse-${mode}`).attachShadow({mode});
      root.innerHTML = '<a href="#one" style="display:inline-block;width:100px">First</a><a href="#two">Second</a>';
    }
  });
  const checkMouseTab = async (click, opaque = false) => {
    for (const key of ['Tab', 'Shift+Tab']) {
      await click();
      if (opaque) {
        // An opaque browsing context returns focus after its pointer task.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      await page.keyboard.press(key);
      await frame.locator('body').evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await frame.locator('body').evaluate(() =>
        document.activeElement.matches('.ap-live-marker') ||
        Boolean(document.activeElement.closest('#ap-live-issue-popover'))), true,
      `${key} after a nested mouse click must return to report controls`);
      await page.keyboard.press('Escape');
    }
  };
  await checkMouseTab(() => frame.locator('#mouse-open a').first().click());
  await checkMouseTab(async () => {
    const box = await frame.locator('#mouse-closed').boundingBox();
    await page.mouse.click(box.x + 30, box.y + box.height / 2);
  });
  await checkMouseTab(() => frame.locator('#mouse-nested').contentFrame().getByRole('textbox', {name:'First'}).click());
  // A sandboxed opaque frame cannot be inspected by the bridge.
  await frame.locator('#mouse-nested').evaluate(element => element.setAttribute('sandbox', 'allow-scripts'));
  await frame.locator('#mouse-nested').evaluate(element => { element.srcdoc = '<input aria-label="First"><input aria-label="Second">'; });
  await checkMouseTab(() => frame.locator('#mouse-nested').contentFrame().getByRole('textbox', {name:'First'}).click(), true);

  if (rewrittenHtml) {
    await frame.locator('#mouse-scopes').evaluate(element => element.remove());
    await frame.locator('body').evaluate((body, html) => {
      const child = document.createElement('iframe'); child.id = 'rewritten-child'; child.srcdoc = html;
      child.style.height = '60px';
      body.prepend(child);
    }, rewrittenHtml);
    const child = frame.locator('#rewritten-child').contentFrame();
    await child.locator('#group-target').waitFor();
    await child.locator('body').evaluate(body => {
      body.innerHTML = '<button aria-label="다음 슬라이드">Next slide</button><button>Second</button>';
    });
    await checkMouseTab(() => child.getByRole('button', {name:'다음 슬라이드'}).click());
  }

  await page.evaluate(() => window.__sendLiveCommand({
    source: "accessibility-dashboard", type: "SET_MARKERS_VISIBLE", markersVisible: false
  }));
  await frame.locator('#ap-live-marker-layer').waitFor({ state: "hidden" });
  await walk("Tab", "before-viewer", "after-viewer", false);
  await walk("Shift+Tab", "after-viewer", "before-viewer", false);
  await setIssues([]);
  await frame.locator('.ap-live-marker').first().waitFor({ state: "detached" });
  await walk("Tab", "before-viewer", "after-viewer", false);
  await walk("Shift+Tab", "after-viewer", "before-viewer", false);
}
