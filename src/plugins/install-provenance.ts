// Shared policy and messaging for installs outside OpenClaw's trusted plugin sources.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";

export const NON_CLAWHUB_INSTALL_ACK_FLAG = "--acknowledge-non-clawhub-install";

export type NonClawHubInstallSourceClass =
  | "git"
  | "local-archive"
  | "local-path"
  | "marketplace"
  | "npm"
  | "npm-pack";

const sourceClassLabels: Record<NonClawHubInstallSourceClass, string> = {
  git: "Git repository",
  "local-archive": "local archive",
  "local-path": "local path",
  marketplace: "marketplace source",
  npm: "npm registry",
  "npm-pack": "local npm-pack archive",
};

export function formatNonClawHubInstallWarning(params: {
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): string {
  const sourceLabel = sourceClassLabels[params.sourceClass];
  const spec = sanitizeTerminalText(params.spec);
  return [
    `WARNING - Installing plugin from ${sourceLabel}: ${spec}`,
    "This source is outside ClawHub review and trust metadata. Only continue if you trust the publisher, package contents, and install source.",
  ].join("\n");
}
