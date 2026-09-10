import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { exportLiveReportBrowserFixture } from "./fixtures/live-report-browser-fixture.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ap-live-boundaries-"));
const fixturePath = path.join(temporaryDirectory, "viewer.html");
const prebuiltFixture = process.env.AP_LIVE_REPORT_FIXTURE_PATH?.trim();
let browser;
let server;
const results = [];
const failures = [];

try {
  if (!prebuiltFixture) await exportLiveReportBrowserFixture(fixturePath);
  const fixture = await readFile(prebuiltFixture || fixturePath, "utf8");
  let app = "";
  server = createServer((request, response) => {
    if (request.url === "/viewer") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(fixture);
    } else if (request.url === "/app.mjs") {
      response.setHeader("content-type", "text/javascript");
      response.end(app);
    } else {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head><style>
        body{margin:0}.site-page-evidence-preview{width:900px;height:760px;position:relative}
        iframe{width:100%;height:100%;border:0}.site-page-evidence-replay-overlay{position:absolute;inset:0;background:white}
      </style></head><body><div id="root"></div><script type="module" src="/app.mjs"></script></body></html>`);
    }
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;
  const viewerOrigin = `http://${"a".repeat(40)}.localhost:${port}`;
  const compiled = await build({
    stdin: {
      contents: `
        import React,{useCallback,useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {RenderedPageEvidenceCard} from './src/components/dashboard/panels/site-dashboard/rendered-page-evidence-card';
        import {IssueLocationDialog} from './src/components/dashboard/panels/site-dashboard/issue-location-dialog';
        const count=Number(new URL(location.href).searchParams.get('count'));
        const rows=Array.from({length:count},(_,index)=>({
          issue:{id:index+1,analysisResultId:7,issueCode:'5.1.1',issueTitle:'테스트 문제 '+(index+1),severity:'HIGH',
            locationPath:index===0?'#group-target':index===Math.min(count,5000)-1?'#nearby-target':'#missing-'+index,
            message:'저장된 문제 설명',resolved:false,createdAt:'2026-09-09T00:00:00Z',updatedAt:'2026-09-09T00:00:00Z'},
          severity:{key:'HIGH',label:'높음',color:'#f79009'},analyzerType:'RULE_BASED'
        }));
        const session={sessionId:'6b2d884e-a7f4-4f09-9776-688d08fe8912',bridgeSecret:'test-bridge-secret',
          runtimeUrl:${JSON.stringify(viewerOrigin + "/viewer")},viewerOrigin:${JSON.stringify(viewerOrigin)}};
        function App(){
          const [retries,setRetries]=useState(0),[report,setReport]=useState(null);
          const [selected,setSelected]=useState(count),[focusRequest,setFocusRequest]=useState(0),[details,setDetails]=useState(false);
          const onReport=useCallback(next=>setReport(next),[]);
          const focus=id=>{setSelected(id);setFocusRequest(v=>v+1)};
          return <>
            <output id="retries">{retries}</output>
            <output id="report" data-state={report?.state} data-count={Object.keys(report?.issueStates||{}).length}
              data-overflow={Object.values(report?.issueStates||{}).filter(s=>s.reason==='ISSUE_LIMIT_EXCEEDED').length}/>
            <button id="focus-first" onClick={()=>focus(1)}>첫 문제 보기</button>
            <button id="focus-last" onClick={()=>focus(count)}>마지막 문제 보기</button>
            <button id="show-detail" onClick={()=>setDetails(true)}>마지막 문제 정보</button>
            <RenderedPageEvidenceCard captureMetadata={null} errorMessage={null} evaluationRequestId={7}
              liveSession={session} liveSessionLoadState="ready" onRetry={()=>{}}
              onRetryLiveSession={()=>setRetries(v=>v+1)} onLocatorReportChange={onReport} onSelectIssue={setSelected}
              rows={rows} selectedIssueId={selected} selectedIssueFocusRequestId={focusRequest} targetName="회귀 fixture"/>
            {details&&<IssueLocationDialog row={rows[count-1]} state={report?.issueStates[count]} onClose={()=>setDetails(false)}/>}
          </>
        }
        createRoot(document.getElementById('root')).render(<App/>);
      `,
      resolveDir: project,
      loader: "tsx"
    },
    jsx: "automatic", bundle: true, format: "esm", platform: "browser", write: false,
    define: { "import.meta.env": JSON.stringify({ VITE_LIVE_REPORT_VIEWER_BASE_URL: `http://localhost:${port}` }) },
    alias: { "@": path.join(project, "src") },
    plugins: [{ name: "behavior-fixture-css", setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    } }]
  });
  app = compiled.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });

  const runCase = async (name, count, verify) => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__commands = [];
      const nativePostMessage = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message, ...args) {
        if (message?.type === "COMMAND") window.__commands.push(message.payload);
        return nativePostMessage.call(this, message, ...args);
      };
    });
    try {
      await page.goto(`http://localhost:${port}/?count=${count}`);
      await page.locator('[data-connection-state="ready"][data-loading-phase="complete"]').waitFor({ timeout: 20_000 });
      const frame = page.frames().find(candidate => candidate.url().endsWith("/viewer"));
      await verify(page, frame);
      assert.deepEqual(errors, [], "the application and generated bridge must not throw");
      results.push(name);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    } finally {
      await page.close();
    }
  };
  const commands = (page, type) => page.evaluate(type => window.__commands.filter(message => message.type === type), type);
  const waitReport = (page, count) => page.locator(`#report[data-state="ready"][data-count="${count}"]`).waitFor({ state: "attached", timeout: 10_000 });

  for (const count of [4999, 5000, 5001, 10000, 10001]) {
    await runCase(`issue limit ${count}`, count, async (page, frame) => {
      await page.waitForFunction(() => window.__commands.some(message => message.type === "INIT_ISSUES"));
      const [init] = await commands(page, "INIT_ISSUES");
      assert.equal(init.issues.length, Math.min(count, 5000), "bound INIT before the viewer validates it");
      assert.equal(init.selectedIssueId, count <= 5000 ? count : null, "initial selection belongs to the transmitted subset");
      await waitReport(page, count);
      assert.equal(Number(await page.locator("#report").getAttribute("data-overflow")), Math.max(0, count - 5000));
      await page.locator("#focus-first").click();
      await frame.locator('.ap-live-popover__title').filter({ hasText: "테스트 문제 1" }).waitFor();
      await page.locator("#focus-last").click();
      await page.waitForFunction(expected => window.__commands.filter(message => message.type === "FOCUS_ISSUE").at(-1)?.issueId === expected, count <= 5000 ? count : null);
      assert.equal(await page.locator("#retries").textContent(), "0");
      if (count > 5000) {
        await page.locator("#show-detail").click();
        const details = page.getByRole("dialog", { name: "문제 상세" });
        await details.waitFor();
        assert.match(await details.innerText(), /표시 한도 초과/);
        assert.match(await details.innerText(), new RegExp(`#missing-${count - 1}`));
        await details.getByRole("button", { name: "문제 상세 닫기" }).click();
      }
    });
  }

  await runCase("blocked form keeps connection and ordering", 1, async (page, frame) => {
    await waitReport(page, 1);
    assert.equal(await frame.evaluate(() => {
      const form = document.createElement("form"); form.method = "post"; document.body.append(form);
      try { form.submit(); return null; } catch (error) { return error.name; }
    }), "NotSupportedError");
    await page.locator("#focus-first").click();
    await frame.locator('.ap-live-popover__title').filter({ hasText: "테스트 문제 1" }).waitFor();
    assert.equal(await page.locator("#retries").textContent(), "0");
    assert.equal(await page.locator('[data-connection-state="ready"]').count(), 1);
  });

  console.log(JSON.stringify({ result: failures.length ? "FAIL" : "PASS", cases: results, failures }, null, 2));
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  assert.ok(path.resolve(temporaryDirectory).startsWith(path.resolve(os.tmpdir()) + path.sep)
    && path.basename(temporaryDirectory).startsWith("ap-live-boundaries-"));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
