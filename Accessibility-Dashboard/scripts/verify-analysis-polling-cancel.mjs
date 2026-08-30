/**
 * Regression check: the analysis polling loop must stop when the panel that
 * started it unmounts.
 *
 * The quick-analyze panel polls `GET /api/requests/{id}` with an adaptive
 * delay while the document is visible. Before the AbortSignal wiring, a
 * client-side route change left that loop running for the remaining attempts.
 * This script keeps the request permanently PENDING, navigates away
 * mid-analysis, and asserts that no further polls reach the network.
 *
 * Usage: npm run test:browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createDashboardOverview, fulfillJson } from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-07-28T10:00:00.000Z";
const POLL_INTERVAL_MS = 1500;
const QUIET_WINDOW_MS = 6000;

const organization = {
  id: 1,
  name: "Cancellation Project",
  type: "ETC",
  homepageUrl: "https://example.com",
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

const target = {
  id: 101,
  organizationId: 1,
  name: "Cancellation Page",
  targetType: "WEB",
  accessUrl: "https://example.com/page",
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

/** Never reaches a final status, so the loop would run all 120 attempts. */
const pendingRequest = {
  id: 501,
  evaluationTargetId: 101,
  targetName: target.name,
  status: "PENDING",
  requestNote: "Cancellation probe",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};

const POLL_PATH = "/api/requests/501";

function payloadFor(pathname) {
  if (pathname === "/api/requests" || pathname === "/api/requests/evaluate") return [pendingRequest];
  if (pathname === POLL_PATH) return pendingRequest;
  if (pathname === "/api/organizations") return [organization];
  if (pathname === "/api/organizations/1/evaluation-targets") return [target];
  if (pathname === "/api/targets/101") return target;
  return [];
}

const browser = await chromium.launch({ headless: true });
const observed = { polls: 0, unknownPaths: new Set() };

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (request.method() === "GET" && pathname === "/api/dashboard/overview") {
      await fulfillJson(route, createDashboardOverview({
        organizations: [organization],
        evaluationTargets: [target],
        evaluationRequests: []
      }));
      return;
    }

    if (pathname === POLL_PATH) {
      observed.polls += 1;
    }

    const body =
      request.method() === "POST" && pathname === "/api/requests/evaluate" ? pendingRequest : payloadFor(pathname);

    if (
      ![
        "/api/requests",
        "/api/requests/evaluate",
        POLL_PATH,
        "/api/organizations",
        "/api/organizations/1/evaluation-targets",
        "/api/targets/101"
      ].includes(pathname)
    ) {
      observed.unknownPaths.add(`${request.method()} ${pathname}`);
    }

    await fulfillJson(route, body);
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "networkidle" });
  await page.locator("#quick-analyze-url").waitFor();

  await page.locator("#quick-analyze-url").fill("https://example.com/page");
  await page.getByRole("button", { name: "분석 시작" }).click();

  // Let the loop run for a few cycles so we know polling is genuinely active.
  await page.waitForFunction(() => document.body.innerText.includes("페이지를 분석하고 있습니다"));
  const deadline = Date.now() + POLL_INTERVAL_MS * 6;
  while (observed.polls < 3 && Date.now() < deadline) {
    await page.waitForTimeout(200);
  }
  const pollsWhileMounted = observed.polls;
  assert.ok(
    pollsWhileMounted >= 3,
    `expected the panel to poll at least 3 times while mounted, saw ${pollsWhileMounted}`
  );

  // Client-side navigation (not a reload) so React unmount cleanup is what stops
  // the loop. The sidebar project row calls navigate("/projects/1").
  const projectRow = page.locator("button.sidebar-tree-parent-row").first();
  await projectRow.waitFor();
  await projectRow.click();
  await page.waitForURL("**/projects/1");
  assert.equal(new URL(page.url()).pathname, "/projects/1");

  const pollsAtNavigation = observed.polls;
  await page.waitForTimeout(QUIET_WINDOW_MS);
  const pollsAfterNavigation = observed.polls;
  const leakedPolls = pollsAfterNavigation - pollsAtNavigation;

  assert.equal(
    leakedPolls,
    0,
    `polling continued after unmount: ${leakedPolls} extra request(s) to ${POLL_PATH} in ${QUIET_WINDOW_MS}ms`
  );

  console.log(
    JSON.stringify(
      {
        pollsWhileMounted,
        pollsAtNavigation,
        pollsAfterNavigation,
        leakedPolls,
        quietWindowMs: QUIET_WINDOW_MS,
        expectedLeakWithoutFix: Math.floor(QUIET_WINDOW_MS / POLL_INTERVAL_MS),
        unknownPaths: [...observed.unknownPaths],
        result: "PASS"
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
