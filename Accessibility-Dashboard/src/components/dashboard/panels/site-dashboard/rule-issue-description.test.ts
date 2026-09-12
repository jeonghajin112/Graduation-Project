import { describe, expect, it } from "vitest";
import { formatIssueDescription } from "./page-replay-protocol";
import { localizeRuleDescription } from "./rule-issue-description";

describe("rule descriptions", () => {
  it.each([
    ["link-name", "링크"], ["image-alt", "대체 텍스트"],
    ["list", "허용되지 않는"], ["listitem", "li"],
    ["button-name", "버튼"], ["label", "레이블"],
    ["color-contrast", "명도 대비"], ["document-title", "문서 제목"],
    ["html-has-lang", "기본 언어"], ["html-lang-valid", "언어 코드"]
  ])("uses precise engine rule %s", (id, description) => {
    const result = formatIssueDescription("Detailed original engine finding", "RULE_BASED", id);
    expect(result).toContain(description);
    expect(result).toContain("개선 안내");
  });
  it("recognizes the exact help in legacy records, not text embedded in a finding", () => {
    const help = "Links must have discernible text";
    expect(localizeRuleDescription(`${help}\nFix all of the following:`)).toContain("링크");
    expect(localizeRuleDescription(`Unknown finding\n${help}`)).toBeNull();
    expect(localizeRuleDescription(help, "unknown-rule")).toBeNull();
    expect(localizeRuleDescription(help, "__proto__")).toBeNull();
  });
  it("does not reinterpret unknown rules or other analysis modules", () => {
    const raw = "An unsupported rule with <script> text";
    expect(formatIssueDescription(raw, "RULE_BASED", "new-rule")).toBe(raw);
    expect(formatIssueDescription(raw, "AI_TEXT", "link-name")).toBe(raw);
    expect(formatIssueDescription(raw, "CV_VISION", "link-name")).toBe(raw);
  });
});
