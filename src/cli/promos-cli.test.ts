// Promos CLI tests cover non-interactive claim option normalization.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPromosCli } from "./promos-cli.js";

const mocks = vi.hoisted(() => ({
  promosClaimCommand: vi.fn(),
}));

vi.mock("../commands/promos/claim.js", () => ({
  promosClaimCommand: mocks.promosClaimCommand,
}));

describe("registerPromosCli", () => {
  beforeEach(() => {
    mocks.promosClaimCommand.mockReset();
  });

  it("normalizes non-ClawHub install acknowledgement for promotion claims", async () => {
    const program = new Command().name("openclaw");
    registerPromosCli(program);

    await program.parseAsync(
      [
        "promos",
        "claim",
        "spring-models",
        "--api-key",
        "sk-test",
        "--acknowledge-non-clawhub-install",
      ],
      { from: "user" },
    );

    expect(mocks.promosClaimCommand).toHaveBeenCalledWith(
      "spring-models",
      {
        acknowledgeNonClawHubInstall: true,
        apiKey: "sk-test",
      },
      expect.any(Object),
    );
  });
});
