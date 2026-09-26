import { build } from "esbuild";
import { performance } from "node:perf_hooks";
const compiled = await build({ entryPoints: ["src/components/dashboard/panels/site-dashboard/locator-report.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { buildLocatorReport, sameLocatorReport } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const results = [];
for (const count of [500, 5000]) {
  const issueIds = Array.from({ length: count }, (_, i) => i + 1);
  const states = new Map(issueIds.map(id => [id, { status: "VISIBLE" }]));
  const input = { requestId: 1, issueIds, issueIdsSignature: issueIds.join(","), issueLimit: 5000, connected: true, failed: false, states };
  let previous = buildLocatorReport(input);
  const samples = [];
  for (let i = 0; i < 220; i++) {
    states.set(1, { status: i % 2 ? "VISIBLE" : "UNAVAILABLE", reason: "SELECTOR_NOT_FOUND" });
    const started = performance.now();
    const next = buildLocatorReport(input);
    sameLocatorReport(previous, next);
    const elapsed = performance.now() - started;
    if (i >= 20) samples.push(elapsed);
    previous = next;
  }
  samples.sort((a, b) => a - b);
  results.push({ issues: count, samples: samples.length, medianMs: samples[100], p95Ms: samples[190] });
}
console.log(JSON.stringify({ scope: "actual report builder and equality; excludes React paint", results }, null, 2));
