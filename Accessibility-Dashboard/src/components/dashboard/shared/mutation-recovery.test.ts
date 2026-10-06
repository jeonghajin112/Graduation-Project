import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "@/services/backend-api";

import { commitMutationOnce, reconcileWithRetries } from "./mutation-recovery";

function requestError(status: number | null): ApiRequestError {
  return new ApiRequestError({
    method: "POST",
    path: "/requests",
    payload: null,
    status,
    url: "http://localhost/api/requests",
    message: "request failed"
  });
}

beforeEach(() => {
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("commitMutationOnce", () => {
  it("accepts one validated response without repeating the mutation", async () => {
    const operation = vi.fn(async () => ({ id: 7 }));
    await expect(
      commitMutationOnce({
        operation,
        accept: (response) => response.id
      })
    ).resolves.toEqual({ kind: "accepted", value: 7 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([requestError(null), requestError(503)])(
    "classifies an uncertain failure as GET-only reconciliation work",
    async (error) => {
      const operation = vi.fn(async () => {
        throw error;
      });
      await expect(
        commitMutationOnce({ operation, accept: () => 1 })
      ).resolves.toEqual({ kind: "ambiguous" });
      expect(operation).toHaveBeenCalledTimes(1);
    }
  );

  it("does not hide a definitive client rejection", async () => {
    const error = requestError(400);
    await expect(
      commitMutationOnce({
        operation: async () => {
          throw error;
        },
        accept: () => 1
      })
    ).rejects.toBe(error);
  });
});

describe("reconcileWithRetries", () => {
  it("returns the first recovered value from a bounded GET-only loop", async () => {
    const controller = new AbortController();
    const probe = vi
      .fn<(signal: AbortSignal, attempt: number) => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(42);

    await expect(
      reconcileWithRetries({
        attempts: 4,
        intervalMs: 0,
        probe,
        signal: controller.signal
      })
    ).resolves.toBe(42);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
