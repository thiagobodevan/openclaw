import { describe, expect, it } from "vitest";
import { normalizeSetupPlannerValue } from "./setup-app.ts";

describe("setup planner value validation", () => {
  it("maps a displayed option label to its typed value", () => {
    expect(
      normalizeSetupPlannerValue(
        {
          type: "select",
          options: [{ value: "quickstart", label: "QuickStart" }],
        },
        "quickstart",
      ),
    ).toEqual({ ok: true, value: "quickstart" });
    expect(
      normalizeSetupPlannerValue(
        {
          type: "select",
          options: [{ value: "quickstart", label: "QuickStart" }],
        },
        "QuickStart",
      ),
    ).toEqual({ ok: true, value: "quickstart" });
  });

  it("rejects values outside select and multiselect options", () => {
    expect(
      normalizeSetupPlannerValue(
        {
          type: "select",
          options: [{ value: "quickstart", label: "QuickStart" }],
        },
        "manual",
      ),
    ).toEqual({ ok: false });
    expect(
      normalizeSetupPlannerValue(
        {
          type: "multiselect",
          options: [{ value: "discord", label: "Discord" }],
        },
        ["discord", "shell"],
      ),
    ).toEqual({ ok: false });
  });

  it("keeps typed booleans and rejects mismatched confirm values", () => {
    expect(normalizeSetupPlannerValue({ type: "confirm" }, true)).toEqual({
      ok: true,
      value: true,
    });
    expect(normalizeSetupPlannerValue({ type: "confirm" }, "yes")).toEqual({ ok: false });
  });
});
