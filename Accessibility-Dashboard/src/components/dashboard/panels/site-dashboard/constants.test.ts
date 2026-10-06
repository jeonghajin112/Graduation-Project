import { describe, expect, it } from "vitest";

import { formatIssueCodeLabel, normalizeIssueCode } from "./constants";

describe("issue standard code normalization", () => {
  it.each([
    ["img-alt", "5.1.1"],
    ["heading-order", "5.3.2"],
    ["color-contrast", "5.4.3"],
    ["keyboard-focus", "6.1.2"],
    ["label-missing", "7.3.2"]
  ])("maps %s to its canonical KWCAG criterion", (issueCode, criterion) => {
    expect(normalizeIssueCode(issueCode)).toBe(criterion);
    expect(formatIssueCodeLabel(issueCode)).toBe(`KWCAG ${criterion}`);
  });

  it("preserves an explicitly identified WCAG criterion", () => {
    expect(normalizeIssueCode(" WCAG 3.1.5 ")).toBe("WCAG 3.1.5");
    expect(formatIssueCodeLabel("WCAG 3.1.5")).toBe("WCAG 3.1.5");
  });

  it("does not disguise an unclassified legacy code as KWCAG", () => {
    expect(formatIssueCodeLabel("TEXT_DIFFICULTY")).toBe("TEXT_DIFFICULTY");
  });
});
