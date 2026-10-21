import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise the actual module injected ahead of upstream scripts, using phone
// navigator objects. Backend tests check that the same UA is sent over HTTP.
const source = readFileSync(new URL("../../../../../../ap-backend/src/main/resources/livereport/desktop-environment.js", import.meta.url), "utf8");
const desktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

describe("live viewer desktop device identity", () => {
  it.each([
    { userAgent: "Mozilla/5.0 (iPhone) Mobile Safari/604.1", platform: "iPhone", maxTouchPoints: 5 },
    { userAgent: "Mozilla/5.0 (iPad) Mobile Safari/604.1", platform: "MacIntel", maxTouchPoints: 5 }
  ])("uses desktop detection for $platform without inventing client hints", navigator => {
    runInNewContext(source, { navigator, bridgeConfig: { desktopUserAgent } });
    expect(navigator.userAgent).toBe(desktopUserAgent);
    expect(navigator.platform).toBe("Win32");
    expect(navigator.maxTouchPoints).toBe(0);
    expect("userAgentData" in navigator).toBe(false);
  });

  it("keeps Android low and high entropy hints consistent with the HTTP desktop identity", async () => {
    const navigator = {
      userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile",
      platform: "Linux armv8l", maxTouchPoints: 5,
      userAgentData: { mobile: true, platform: "Android" }
    };
    const parentNavigator = { userAgent: navigator.userAgent };
    runInNewContext(source, { navigator, parent: { navigator: parentNavigator }, bridgeConfig: { desktopUserAgent } });
    const hints = navigator.userAgentData as unknown as {
      mobile: boolean; platform: string; toJSON: () => unknown;
      getHighEntropyValues: (keys: string[]) => Promise<Record<string, unknown>>;
    };
    expect(hints.mobile).toBe(false);
    expect(hints.platform).toBe("Windows");
    expect(hints.toJSON()).toMatchObject({ mobile: false, platform: "Windows" });
    expect(await hints.getHighEntropyValues(["model", "architecture", "formFactors", "uaFullVersion"]))
      .toMatchObject({ mobile: false, platform: "Windows", model: "", architecture: "x86", formFactors: ["Desktop"], uaFullVersion: "146.0.0.0" });
    expect(parentNavigator.userAgent).toContain("Android");
  });

  it("continues initialization when a browser locks one device property", () => {
    const navigator: Record<string, unknown> = Object.defineProperty({}, "userAgent", { value: "locked", configurable: false });
    expect(() => runInNewContext(source, { navigator, bridgeConfig: { desktopUserAgent } })).not.toThrow();
    expect(navigator.platform).toBe("Win32");
  });
});
