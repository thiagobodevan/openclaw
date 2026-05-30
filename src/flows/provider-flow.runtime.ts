import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as providerWizard from "../plugins/provider-wizard.js";
import type { ProviderModelPickerEntry } from "../plugins/provider-wizard.js";
import * as providersRuntime from "../plugins/providers.runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { FlowContribution } from "./types.js";
import { sortFlowContributionsByLabel } from "./types.js";

type ProviderModelPickerFlowEntry = ProviderModelPickerEntry;

type ProviderModelPickerFlowContribution = FlowContribution & {
  kind: "provider";
  surface: "model-picker";
  providerId: string;
  option: ProviderModelPickerFlowEntry;
  source: "runtime";
};

function readRecordValue(record: unknown, field: string): unknown {
  if (record === null || typeof record !== "object") {
    return undefined;
  }
  try {
    return (record as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function readStringField(record: unknown, field: string): string | undefined {
  return normalizeOptionalString(readRecordValue(record, field));
}

function copyProviderModelPickerEntry(entry: unknown): ProviderModelPickerFlowEntry | undefined {
  const value = readStringField(entry, "value");
  const label = readStringField(entry, "label");
  if (!value || !label) {
    return undefined;
  }
  const hint = readStringField(entry, "hint");
  return {
    value,
    label,
    ...(hint ? { hint } : {}),
  };
}

function resolveProviderDocsById(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Map<string, string> {
  const docsById = new Map<string, string>();
  for (const provider of providersRuntime.resolvePluginProviders({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
    mode: "setup",
  })) {
    const id = readStringField(provider, "id");
    const docsPath = readStringField(provider, "docsPath");
    if (id && docsPath) {
      docsById.set(id, docsPath);
    }
  }
  return docsById;
}

export function resolveProviderModelPickerFlowEntries(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowEntry[] {
  return resolveProviderModelPickerFlowContributions(params).map(
    (contribution) => contribution.option,
  );
}

export function resolveProviderModelPickerFlowContributions(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderModelPickerFlowContribution[] {
  const docsByProvider = resolveProviderDocsById(params ?? {});
  return sortFlowContributionsByLabel(
    providerWizard.resolveProviderModelPickerEntries(params ?? {}).flatMap((rawEntry) => {
      const entry = copyProviderModelPickerEntry(rawEntry);
      if (!entry) {
        return [];
      }
      const providerId = entry.value.startsWith("provider-plugin:")
        ? entry.value.slice("provider-plugin:".length).split(":")[0]
        : entry.value;
      return [
        {
          id: `provider:model-picker:${entry.value}`,
          kind: "provider" as const,
          surface: "model-picker" as const,
          providerId,
          option: {
            value: entry.value,
            label: entry.label,
            ...(entry.hint ? { hint: entry.hint } : {}),
            ...(docsByProvider.get(providerId)
              ? { docs: { path: docsByProvider.get(providerId)! } }
              : {}),
          },
          source: "runtime" as const,
        },
      ];
    }),
  );
}
