import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(),
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: (...args: unknown[]) => mocks.loadPluginRegistrySnapshot(...args),
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForInstalledIndex({
      ...(args[0] && typeof args[0] === "object" ? args[0] : {}),
      index: mocks.loadPluginRegistrySnapshot(...args),
    }),
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForInstalledIndex(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.loadPluginMetadataSnapshot(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) =>
    mocks.resolvePluginMetadataSnapshot(...args),
}));

let resolveManifestDeclaredWebProviderCandidatePluginIds: typeof import("./web-provider-resolution-shared.js").resolveManifestDeclaredWebProviderCandidatePluginIds;
let mapRegistryProviders: typeof import("./web-provider-resolution-shared.js").mapRegistryProviders;
let sortPluginProviders: typeof import("./web-provider-resolution-shared.js").sortPluginProviders;

function createMockWebProvider() {
  return {
    id: "mockprovider",
    label: "Mock Provider",
    hint: "Mock web provider",
    envVars: ["MOCK_API_KEY"],
    placeholder: "mock-api-key",
    signupUrl: "https://example.invalid/mockplugin",
    credentialPath: "tools.web.search.apiKey",
    createTool: vi.fn(() => null),
    getCredentialValue: vi.fn(),
    setCredentialValue: vi.fn(),
  };
}

describe("resolveManifestDeclaredWebProviderCandidatePluginIds", () => {
  beforeAll(async () => {
    ({
      mapRegistryProviders,
      resolveManifestDeclaredWebProviderCandidatePluginIds,
      sortPluginProviders,
    } = await import("./web-provider-resolution-shared.js"));
  });

  beforeEach(() => {
    mocks.loadPluginRegistrySnapshot.mockReset();
    mocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "bundled",
          configSchema: {
            properties: {
              webSearch: {},
            },
          },
        },
        {
          id: "beta",
          origin: "bundled",
          contracts: {
            webSearchProviders: ["beta-search"],
          },
        },
      ],
      diagnostics: [],
    });
    mocks.loadPluginMetadataSnapshot.mockReset();
    mocks.loadPluginMetadataSnapshot.mockImplementation((...args: unknown[]) => ({
      plugins: mocks.loadPluginManifestRegistryForInstalledIndex(...args).plugins,
    }));
    mocks.resolvePluginMetadataSnapshot.mockReset();
    mocks.resolvePluginMetadataSnapshot.mockImplementation((...args: unknown[]) => ({
      plugins: mocks.loadPluginManifestRegistryForInstalledIndex(...args).plugins,
    }));
  });

  it("treats explicit empty plugin scopes as scoped-empty", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: [],
      }),
    ).toStrictEqual([]);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("keeps scoped plugins with no declared web candidates scoped-empty", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        onlyPluginIds: ["missing-plugin"],
      }),
    ).toStrictEqual([]);
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps origin filters with no declared web candidates scoped-empty", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "workspace-tool",
          origin: "workspace",
          configSchema: {
            properties: {},
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        origin: "bundled",
      }),
    ).toStrictEqual([]);
  });

  it("derives provider candidates from a single manifest-registry read", () => {
    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
      }),
    ).toEqual(["alpha", "beta"]);
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledTimes(1);
  });

  it("skips unreadable web provider manifest config metadata", () => {
    mocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "fuzzplugin",
          origin: "bundled",
          configUiHints: new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("fuzzplugin web hint keys failed");
              },
            },
          ),
          configSchema: {
            properties: new Proxy(
              {},
              {
                ownKeys() {
                  throw new Error("mockplugin web schema keys failed");
                },
              },
            ),
          },
        },
        {
          id: "mockplugin",
          origin: "bundled",
          contracts: {
            webSearchProviders: ["mocksearch"],
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
      }),
    ).toEqual(["mockplugin"]);
  });

  it("skips unreadable optional web provider metadata while preserving required fields", () => {
    const target = createMockWebProvider();
    const { createTool, getCredentialValue, setCredentialValue } = target;
    const provider = new Proxy(target, {
      get(target, key, receiver) {
        if (key === "docsUrl") {
          throw new Error("mockplugin web provider docsUrl failed");
        }
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true };
      },
      ownKeys() {
        return [...Reflect.ownKeys(target), "docsUrl"];
      },
    });

    expect(
      mapRegistryProviders({
        entries: [{ pluginId: "fuzzplugin", provider }],
        sortProviders: sortPluginProviders,
      }),
    ).toEqual([
      {
        id: "mockprovider",
        pluginId: "fuzzplugin",
        label: "Mock Provider",
        hint: "Mock web provider",
        envVars: ["MOCK_API_KEY"],
        placeholder: "mock-api-key",
        signupUrl: "https://example.invalid/mockplugin",
        credentialPath: "tools.web.search.apiKey",
        createTool,
        getCredentialValue,
        setCredentialValue,
      },
    ]);
  });

  it("skips unreadable web provider registry entries while preserving healthy providers", () => {
    const target = createMockWebProvider();
    const { createTool, getCredentialValue, setCredentialValue } = target;
    const unreadableEntry = {};
    Object.defineProperty(unreadableEntry, "pluginId", {
      get() {
        throw new Error("fuzzplugin web provider pluginId failed");
      },
    });

    expect(
      mapRegistryProviders({
        entries: [
          unreadableEntry as never,
          {
            pluginId: "mockplugin",
            provider: target,
          },
        ],
        onlyPluginIds: ["mockplugin"],
        sortProviders: sortPluginProviders,
      }),
    ).toEqual([
      {
        id: "mockprovider",
        pluginId: "mockplugin",
        label: "Mock Provider",
        hint: "Mock web provider",
        envVars: ["MOCK_API_KEY"],
        placeholder: "mock-api-key",
        signupUrl: "https://example.invalid/mockplugin",
        credentialPath: "tools.web.search.apiKey",
        createTool,
        getCredentialValue,
        setCredentialValue,
      },
    ]);
  });

  it("skips web providers with unreadable required runtime methods", () => {
    const target = createMockWebProvider();
    const provider = new Proxy(target, {
      get(target, key, receiver) {
        if (key === "createTool") {
          throw new Error("fuzzplugin web provider createTool failed");
        }
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true };
      },
      ownKeys() {
        return Reflect.ownKeys(target);
      },
    });

    expect(
      mapRegistryProviders({
        entries: [{ pluginId: "fuzzplugin", provider }],
        sortProviders: sortPluginProviders,
      }),
    ).toEqual([]);
  });
});
