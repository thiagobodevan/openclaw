// Voice Call tests cover runtime plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  resolveVoiceCallConfig: vi.fn(),
  resolveTwilioAuthToken: vi.fn(),
  validateProviderConfig: vi.fn(),
  managerInitialize: vi.fn(),
  managerGetCall: vi.fn(),
  webhookStart: vi.fn(),
  webhookStop: vi.fn(),
  webhookSetRealtimeHandler: vi.fn(),
  webhookGetRealtimeHandler: vi.fn(),
  webhookGetMediaStreamHandler: vi.fn(),
  webhookCtorArgs: [] as unknown[][],
  realtimeHandlerCtorArgs: [] as unknown[][],
  realtimeHandlerRegisterToolHandler: vi.fn(),
  realtimeHandlerSetPublicUrl: vi.fn(),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  resolveRealtimeFastContextConsult: vi.fn(),
  startTunnel: vi.fn(),
  setupTailscaleExposure: vi.fn(),
  cleanupTailscaleExposure: vi.fn(),
}));

vi.mock("./config.js", () => ({
  resolveVoiceCallSessionKey: (params: {
    config: Pick<VoiceCallConfig, "agentId" | "sessionScope">;
    callId: string;
    phone?: string;
    explicitSessionKey?: string;
  }) => {
    const explicit = params.explicitSessionKey?.trim();
    if (explicit) {
      const lower = explicit.toLowerCase();
      return lower === "global" || lower === "unknown" || lower.startsWith("agent:")
        ? explicit
        : `agent:${params.config.agentId?.trim().toLowerCase() || "main"}:${explicit}`;
    }
    const agentId = params.config.agentId?.trim().toLowerCase() || "main";
    const prefix = `agent:${agentId}:voice`;
    if (params.config.sessionScope === "per-call") {
      return `${prefix}:call:${params.callId}`.toLowerCase();
    }
    const normalizedPhone = params.phone?.replace(/\D/g, "");
    return (
      normalizedPhone ? `${prefix}:${normalizedPhone}` : `${prefix}:${params.callId}`
    ).toLowerCase();
  },
  resolveVoiceCallNumberRouteKeyForCall: (call: {
    direction?: "inbound" | "outbound";
    to?: string;
    metadata?: { numberRouteKey?: unknown };
  }) =>
    call.direction === "inbound"
      ? typeof call.metadata?.numberRouteKey === "string"
        ? call.metadata.numberRouteKey
        : call.to
      : undefined,
  resolveVoiceCallEffectiveConfig: (config: VoiceCallConfig, numberRouteKey?: string) => {
    const route = numberRouteKey ? config.numbers[numberRouteKey] : undefined;
    return route ? { config: { ...config, ...route }, numberRouteKey } : { config };
  },
  resolveVoiceCallConfig: mocks.resolveVoiceCallConfig,
  resolveTwilioAuthToken: mocks.resolveTwilioAuthToken,
  validateProviderConfig: mocks.validateProviderConfig,
}));

vi.mock("./manager.js", () => ({
  CallManager: class {
    initialize = mocks.managerInitialize;
    getCall = mocks.managerGetCall;
  },
}));

vi.mock("./webhook.js", () => ({
  VoiceCallWebhookServer: class {
    constructor(...args: unknown[]) {
      mocks.webhookCtorArgs.push(args);
    }
    start = mocks.webhookStart;
    stop = mocks.webhookStop;
    setRealtimeHandler = mocks.webhookSetRealtimeHandler;
    getRealtimeHandler = mocks.webhookGetRealtimeHandler;
    getMediaStreamHandler = mocks.webhookGetMediaStreamHandler;
  },
}));

vi.mock("./realtime-voice.runtime.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
}));

vi.mock("./realtime-fast-context.js", () => ({
  resolveRealtimeFastContextConsult: mocks.resolveRealtimeFastContextConsult,
}));

vi.mock("./webhook/realtime-handler.js", () => ({
  RealtimeCallHandler: class {
    constructor(...args: unknown[]) {
      mocks.realtimeHandlerCtorArgs.push(args);
    }
    registerToolHandler = mocks.realtimeHandlerRegisterToolHandler;
    setPublicUrl = mocks.realtimeHandlerSetPublicUrl;
  },
}));

vi.mock("./tunnel.js", () => ({
  startTunnel: mocks.startTunnel,
}));

