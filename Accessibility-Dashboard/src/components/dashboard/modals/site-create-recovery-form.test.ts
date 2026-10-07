import { describe, expect, it } from "vitest";

import { API_BASE_URL } from "@/config/api";
import type { PersistedSiteCreateAttempt } from "@/services/site-create-recovery-storage";

import { EVALUATION_REQUEST_FAILED_MESSAGE } from "../shared/evaluation-request-status";
import {
  EMPTY_RECOVERY_FORM,
  SITE_RECOVERY_BLOCKED_MESSAGE,
  SITE_RECOVERY_CONFLICT_MESSAGE,
  SITE_RECOVERY_STALE_MESSAGE,
  phaseAfterFailedRequest,
  recoveryFormFromRead
} from "./site-create-recovery-form";

const base = {
  version: 1 as const,
  attemptId: "attempt-1",
  apiScope: API_BASE_URL,
  projectId: 7,
  name: "Pricing",
  accessUrl: "https://example.com/pricing",
  previousTargetIds: [1, 2],
  startedAt: 1
};

const attempts = {
  creating: { ...base, phase: "target-reconciling" },
  ready: { ...base, phase: "request-ready", targetId: 9, previousFailedRequestId: null },
  failed: { ...base, phase: "request-ready", targetId: 9, previousFailedRequestId: 40 },
  reconciling: { ...base, phase: "request-reconciling", targetId: 9, knownRequestIds: [40], previousFailedRequestId: 40 },
  polling: { ...base, phase: "poll", targetId: 9, knownRequestIds: [], requestId: 41 }
} satisfies Record<string, PersistedSiteCreateAttempt>;

const valid = (attempt: PersistedSiteCreateAttempt, isStale = false) =>
  ({ kind: "valid", attempt, rawValue: "raw", isStale }) as const;

describe("site create recovery form", () => {
  it("starts empty when nothing is stored", () => {
    expect(recoveryFormFromRead({ kind: "none" }, 7)).toEqual(EMPTY_RECOVERY_FORM);
  });

  it("blocks on an unreadable record, discardable only when storage could be read", () => {
    expect(recoveryFormFromRead({ kind: "blocked", rawValue: "{" }, 7)).toEqual({
      ...EMPTY_RECOVERY_FORM, rawValue: "{", isBlocked: true, canDiscard: true, message: SITE_RECOVERY_BLOCKED_MESSAGE
    });
    expect(recoveryFormFromRead({ kind: "blocked", rawValue: null }, 7)).toMatchObject({
      isBlocked: true, canDiscard: false, rawValue: null
    });
  });

  it("blocks on another project's attempt without showing its page", () => {
    expect(recoveryFormFromRead(valid(attempts.ready), 8)).toEqual({
      ...EMPTY_RECOVERY_FORM, rawValue: "raw", isBlocked: true, canDiscard: false, message: SITE_RECOVERY_CONFLICT_MESSAGE
    });
    expect(recoveryFormFromRead(valid(attempts.ready, true), 8)).toMatchObject({
      isBlocked: true, canDiscard: true, message: SITE_RECOVERY_STALE_MESSAGE
    });
  });

  it.each([
    ["creating", { kind: "create" }, null],
    ["ready", { kind: "request", targetId: 9 }, "ready"],
    ["failed", { kind: "request", targetId: 9, previousFailedRequestId: 40 }, "failed"],
    ["reconciling", { kind: "request", targetId: 9, previousFailedRequestId: 40 }, "paused"],
    ["polling", { kind: "poll", targetId: 9, requestId: 41 }, "paused"]
  ] as const)("resumes this project's %s attempt", (name, resumePoint, phase) => {
    const form = recoveryFormFromRead(valid(attempts[name]), 7);
    expect(form).toMatchObject({
      rawValue: "raw", isBlocked: false, canDiscard: false, resumePoint, phase,
      siteName: "Pricing", baseUrl: "https://example.com/pricing"
    });
    expect(form.message.length).toBeGreaterThan(0);
  });

  it("explains a failed earlier request and lets a stale attempt be discarded", () => {
    expect(recoveryFormFromRead(valid(attempts.failed), 7).message).toBe(EVALUATION_REQUEST_FAILED_MESSAGE);
    expect(recoveryFormFromRead(valid(attempts.polling, true), 7)).toMatchObject({
      isBlocked: false, canDiscard: true, message: SITE_RECOVERY_STALE_MESSAGE
    });
  });

  it("pauses after a failure only while a request may already be running", () => {
    const request = { kind: "request", targetId: 9 } as const;
    expect(phaseAfterFailedRequest(attempts.reconciling, request)).toBe("paused");
    expect(phaseAfterFailedRequest(attempts.polling, request)).toBe("paused");
    expect(phaseAfterFailedRequest(null, { kind: "poll", targetId: 9, requestId: 41 })).toBe("paused");
    expect(phaseAfterFailedRequest(attempts.ready, request)).toBe("ready");
    expect(phaseAfterFailedRequest(attempts.failed, request)).toBe("failed");
    expect(phaseAfterFailedRequest(null, request)).toBe("failed");
  });
});
