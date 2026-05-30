import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog.js";
import type { ProviderCatalogContext } from "./types.js";

function createProviderConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "https://default.example/v1",
    models: [],
    ...overrides,
  };
}

function createCatalogContext(params: {
  config?: OpenClawConfig;
  apiKeys?: Record<string, string | undefined>;
}): ProviderCatalogContext {
  return {
    config: params.config ?? {},
    env: {},
    resolveProviderApiKey: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
    }),
    resolveProviderAuth: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
      mode: providerId && params.apiKeys?.[providerId] ? "api_key" : "none",
      source: providerId && params.apiKeys?.[providerId] ? "env" : "none",
    }),
  };
}

function expectCatalogTemplateMatch(params: {
  entries: Parameters<typeof findCatalogTemplate>[0]["entries"];
  providerId: string;
  templateIds: readonly string[];
  expected: ReturnType<typeof findCatalogTemplate>;
}) {
  expect(
    findCatalogTemplate({
      entries: params.entries,
      providerId: params.providerId,
      templateIds: params.templateIds,
    }),
  ).toEqual(params.expected);
}

function expectPairedCatalogProviders(
  result: Awaited<ReturnType<typeof buildPairedProviderApiKeyCatalog>>,
  expected: Record<string, ModelProviderConfig & { apiKey: string }>,
) {
  expect(result).toEqual({
    providers: expected,
  });
}

function createSingleCatalogProvider(overrides: Partial<ModelProviderConfig> & { apiKey: string }) {
  return {
    provider: {
      ...createProviderConfig(overrides),
      apiKey: overrides.apiKey,
    },
  };
}

function createPairedCatalogProviders(
  apiKey: string,
  overrides: Partial<ModelProviderConfig> = {},
) {
  return {
    alpha: {
      ...createProviderConfig(overrides),
      apiKey,
    },
    beta: {
      ...createProviderConfig(overrides),
      apiKey,
    },
  };
}

async function expectSingleCatalogResult(params: {
  ctx: ProviderCatalogContext;
  providerId?: string;
  allowExplicitBaseUrl?: boolean;
  buildProvider?: () => ModelProviderConfig;
  expected: Awaited<ReturnType<typeof buildSingleProviderApiKeyCatalog>>;
}) {
  const result = await buildSingleProviderApiKeyCatalog({
    ctx: params.ctx,
    providerId: params.providerId ?? "test-provider",
    buildProvider: params.buildProvider ?? (() => createProviderConfig()),
    allowExplicitBaseUrl: params.allowExplicitBaseUrl,
  });

  expect(result).toEqual(params.expected);
}

async function expectPairedCatalogResult(params: {
  ctx: ProviderCatalogContext;
  expected: Record<string, ModelProviderConfig & { apiKey: string }>;
}) {
  const result = await buildPairedProviderApiKeyCatalog({
    ctx: params.ctx,
    providerId: "test-provider",
    buildProviders: async () => ({
      alpha: createProviderConfig(),
      beta: createProviderConfig(),
    }),
  });

  expectPairedCatalogProviders(result, params.expected);
}

