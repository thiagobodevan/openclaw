import { normalizeProviderId } from "../agents/provider-id.js";
import type { ModelProviderConfig } from "../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveConfiguredProviderConfig } from "./provider-config-owner.js";
import type { ProviderCatalogContext, ProviderCatalogResult } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return [];
  }
  if (!isArray) {
    return [];
  }
  const arrayValue = value as readonly unknown[];
  let length: number;
  try {
    length = arrayValue.length;
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      entries.push(arrayValue[index]);
    } catch {
      continue;
    }
  }
  return entries;
}

function copyProviderEntries(value: unknown): Array<[string, ModelProviderConfig]> {
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
    try {
      const provider = readRecordValue(value, key);
      if (isRecord(provider)) {
        entries.push([key, provider as ModelProviderConfig]);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function addApiKeyToProvider(
  provider: ModelProviderConfig,
  apiKey: string,
): (ModelProviderConfig & { apiKey: string }) | undefined {
  try {
    return { ...provider, apiKey };
  } catch {
    return undefined;
  }
}

function addBaseUrlAndApiKeyToProvider(
  provider: ModelProviderConfig,
  apiKey: string,
  explicitBaseUrl: string,
): (ModelProviderConfig & { apiKey: string }) | undefined {
  try {
    return {
      ...provider,
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      apiKey,
    };
  } catch {
    return undefined;
  }
}

function readCatalogTemplateEntry(entry: unknown):
  | {
      provider: string;
      id: string;
      entry: { provider: string; id: string };
    }
  | undefined {
  const provider = readRecordValue(entry, "provider");
  const id = readRecordValue(entry, "id");
  if (typeof provider !== "string" || typeof id !== "string") {
    return undefined;
  }
  return { provider, id, entry: entry as { provider: string; id: string } };
}

export function findCatalogTemplate(params: {
  entries: ReadonlyArray<{ provider: string; id: string }>;
  providerId: string;
  templateIds: readonly string[];
}) {
  const normalizedProviderId = normalizeProviderId(params.providerId);
  for (const templateId of copyArrayEntries(params.templateIds)) {
    if (typeof templateId !== "string") {
      continue;
    }
    const normalizedTemplateId = normalizeLowercaseStringOrEmpty(templateId);
    const match = copyArrayEntries(params.entries)
      .map(readCatalogTemplateEntry)
      .find(
        (entry) =>
          entry &&
          normalizeProviderId(entry.provider) === normalizedProviderId &&
          normalizeLowercaseStringOrEmpty(entry.id) === normalizedTemplateId,
      );
    if (match) {
      return match.entry;
    }
  }
  return undefined;
}

export async function buildSingleProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
}): Promise<ProviderCatalogResult> {
  const providerId = normalizeProviderId(params.providerId);
  const apiKey = params.ctx.resolveProviderApiKey(providerId).apiKey;
  if (!apiKey) {
    return null;
  }

  const explicitProvider = params.allowExplicitBaseUrl
    ? resolveConfiguredProviderConfig({ provider: providerId, config: params.ctx.config })
    : undefined;
  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl) ?? "";

  const provider = addBaseUrlAndApiKeyToProvider(
    await params.buildProvider(),
    apiKey,
    explicitBaseUrl,
  );
  return provider ? { provider } : null;
}

export async function buildPairedProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProviders: () =>
    | Record<string, ModelProviderConfig>
    | Promise<Record<string, ModelProviderConfig>>;
}): Promise<ProviderCatalogResult> {
  const apiKey = params.ctx.resolveProviderApiKey(normalizeProviderId(params.providerId)).apiKey;
  if (!apiKey) {
    return null;
  }

  const providers = await params.buildProviders();
  return {
    providers: Object.fromEntries(
      copyProviderEntries(providers).flatMap(([id, provider]) => {
        const providerWithApiKey = addApiKeyToProvider(provider, apiKey);
        return providerWithApiKey ? [[id, providerWithApiKey]] : [];
      }),
    ),
  };
}
