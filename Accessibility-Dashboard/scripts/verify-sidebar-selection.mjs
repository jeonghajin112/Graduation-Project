import assert from "node:assert/strict";

import { parseDashboardRoute } from "../src/services/dashboard-route.ts";
import {
  QUICK_ANALYSIS_REGISTRY_VERSION,
  buildRecentAnalyzedPages,
  parseQuickAnalysisRegistry
} from "../src/services/quick-analysis-registry.ts";

assert.deepEqual(parseDashboardRoute("/projects/11").sidebarSelection, {
  kind: "project",
  id: 11
});
assert.deepEqual(parseDashboardRoute("/projects/11/pages/101").sidebarSelection, {
  kind: "projectPage",
  projectId: 11,
  pageId: 101
});
assert.deepEqual(parseDashboardRoute("/recent-pages/101").sidebarSelection, {
  kind: "recentPage",
  id: 101
});
assert.equal(parseDashboardRoute("/projects/not-a-number").sidebarSelection, null);
assert.equal(parseDashboardRoute("/recent-pages/0").sidebarSelection, null);
assert.deepEqual(parseDashboardRoute("/dashboard"), {
  kind: "dashboard",
  menu: "dashboard",
  selectedOrganizationModelId: null,
  selectedEvaluationTargetModelId: null,
  sidebarSelection: null
});

const organizations = [
  {
    id: 11,
    name: "첫 프로젝트",
    evaluationTargets: [
      { id: 101, name: "Quick 결과" },
      { id: 102, name: "프로젝트 생성 결과" }
    ]
  },
  {
    id: 22,
    name: "다른 프로젝트",
    evaluationTargets: [{ id: 201, name: "재분석 결과" }]
  }
];
const fixture = JSON.stringify({
  version: QUICK_ANALYSIS_REGISTRY_VERSION,
  records: [
    { projectId: 11, pageId: 101, timestamp: 3000 },
    { projectId: 11, pageId: 999, timestamp: 4000 },
    { projectId: 22, pageId: 101, timestamp: 5000 },
    { projectId: 11, pageId: 101, timestamp: 1000 },
    { projectId: -1, pageId: 102, timestamp: 6000 },
    { projectId: 22, pageId: 201, timestamp: "broken" }
  ]
});
const parsedFixture = parseQuickAnalysisRegistry(fixture);
const recentPages = buildRecentAnalyzedPages({
  organizations,
  quickAnalysisResults: parsedFixture
});

assert.deepEqual(
  recentPages.map(({ projectId, pageId }) => ({ projectId, pageId })),
  [{ projectId: 11, pageId: 101 }]
);
assert.deepEqual(parseQuickAnalysisRegistry("{broken"), []);
assert.deepEqual(
  parseQuickAnalysisRegistry(
    JSON.stringify({
      version: QUICK_ANALYSIS_REGISTRY_VERSION - 1,
      records: [{ projectId: 11, pageId: 101, timestamp: 3000 }]
    })
  ),
  []
);

console.log(
  JSON.stringify({
    routeCases: 6,
    parsedRegistryRecords: parsedFixture.length,
    recentPageIds: recentPages.map((page) => page.pageId),
    status: "PASS"
  })
);
