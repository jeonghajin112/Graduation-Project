import { describe, expect, it, vi } from "vitest";
import { installApiRouteFixture } from "./api-route-fixture.mjs";

async function setup(routes) {
  const page = { route: vi.fn() };
  const fixture = await installApiRouteFixture(page, routes);
  const dispatch = page.route.mock.calls[0][1];
  const createRoute = (method, path, origin = "http://app.test") => ({
    request: () => ({ method: () => method, url: () => origin + path }),
    fulfill: vi.fn()
  });
  return { page, fixture, dispatch, createRoute };
}

describe("API route fixture boundary", () => {
  it("dispatches declared methods and records paths, queries, and request counts", async () => {
    const handle = vi.fn(route => route.fulfill({ status: 200, body: "data" }));
    const { fixture, dispatch, createRoute } = await setup([
      { method: "GET", pathname: "/api/items", handle },
      { method: "POST", pathname: "/api/items", handle }
    ]);
    await dispatch(createRoute("GET", "/api/items?page=2"));
    await dispatch(createRoute("POST", "/api/items"));
    expect(handle).toHaveBeenCalledTimes(2);
    expect(fixture.journal).toEqual([
      { method: "GET", pathname: "/api/items", search: "?page=2" },
      { method: "POST", pathname: "/api/items", search: "" }
    ]);
    expect(fixture.countRequests({ pathname: "/api/items" })).toBe(2);
    expect(fixture.countRequests({ method: "POST", pathname: "/api/items" })).toBe(1);
    expect(() => fixture.assertIsolated()).not.toThrow();
  });

  it.each([
    ["GET", "/api/undeclared"],
    ["PATCH", "/api/items"],
    ["GET", "/api/items/extra"]
  ])("fails an undeclared %s %s instead of returning empty successful data", async (method, path) => {
    const handle = vi.fn();
    const { fixture, dispatch, createRoute } = await setup([{ method: "GET", pathname: "/api/items", handle }]);
    const route = createRoute(method, path);
    await dispatch(route);
    expect(handle).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledOnce();
    const response = route.fulfill.mock.calls[0][0];
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      success: false, data: null, message: `Unexpected fixture request: ${method} ${path}`
    });
    expect(() => fixture.assertIsolated()).toThrow(/undeclared request/);
  });

  it("restricts a viewer document to its declared origin and path", async () => {
    const handle = vi.fn(route => route.fulfill({ status: 200, body: "viewer" }));
    const { fixture, dispatch, createRoute } = await setup([
      { method: "GET", pathname: "/api/document", origin: "http://viewer.test", handle }
    ]);
    await dispatch(createRoute("GET", "/api/document", "http://viewer.test"));
    expect(() => fixture.assertIsolated()).not.toThrow();
    await dispatch(createRoute("GET", "/api/document"));
    expect(handle).toHaveBeenCalledOnce();
    expect(() => fixture.assertIsolated()).toThrow();
  });

  it("awaits a scenario response gate and reads its current payload after release", async () => {
    let release;
    let payload = "before";
    const gate = new Promise(resolve => { release = resolve; });
    const { fixture, dispatch, createRoute } = await setup([
      { method: "GET", pathname: "/api/items", handle: async route => {
        await gate;
        await route.fulfill({ status: 200, body: payload });
      } }
    ]);
    const route = createRoute("GET", "/api/items");
    const response = dispatch(route);
    expect(fixture.countRequests({ method: "GET" })).toBe(1);
    expect(route.fulfill).not.toHaveBeenCalled();
    payload = "after";
    release();
    await response;
    expect(route.fulfill).toHaveBeenCalledWith({ status: 200, body: "after" });
    expect(() => fixture.assertIsolated()).not.toThrow();
  });

  it("keeps pages' request journals and isolation failures independent", async () => {
    const first = await setup([]);
    const second = await setup([]);
    await first.dispatch(first.createRoute("GET", "/api/undeclared"));
    expect(() => second.fixture.assertIsolated()).not.toThrow();
    expect(first.fixture.journal).toHaveLength(1);
    expect(second.fixture.journal).toEqual([]);
  });
});
