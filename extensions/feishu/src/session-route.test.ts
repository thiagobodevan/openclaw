import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import { resolveFeishuCurrentConversationRoute } from "./session-route.js";

type BindingRouteParams = {
  cfg: {
    bindings?: Array<{
      type?: string;
      agentId?: string;
      match?: { peer?: { id?: string } };
    }>;
  };
  route: ResolvedAgentRoute;
  conversation: { conversationId: string };
};

const bindingRuntimeMocks = vi.hoisted(() => ({
  resolveConfiguredBindingRoute: vi.fn((params: BindingRouteParams) => {
    const binding = params.cfg.bindings?.find(
      (candidate) =>
        candidate.type === "acp" &&
        candidate.match?.peer?.id === params.conversation.conversationId,
    );
    if (!binding) {
      return { bindingResolution: null, route: params.route };
    }
    const agentId = binding.agentId ?? params.route.agentId;
    const sessionKey = `agent:${agentId}:acp:binding:test`;
    return {
      bindingResolution: {},
      boundAgentId: agentId,
      boundSessionKey: sessionKey,
      route: {
        ...params.route,
        agentId,
        sessionKey,
        lastRoutePolicy: "session" as const,
        matchedBy: "binding.channel" as const,
      },
    };
  }),
  lookupRuntimeConversationBindingRoute: vi.fn(({ route }: { route: ResolvedAgentRoute }) => ({
    bindingRecord: null,
    route,
  })),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => bindingRuntimeMocks);

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

  it("rejects a group target that disagrees with its native conversation", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
          broadcast: { "chat-old": ["service"] },
        },
        agentId: "service",
        accountId: "default",
        target: "chat:chat-new",
        conversationId: "chat-old:topic:topic-1",
        chatType: "group",
        senderId: "user-1",
        threadId: "topic-1",
      }),
    ).toBeNull();
  });

  it("rejects conflicting persisted topic evidence", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: { channels: { feishu: { groupSessionScope: "group_topic" } } },
        accountId: "default",
        target: "chat:chat-1",
        conversationId: "chat-1:topic:topic-1",
        chatType: "group",
        threadId: "topic-1",
        audienceEvidence: [
          { source: "route", value: "chat-1:topic:topic-1" },
          { source: "delivery", value: "chat-1:topic:topic-2" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("rejects direct audience evidence for a shared chat with the same id", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "chat:chat-1",
        conversationId: "chat-1",
        chatType: "group",
        audienceEvidence: [
          { source: "route", value: "chat:chat-1" },
          { source: "origin-native", value: "user:chat-1" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("rejects topic evidence when the selected chat is unscoped", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "chat:chat-1",
        conversationId: "chat-1",
        chatType: "group",
        threadId: "topic-1",
        audienceEvidence: [
          { source: "route", value: "chat:chat-1" },
          { source: "origin-native", value: "chat-1:topic:topic-1" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("rejects sender evidence when the selected chat is unscoped", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "chat:chat-1",
        conversationId: "chat-1",
        chatType: "group",
        senderId: "user-1",
        audienceEvidence: [
          { source: "route", value: "chat:chat-1" },
          { source: "origin-native", value: "chat-1:sender:user-1" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
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

  it("certifies equivalent persisted direct audience forms", () => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "feishu",
              accountId: "default",
              peer: { kind: "direct", id: "ou_user_1" },
            },
          },
        ],
      },
      agentId: "service",
      accountId: "default",
      target: "user:ou_user_1",
      conversationId: "open_id:ou_user_1",
      chatType: "direct",
      senderId: "ou_user_1",
      audienceEvidence: [
        { source: "route", value: "user:ou_user_1" },
        { source: "origin-native", value: "chat:ou_user_1" },
        { source: "origin-target", value: "dm:ou_user_1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      matchedBy: "binding.peer",
      audienceValidated: true,
    });
  });

  it("certifies a bare generic user id with matching direct sender evidence", () => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "feishu",
              accountId: "default",
              peer: { kind: "direct", id: "u_123" },
            },
          },
        ],
      },
      agentId: "service",
      accountId: "default",
      target: "u_123",
      conversationId: "u_123",
      chatType: "direct",
      senderId: "u_123",
      audienceEvidence: [
        { source: "route", value: "u_123" },
        { source: "origin-target", value: "user:u_123" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      matchedBy: "binding.peer",
      audienceValidated: true,
    });
  });

  it("keeps a matching oc_ chat id group-owned in direct metadata", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "oc_shared_chat",
        conversationId: "oc_shared_chat",
        chatType: "direct",
        senderId: "oc_shared_chat",
        audienceEvidence: [
          { source: "route", value: "oc_shared_chat" },
          { source: "origin-target", value: "user:oc_shared_chat" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("keeps reply root metadata out of a canonical topic selection", () => {
    const route = resolveFeishuCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "feishu",
              accountId: "default",
              peer: { kind: "group", id: "chat-1:topic:thread-1" },
            },
          },
        ],
        channels: { feishu: { groupSessionScope: "group_topic" } },
      },
      agentId: "service",
      accountId: "default",
      target: "chat:chat-1",
      conversationId: "chat-1:topic:thread-1",
      chatType: "group",
      senderId: "user-1",
      threadId: "root-message-1",
      audienceEvidence: [
        { source: "route", value: "chat:chat-1" },
        { source: "origin-native", value: "chat-1:topic:thread-1" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:feishu:group:chat-1:topic:thread-1",
      audienceValidated: true,
    });
  });

  it("rejects shared evidence for a persisted direct audience", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "user:legacy_user_1",
        conversationId: "legacy_user_1",
        chatType: "direct",
        senderId: "legacy_user_1",
        audienceEvidence: [
          { source: "route", value: "user:legacy_user_1" },
          { source: "origin-native", value: "chat:legacy_user_1" },
        ],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("rejects a native chat id presented as a direct audience", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "oc_shared_chat",
        conversationId: "oc_shared_chat",
        chatType: "direct",
        audienceEvidence: [{ source: "route", value: "oc_shared_chat" }],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });

  it("does not let a direct prefix recast a native shared chat id", () => {
    expect(
      resolveFeishuCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "user:oc_shared_chat",
        conversationId: "oc_shared_chat",
        chatType: "direct",
        senderId: "oc_shared_chat",
        audienceEvidence: [{ source: "route", value: "user:oc_shared_chat" }],
        requireAudienceValidation: true,
      }),
    ).toBeNull();
  });
});
