import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const valid = `/api/favicons/${"a".repeat(64)}.png`;
const missing = `/api/favicons/${"b".repeat(64)}.png`;
const { outputFiles } = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {OrganizationModelDetailPanel} from './src/components/dashboard/panels/project-detail-panel';
    import {PageFavicon} from './src/components/dashboard/panels/site-dashboard/page-favicon';
    const icons=[null, 'https://unverified.example/favicon.ico', '${valid}', '${missing}'];
    const organization={id:1,name:'Favicon regression',evaluationTargets:icons.map((faviconUrl,i)=>({id:i+1,name:'Site '+i,targetType:'WEB',status:'ACTIVE',createdAt:'2026-09-20',accessUrl:'https://unverified.example/page',faviconUrl}))};
    createRoot(document.getElementById('root')).render(<><OrganizationModelDetailPanel organization={organization} evaluationRequests={[]} scoreResults={[]} isDarkMode={false} onSiteClick={()=>{}} actions={null}/>{icons.map((faviconUrl,i)=><PageFavicon key={i} faviconUrl={faviconUrl} className={'page-icon page-icon-'+i}/>)}</>);`,
    resolveDir: frontend, loader: "tsx" },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  alias: { "@": frontend + "src" }, define: { "import.meta.env": "{}" },
});
const browser = await chromium.launch({ headless: true });
let server;
try {
  const page = await browser.newPage();
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  server = http.createServer((req, res) => {
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(outputFiles[0].text); }
    else if (req.url === valid) { res.setHeader("Content-Type", "image/png"); res.end(png); }
    else if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<html><head><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const requests = [], errors = [];
  page.on("request", request => requests.push(request.url()));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-favicon-loaded="true"]').length === 2);
  await page.waitForFunction(() => document.querySelectorAll('.dashboard-project-favicon img, .page-icon img').length === 2);
  for (const selector of [".dashboard-project-favicon", ".page-icon"]) {
    const state = await page.locator(selector).evaluateAll(elements => elements.map(el => ({
      loaded: el.dataset.faviconLoaded, image: Boolean(el.querySelector('img')),
      globe: Boolean(el.querySelector('svg')), width: el.querySelector('img')?.naturalWidth,
    })));
    assert.equal(state.length, 4);
    assert.equal(state.filter(item => item.loaded === "true" && item.width === 64).length, 1);
    assert.equal(state.filter(item => !item.image && item.globe).length, 3);
  }
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => !url.includes("unverified.example") && !url.endsWith("/favicon.ico")), requests.join("\n"));
  console.log("PASS: both favicon components use verified bytes; missing, legacy and failed icons retain the globe without remote fallback.");
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
