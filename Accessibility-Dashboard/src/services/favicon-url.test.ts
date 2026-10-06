import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("only accepts verified cache paths", async () => {
  vi.stubEnv("VITE_API_BASE_URL", "");
  const { getVerifiedFaviconUrl } = await import("./favicon-url");
  const valid = `/api/favicons/${"a".repeat(64)}.png`;
  expect(getVerifiedFaviconUrl(valid)).toBe(valid);
  for (const invalid of [null, undefined, "", "https://example.com/favicon.ico", "/favicon.ico", `${valid}?remote=1`, "/api/favicons/../private.png"]) {
    expect(getVerifiedFaviconUrl(invalid)).toBeNull();
  }
});

it("resolves verified paths against a separate API origin", async () => {
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/api/");
  const { getVerifiedFaviconUrl } = await import("./favicon-url");
  expect(getVerifiedFaviconUrl(`/api/favicons/${"b".repeat(64)}.svg`))
    .toBe(`https://api.example.com/api/favicons/${"b".repeat(64)}.svg`);
});
