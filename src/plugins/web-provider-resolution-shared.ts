import { resolveBundledPluginCompatibleLoadValues } from "./activation-context.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginIdScopeSet, normalizePluginIdScope } from "./plugin-scope.js";

export type WebProviderContract = "webSearchProviders" | "webFetchProviders";
export type WebProviderConfigKey = "webSearch" | "webFetch";

export type WebProviderCandidateResolution = {
  pluginIds: string[] | undefined;
  manifestRecords?: readonly PluginManifestRecord[];
};

type WebProviderSortEntry = {
  id: string;
  pluginId: string;
  autoDetectOrder?: number;
};
type RegistryProviderEntry = {
  pluginId: string;
  provider: unknown;
};

const REQUIRED_WEB_PROVIDER_METHODS = [
  "createTool",
  "getCredentialValue",
  "setCredentialValue",
] as const;
const REQUIRED_WEB_PROVIDER_STRING_FIELDS = [
  "label",
  "hint",
  "placeholder",
  "signupUrl",
  "credentialPath",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecordValue(record: unknown, key: string): unknown {
  if (!isRecord(record)) {
    return undefined;
  }
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function copyRecordKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function copyStringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  try {
    return value.every((entry) => typeof entry === "string") ? [...value] : undefined;
  } catch {
    return undefined;
  }
}

function copyProviderWithPluginId<TProvider extends { id: string }>(
  provider: TProvider,
  pluginId: string,
): (TProvider & { pluginId: string }) | undefined {
  if (!isRecord(provider)) {
    return undefined;
  }
  const id = readRecordValue(provider, "id");
  if (typeof id !== "string" || !id) {
    return undefined;
  }
  const copy: Record<string, unknown> = { id, pluginId };
  for (const key of REQUIRED_WEB_PROVIDER_STRING_FIELDS) {
    const value = readRecordValue(provider, key);
    if (typeof value !== "string") {
      return undefined;
    }
    copy[key] = value;
  }
  const envVars = copyStringArrayValue(readRecordValue(provider, "envVars"));
  if (!envVars) {
    return undefined;
  }
  copy.envVars = envVars;
  for (const key of REQUIRED_WEB_PROVIDER_METHODS) {
    const value = readRecordValue(provider, key);
    if (typeof value !== "function") {
      return undefined;
    }
    copy[key] = value;
  }
  for (const key of copyRecordKeys(provider)) {
    if (
      key === "id" ||
      key === "pluginId" ||
      key === "envVars" ||
      REQUIRED_WEB_PROVIDER_STRING_FIELDS.some((requiredKey) => requiredKey === key) ||
      REQUIRED_WEB_PROVIDER_METHODS.some((requiredKey) => requiredKey === key)
    ) {
      continue;
    }
    const value = readRecordValue(provider, key);
    if (value !== undefined) {
      copy[key] = value;
    }
  }
  return copy as TProvider & { pluginId: string };
}

function readRegistryProviderEntry(entry: unknown): RegistryProviderEntry | null {
  const rawPluginId = readRecordValue(entry, "pluginId");
  const pluginId = typeof rawPluginId === "string" ? rawPluginId.trim() : undefined;
  if (!pluginId) {
    return null;
  }
  return {
    pluginId,
    provider: readRecordValue(entry, "provider"),
  };
}

function comparePluginProvidersAlphabetically(
  left: Pick<WebProviderSortEntry, "id" | "pluginId">,
  right: Pick<WebProviderSortEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortPluginProviders<T extends Pick<WebProviderSortEntry, "id" | "pluginId">>(
  providers: T[],
): T[] {
  return providers.toSorted(comparePluginProvidersAlphabetically);
}

export function sortPluginProvidersForAutoDetect<T extends WebProviderSortEntry>(
  providers: T[],
): T[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return comparePluginProvidersAlphabetically(left, right);
  });
}

