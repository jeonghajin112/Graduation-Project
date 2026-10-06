/**
 * Regression check for the dashboard shell's background request polling.
 *
 * While an evaluation is active, the shell must poll only that request's
 * lightweight status endpoint. A terminal transition triggers one fresh
 * overview, after which status polling stops.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  createDashboardOverview,
  fulfillJson
} from "./fixtures/dashboard-api-fixture.mjs";
import { resolveTestBaseUrl } from "./frontend-test-runtime.mjs";

const baseUrl = resolveTestBaseUrl();
const timestamp = "2026-08-29T10:00:00.000Z";
const requestId = 501;
const organization = {
  id: 1,
  name: "Status Poll Project",
  type: "ETC",
  homepageUrl: "https://status-poll.example.com",
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const target = {
  id: 101,
  organizationId: organization.id,
  name: "Status Poll Page",
  targetType: "WEB",
  accessUrl: "https://status-poll.example.com/page",
  faviconUrl: null,
  description: "",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};

function evaluationRequest(status) {
  return {
    id: requestId,
    evaluationTargetId: target.id,
    targetName: target.name,
    faviconUrl: null,
    status,
    requestNote: "Lightweight status polling fixture",
    requestedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function waitUntil(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`${message}: ${JSON.stringify(journal)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const journal = [];
const unexpectedRequests = [];
let allowTerminalStatus = false;
let overviewGets = 0;
let statusGets = 0;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler, timeout, ...args) =>
      nativeSetInterval(handler, timeout === 5_000 ? 100 : timeout, ...args));
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    journal.push({ method: request.method(), pathname });

    if (request.method() === "GET" && pathname === "/api/dashboard/overview") {
      overviewGets += 1;
      await fulfillJson(route, createDashboardOverview({
        organizations: [organization],
        evaluationTargets: [target],
        evaluationRequests: [evaluationRequest(allowTerminalStatus ? "FAILED" : "IN_PROGRESS")]
      }));
      return;
    }

    if (request.method() === "GET" && pathname === `/api/requests/${requestId}`) {
      statusGets += 1;
      await fulfillJson(
        route,
        evaluationRequest(allowTerminalStatus ? "FAILED" : "IN_PROGRESS")
      );
      return;
    }

    unexpectedRequests.push(`${request.method()} ${pathname}`);
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        data: null,
        message: `Unexpected API call: ${request.method()} ${pathname}`
      })
    });
  });

  await page.goto(`${baseUrl}/analyze`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("complementary")
    .getByRole("button", { name: organization.name, exact: true })
    .waitFor();

  const bootstrapOverviewCount = overviewGets;
  await waitUntil(
    () => statusGets >= 2,
    "active request status polling did not start"
  );
  assert.equal(
    overviewGets,
    bootstrapOverviewCount,
    "non-terminal polls must not refetch the dashboard overview"
  );
  assert.equal(
    journal.some((entry) => entry.pathname === "/api/requests"),
    false,
    "background polling must not fetch the full request directory"
  );

  allowTerminalStatus = true;
  await waitUntil(
    () => overviewGets > bootstrapOverviewCount,
    "terminal request status did not trigger an overview refresh"
  );
  assert.equal(
    overviewGets,
    bootstrapOverviewCount + 1,
    "one terminal transition must trigger exactly one overview refresh"
  );

  const statusGetsAfterTerminalRefresh = statusGets;
  await page.waitForTimeout(350);
  assert.equal(
    statusGets,
    statusGetsAfterTerminalRefresh,
    "status polling must stop after the terminal overview removes the active request"
  );
  assert.deepEqual(unexpectedRequests, []);

  console.log(JSON.stringify({
    result: "PASS",
    bootstrapOverviewCount,
    nonTerminalStatusPolls: statusGetsAfterTerminalRefresh - 1,
    terminalOverviewRefreshes: overviewGets - bootstrapOverviewCount,
    fullRequestDirectoryGets: journal.filter(
      (entry) => entry.method === "GET" && entry.pathname === "/api/requests"
    ).length,
    statusPollsAfterTerminalRefresh: statusGets - statusGetsAfterTerminalRefresh
  }, null, 2));
} finally {
  await browser.close();
}
