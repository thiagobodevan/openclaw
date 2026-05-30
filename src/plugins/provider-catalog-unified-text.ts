import type { ModelProviderConfig } from "../config/types.models.js";
import type { UnifiedModelCatalogEntry } from "../model-catalog/types.js";
import type { ProviderCatalogResult } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function copyArrayEntries(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(value[index]);
    } catch {
      return [];
    }
  }
  return entries;
}

function copyProviderCatalogEntries(value: unknown): Array<[string, ModelProviderConfig]> {
  if (!isRecord(value)) {
    return [];
  }
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, ModelProviderConfig]> = [];
  for (const key of keys) {
    const providerConfig = readRecordValue(value, key);
    if (isRecord(providerConfig)) {
      entries.push([key, providerConfig as ModelProviderConfig]);
    }
  }
  return entries;
}

function copyProviderCatalogResultEntries(params: {
  providerId: string;
  result: ProviderCatalogResult;
}): Array<[string, ModelProviderConfig]> {
  const provider = readRecordValue(params.result, "provider");
  if (isRecord(provider)) {
    return [[params.providerId, provider as ModelProviderConfig]];
  }
  return copyProviderCatalogEntries(readRecordValue(params.result, "providers"));
}

function copyProviderModels(providerConfig: ModelProviderConfig): ModelProviderConfig["models"] {
  return copyArrayEntries(readRecordValue(providerConfig, "models")).filter(
    (entry): entry is ModelProviderConfig["models"][number] => isRecord(entry),
  );
}

export function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  const rows: UnifiedModelCatalogEntry[] = [];
  for (const [providerId, providerConfig] of copyProviderCatalogResultEntries(params)) {
    for (const model of copyProviderModels(providerConfig)) {
      const modelId = readRecordValue(model, "id");
      if (typeof modelId !== "string") {
        continue;
      }
      const modelName = readRecordValue(model, "name");
      rows.push({
        kind: "text",
        provider: providerId,
        model: modelId,
        ...(typeof modelName === "string" && modelName ? { label: modelName } : {}),
        source: params.source,
      });
    }
  }
  return rows;
}
