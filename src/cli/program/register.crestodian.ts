// Crestodian command registration: setup/repair assistant entrypoint exposed from the root CLI.
import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { runCrestodian } from "../../crestodian/crestodian.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { NON_CLAWHUB_INSTALL_ACK_FLAG } from "../non-clawhub-install-acknowledgement.js";

function normalizeNonClawHubInstallAcknowledgement(opts: {
  acknowledgeNonClawHubInstall?: boolean;
  acknowledgeNonClawhubInstall?: boolean;
}): boolean {
  return opts.acknowledgeNonClawHubInstall === true || opts.acknowledgeNonClawhubInstall === true;
}

/** Register the Crestodian helper command and its one-shot request flags. */
export function registerCrestodianCommand(program: Command) {
  program
    .command("crestodian")
    .description("Open the ring-zero setup and repair helper")
    .option("-m, --message <text>", "Run one Crestodian request")
    .option("--yes", "Approve persistent config writes for this request", false)
    .option(
      NON_CLAWHUB_INSTALL_ACK_FLAG,
      "Acknowledge plugin install sources outside ClawHub review",
      false,
    )
    .option("--json", "Output startup overview as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw", "Start Crestodian."],
          ["openclaw crestodian", "Start Crestodian explicitly."],
          ['openclaw crestodian -m "status"', "Run one status request."],
          [
            'openclaw crestodian -m "set default model openai/gpt-5.2" --yes',
            "Apply a typed config write.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runCrestodian({
          message: opts.message as string | undefined,
          yes: Boolean(opts.yes),
          acknowledgeNonClawHubInstall: normalizeNonClawHubInstallAcknowledgement(opts),
          json: Boolean(opts.json),
        });
      });
    });
}
