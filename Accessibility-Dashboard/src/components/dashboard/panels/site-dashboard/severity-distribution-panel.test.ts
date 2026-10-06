import { describe, expect, it } from "vitest";

import { getSeverityBarHeightPercent } from "./severity-distribution-panel";

describe("severity distribution bar height", () => {
  it("keeps rare non-zero severities visible", () => {
    expect(getSeverityBarHeightPercent(1, 300)).toBe(5);
  });

  it("keeps empty severities empty", () => {
    expect(getSeverityBarHeightPercent(0, 300)).toBe(0);
    expect(getSeverityBarHeightPercent(0, 0)).toBe(0);
  });

  it("preserves ratios above the visual minimum", () => {
    expect(getSeverityBarHeightPercent(30, 100)).toBe(30);
  });
});
