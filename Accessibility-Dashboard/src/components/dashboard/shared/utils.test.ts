import { describe, expect, it } from "vitest";

import { formatScore } from "./utils";

describe("formatScore", () => {
  it("rounds to one decimal and drops a trailing .0", () => {
    expect(formatScore(75)).toBe("75");
    expect(formatScore(86.25)).toBe("86.3");
    expect(formatScore(58.1)).toBe("58.1");
    expect(formatScore(99.96)).toBe("100");
    expect(formatScore(58.099999)).toBe("58.1");
    expect(formatScore(0)).toBe("0");
  });
});
