import { describe, expect, it } from "vitest";
import {
  MATRIX_QA_ALL_SCENARIO_IDS,
  MATRIX_QA_E2EE_CLI_SCENARIO_IDS,
  MATRIX_QA_E2EE_DEEP_SCENARIO_IDS,
  MATRIX_QA_E2EE_SMOKE_SCENARIO_IDS,
  MATRIX_QA_FAST_SCENARIO_IDS,
  MATRIX_QA_MEDIA_SCENARIO_IDS,
  MATRIX_QA_TRANSPORT_SCENARIO_IDS,
  resolveMatrixQaScenarioIds,
} from "./profiles.js";

describe("QA Lab Matrix profiles", () => {
  it("preserves the legacy profile sizes and default selection", () => {
    expect(MATRIX_QA_ALL_SCENARIO_IDS).toHaveLength(92);
    expect(MATRIX_QA_FAST_SCENARIO_IDS).toHaveLength(11);
    expect(MATRIX_QA_TRANSPORT_SCENARIO_IDS).toHaveLength(50);
    expect(MATRIX_QA_MEDIA_SCENARIO_IDS).toHaveLength(7);
    expect(MATRIX_QA_E2EE_SMOKE_SCENARIO_IDS).toHaveLength(8);
    expect(MATRIX_QA_E2EE_DEEP_SCENARIO_IDS).toHaveLength(18);
    expect(MATRIX_QA_E2EE_CLI_SCENARIO_IDS).toHaveLength(9);
    expect(resolveMatrixQaScenarioIds({})).toEqual(MATRIX_QA_ALL_SCENARIO_IDS);
  });

  it("keeps profile ids unique and excludes the legacy explicit-only scenarios", () => {
    for (const profile of [
      MATRIX_QA_ALL_SCENARIO_IDS,
      MATRIX_QA_FAST_SCENARIO_IDS,
      MATRIX_QA_TRANSPORT_SCENARIO_IDS,
      MATRIX_QA_MEDIA_SCENARIO_IDS,
      MATRIX_QA_E2EE_SMOKE_SCENARIO_IDS,
      MATRIX_QA_E2EE_DEEP_SCENARIO_IDS,
      MATRIX_QA_E2EE_CLI_SCENARIO_IDS,
    ]) {
      expect(new Set(profile).size).toBe(profile.length);
    }
    expect(MATRIX_QA_ALL_SCENARIO_IDS).not.toContain("matrix-room-block-streaming");
    expect(MATRIX_QA_ALL_SCENARIO_IDS).not.toContain("subagent-thread-spawn");
  });
});
