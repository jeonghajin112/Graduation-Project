import { describe, expect, it } from "vitest";
import { failedPoll } from "./request-poll-policy";
import { createEvaluationStatusesParser } from "@/services/analysis-protocol-api";

describe("request polling observations", () => {
  it("backs off without declaring failure and pauses only after repeated, sustained absence", () => {
    let observation = failedPoll(undefined, 1000);
    expect(observation.nextAttemptAt).toBe(6000);
    for (let i = 0; i < 5; i++) observation = failedPoll(observation, 1000);
    expect(observation.paused).toBe(false);
    observation = failedPoll(observation, 121000);
    expect(observation.paused).toBe(true);
    expect(observation.nextAttemptAt).toBe(181000);
    expect(observation).not.toHaveProperty("status");
  });
  it("validates each requested ID, missing result and server removal independently", () => {
    const parse = createEvaluationStatusesParser([1, 2]);
    expect(parse([{ id: 1, outcome: "NOT_FOUND", request: null }, { id: 2, outcome: "REMOVED", request: null }], "batch")).toHaveLength(2);
    for (const invalid of [[], [{ id: 1, outcome: "FOUND", request: null }],
      [{ id: 1, outcome: "NOT_FOUND", request: null }, { id: 1, outcome: "NOT_FOUND", request: null }]]) {
      expect(() => parse(invalid, "batch")).toThrow();
    }
  });
});
