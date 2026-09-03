import { describe, expect, it } from "vitest";

import { isAbortError } from "@/services/backend-api";
import { UserFacingError } from "@/services/user-facing-error";

import { normalizeCaptureMetadataRequestError } from "./use-evaluation-capture-metadata";

describe("capture metadata request errors", () => {
  it("turns the hook-owned timeout abort into a visible terminal error", () => {
    const timeoutError = normalizeCaptureMetadataRequestError(
      new DOMException("aborted", "AbortError"),
      true
    );

    expect(timeoutError).toBeInstanceOf(UserFacingError);
    expect((timeoutError as Error).message).toContain("시간이 오래 걸리고 있습니다");
    expect(isAbortError(timeoutError)).toBe(false);
  });

  it("preserves ordinary aborts so unmounted consumers stay silent", () => {
    const abortError = new DOMException("aborted", "AbortError");
    expect(normalizeCaptureMetadataRequestError(abortError, false)).toBe(abortError);
  });
});
