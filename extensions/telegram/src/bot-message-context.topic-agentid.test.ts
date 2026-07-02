// Telegram tests cover bot message context.topic agentid plugin behavior.
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultRouteConfig } = vi.hoisted(() => ({
  defaultRouteConfig: {
    agents: {
      list: [{ id: "main", default: true }, { id: "zu" }, { id: "q" }, { id: "support" }],
    },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: vi.fn(() => defaultRouteConfig),
  };
});

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

const topicRoutingConfig = {
  agents: {
    list: [
      { id: "personal", default: true },
      { id: "main" },
      { id: "zu" },
      { id: "q" },
      { id: "support" },
    ],
  },
  bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }],
  channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  messages: { groupChat: { mentionPatterns: [] } },
};

describe("buildTelegramMessageContext per-topic agentId routing", () => {
  function buildForumMessage(threadId = 3) {
    return {
      message_id: 1,
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "Forum",
        is_forum: true,
      },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: threadId,
      from: { id: 42, first_name: "Alice" },
    };
  }

  async function buildForumContext(params: {
    threadId?: number;
    topicConfig?: Record<string, unknown>;
  }) {
    return await buildTelegramMessageContextForTest({
      message: buildForumMessage(params.threadId),
      cfg: topicRoutingConfig,
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        ...(params.topicConfig ? { topicConfig: params.topicConfig } : {}),
      }),
    });
  }

  beforeEach(() => {
    vi.mocked(getRuntimeConfig).mockReturnValue(defaultRouteConfig as never);
  });

  it("uses group-level agent when no topic agentId is set", async () => {
    const ctx = await buildForumContext({ topicConfig: { systemPrompt: "Be nice" } });

    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:3");
  });

  it("routes to topic-specific agent when agentId is set", async () => {
    const ctx = await buildForumContext({
      topicConfig: { agentId: "zu", systemPrompt: "I am Zu" },
    });

    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:zu:");
    expect(ctx?.ctxPayload?.SessionKey).toContain("telegram:group:-1001234567890:topic:3");
    expect(ctx?.ctxPayload?.AgentRouteMatchedBy).toBe("config.agent");
  });

  it("different topics route to different agents", async () => {
    const buildForTopic = async (threadId: number, agentId: string) =>
      await buildForumContext({ threadId, topicConfig: { agentId } });

    const ctxA = await buildForTopic(1, "main");
    const ctxB = await buildForTopic(3, "zu");
    const ctxC = await buildForTopic(5, "q");

    expect(ctxA?.ctxPayload?.SessionKey).toContain("agent:main:");
    expect(ctxB?.ctxPayload?.SessionKey).toContain("agent:zu:");
    expect(ctxC?.ctxPayload?.SessionKey).toContain("agent:q:");

    expect(ctxA?.ctxPayload?.SessionKey).not.toBe(ctxB?.ctxPayload?.SessionKey);
    expect(ctxB?.ctxPayload?.SessionKey).not.toBe(ctxC?.ctxPayload?.SessionKey);
  });

  it("preserves topic routing when Telegram omits chat.is_forum", async () => {
    const resolveTelegramGroupConfig = vi.fn(() => ({
      groupConfig: { requireMention: false },
      topicConfig: { agentId: "zu" },
    }));
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum",
        },
        date: 1700000000,
        text: "@bot hello",
        is_topic_message: true,
        message_thread_id: 3,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      cfg: topicRoutingConfig,
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig,
    });

    expect(resolveTelegramGroupConfig).toHaveBeenCalledWith(-1001234567890, 3);
    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:zu:");
    expect(ctx?.ctxPayload?.SessionKey).toContain("telegram:group:-1001234567890:topic:3");
  });

  it("ignores whitespace-only agentId and uses group-level agent", async () => {
    const ctx = await buildForumContext({
      topicConfig: { agentId: "   ", systemPrompt: "Be nice" },
    });

    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:main:");
  });

  it("rejects an unknown topic agentId", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      agents: {
        list: [{ id: "main", default: true }, { id: "zu" }],
      },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
    } as never);

    const ctx = await buildForumContext({ topicConfig: { agentId: "ghost" } });

    expect(ctx).toBeNull();
  });

  it("denies an unbound shared route before probing omitted forum metadata", async () => {
    const getChat = vi.fn(async () => ({
      id: -1001234567890,
      type: "supergroup",
      is_forum: true,
    }));

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: -1001234567890, type: "supergroup", title: "Shared" },
        date: 1700000000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      botApi: { getChat },
      cfg: {
        agents: { list: [{ id: "personal", default: true }] },
        channels: { telegram: {} },
      },
    });

    expect(ctx).toBeNull();
    expect(getChat).not.toHaveBeenCalled();
  });

  it("routes DM topic to specific agent when agentId is set", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: {
          id: 123456789,
          type: "private",
        },
        date: 1700000000,
        text: "@bot hello",
        message_thread_id: 99,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      cfg: topicRoutingConfig,
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "support", systemPrompt: "I am support" },
      }),
    });

    expect(ctx?.ctxPayload?.SessionKey).toContain("agent:support:");
  });
});
