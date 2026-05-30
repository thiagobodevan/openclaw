import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { ProviderPlugin, SpeechProviderPlugin } from "./types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createCatalogModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

function diagnosticSummaries(diagnostics: readonly unknown[]) {
  return diagnostics.map((entry) => {
    const diagnostic = entry as { pluginId?: string; message?: string };
    return { pluginId: diagnostic.pluginId, message: diagnostic.message };
  });
}

function createUnreadableProviderId(message: string): ProviderPlugin {
  return Object.defineProperty(
    {
      label: "Fuzz Plugin Provider",
      auth: [],
    },
    "id",
    {
      get() {
        throw new Error(message);
      },
    },
  ) as ProviderPlugin;
}

function createUnreadableSpeechProviderId(message: string): SpeechProviderPlugin {
  return Object.defineProperty(
    {
      label: "Fuzz Plugin Speech",
      defaultModel: "fuzzplugin-voice",
      models: ["fuzzplugin-voice"],
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    },
    "id",
    {
      get() {
        throw new Error(message);
      },
    },
  ) as SpeechProviderPlugin;
}

describe("plugin registry provider-like registrations", () => {
  it("captures unified model catalog provider registrations", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["text", "video_generation"],
      staticCatalog: () => [
        {
          kind: "text",
          provider: "catalog-provider",
          model: "catalog-model",
          source: "static",
        },
      ],
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogRegistration = pluginRegistry.registry.modelCatalogProviders[0];
    expect(catalogRegistration?.pluginId).toBe("catalog-owner");
    expect(catalogRegistration?.provider.provider).toBe("catalog-provider");
    expect(catalogRegistration?.provider.kinds).toEqual(["text", "video_generation"]);
  });

  it("combines same-plugin overlapping model catalog hooks", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "catalog-owner",
      name: "Catalog Owner",
      source: "/tmp/catalog-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["voice"],
      staticCatalog: () => [
        {
          kind: "voice",
          provider: "catalog-provider",
          model: "tts-model",
          source: "static",
        },
      ],
    });
    pluginRegistry.registerModelCatalogProvider(record, {
      provider: "catalog-provider",
      kinds: ["voice"],
      staticCatalog: () => [
        {
          kind: "voice",
          provider: "catalog-provider",
          model: "realtime-model",
          source: "static",
        },
      ],
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    await expect(catalogProvider?.staticCatalog?.({} as never)).resolves.toEqual([
      {
        kind: "voice",
        provider: "catalog-provider",
        model: "tts-model",
        source: "static",
      },
      {
        kind: "voice",
        provider: "catalog-provider",
        model: "realtime-model",
        source: "static",
      },
    ]);
  });

  it("rejects malformed model catalog providers without retaining plugin state", async () => {
    const pluginRegistry = createTestRegistry();
    const fuzzRecord = createPluginRecord({
      id: "fuzzplugin-model-catalog",
      name: "Fuzz Plugin Model Catalog",
      source: "/tmp/fuzzplugin-model-catalog/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const mockRecord = createPluginRecord({
      id: "mockplugin-model-catalog",
      name: "Mock Plugin Model Catalog",
      source: "/tmp/mockplugin-model-catalog/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    const unreadableProvider = Object.defineProperty({}, "provider", {
      get() {
        throw new Error("fuzzplugin model catalog provider getter failed");
      },
    });
    const revokedKinds = Proxy.revocable(["text"], {});
    revokedKinds.revoke();
    const invalidHook = {
      provider: "fuzzplugin-model-catalog-invalid-hook",
      kinds: ["text"],
      staticCatalog: true,
    };
    class MockCatalogProvider {
      #model = "mockplugin-catalog-model";
      provider = "mockplugin-model-catalog";
      kinds = ["text"];

      staticCatalog() {
        return [
          {
            kind: "text" as const,
            provider: this.provider,
            model: this.#model,
            source: "static" as const,
          },
        ];
      }
    }
    const healthyProvider = Object.defineProperty(new MockCatalogProvider(), "extraCrash", {
      enumerable: true,
      get() {
        throw new Error("mockplugin model catalog extra getter should not be enumerated");
      },
    });

    expect(() =>
      pluginRegistry.registerModelCatalogProvider(fuzzRecord, unreadableProvider as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerModelCatalogProvider(fuzzRecord, {
        provider: "fuzzplugin-model-catalog-revoked-kinds",
        kinds: revokedKinds.proxy,
      } as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerModelCatalogProvider(fuzzRecord, invalidHook as never),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerModelCatalogProvider(mockRecord, healthyProvider as never),
    ).not.toThrow();

    healthyProvider.kinds.push("voice");

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogRegistration = pluginRegistry.registry.modelCatalogProviders[0];
    expect(catalogRegistration?.pluginId).toBe("mockplugin-model-catalog");
    expect(Object.is(catalogRegistration?.provider, healthyProvider)).toBe(false);
    expect(Object.hasOwn(catalogRegistration?.provider ?? {}, "extraCrash")).toBe(false);
    expect(catalogRegistration?.provider.provider).toBe("mockplugin-model-catalog");
    expect(catalogRegistration?.provider.kinds).toEqual(["text"]);
    await expect(
      Promise.resolve(catalogRegistration?.provider.staticCatalog?.({} as never)),
    ).resolves.toEqual([
      {
        kind: "text",
        provider: "mockplugin-model-catalog",
        model: "mockplugin-catalog-model",
        source: "static",
      },
    ]);
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toEqual([
      {
        pluginId: "fuzzplugin-model-catalog",
        message: "model catalog provider registration has unreadable field: provider",
      },
      {
        pluginId: "fuzzplugin-model-catalog",
        message:
          'model catalog provider "fuzzplugin-model-catalog-revoked-kinds" registration has unreadable field: kinds',
      },
      {
        pluginId: "fuzzplugin-model-catalog",
        message:
          'model catalog provider "fuzzplugin-model-catalog-invalid-hook" registration has invalid field: staticCatalog',
      },
    ]);
  });

  it("publishes text catalog rows for registered provider catalog hooks", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "text-owner",
      name: "Text Owner",
      source: "/tmp/text-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerProvider(record, {
      id: "text-provider",
      label: "Text Provider",
      auth: [],
      catalog: {
        run: async () => ({
          provider: {
            baseUrl: "https://text.example/v1",
            models: [createCatalogModel("text-live", "Text Live")],
          },
        }),
      },
      staticCatalog: {
        run: async () => ({
          provider: {
            baseUrl: "https://text.example/v1",
            models: [createCatalogModel("text-static", "Text Static")],
          },
        }),
      },
    });

    expect(pluginRegistry.registry.providers).toHaveLength(1);
    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    expect(catalogProvider?.provider).toBe("text-provider");
    expect(catalogProvider?.kinds).toEqual(["text"]);
    await expect(catalogProvider?.staticCatalog?.({} as never)).resolves.toEqual([
      {
        kind: "text",
        provider: "text-provider",
        model: "text-static",
        label: "Text Static",
        source: "static",
      },
    ]);
    await expect(catalogProvider?.liveCatalog?.({} as never)).resolves.toEqual([
      {
        kind: "text",
        provider: "text-provider",
        model: "text-live",
        label: "Text Live",
        source: "live",
      },
    ]);
  });

  it("skips unreadable existing provider registrations during duplicate checks", () => {
    const pluginRegistry = createTestRegistry();
    const mockRecord = createPluginRecord({
      id: "mockplugin-provider-registration",
      name: "Mock Plugin Provider Registration",
      source: "/tmp/mockplugin-provider-registration/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registry.providers.push({
      pluginId: "fuzzplugin-provider-registration",
      pluginName: "Fuzz Plugin Provider Registration",
      provider: createUnreadableProviderId("fuzzplugin provider id getter failed"),
      source: "/tmp/fuzzplugin-provider-registration/index.js",
    });
    pluginRegistry.registry.speechProviders.push({
      pluginId: "fuzzplugin-speech-registration",
      pluginName: "Fuzz Plugin Speech Registration",
      provider: createUnreadableSpeechProviderId("fuzzplugin speech provider id getter failed"),
      source: "/tmp/fuzzplugin-speech-registration/index.js",
    });

    expect(() =>
      pluginRegistry.registerProvider(mockRecord, {
        id: "mockplugin-provider",
        label: "Mock Plugin Provider",
        auth: [],
      }),
    ).not.toThrow();
    expect(() =>
      pluginRegistry.registerSpeechProvider(mockRecord, {
        id: "mockplugin-speech",
        label: "Mock Plugin Speech",
        defaultModel: "mockplugin-voice",
        models: ["mockplugin-voice"],
        isConfigured: () => true,
        synthesize: async () => ({
          audioBuffer: Buffer.alloc(0),
          fileExtension: "mp3",
          outputFormat: "audio/mpeg",
          voiceCompatible: true,
        }),
      }),
    ).not.toThrow();

    expect(mockRecord.providerIds).toEqual(["mockplugin-provider"]);
    expect(mockRecord.speechProviderIds).toEqual(["mockplugin-speech"]);
    expect(pluginRegistry.registry.providers.at(-1)?.provider.id).toBe("mockplugin-provider");
    expect(pluginRegistry.registry.speechProviders.at(-1)?.provider.id).toBe("mockplugin-speech");
  });

  it("publishes synthesized media-generation catalog rows during provider registration", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "media-owner",
      name: "Media Owner",
      source: "/tmp/media-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerVideoGenerationProvider(record, {
      id: "video-provider",
      label: "Video Provider",
      defaultModel: "video-default",
      models: ["video-default", "video-pro"],
      capabilities: {
        generate: {
          supportedDurationSeconds: [4, 8],
        },
      },
      generateVideo: async () => ({
        videos: [{ buffer: Buffer.alloc(0), mimeType: "video/mp4" }],
      }),
    });

    expect(pluginRegistry.registry.videoGenerationProviders).toHaveLength(1);
    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    expect(catalogProvider?.provider).toBe("video-provider");
    expect(catalogProvider?.kinds).toEqual(["video_generation"]);
    const staticRows = await catalogProvider?.staticCatalog?.({} as never);
    expect(staticRows).toHaveLength(2);
    expect(staticRows?.[0]?.kind).toBe("video_generation");
    expect(staticRows?.[0]?.provider).toBe("video-provider");
    expect(staticRows?.[0]?.model).toBe("video-default");
    expect(staticRows?.[0]?.source).toBe("static");
    expect(staticRows?.[0]?.default).toBe(true);
    expect(staticRows?.[0]?.capabilities).toEqual({
      generate: {
        supportedDurationSeconds: [4, 8],
      },
    });
    expect(staticRows?.[1]?.kind).toBe("video_generation");
    expect(staticRows?.[1]?.provider).toBe("video-provider");
    expect(staticRows?.[1]?.model).toBe("video-pro");
    expect(staticRows?.[1]?.source).toBe("static");
  });

  it("publishes synthesized voice catalog rows during speech provider registration", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "speech-owner",
      name: "Speech Owner",
      source: "/tmp/speech-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "speech-provider",
      label: "Speech Provider",
      defaultModel: "tts-default",
      models: ["tts-default", "tts-pro"],
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });

    expect(pluginRegistry.registry.speechProviders).toHaveLength(1);
    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const catalogProvider = pluginRegistry.registry.modelCatalogProviders[0]?.provider;
    expect(catalogProvider?.provider).toBe("speech-provider");
    expect(catalogProvider?.kinds).toEqual(["voice"]);
    const staticRows = await catalogProvider?.staticCatalog?.({} as never);
    expect(staticRows).toEqual([
      {
        kind: "voice",
        provider: "speech-provider",
        model: "tts-default",
        label: "Speech Provider",
        source: "static",
        default: true,
        modes: ["tts"],
        capabilities: { tts: true },
      },
      {
        kind: "voice",
        provider: "speech-provider",
        model: "tts-pro",
        label: "Speech Provider",
        source: "static",
        modes: ["tts"],
        capabilities: { tts: true },
      },
    ]);
  });

  it("combines voice catalog rows from speech and realtime providers", async () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "voice-owner",
      name: "Voice Owner",
      source: "/tmp/voice-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "voice-provider",
      label: "Voice Provider",
      defaultModel: "tts-default",
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });
    pluginRegistry.registerRealtimeTranscriptionProvider(record, {
      id: "voice-provider",
      label: "Voice Provider",
      defaultModel: "stt-default",
      isConfigured: () => true,
      createSession: () => ({
        connect: async () => {},
        sendAudio() {},
        close() {},
        isConnected: () => true,
      }),
    });
    pluginRegistry.registerRealtimeVoiceProvider(record, {
      id: "voice-provider",
      label: "Voice Provider",
      defaultModel: "realtime-default",
      isConfigured: () => true,
      createBridge: () => ({
        connect: async () => {},
        sendAudio() {},
        setMediaTimestamp() {},
        submitToolResult() {},
        acknowledgeMark() {},
        close() {},
        isConnected: () => true,
      }),
    });

    expect(pluginRegistry.registry.modelCatalogProviders).toHaveLength(1);
    const staticRows =
      await pluginRegistry.registry.modelCatalogProviders[0]?.provider.staticCatalog?.({} as never);
    expect(staticRows?.map((row) => [row.model, row.modes, row.capabilities])).toEqual([
      ["tts-default", ["tts"], { tts: true }],
      ["stt-default", ["realtime_transcription"], { realtime_transcription: true }],
      ["realtime-default", ["realtime_voice"], { realtime_voice: true }],
    ]);
  });

  it("does not duplicate manifest-declared capability provider ids during runtime registration", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      contracts: {
        speechProviders: ["kitchen-sink-speech-provider"],
      },
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "kitchen-sink-speech-provider",
      label: "Kitchen Sink Speech",
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });

    expect(record.speechProviderIds).toEqual(["kitchen-sink-speech-provider"]);
    expect(pluginRegistry.registry.speechProviders).toHaveLength(1);
  });

  it("preserves provider instances while guarding provider-like ids", async () => {
    class StatefulSpeechProvider {
      #calls = 0;
      id = "stateful-speech-provider";
      label = "Stateful Speech";

      isConfigured() {
        return true;
      }

      async synthesize() {
        this.#calls += 1;
        return {
          audioBuffer: Buffer.alloc(0),
          fileExtension: "mp3",
          outputFormat: "audio/mpeg",
          voiceCompatible: true,
        };
      }

      get calls() {
        return this.#calls;
      }
    }
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "stateful-provider-owner",
      name: "Stateful Provider Owner",
      source: "/tmp/stateful-provider-owner/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const provider = new StatefulSpeechProvider();

    pluginRegistry.registerSpeechProvider(record, provider);

    const storedProvider = pluginRegistry.registry.speechProviders[0]?.provider;
    expect(storedProvider).toBe(provider);
    await expect(storedProvider?.synthesize({} as never)).resolves.toEqual({
      audioBuffer: Buffer.alloc(0),
      fileExtension: "mp3",
      outputFormat: "audio/mpeg",
      voiceCompatible: true,
    });
    expect(provider.calls).toBe(1);
  });

  it("rejects unreadable provider-like ids without aborting sibling providers", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "fuzzplugin-provider",
      name: "Fuzz Plugin Provider",
      source: "/tmp/fuzzplugin-provider/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const provider = {
      label: "Broken Speech Provider",
      isConfigured: () => true,
      get id() {
        throw new Error("fuzzplugin provider id getter failed");
      },
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    } as never;

    pluginRegistry.registerSpeechProvider(record, provider);
    pluginRegistry.registerSpeechProvider(record, {
      id: "mockplugin-speech-provider",
      label: "Mock Plugin Speech",
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });

    expect(record.speechProviderIds).toEqual(["mockplugin-speech-provider"]);
    expect(pluginRegistry.registry.speechProviders.map((entry) => entry.provider.id)).toEqual([
      "mockplugin-speech-provider",
    ]);
    expect(diagnosticSummaries(pluginRegistry.registry.diagnostics)).toContainEqual({
      pluginId: "fuzzplugin-provider",
      message: "speech provider registration has unreadable field: id",
    });
  });
});