function pluginManifestDeclaresProviderConfig(
  record: PluginManifestRecord,
  configKey: WebProviderConfigKey,
  contract: WebProviderContract,
): boolean {
  const contractValues = readRecordValue(readRecordValue(record, "contracts"), contract);
  if (Array.isArray(contractValues) && contractValues.length > 0) {
    return true;
  }
  const configUiHintKeys = copyRecordKeys(readRecordValue(record, "configUiHints"));
  if (configUiHintKeys.some((key) => key === configKey || key.startsWith(`${configKey}.`))) {
    return true;
  }
  const properties = readRecordValue(readRecordValue(record, "configSchema"), "properties");
  if (!isRecord(properties)) {
    return false;
  }
  return copyRecordKeys(properties).includes(configKey);
}

function loadInstalledWebProviderManifestRecords(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  pluginIds?: readonly string[];
}): readonly PluginManifestRecord[] {
  const records = loadManifestMetadataSnapshot({
    config: params.config ?? {},
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
  }).plugins;
  const pluginIdSet = createPluginIdScopeSet(params.pluginIds);
  return pluginIdSet ? records.filter((plugin) => pluginIdSet.has(plugin.id)) : records;
}

export function resolveManifestDeclaredWebProviderCandidatePluginIds(params: {
  contract: WebProviderContract;
  configKey: WebProviderConfigKey;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  return resolveManifestDeclaredWebProviderCandidates(params).pluginIds;
}

export function resolveManifestDeclaredWebProviderCandidates(params: {
  contract: WebProviderContract;
  configKey: WebProviderConfigKey;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
  manifestRecords?: readonly PluginManifestRecord[];
}): WebProviderCandidateResolution {
  const scopedPluginIds = normalizePluginIdScope(params.onlyPluginIds);
  if (scopedPluginIds?.length === 0) {
    return { pluginIds: [] };
  }
  const onlyPluginIdSet = createPluginIdScopeSet(scopedPluginIds);
  const manifestRecords =
    params.manifestRecords ??
    loadInstalledWebProviderManifestRecords({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      pluginIds: scopedPluginIds,
    });
  const ids = manifestRecords
    .filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        pluginManifestDeclaresProviderConfig(plugin, params.configKey, params.contract),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  if (ids.length > 0) {
    return { pluginIds: ids, manifestRecords };
  }
  if (params.origin || scopedPluginIds !== undefined) {
    return { pluginIds: [], manifestRecords };
  }
  return { pluginIds: undefined, manifestRecords };
}

function resolveBundledWebProviderCompatPluginIds(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return loadInstalledWebProviderManifestRecords(params)
    .filter(
      (plugin) =>
        plugin.origin === "bundled" && (plugin.contracts?.[params.contract]?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveBundledWebProviderResolutionConfig(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): {
  config: PluginLoadOptions["config"];
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  const activation = resolveBundledPluginCompatibleLoadValues({
    rawConfig: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    applyAutoEnable: true,
    compatMode: {
      enablement: "always",
      vitest: params.config !== undefined,
    },
    resolveCompatPluginIds: (compatParams) =>
      resolveBundledWebProviderCompatPluginIds({
        contract: params.contract,
        ...compatParams,
      }),
  });

  return {
    config: activation.config,
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
  };
}

export function mapRegistryProviders<TProvider extends { id: string }>(params: {
  entries: readonly { pluginId: string; provider: TProvider }[];
  onlyPluginIds?: readonly string[];
  sortProviders: (
    providers: Array<TProvider & { pluginId: string }>,
  ) => Array<TProvider & { pluginId: string }>;
}): Array<TProvider & { pluginId: string }> {
  const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
  return params.sortProviders(
    params.entries
      .map(readRegistryProviderEntry)
      .filter((entry): entry is RegistryProviderEntry => Boolean(entry))
      .filter((entry) => !onlyPluginIdSet || onlyPluginIdSet.has(entry.pluginId))
      .flatMap((entry) => {
        const provider = copyProviderWithPluginId(entry.provider as TProvider, entry.pluginId);
        return provider ? [provider] : [];
      }),
  );
}
