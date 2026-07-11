import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { RuntimeEnv } from "../runtime.js";
import { promptYesNo } from "./prompt.js";

export const NON_CLAWHUB_INSTALL_ACK_FLAG = "--acknowledge-non-clawhub-install";

export type NonClawHubInstallSourceClass =
  | "git"
  | "local-archive"
  | "local-path"
  | "marketplace"
  | "npm"
  | "npm-pack";

export type NonClawHubInstallAcknowledgementOptions = {
  acknowledgeNonClawHubInstall?: boolean;
};

export type NonClawHubInstallAcknowledgementRequest = {
  pluginId: string;
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
};

const sourceClassLabels: Record<NonClawHubInstallSourceClass, string> = {
  git: "Git repository",
  "local-archive": "local archive",
  "local-path": "local path",
  marketplace: "marketplace source",
  npm: "npm registry",
  "npm-pack": "local npm-pack archive",
};

function canPromptForNonClawHubInstall(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function formatSourceClass(sourceClass: NonClawHubInstallSourceClass): string {
  return sourceClassLabels[sourceClass];
}

export function formatNonClawHubInstallWarning(params: {
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): string {
  const sourceLabel = formatSourceClass(params.sourceClass);
  const spec = sanitizeTerminalText(params.spec);
  return [
    `WARNING - Installing plugin from ${sourceLabel}: ${spec}`,
    "This source is outside ClawHub review and trust metadata. Only continue if you trust the publisher, package contents, and install source.",
  ].join("\n");
}

export async function confirmNonClawHubInstall(params: {
  acknowledged?: boolean;
  runtime: RuntimeEnv;
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): Promise<boolean> {
  const warning = formatNonClawHubInstallWarning({
    sourceClass: params.sourceClass,
    spec: params.spec,
  });
  if (params.acknowledged) {
    params.runtime.log(theme.warn(warning));
    return true;
  }
  if (canPromptForNonClawHubInstall()) {
    params.runtime.log(theme.warn(warning));
    return await promptYesNo("Install this non-ClawHub plugin source?");
  }
  params.runtime.error(
    `${warning}\nInstall cancelled; rerun with ${NON_CLAWHUB_INSTALL_ACK_FLAG} after reviewing the source.`,
  );
  return false;
}