vi.mock("./webhook/tailscale.js", () => ({
  setupTailscaleExposure: mocks.setupTailscaleExposure,
  cleanupTailscaleExposure: mocks.cleanupTailscaleExposure,
}));

import { createVoiceCallRuntime } from "./runtime.js";

function createBaseConfig(): VoiceCallConfig {
  return createVoiceCallBaseConfig({ tunnelProvider: "ngrok" });
}

function createExternalProviderConfig(params: {
  provider: "twilio" | "telnyx" | "plivo";
  publicUrl?: string;
}): VoiceCallConfig {
  const config = createVoiceCallBaseConfig({
    provider: params.provider,
    tunnelProvider: "none",
  });
  config.twilio = {
    accountSid: "AC123",
    authToken: "secret",
  };
  config.telnyx = {
    apiKey: "key",
    connectionId: "conn",
    publicKey: "pub",
  };
  config.plivo = {
    authId: "MA123",
    authToken: "secret",
  };
  if (params.publicUrl) {
    config.publicUrl = params.publicUrl;
  }
  return config;
}

type RealtimeConsultToolHandler = (
  args: unknown,
  callId: string,
  context?: { partialUserTranscript?: string },
) => Promise<unknown>;

function firstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function firstCallParam(calls: readonly unknown[][], label: string) {
  const call = firstMockCall(calls, label);
  return call[0];
}

type MockSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  [key: string]: unknown;
};