describe("buildSingleProviderApiKeyCatalog", () => {
  it.each([
    {
      name: "matches provider templates case-insensitively",
      entries: [
        { provider: "Demo Provider", id: "demo-model" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "demo provider",
      templateIds: ["missing", "DEMO-MODEL"],
      expected: { provider: "Demo Provider", id: "demo-model" },
    },
    {
      name: "does not match provider templates across provider id variants",
      entries: [
        { provider: "z.ai", id: "glm-4.7" },
        { provider: "other", id: "fallback" },
      ],
      providerId: "z-ai",
      templateIds: ["GLM-4.7"],
      expected: undefined,
    },
  ] as const)("$name", ({ entries, providerId, templateIds, expected }) => {
    expectCatalogTemplateMatch({
      entries,
      providerId,
      templateIds,
      expected,
    });
  });

  it("skips unreadable catalog template rows while preserving healthy matches", () => {
    const unreadableEntry: Record<string, unknown> = {
      id: "fuzz-model",
    };
    Object.defineProperty(unreadableEntry, "provider", {
      get() {
        throw new Error("fuzzplugin catalog provider failed");
      },
    });
    const revokedEntry = Proxy.revocable(
      {
        provider: "fuzzprovider",
        id: "fuzz-model",
      },
      {},
    );
    revokedEntry.revoke();

    const healthyEntry = {
      provider: "mock provider",
      id: "mock-model",
      api: "openai-completions",
    };

    expectCatalogTemplateMatch({
      entries: [unreadableEntry as never, revokedEntry.proxy as never, healthyEntry],
      providerId: "mock provider",
      templateIds: ["missing", "mock-model"],
      expected: healthyEntry,
    });
    expect(
      findCatalogTemplate({
        entries: [unreadableEntry as never, healthyEntry],
        providerId: "mock provider",
        templateIds: ["mock-model"],
      }),
    ).toBe(healthyEntry);
  });

  it.each([
    {
      name: "returns null when api key is missing",
      ctx: createCatalogContext({}),
      expected: null,
    },
    {
      name: "adds api key to the built provider",
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      expected: createSingleCatalogProvider({
        apiKey: "secret-key",
      }),
    },
    {
      name: "prefers explicit base url when allowed",
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
        config: {
          models: {
            providers: {
              "test-provider": {
                baseUrl: " https://override.example/v1/ ",
                models: [],
              },
            },
          },
        },
      }),
      allowExplicitBaseUrl: true,
      expected: createSingleCatalogProvider({
        baseUrl: "https://override.example/v1/",
        apiKey: "secret-key",
      }),
    },
    {
      name: "matches explicit base url config for exact provider ids",
      ctx: createCatalogContext({
        apiKeys: { "z.ai": "secret-key" },
        config: {
          models: {
            providers: {
              "z.ai": {
                baseUrl: " https://api.z.ai/custom ",
                models: [],
              },
            },
          },
        },
      }),
      allowExplicitBaseUrl: true,
      expected: createSingleCatalogProvider({
        baseUrl: "https://api.z.ai/custom",
        apiKey: "secret-key",
      }),
      providerId: "z.ai",
      buildProvider: () => createProviderConfig({ baseUrl: "https://default.example/zai" }),
    },
    {
      name: "uses default base url when explicit provider keys are unreadable",
      ctx: createCatalogContext({
        apiKeys: { "mock provider": "secret-key" },
        config: {
          models: {
            providers: new Proxy(
              {
                mockprovider: {
                  baseUrl: " https://override.example/v1/ ",
                  models: [],
                },
              },
              {
                ownKeys() {
                  throw new Error("fuzzplugin provider keys failed");
                },
              },
            ),
          },
        } as OpenClawConfig,
      }),
      allowExplicitBaseUrl: true,
      expected: createSingleCatalogProvider({
        baseUrl: "https://default.example/v1",
        apiKey: "secret-key",
      }),
      providerId: "mock provider",
    },
  ] as const)(
    "$name",
    async ({ ctx, allowExplicitBaseUrl, expected, providerId, buildProvider }) => {
      await expectSingleCatalogResult({
        ctx,
        ...(providerId ? { providerId } : {}),
        allowExplicitBaseUrl,
        ...(buildProvider ? { buildProvider } : {}),
        expected,
      });
    },
  );

  it("returns null when a single provider catalog entry is unreadable", async () => {
    const unreadableProvider = new Proxy(createProviderConfig(), {
      ownKeys() {
        throw new Error("fuzzplugin single provider keys failed");
      },
    });

    await expectSingleCatalogResult({
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      buildProvider: () => unreadableProvider,
      expected: null,
    });
  });

  it("adds api key to each paired provider", async () => {
    await expectPairedCatalogResult({
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      expected: createPairedCatalogProviders("secret-key"),
    });
  });

  it("omits unreadable paired provider catalog entries", async () => {
    const unreadableProvider = new Proxy(createProviderConfig(), {
      ownKeys() {
        throw new Error("mockplugin provider config keys failed");
      },
    });
    const result = await buildPairedProviderApiKeyCatalog({
      ctx: createCatalogContext({
        apiKeys: { fuzzplugin: "secret-key" },
      }),
      providerId: "fuzzplugin",
      buildProviders: async () =>
        ({
          readable: createProviderConfig({ baseUrl: "https://fuzzplugin.test/v1" }),
          unreadable: unreadableProvider,
        }) as Record<string, ModelProviderConfig>,
    });

    expectPairedCatalogProviders(result, {
      readable: {
        ...createProviderConfig({ baseUrl: "https://fuzzplugin.test/v1" }),
        apiKey: "secret-key",
      },
    });
  });

  it("returns an empty paired provider catalog when provider keys are unreadable", async () => {
    const providers = new Proxy(
      {
        readable: createProviderConfig(),
      },
      {
        ownKeys() {
          throw new Error("fuzzplugin provider catalog keys failed");
        },
      },
    );
    const result = await buildPairedProviderApiKeyCatalog({
      ctx: createCatalogContext({
        apiKeys: { fuzzplugin: "secret-key" },
      }),
      providerId: "fuzzplugin",
      buildProviders: async () => providers,
    });

    expectPairedCatalogProviders(result, {});
  });
});
