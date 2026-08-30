import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const reportPath = path.join(projectDirectory, "dist", "bundle-analysis.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const chunksByFileName = new Map(report.chunks.map((chunk) => [chunk.fileName, chunk]));

function findChunkByModule(moduleId) {
  const matches = report.chunks.filter((chunk) =>
    chunk.modules.some((module) => module.id === moduleId)
  );
  assert.equal(matches.length, 1, `Expected one chunk for ${moduleId}, received ${matches.length}.`);
  return matches[0];
}

function collectStaticClosure(initialChunks) {
  const closure = new Map();
  const pending = [...initialChunks];

  while (pending.length > 0) {
    const chunk = pending.pop();
    if (!chunk || closure.has(chunk.fileName)) {
      continue;
    }

    closure.set(chunk.fileName, chunk);
    for (const importedFileName of chunk.imports) {
      const importedChunk = chunksByFileName.get(importedFileName);
      assert(importedChunk, `Missing imported chunk ${importedFileName}.`);
      pending.push(importedChunk);
    }
  }

  return [...closure.values()];
}

function closureContainsModule(chunks, predicate) {
  return chunks.some((chunk) => chunk.modules.some((module) => predicate(module.id)));
}

async function gzipSize(chunks) {
  const sizes = await Promise.all(
    chunks.map(async (chunk) => {
      const file = await readFile(path.join(projectDirectory, "dist", chunk.fileName));
      return gzipSync(file).byteLength;
    })
  );
  return sizes.reduce((total, size) => total + size, 0);
}

const entry = report.chunks.find((chunk) => chunk.isEntry);
assert(entry, "The bundle report must contain an entry chunk.");

const landingChunk = findChunkByModule("src/components/ui/hero-demo.tsx");
const dashboardAppChunk = findChunkByModule("src/components/dashboard/dashboard-app-route.tsx");
const quickAnalyzeChunk = findChunkByModule(
  "src/components/dashboard/panels/quick-analyze-panel.tsx"
);
const projectDetailChunk = findChunkByModule(
  "src/components/dashboard/panels/project-detail-panel.tsx"
);
const pageDetailChunk = findChunkByModule(
  "src/components/dashboard/panels/site-dashboard-panel.tsx"
);
const modalChunks = [
  findChunkByModule("src/components/dashboard/modals/account-settings-modal.tsx"),
  findChunkByModule("src/components/dashboard/modals/organization-model-create-modal.tsx"),
  findChunkByModule("src/components/dashboard/modals/site-create-modal.tsx")
];

const routeClosures = {
  landing: collectStaticClosure([entry, landingChunk]),
  analyze: collectStaticClosure([entry, dashboardAppChunk, quickAnalyzeChunk]),
  projectDetail: collectStaticClosure([entry, dashboardAppChunk, projectDetailChunk]),
  pageDetail: collectStaticClosure([entry, dashboardAppChunk, pageDetailChunk])
};

const isLandingModule = (moduleId) => moduleId.startsWith("src/components/landing/");
const isDashboardModule = (moduleId) => moduleId.startsWith("src/components/dashboard/");
const isMotionModule = (moduleId) =>
  moduleId.startsWith("node_modules/framer-motion/") ||
  moduleId.startsWith("node_modules/motion-dom/");
const isChartModule = (moduleId) => moduleId.startsWith("node_modules/recharts/");

assert(!closureContainsModule(routeClosures.landing, isDashboardModule));
assert(!closureContainsModule(routeClosures.landing, isChartModule));
assert(!closureContainsModule(routeClosures.analyze, isLandingModule));
assert(!closureContainsModule(routeClosures.analyze, isMotionModule));
assert(!closureContainsModule(routeClosures.analyze, isChartModule));
assert(!closureContainsModule(routeClosures.projectDetail, isLandingModule));
assert(!closureContainsModule(routeClosures.projectDetail, isMotionModule));
assert(!closureContainsModule(routeClosures.projectDetail, isChartModule));
assert(!closureContainsModule(routeClosures.pageDetail, isLandingModule));
assert(!closureContainsModule(routeClosures.pageDetail, isMotionModule));
assert(closureContainsModule(routeClosures.pageDetail, isChartModule));

const initialAppRoutes = Object.entries(routeClosures).filter(([route]) => route !== "landing");
for (const modalChunk of modalChunks) {
  assert(modalChunk.isDynamicEntry, `${modalChunk.fileName} must remain a dynamic modal entry.`);
  const modalModuleIds = new Set(modalChunk.modules.map((module) => module.id));
  for (const [route, chunks] of initialAppRoutes) {
    assert(
      !closureContainsModule(chunks, (moduleId) => modalModuleIds.has(moduleId)),
      `Closed modal ${modalChunk.fileName} must remain outside the ${route} route's initial closure.`
    );
  }
}

const routeBudgets = {
  landing: 112 * 1024,
  analyze: 118 * 1024,
  projectDetail: 115 * 1024,
  pageDetail: 230 * 1024
};
const routeResults = {};

for (const [route, chunks] of Object.entries(routeClosures)) {
  const gzipJavaScriptBytes = await gzipSize(chunks);
  assert(
    gzipJavaScriptBytes <= routeBudgets[route],
    `${route} JavaScript is ${gzipJavaScriptBytes} gzip bytes; budget is ${routeBudgets[route]}.`
  );
  routeResults[route] = {
    gzipJavaScriptBytes,
    budgetBytes: routeBudgets[route],
    files: chunks.map((chunk) => chunk.fileName).sort()
  };
}

console.log(
  JSON.stringify(
    {
      result: "PASS",
      entryRawBytes: entry.rawBytes,
      routeResults
    },
    null,
    2
  )
);