function createMockSessionRuntime(sessionStore: Record<string, unknown>) {
  return {
    resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
    loadSessionStore: vi.fn(() => sessionStore),
    saveSessionStore: vi.fn(async () => {}),
    updateSessionStore: vi.fn(async (_storePath, mutator: (store: never) => unknown) =>
      mutator(sessionStore as never),
    ),
    getSessionEntry: vi.fn(
      ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey] as MockSessionEntry,
    ),
    patchSessionEntry: vi.fn(
      async ({
        sessionKey,
        fallbackEntry,
        update,
      }: {
        sessionKey: string;
        fallbackEntry: MockSessionEntry;
        update: (entry: MockSessionEntry) => Promise<MockSessionEntry> | MockSessionEntry;
      }) => {
        const current = (sessionStore[sessionKey] as MockSessionEntry | undefined) ?? fallbackEntry;
        const patch = await update(current);
        const next = { ...current, ...patch };
        sessionStore[sessionKey] = next;
        return next;
      },
    ),
    resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireRealtimeConsultToolHandler(): RealtimeConsultToolHandler {
  const registeredToolHandler = firstMockCall(
    mocks.realtimeHandlerRegisterToolHandler.mock.calls,
    "realtime tool handler registration",
  );
  expect(registeredToolHandler[0]).toBe("openclaw_agent_consult");
  if (typeof registeredToolHandler[1] !== "function") {
    throw new Error("expected realtime tool handler callback");
  }
  return registeredToolHandler[1] as RealtimeConsultToolHandler;
}

describe("createVoiceCallRuntime lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVoiceCallConfig.mockImplementation((cfg: VoiceCallConfig) => cfg);
    mocks.resolveTwilioAuthToken.mockImplementation(
      (cfg: VoiceCallConfig) => cfg.twilio?.authToken,
    );
    mocks.validateProviderConfig.mockReturnValue({ valid: true, errors: [] });
    mocks.managerInitialize.mockResolvedValue(undefined);
    mocks.managerGetCall.mockReset();
    mocks.webhookStart.mockResolvedValue("http://127.0.0.1:3334/voice/webhook");
    mocks.webhookStop.mockResolvedValue(undefined);
    mocks.webhookSetRealtimeHandler.mockReset();
    mocks.webhookGetRealtimeHandler.mockReturnValue({
      setPublicUrl: mocks.realtimeHandlerSetPublicUrl,
    });
    mocks.webhookGetMediaStreamHandler.mockReturnValue(undefined);
    mocks.webhookCtorArgs.length = 0;
    mocks.realtimeHandlerCtorArgs.length = 0;
    mocks.realtimeHandlerRegisterToolHandler.mockReset();
    mocks.realtimeHandlerSetPublicUrl.mockReset();
    mocks.resolveConfiguredRealtimeVoiceProvider.mockResolvedValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-realtime" },
    });
    mocks.resolveRealtimeFastContextConsult.mockReset();
    mocks.resolveRealtimeFastContextConsult.mockResolvedValue({ handled: false });
    mocks.startTunnel.mockResolvedValue(null);
    mocks.setupTailscaleExposure.mockResolvedValue(null);
    mocks.cleanupTailscaleExposure.mockResolvedValue(undefined);
  });

  it("cleans up tunnel, tailscale, and webhook server when init fails after start", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      provider: "ngrok",
      stop: tunnelStop,
    });
    mocks.managerInitialize.mockRejectedValue(new Error("init failed"));

    await expect(
      createVoiceCallRuntime({
        config: createBaseConfig(),
        coreConfig: {},
        agentRuntime: {} as never,
      }),
    ).rejects.toThrow("init failed");

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("returns an idempotent stop handler", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      provider: "ngrok",
      stop: tunnelStop,
    });

    const runtime = await createVoiceCallRuntime({
      config: createBaseConfig(),
      coreConfig: {} as CoreConfig,
      agentRuntime: {} as never,
    });

    await runtime.stop();
    await runtime.stop();

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("passes fullConfig to the webhook server for streaming provider resolution", async () => {
    const coreConfig = { messages: { tts: { provider: "openai" } } } as CoreConfig;
    const fullConfig = {
      plugins: {
        entries: {
          openai: { enabled: true },
        },
      },
    } as OpenClawConfig;

    await createVoiceCallRuntime({
      config: createBaseConfig(),
      coreConfig,
      fullConfig,
      agentRuntime: {} as never,
    });

    expect(mocks.webhookCtorArgs[0]?.[3]).toBe(coreConfig);
    expect(mocks.webhookCtorArgs[0]?.[4]).toBe(fullConfig);
  });

  it.each(["twilio", "telnyx", "plivo"] as const)(
    "fails closed when %s falls back to a local-only webhook",
    async (provider) => {
      await expect(
        createVoiceCallRuntime({
          config: createExternalProviderConfig({ provider }),
          coreConfig: {} as CoreConfig,
          agentRuntime: {} as never,
        }),
      ).rejects.toThrow(`${provider} requires a publicly reachable webhook URL`);
      expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "http://127.0.0.1:3334/voice/webhook",
    "http://[::1]:3334/voice/webhook",
    "http://[fd00::1]/voice/webhook",
  ])("fails closed when Twilio publicUrl %s points at a local-only webhook", async (publicUrl) => {
    await expect(
      createVoiceCallRuntime({
        config: createExternalProviderConfig({
          provider: "twilio",
          publicUrl,
        }),
        coreConfig: {} as CoreConfig,
        agentRuntime: {} as never,
      }),
    ).rejects.toThrow("twilio requires a publicly reachable webhook URL");
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit public URL for external voice providers", async () => {
    const runtime = await createVoiceCallRuntime({
      config: createExternalProviderConfig({
        provider: "twilio",
        publicUrl: "https://voice.example.com/voice/webhook",
      }),
      coreConfig: {} as CoreConfig,
      agentRuntime: {} as never,
    });

    expect(runtime.webhookUrl).toBe("https://voice.example.com/voice/webhook");
    expect(runtime.publicUrl).toBe("https://voice.example.com/voice/webhook");

    await runtime.stop();
  });

  it("does not log duplicate webhook and public URLs when they match", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runtime = await createVoiceCallRuntime({
      config: createExternalProviderConfig({
        provider: "twilio",
        publicUrl: "https://voice.example.com/voice/webhook",
      }),
      coreConfig: {} as CoreConfig,
      agentRuntime: {} as never,
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "[voice-call] Webhook URL: https://voice.example.com/voice/webhook",
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "[voice-call] Public URL: https://voice.example.com/voice/webhook",
    );

    await runtime.stop();
  });

  it("warns at startup when inbound calls can fall through to the personal default", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.allowFrom = ["+15550005678"];
    config.numbers["+15550009999"] = {};
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const runtime = await createVoiceCallRuntime({
      config,
      coreConfig: { agents: { list: [{ id: "personal", default: true }] } } as CoreConfig,
      agentRuntime: {} as never,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "[voice-call] Inbound calls without a matching number route will be rejected. Configure agentId with a non-default service agent.",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[voice-call] 1 inbound number route(s) will be rejected. Configure numbers.<dialed-number>.agentId with a non-default service agent.",
    );

    await runtime.stop();
  });

  it("wires realtime consults and keeps outbound calls off inbound number routes", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.numbers["+15550009999"] = {
      agentId: "inbound-route",
      responseModel: "openai/gpt-5.5",
    };
    config.realtime.enabled = true;
    config.realtime.agentContext.enabled = true;
    config.realtime.agentContext.includeIdentity = true;
    config.realtime.tools = [
      {
        type: "function",
        name: "custom_tool",
        description: "Custom tool",
        parameters: { type: "object", properties: {} },
      },
    ];
    const sessionStore: Record<string, unknown> = {};
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "Use the shipment status." }],
      meta: {},
    }));
    const agentRuntime = {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(() => ({ name: "Personal Agent" })),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      direction: "outbound",
      from: "+15550001234",
      to: "+15550009999",
      metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
      transcript: [{ speaker: "user", text: "Can you check shipment status?" }],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as CoreConfig,
      agentRuntime: agentRuntime as never,
    });

    const realtimeHandlerOptions = requireRecord(
      mocks.realtimeHandlerCtorArgs[0]?.[0],
      "realtime handler options",
    );
    const tools = realtimeHandlerOptions.tools;
    if (!Array.isArray(tools)) {
      throw new Error("expected realtime handler tools to be an array");
    }
    expect(tools.map((tool) => requireRecord(tool, "realtime tool").name)).toEqual([
      "openclaw_agent_consult",
      "custom_tool",
    ]);
    expect(realtimeHandlerOptions.instructions).not.toContain("Personal Agent");
    expect(agentRuntime.resolveAgentIdentity).not.toHaveBeenCalled();
    const handler = requireRealtimeConsultToolHandler();
    await expect(
      handler({ question: "What should I say?" }, "call-1", {
        partialUserTranscript: "Also check the ETA.",
      }),
    ).resolves.toEqual({
      text: "Use the shipment status.",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = requireRecord(
      firstCallParam(runEmbeddedAgent.mock.calls as unknown[][], "embedded OpenClaw consult"),
      "embedded OpenClaw consult params",
    );
    expect(consultParams.sessionKey).toBe("agent:main:voice:15550009999");
    expect(consultParams.spawnedBy).toBe("agent:main:discord:channel:general");
    expect(consultParams.messageProvider).toBe("voice");
    expect(consultParams.lane).toBe("voice");
    expect(consultParams.provider).toBe("openai");
    expect(consultParams.model).toBe("gpt-5.4");
    expect(consultParams.toolsAllow).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(consultParams.extraSystemPrompt).toContain("one or two bounded read-only queries");
    expect(consultParams.prompt).toContain("Caller: Can you check shipment status?");
    expect(consultParams.prompt).toContain("Caller: Also check the ETA.");
  });

  it("keeps restored realtime calls on their admitted agent after route reassignment", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.realtime.enabled = true;
    config.sessionScope = "per-call";
    config.agentId = "reassigned-service";
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "Per-call consult answer." }],
      meta: {},
    }));
    const sessionStore: Record<string, unknown> = {};
    const agentRuntime = {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      sessionKey: "voice:call:call-1",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      inboundIdentity: {
        agentId: "team-service",
        routeMatchedBy: "config.agent",
        chatType: "direct",
        senderId: "+15550001234",
        senderE164: "+15550001234",
        senderIsOwner: false,
        responsePolicy: {
          model: "openai/admission-model",
          systemPrompt: "Admission-time service prompt.",
          timeoutMs: 7000,
        },
      },
      transcript: [],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {
        agents: {
          list: [{ id: "team-service" }, { id: "reassigned-service", default: true }],
        },
      } as CoreConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    await expect(handler({ question: "What should I say?" }, "call-1")).resolves.toEqual({
      text: "Per-call consult answer.",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = requireRecord(
      firstCallParam(
        runEmbeddedAgent.mock.calls as unknown[][],
        "per-call embedded OpenClaw consult",
      ),
      "per-call embedded OpenClaw consult params",
    );
    expect(consultParams.sessionKey).toBe("agent:team-service:voice:call:call-1");
    expect(consultParams).toMatchObject({
      routeMatchedBy: "config.agent",
      chatType: "direct",
      senderId: "+15550001234",
      senderE164: "+15550001234",
      senderIsOwner: false,
      provider: "openai",
      model: "admission-model",
      timeoutMs: 7000,
    });
    expect(mocks.resolveRealtimeFastContextConsult).not.toHaveBeenCalled();
  });

  it("rejects restored realtime calls after their admitted agent is removed", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.realtime.enabled = true;
    config.sessionScope = "per-call";
    config.agentId = "reassigned-service";
    const runEmbeddedAgent = vi.fn();
    const sessionRuntime = createMockSessionRuntime({});
    const agentRuntime = {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: sessionRuntime,
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      sessionKey: "voice:call:call-1",
      direction: "inbound",
      from: "+15550001234",
      to: "+15550009999",
      inboundIdentity: {
        agentId: "removed-service",
        routeMatchedBy: "config.agent",
        chatType: "direct",
        senderId: "+15550001234",
        senderE164: "+15550001234",
        senderIsOwner: false,
        responsePolicy: { model: null, systemPrompt: null, timeoutMs: 30000 },
      },
      transcript: [],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {
        agents: { list: [{ id: "reassigned-service", default: true }] },
      } as CoreConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    await expect(handler({ question: "What should I say?" }, "call-1")).resolves.toEqual({
      error: "Inbound call agent is no longer configured",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(sessionRuntime.resolveStorePath).not.toHaveBeenCalled();
    expect(agentRuntime.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    expect(mocks.resolveRealtimeFastContextConsult).not.toHaveBeenCalled();
  });

  it("answers realtime consults from fast memory context before starting the full agent", async () => {
    const config = createBaseConfig();
    config.realtime.enabled = true;
    config.realtime.fastContext = {
      enabled: true,
      timeoutMs: 800,
      maxResults: 2,
      sources: ["memory"],
      fallbackToConsult: false,
    };
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "slow answer" }],
      meta: {},
    }));
    const sessionStore: Record<string, unknown> = {};
    const agentRuntime = {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      direction: "outbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });
    mocks.resolveRealtimeFastContextConsult.mockResolvedValue({
      handled: true,
      result: {
        text: "Fast OpenClaw memory or session context found.\nThe caller's basement lights are on.",
      },
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as CoreConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    const fastContextResult = await handler({ question: "Are the basement lights on?" }, "call-1");
    const fastContextRecord = requireRecord(fastContextResult, "fast context result");
    expect(fastContextRecord.text).toContain("The caller's basement lights are on.");
    expect(mocks.resolveRealtimeFastContextConsult).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      args: { question: "Are the basement lights on?" },
      config: {
        enabled: true,
        fallbackToConsult: false,
        maxResults: 2,
        sources: ["memory"],
        timeoutMs: 800,
      },
      logger: {
        info: console.log,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
      },
      sessionKey: "agent:main:voice:15550009999",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("uses the configured realtime consult thinking level when set", async () => {
    const config = createBaseConfig();
    config.inboundPolicy = "allowlist";
    config.realtime.enabled = true;
    config.realtime.consultThinkingLevel = "low";
    config.realtime.consultFastMode = true;
    const sessionStore: Record<string, unknown> = {};
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "Done." }],
      meta: {},
    }));
    const agentRuntime = {
      defaults: { provider: "openai", model: "gpt-5.4" },
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      resolveAgentIdentity: vi.fn(),
      resolveThinkingDefault: vi.fn(() => "high"),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      ensureAgentWorkspace: vi.fn(async () => {}),
      session: createMockSessionRuntime(sessionStore),
      runEmbeddedAgent,
    };
    mocks.managerGetCall.mockReturnValue({
      callId: "call-1",
      direction: "outbound",
      from: "+15550001234",
      to: "+15550009999",
      transcript: [],
    });

    await createVoiceCallRuntime({
      config,
      coreConfig: {} as CoreConfig,
      agentRuntime: agentRuntime as never,
    });

    const handler = requireRealtimeConsultToolHandler();
    await expect(handler({ question: "Turn on the lights." }, "call-1")).resolves.toEqual({
      text: "Done.",
    });

    expect(agentRuntime.resolveThinkingDefault).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = requireRecord(
      firstCallParam(
        runEmbeddedAgent.mock.calls as unknown[][],
        "configured embedded OpenClaw consult",
      ),
      "configured embedded OpenClaw consult params",
    );
    expect(consultParams.thinkLevel).toBe("low");
    expect(consultParams.fastMode).toBe(true);
  });
});
