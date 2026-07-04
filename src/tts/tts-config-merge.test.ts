import { describe, expect, it } from "vitest";
import { mergeTtsConfigValues } from "./tts-config-merge.js";

describe("mergeTtsConfigValues", () => {
  it("deep merges nested objects and preserves base values for undefined overrides", () => {
    expect(
      mergeTtsConfigValues(
        {
          provider: { voice: "alloy", language: "en" },
          enabled: true,
        },
        {
          provider: { voice: "echo", language: undefined },
          enabled: undefined,
        },
      ),
    ).toEqual({
      provider: { voice: "echo", language: "en" },
      enabled: true,
    });
  });

  it("replaces arrays and blocks dangerous prototype keys", () => {
    const override = JSON.parse(
      '{"safe":{"next":true},"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}',
    ) as Record<string, unknown>;

    expect(mergeTtsConfigValues(["a"], ["b"])).toEqual(["b"]);
    expect(mergeTtsConfigValues("base", undefined)).toBe("base");
    expect(mergeTtsConfigValues({ safe: { keep: true } }, override)).toEqual({
      safe: { keep: true, next: true },
    });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
