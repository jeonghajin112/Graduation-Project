import { describe, expect, it } from "vitest";

import { toRequestStatus } from "./quick-analysis-status";

describe("toRequestStatus", () => {
  it("keeps known request statuses", () => {
    expect(toRequestStatus("PENDING")).toBe("PENDING");
    expect(toRequestStatus("IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(toRequestStatus("COMPLETED")).toBe("COMPLETED");
    expect(toRequestStatus("FAILED")).toBe("FAILED");
  });

  it("falls back to PENDING for unknown or missing values", () => {
    expect(toRequestStatus("RUNNING")).toBe("PENDING");
    expect(toRequestStatus("completed")).toBe("PENDING");
    expect(toRequestStatus("")).toBe("PENDING");
    expect(toRequestStatus(null)).toBe("PENDING");
    expect(toRequestStatus(undefined)).toBe("PENDING");
  });
});
