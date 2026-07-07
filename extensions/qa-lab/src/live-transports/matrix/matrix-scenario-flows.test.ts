import { describe, expect, it } from "vitest";
import { readQaBootstrapScenarioCatalog } from "../../scenario-catalog.js";
import * as matrixFixtures from "./scenarios/matrix-scenario.fixture.js";

function readFixtureCall(
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  if (scenario.execution.kind !== "flow") {
    throw new Error(`expected Matrix fixture flow: ${scenario.id}`);
  }
  const actions = scenario.execution.flow?.steps.flatMap((step) => step.actions) ?? [];
  const callAction = actions.find(
    (action): action is { call: string; args?: unknown[] } =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      typeof action.call === "string" &&
      action.call.startsWith("matrixFixtures."),
  );
  if (!callAction) {
    throw new Error(`Matrix fixture flow has no named fixture call: ${scenario.id}`);
  }
  return callAction;
}

describe("Matrix QA Lab scenario flows", () => {
  const scenarios = readQaBootstrapScenarioCatalog().scenarios.filter((scenario) => {
    if (scenario.execution.kind !== "flow") {
      return false;
    }
    return scenario.execution.flow?.steps.some((step) =>
      step.actions.some(
        (action) =>
          typeof action === "object" &&
          action !== null &&
          "call" in action &&
          typeof action.call === "string" &&
          action.call.startsWith("matrixFixtures."),
      ),
    );
  });

  it("routes every migrated Matrix scenario through the shared flow host", () => {
    expect(scenarios).toHaveLength(81);
    for (const scenario of scenarios) {
      expect(scenario.execution.kind, scenario.id).toBe("flow");
      if (scenario.execution.kind !== "flow") {
        continue;
      }
      expect(scenario.execution.channel, scenario.id).toBe("matrix");
      expect(scenario.execution.retryCount, scenario.id).toBe(0);
      expect(scenario.execution.timeoutMs, scenario.id).toBeGreaterThan(0);
      expect(scenario.execution.flow?.steps.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.execution.flow?.steps.at(-1)?.detailsExpr, scenario.id).toBe(
        "result.details ?? (result.artifacts ? JSON.stringify(result.artifacts, null, 2) : undefined)",
      );
    }
  });

  it("binds every flow to an exported named fixture", () => {
    const fixtureNames = new Set<string>();
    for (const scenario of scenarios) {
      const callAction = readFixtureCall(scenario);
      const fixtureName = callAction.call.slice("matrixFixtures.".length);
      fixtureNames.add(fixtureName);
      expect(typeof matrixFixtures[fixtureName as keyof typeof matrixFixtures], scenario.id).toBe(
        "function",
      );
    }
    expect(fixtureNames.size).toBe(81);
  });

  it("requests the shared reaction canary only for reaction fixtures", () => {
    for (const scenario of scenarios) {
      const callAction = readFixtureCall(scenario);
      const argsJson = JSON.stringify(callAction.args ?? []);
      expect(argsJson.includes("requireCanary: true"), scenario.id).toBe(
        scenario.id.startsWith("matrix-reaction-"),
      );
    }
  });
});
