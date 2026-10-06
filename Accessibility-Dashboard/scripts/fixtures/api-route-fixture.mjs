import assert from "node:assert/strict";

// Keep scenario payloads and response gates in their fixture. This boundary
// only owns allowed methods/paths, request recording, and isolation failures.
export async function installApiRouteFixture(page, routes) {
  const journal = [];
  const unexpectedRequests = [];
  const pattern = "**/api/**";
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;
    journal.push({ method, pathname, search: url.search });
    const allowed = routes.find((entry) =>
      entry.method === method && entry.pathname === pathname &&
      (entry.origin === undefined || entry.origin === url.origin)
    );
    if (allowed) {
      await allowed.handle(route);
      return;
    }

    const label = `${method} ${pathname}${url.search}`;
    unexpectedRequests.push(label);
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ success: false, data: null, message: `Unexpected fixture request: ${label}` })
    });
  };
  await page.route(pattern, handler);

  return {
    journal,
    countRequests({ method, pathname }) {
      return journal.filter((entry) =>
        (method === undefined || entry.method === method) &&
        (pathname === undefined || entry.pathname === pathname)
      ).length;
    },
    assertIsolated() {
      assert.deepEqual(unexpectedRequests, [], "The API fixture received an undeclared request");
    }
  };
}
