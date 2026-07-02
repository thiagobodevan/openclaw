import { describe, expect, it } from "vitest";
import { resolveFeishuCurrentConversationRoute } from "./session-route.js";

describe("resolveFeishuCurrentConversationRoute", () => {
  it("revalidates a persisted broadcast service route", () => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "main", default: true }, { id: "service" }] },
        broadcast: { "chat-1": ["service"] },
      },
      agentId: "service",
      accountId: "default",
      target: "chat:chat-1",
      conversationId: "chat-1",
      chatType: "group",
      senderId: "user-1",
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:feishu:group:chat-1",
      mainSessionKey: "agent:service:main",
      matchedBy: "config.agent",
    });
  });

  it("preserves a configured ACP route when selecting a broadcast service agent", () => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: {
          list: [{ id: "personal", default: true }, { id: "codex" }, { id: "service" }],
        },
        bindings: [
          {
            type: "acp",
            agentId: "codex",
            match: {
              channel: "feishu",
              accountId: "default",
              peer: { kind: "group", id: "chat-1:topic:topic-1" },
            },
            acp: { backend: "acpx" },
          },
        ],
        broadcast: { "chat-1": ["service"] },
        channels: { feishu: { groupSessionScope: "group_topic" } },
      },
      agentId: "service",
      accountId: "default",
      target: "chat:chat-1",
      conversationId: "chat-1:topic:topic-1",
      chatType: "group",
      senderId: "user-1",
      threadId: "topic-1",
    });

    expect(route).toMatchObject({
      agentId: "service",
      matchedBy: "config.agent",
    });
    expect(route?.sessionKey).toMatch(/^agent:service:acp:/);
  });

  it.each([
    {
      scope: "group_sender" as const,
      threadId: undefined,
      expectedPeer: "chat-1:sender:user-1",
    },
    {
      scope: "group_topic" as const,
      threadId: "topic-1",
      expectedPeer: "chat-1:topic:topic-1",
    },
    {
      scope: "group_topic_sender" as const,
      threadId: "topic-1",
      expectedPeer: "chat-1:topic:topic-1:sender:user-1",
    },
  ])("reconstructs $scope broadcast session scope", ({ scope, threadId, expectedPeer }) => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "main", default: true }, { id: "service" }] },
        broadcast: { "chat-1": ["service"] },
        channels: { feishu: { groupSessionScope: scope } },
      },
      agentId: "service",
      accountId: "default",
      target: "chat:chat-1",
      conversationId: "chat-1",
      chatType: "group",
      senderId: "user-1",
      threadId,
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: `agent:service:feishu:group:${expectedPeer}`,
      matchedBy: "config.agent",
    });
  });

  it.each([
    {
      scope: "group_sender" as const,
      conversationId: "chat-1:sender:user-1",
      threadId: undefined,
    },
    {
      scope: "group_topic" as const,
      conversationId: "chat-1:topic:topic-1",
      threadId: "topic-1",
    },
    {
      scope: "group_topic_sender" as const,
      conversationId: "chat-1:topic:topic-1:sender:user-1",
      threadId: "topic-1",
    },
  ])("revalidates a non-broadcast $scope service route", ({ scope, conversationId, threadId }) => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "feishu",
              accountId: "default",
              peer: { kind: "group", id: conversationId },
            },
          },
        ],
        channels: { feishu: { groupSessionScope: scope } },
      },
      agentId: "service",
      accountId: "default",
      target: "chat:chat-1",
      conversationId,
      chatType: "group",
      senderId: "user-1",
      threadId,
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: `agent:service:feishu:group:${conversationId}`,
      matchedBy: "binding.peer",
    });
  });

  it("normalizes direct identities before configured ACP binding resolution", () => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            type: "acp",
            agentId: "service",
            match: {
              channel: "feishu",
              accountId: "default",
              peer: { kind: "direct", id: "ou_user_1" },
            },
            acp: { backend: "acpx" },
          },
        ],
      },
      agentId: "service",
      accountId: "default",
      target: "user:ou_user_1",
      chatType: "direct",
      senderId: "ou_user_1",
    });

    expect(route).toMatchObject({
      agentId: "service",
      matchedBy: "binding.channel",
    });
    expect(route?.sessionKey).toMatch(/^agent:service:acp:/);
  });
});
