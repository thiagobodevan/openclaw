import { describe, expect, it } from "vitest";
import { parseSetupPlannerResult } from "./model.ts";

describe("setup model planner parsing", () => {
  it("parses compact JSON wrapped in model prose", () => {
    expect(
      parseSetupPlannerResult(
        'Here is the plan: {"reply":"Using QuickStart.","value":"quickstart"}',
      ),
    ).toEqual({
      reply: "Using QuickStart.",
      value: "quickstart",
    });
  });

  it("normalizes missing values to null", () => {
    expect(parseSetupPlannerResult('{"reply":"Please choose an option."}')).toEqual({
      reply: "Please choose an option.",
      value: null,
    });
  });

  it("rejects non-JSON or malformed planner output", () => {
    expect(parseSetupPlannerResult("I cannot answer that")).toBeNull();
    expect(parseSetupPlannerResult('{"value":"quickstart"}')).toBeNull();
  });
});
