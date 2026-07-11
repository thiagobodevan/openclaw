/** Command for setting the default text model. */
import {
  confirmNonClawHubInstall,
  type NonClawHubInstallAcknowledgementRequest,
} from "../../cli/non-clawhub-install-acknowledgement.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { repairCodexRuntimePluginInstallForModelSelection } from "../codex-runtime-plugin-install.js";
import { repairCopilotRuntimePluginInstallForModelSelection } from "../copilot-runtime-plugin-install.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";

export type ModelsSetOptions = {
  acknowledgeNonClawHubInstall?: boolean;
};

/** Sets agents.defaults.model.primary and repairs provider runtime plugin installs when needed. */
export async function modelsSetCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
  opts: ModelsSetOptions = {},
) {
  let selectedModel = modelRaw;
  await updateConfig(async (cfg, context) => {
    const next = applyDefaultModelPrimaryUpdate({
      cfg,
      resolveCfg: context.runtimeConfig,
      modelRaw,
      field: "model",
    });
    selectedModel = resolveAgentModelPrimaryValue(next.agents?.defaults?.model) ?? modelRaw;
    const onNonClawHubInstall = ({ sourceClass, spec }: NonClawHubInstallAcknowledgementRequest) =>
      confirmNonClawHubInstall({ runtime, sourceClass, spec });
    const acknowledgement =
      opts.acknowledgeNonClawHubInstall === true
        ? { acknowledgeNonClawHubInstall: true as const }
        : { onNonClawHubInstall };
    const repaired = await repairCodexRuntimePluginInstallForModelSelection({
      cfg: next,
      model: selectedModel,
      ...acknowledgement,
    });
    const copilotRepaired = await repairCopilotRuntimePluginInstallForModelSelection({
      cfg: next,
      model: selectedModel,
      ...acknowledgement,
    });
    for (const warning of [...repaired.warnings, ...copilotRepaired.warnings]) {
      runtime.error?.(warning);
    }
    if (repaired.failed || copilotRepaired.failed) {
      throw new Error(
        `Default model was not changed because the required runtime plugin was not installed for ${selectedModel}.`,
      );
    }
    return next;
  });

  logConfigUpdated(runtime);
  runtime.log(`Default model: ${selectedModel}`);
}
