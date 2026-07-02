// Tests before-agent-reply hooks in the get-reply pipeline.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  buildGetReplyGroupCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runBeforeAgentReply: vi.fn<HookRunner["runBeforeAgentReply"]>(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: mocks.hasHooks,
      runBeforeAgentReply: mocks.runBeforeAgentReply,
    }) as unknown as HookRunner,
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

const serviceAgentConfig = {
  agents: { list: [{ id: "personal", default: true }, { id: "main" }] },
};

function buildBoundGroupCtx(overrides: Parameters<typeof buildGetReplyGroupCtx>[0] = {}) {
  return buildGetReplyGroupCtx({
    AgentId: "main",
    AgentRouteMatchedBy: "binding.peer",
    SessionKey: "agent:main:telegram:-100123",
    ...overrides,
  });
}

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function createContinueDirectivesResult() {
  return createGetReplyContinueDirectivesResult({
    body: "hello world",
    abortKey: "agent:main:telegram:-100123",
    from: "telegram:user:42",
    to: "telegram:-100123",
    senderId: "42",
    commandSource: "text",
    senderIsOwner: false,
    resetHookTriggered: false,
  });
}

describe("getReplyFromConfig before_agent_reply wiring", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.hasHooks.mockReset();
    mocks.runBeforeAgentReply.mockReset();

    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: buildGetReplyGroupCtx({
          OriginatingChannel: "Telegram",
          Provider: "telegram",
          SenderId: "42",
          ChatId: "-100123-native",
        }),
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
        triggerBodyNormalized: "hello world",
        bodyStripped: "hello world",
      }),
    );
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      kind: "continue",
      directives: {},
      abortedLastRun: false,
      cleanedBody: "hello world",
    });
    mocks.hasHooks.mockImplementation((hookName) => hookName === "before_agent_reply");
  });

  it("returns a plugin reply and invokes the hook after inline actions", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "plugin reply" },
    });

    const result = await getReplyFromConfig(
      buildBoundGroupCtx({ SenderId: "telegram-user-42" }),
      { identityContractVersion: 1 },
      serviceAgentConfig,
    );

    expect(result).toEqual({ text: "plugin reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    const [[body, hookCtx]] = mocks.runBeforeAgentReply.mock.calls as unknown as Array<
      [
        { cleanedBody?: string },
        {
          agentId?: string;
          sessionKey?: string;
          sessionId?: string;
          workspaceDir?: string;
          messageProvider?: string;
          trigger?: string;
          channelId?: string;
          senderId?: string;
          chatId?: string;
          channel?: string;
          channelContext?: {
            sender?: { id?: string };
            chat?: { id?: string };
          };
        },
      ]
    >;
    expect(body.cleanedBody).toBe("hello world");
    expect(hookCtx.agentId).toBe("main");
    expect(hookCtx.sessionKey).toBe("agent:main:telegram:-100123");
    expect(hookCtx.sessionId).toBe("session-1");
    expect(hookCtx.workspaceDir).toBe("/tmp/workspace");
    expect(hookCtx.messageProvider).toBe("telegram");
    expect(hookCtx.trigger).toBe("user");
    expect(hookCtx.channel).toBe("telegram");
    expect(hookCtx.channelId).toBe("-100123");
    expect(hookCtx.senderId).toBe("42");
    expect(hookCtx.chatId).toBe("-100123-native");
    expect(hookCtx.channelContext?.sender?.id).toBe("42");
    expect(hookCtx.channelContext?.chat?.id).toBe("-100123-native");
    expect(mocks.handleInlineActions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runBeforeAgentReply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    {
      name: "account-selected service agent in a shared room",
      context: buildBoundGroupCtx({ AgentRouteMatchedBy: "config.agent" }),
    },
    {
      name: "bound service agent in a direct conversation",
      context: buildBoundGroupCtx({ ChatType: "direct", AgentRouteMatchedBy: "binding.peer" }),
    },
  ])("admits $name without personal fallback", async ({ context }) => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "service reply" },
    });

    const result = await getReplyFromConfig(
      context,
      { identityContractVersion: 1 },
      serviceAgentConfig,
    );

    expect(result).toEqual({ text: "service reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledOnce();
  });

  it("falls back to NO_REPLY when the hook claims without a reply payload", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: true });

    const result = await getReplyFromConfig(
      buildBoundGroupCtx(),
      { identityContractVersion: 1 },
      serviceAgentConfig,
    );

    expect(result).toEqual({ text: SILENT_REPLY_TOKEN });
  });

  it("denies an unbound shared audience before hooks or session setup", async () => {
    const result = await getReplyFromConfig(
      buildGetReplyGroupCtx({
        AgentId: "personal",
        AgentRouteMatchedBy: "default",
        SessionKey: "agent:personal:telegram:-100123",
      }),
      { identityContractVersion: 1 },
      { agents: { list: [{ id: "personal", default: true }] } },
    );

    expect(result).toEqual({
      text: "This conversation is not bound to a shared service agent. Ask an operator to configure an explicit agent binding for this audience.",
    });
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.handleInlineActions).not.toHaveBeenCalled();
    expect(mocks.runBeforeAgentReply).not.toHaveBeenCalled();
  });

  it("preserves unversioned public reply behavior for existing plugins", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "legacy plugin reply" },
    });

    const result = await getReplyFromConfig(
      buildGetReplyGroupCtx({
        AgentId: "personal",
        AgentRouteMatchedBy: "default",
        SessionKey: "agent:personal:telegram:-100123",
      }),
      undefined,
      { agents: { list: [{ id: "personal", default: true }] } },
    );

    expect(result).toEqual({ text: "legacy plugin reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledOnce();
  });

  it("rejects unsupported reply identity contract versions", async () => {
    await expect(
      getReplyFromConfig(buildBoundGroupCtx(), { identityContractVersion: 2 } as never, {}),
    ).rejects.toThrow("Unsupported reply identity contract version: 2");
  });

  it("does not trust heartbeat labels without internal provenance", async () => {
    const result = await getReplyFromConfig(
      buildGetReplyGroupCtx({
        Provider: "heartbeat",
        Surface: "slack",
        AgentId: "personal",
        AgentRouteMatchedBy: "default",
        SessionKey: "agent:personal:slack:channel:C_SHARED",
        ChatType: "channel",
      }),
      { identityContractVersion: 1, isHeartbeat: true },
      { agents: { list: [{ id: "personal", default: true }] } },
    );

    expect(result).toEqual({
      text: "This conversation is not bound to a shared service agent. Ask an operator to configure an explicit agent binding for this audience.",
    });
    expect(mocks.initSessionState).not.toHaveBeenCalled();
  });

  it("keeps trusted internal continuations in their existing session", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "resumed" },
    });

    const result = await getReplyFromConfig(
      buildGetReplyGroupCtx({
        Provider: "webchat",
        Surface: "webchat",
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "telegram",
          sourceTool: "restart-sentinel",
        },
      }),
      { identityContractVersion: 1 },
      {},
    );

    expect(result).toEqual({ text: "resumed" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledOnce();
  });

  it("admits authenticated gateway writers without requiring operator admin", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "gateway reply" },
    });

    const result = await getReplyFromConfig(
      buildGetReplyGroupCtx({
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        GatewayClientScopes: ["operator.write"],
      }),
      { identityContractVersion: 1 },
      {},
    );

    expect(result).toEqual({ text: "gateway reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledOnce();
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
