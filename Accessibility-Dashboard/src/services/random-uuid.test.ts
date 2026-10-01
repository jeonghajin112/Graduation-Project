import { afterEach, expect, it, vi } from "vitest";

import { createRandomUuid } from "./random-uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => { vi.unstubAllGlobals(); });

it("uses the native generator in secure contexts", () => {
  expect(createRandomUuid()).toMatch(UUID_V4);
});

it("builds a v4 UUID from getRandomValues on insecure HTTP origins", () => {
  vi.stubGlobal("crypto", {
    getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff)
  });
  const value = createRandomUuid();
  expect(value).toMatch(UUID_V4);
  expect(value).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
});
