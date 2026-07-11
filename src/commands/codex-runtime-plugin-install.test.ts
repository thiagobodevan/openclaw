import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
}));

type MissingPluginInstallRepairCall = {
  pluginIds: string[];
  env?: NodeJS.ProcessEnv;
  acknowledgeNonClawHubInstall?: boolean;
  onNonClawHubInstall?: (request: {
    pluginId: string;
    sourceClass: "npm";
    spec: string;
  }) => boolean | Promise<boolean>;
};

function readOnlyMissingPluginInstallRepairCall(): MissingPluginInstallRepairCall {
  expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledOnce();
  const calls = mocks.repairMissingPluginInstallsForIds.mock.calls as unknown as Array<
    [MissingPluginInstallRepairCall]
  >;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected missing plugin install repair call");
  }
  return call;
}

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingPluginInstallsForIds: mocks.repairMissingPluginInstallsForIds,
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
}));

describe("Codex runtime plugin install repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [],
      warnings: [],
    });
  });

  it("does not auto-acknowledge non-ClawHub runtime plugin repairs", async () => {
    const reviewNotice = "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check";
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Repaired missing configured plugin "codex".'],
      warnings: [],
      notices: [reviewNotice],
    });

    const { repairCodexRuntimePluginInstallForModelSelection } =
      await import("./codex-runtime-plugin-install.js");
    const result = await repairCodexRuntimePluginInstallForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      env: {},
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall.pluginIds).toStrictEqual(["codex"]);
    expect(repairCall.env).toStrictEqual({});
    expect(repairCall.acknowledgeNonClawHubInstall).toBeUndefined();
    expect(result).toStrictEqual({
      required: true,
      changes: ['Repaired missing configured plugin "codex".'],
      warnings: [reviewNotice],
      failed: false,
    });
  });

  it("forwards explicit non-ClawHub acknowledgement to runtime plugin repair", async () => {
    const { repairCodexRuntimePluginInstallForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    await repairCodexRuntimePluginInstallForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      acknowledgeNonClawHubInstall: true,
    });

    expect(readOnlyMissingPluginInstallRepairCall().acknowledgeNonClawHubInstall).toBe(true);
  });

  it("reports a refused runtime plugin repair as failed", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [],
      warnings: ["Non-ClawHub acknowledgement required."],
      failedPluginIds: ["codex"],
    });
    const onNonClawHubInstall = vi.fn(async () => false);
    const { repairCodexRuntimePluginInstallForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await repairCodexRuntimePluginInstallForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      onNonClawHubInstall,
    });

    expect(readOnlyMissingPluginInstallRepairCall().onNonClawHubInstall).toBe(onNonClawHubInstall);
    expect(result).toEqual({
      required: true,
      changes: [],
      warnings: ["Non-ClawHub acknowledgement required."],
      failed: true,
    });
  });

  it.each([
    ["plugins disabled", { plugins: { enabled: false } }],
    ["denylisted", { plugins: { deny: ["codex"] } }],
    ["not allowlisted", { plugins: { allow: ["other"] } }],
  ])("does not report an existing Codex install as usable when %s", async (_label, cfg) => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      cfg,
      required: true,
      installed: false,
      status: "failed",
    });
    expect(result.reason).toBeTruthy();
  });

  it("enables an allowed existing Codex install", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["codex"],
        entries: { codex: { enabled: false } },
      },
    };
    const confirm = vi.fn(async () => true);
    mocks.repairMissingPluginInstallsForIds.mockImplementationOnce(
      async (params: MissingPluginInstallRepairCall) => {
        await params.onNonClawHubInstall?.({
          pluginId: "codex",
          sourceClass: "npm",
          spec: "@openclaw/codex",
        });
        return { changes: [], warnings: [] };
      },
    );
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      prompter: { confirm } as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      required: true,
      installed: true,
      status: "installed",
      cfg: { plugins: { entries: { codex: { enabled: true } } } },
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("@openclaw/codex"),
        initialValue: false,
      }),
    );
  });

  it("sees an agent-scoped Codex runtime pin behind a custom OpenAI route", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const cfg = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      models: {
        providers: {
          openai: { baseUrl: "https://proxy.example.test/v1", models: [] },
        },
      },
    };
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      agentId: "ops",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      required: true,
      installed: true,
      status: "installed",
    });
  });
});
