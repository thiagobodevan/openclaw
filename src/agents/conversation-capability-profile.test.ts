import { beforeEach, describe, expect, it } from "vitest";
import { buildConfiguredAcpSessionKey } from "../acp/persistent-bindings.types.js";
import { ensureConfiguredBindingBuiltinsRegistered } from "../channels/plugins/configured-binding-builtins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  isInterSessionIdentityTransitionAllowed,
  resolveConversationIdentityMode,
  resolveStableSenderIsOwner,
} from "../routing/conversation-identity.js";
import { resolvePersistedConversationIdentityContext } from "../routing/persisted-conversation-identity.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";

const identityConfig: OpenClawConfig = {
  agents: {
    list: [{ id: "personal", default: true }, { id: "team-ops" }],
  },
};

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  setActivePluginRegistry(createTestRegistry());
  ensureConfiguredBindingBuiltinsRegistered();
});

describe("resolveConversationCapabilityProfile", () => {
  it("prepares a direct conversation profile with sender tool restrictions", () => {
    const cfg: OpenClawConfig = {
      tools: {
        toolsBySender: {
          "id:guest": { deny: ["exec", "process"] },
        },
      },
      agents: identityConfig.agents,
    };

    const profile = resolveConversationCapabilityProfile({
      config: cfg,
      sessionKey: "agent:main:discord:dm:guest",
      agentId: "personal",
      routeMatchedBy: "default",
      messageProvider: "discord",
      chatType: "direct",
      senderId: "guest",
      senderIsOwner: true,
      modelProvider: "openai",
      modelId: "gpt-5.5",
      modelApi: "responses",
      workspaceDir: "/tmp/openclaw-direct-profile",
      cwd: "/tmp/openclaw-direct-profile/task",
      agentDir: "/tmp/openclaw-agent-direct-profile",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "ops" }],
      },
    });

    expect(profile.conversation.scope).toBe("direct");
    expect(profile.conversation.identity).toEqual({
      mode: "personal",
      allowed: true,
      reason: "owner_direct",
    });
    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
    expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
    expect(profile.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      api: "responses",
    });
    expect(profile.workspace).toMatchObject({
      workspaceRoot: "/tmp/openclaw-direct-profile",
      runtimeRoot: "/tmp/openclaw-direct-profile/task",
      instructionRoot: "/tmp/openclaw-agent-direct-profile",
    });
    expect(profile.skills.snapshot?.skills).toEqual([{ name: "ops" }]);
  });

  it.each([
    { provider: "slack", routeMatchedBy: "binding.team" as const, groupSpace: "T123" },
    { provider: "discord", routeMatchedBy: "binding.guild" as const, groupSpace: "G123" },
  ])(
    "prepares an organization profile from generic $provider binding metadata",
    ({ provider, routeMatchedBy, groupSpace }) => {
      const cfg: OpenClawConfig = {
        agents: identityConfig.agents,
        tools: {
          toolsBySender: {
            "id:alice": { deny: ["exec", "process"] },
          },
        },
      };

      const profile = resolveConversationCapabilityProfile({
        config: cfg,
        sessionKey: `agent:team-ops:${provider}:channel:team`,
        agentId: "team-ops",
        routeMatchedBy,
        messageProvider: provider,
        chatType: "channel",
        groupSpace,
        senderId: "alice",
        modelProvider: "openai",
        modelId: "gpt-5.5",
        workspaceDir: "/tmp/openclaw-shared-profile",
      });

      expect(profile.conversation).toMatchObject({
        scope: "shared",
        routeMatchedBy,
        identity: {
          mode: "organization",
          allowed: true,
          reason: "bound_service_agent",
        },
      });
      expect(profile.policy.senderPolicy).toEqual({ deny: ["exec", "process"] });
      expect(profile.policy.explicitToolDenylist).toEqual(["exec", "process"]);
    },
  );

  it("keeps admitted source policy when delivery uses another channel", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        agents: identityConfig.agents,
        tools: {
          toolsBySender: {
            "channel:slack:member-1": { deny: ["exec"] },
            "channel:telegram:member-1": { deny: ["web_search"] },
          },
        },
      },
      sessionKey: "agent:team-ops:slack:channel:C123",
      agentId: "team-ops",
      routeMatchedBy: "binding.peer",
      messageProvider: "slack",
      messageChannel: "telegram",
      policyMessageProvider: "slack",
      chatType: "channel",
      senderId: "member-1",
    });

    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec"] });
    expect(profile.policy.explicitToolDenylist).toContain("exec");
    expect(profile.policy.explicitToolDenylist).not.toContain("web_search");
  });

  it.each([
    {
      name: "an unbound shared audience",
      agentId: "personal",
      routeMatchedBy: "default" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "a guest direct message",
      agentId: "personal",
      routeMatchedBy: "default" as const,
      chatType: "direct",
      senderIsOwner: false,
      senderName: "Personal Owner",
    },
    {
      name: "an explicit shared binding to the personal agent",
      agentId: "personal",
      routeMatchedBy: "binding.guild" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "a fallback route that names a service agent",
      agentId: "team-ops",
      routeMatchedBy: "default" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "an owner direct fallback that names a service agent",
      agentId: "team-ops",
      routeMatchedBy: "default" as const,
      chatType: "direct",
      senderIsOwner: true,
    },
    {
      name: "a service agent without binding provenance",
      agentId: "team-ops",
      routeMatchedBy: undefined,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "an unknown account-selected service agent",
      agentId: "typo-service",
      routeMatchedBy: "config.agent" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
    {
      name: "a stale runtime binding to a removed service agent",
      agentId: "removed-service",
      routeMatchedBy: "binding.channel" as const,
      chatType: "channel",
      senderIsOwner: true,
    },
  ])("denies $name without personal fallback", (params) => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        ...params,
      }),
    ).toMatchObject({ mode: "external", allowed: false });
  });

  it("allows a configured account-selected service agent for a shared audience", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        agentId: "team-ops",
        routeMatchedBy: "config.agent",
        chatType: "channel",
      }),
    ).toEqual({ mode: "organization", allowed: true, reason: "bound_service_agent" });
  });

  it("does not reinterpret an audienceless service session as personal owner context", async () => {
    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey: "agent:team-ops:main",
        audienceless: "owner-direct",
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "untrusted_direct" },
      routeMatchedBy: "default",
      chatType: "direct",
      senderIsOwner: true,
    });
  });

  it.each(["slack", "discord"])(
    "preserves the provider-native direct identity for a %s runtime binding",
    async (provider) => {
      const sessionKey = `agent:team-ops:${provider}:direct:U123`;
      registerSessionBindingAdapter({
        channel: provider,
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: (conversation) =>
          conversation.conversationId === "user:U123"
            ? {
                bindingId: `${provider}:default:user:U123`,
                targetSessionKey: sessionKey,
                targetKind: "session",
                conversation,
                status: "active",
                boundAt: 1,
              }
            : null,
      });

      await expect(
        resolvePersistedConversationIdentityContext({
          cfg: identityConfig,
          agentId: "team-ops",
          sessionKey,
          sessionEntry: {
            sessionId: `${provider}-direct`,
            updatedAt: 1,
            chatType: "direct",
            channel: provider,
            route: {
              channel: provider,
              accountId: "default",
              target: { to: "user:U123", chatType: "direct" },
            },
            origin: {
              provider,
              accountId: "default",
              chatType: "direct",
              from: `${provider}:U123`,
              to: "user:U123",
              nativeDirectUserId: "U123",
            },
          },
          audienceless: "deny",
          resolvePluginRoute: async () => ({ kind: "unsupported" }),
        }),
      ).resolves.toMatchObject({
        decision: {
          mode: "organization",
          allowed: true,
          reason: "bound_service_agent",
        },
        routeMatchedBy: "binding.channel",
        chatType: "direct",
      });
    },
  );

  it("carries the persisted native guild sender into current route revalidation", async () => {
    const sessionKey = "agent:team-ops:discord:channel:123";
    let currentSenderId: string | undefined;

    const result = await resolvePersistedConversationIdentityContext({
      cfg: identityConfig,
      agentId: "team-ops",
      sessionKey,
      sessionEntry: {
        sessionId: "discord-role-route",
        updatedAt: 1,
        space: "789",
        route: {
          channel: "discord",
          accountId: "default",
          target: { to: "channel:123", chatType: "channel" },
        },
        origin: {
          provider: "discord",
          accountId: "default",
          chatType: "channel",
          from: "discord:channel:123",
          to: "channel:123",
          nativeChannelId: "123",
          nativeSenderId: "456",
          nativeProvider: "discord",
        },
      },
      audienceless: "deny",
      resolvePluginRoute: async (params) => {
        currentSenderId = params.senderId;
        return params.senderId === "456"
          ? {
              kind: "resolved",
              route: {
                agentId: "team-ops",
                channel: "discord",
                accountId: "default",
                sessionKey,
                mainSessionKey: "agent:team-ops:main",
                lastRoutePolicy: "session",
                matchedBy: "binding.guild+roles",
              },
            }
          : { kind: "unresolved" };
      },
    });

    expect(currentSenderId).toBe("456");
    expect(result).toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.guild+roles",
      senderId: "456",
    });
  });

  it("uses a direct delivery identity for a configured generic binding", async () => {
    const conversationId = "user:U123";
    const sessionKey = buildConfiguredAcpSessionKey({
      channel: "slack",
      accountId: "default",
      conversationId,
      agentId: "team-ops",
      mode: "persistent",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            bindings: {
              compileConfiguredBinding: ({ conversationId: configuredId }) => ({
                conversationId: configuredId,
              }),
              matchInboundConversation: ({ compiledBinding, conversationId: incomingId }) =>
                compiledBinding.conversationId === incomingId
                  ? { conversationId: incomingId, matchPriority: 2 }
                  : null,
            },
          },
        },
      ]),
    );
    const cfg: OpenClawConfig = {
      agents: identityConfig.agents,
      bindings: [
        {
          type: "acp",
          agentId: "team-ops",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "direct", id: conversationId },
          },
          acp: { mode: "persistent" },
        },
      ],
    };

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "configured-slack-direct",
          updatedAt: 1,
          chatType: "direct",
          channel: "slack",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: conversationId, chatType: "direct" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "direct",
            from: "slack:U123",
            to: conversationId,
            nativeChannelId: "D123",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => ({ kind: "unsupported" }),
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.channel",
      chatType: "direct",
    });
  });

  it("keeps a direct plugin route's native conversation id separate from its delivery target", async () => {
    const sessionKey = "agent:team-ops:matrix:channel:!dm:example.org";
    let resolvedConversationId: string | null | undefined;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "matrix-per-room-direct",
          updatedAt: 1,
          chatType: "direct",
          channel: "matrix",
          route: {
            channel: "matrix",
            accountId: "default",
            target: { to: "room:@alice:example.org", chatType: "direct" },
          },
          origin: {
            provider: "matrix",
            accountId: "default",
            chatType: "direct",
            from: "matrix:@alice:example.org",
            to: "room:@alice:example.org",
            nativeChannelId: "!dm:example.org",
            nativeDirectUserId: "@alice:example.org",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          resolvedConversationId = params.conversationId;
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: "matrix",
              accountId: "default",
              sessionKey,
              mainSessionKey: "agent:team-ops:main",
              lastRoutePolicy: "session",
              matchedBy: "binding.peer",
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.peer",
      chatType: "direct",
    });
    expect(resolvedConversationId).toBe("!dm:example.org");
  });

  it("carries a persisted parent conversation into current route resolution", async () => {
    const sessionKey = "agent:team-ops:discord:channel:thread-1";
    let resolvedParentConversationId: string | null | undefined;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "discord-parent-bound-thread",
          updatedAt: 1,
          chatType: "channel",
          route: {
            channel: "discord",
            accountId: "default",
            target: { to: "channel:thread-1", chatType: "channel" },
          },
          origin: {
            provider: "discord",
            accountId: "default",
            chatType: "channel",
            to: "channel:thread-1",
            nativeChannelId: "thread-1",
            parentConversationId: "parent-1",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          resolvedParentConversationId = params.parentConversationId;
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: "discord",
              accountId: "default",
              sessionKey,
              mainSessionKey: "agent:team-ops:main",
              lastRoutePolicy: "session",
              matchedBy: "binding.peer",
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
    });
    expect(resolvedParentConversationId).toBe("parent-1");
  });

  it.each([
    {
      name: "keeps the origin account when a later docked route uses another channel",
      sessionEntry: {
        sessionId: "legacy-docked-direct",
        updatedAt: 1,
        chatType: "direct" as const,
        origin: {
          provider: "slack",
          accountId: "work",
          chatType: "direct",
          from: "slack:U123",
          to: "user:U123",
          nativeChannelId: "D123",
          nativeDirectUserId: "U123",
        },
        lastChannel: "discord",
        lastTo: "user:U999",
        lastAccountId: "default",
      },
      expectedChannel: "slack",
      expectedAccountId: "work",
      expectedConversationId: "D123",
      expectedSenderId: "U123",
    },
    {
      name: "does not inherit an origin account when the persisted route selects another channel",
      sessionEntry: {
        sessionId: "route-over-origin",
        updatedAt: 1,
        chatType: "direct" as const,
        route: {
          channel: "discord",
          target: { to: "user:U999", chatType: "direct" as const },
        },
        origin: {
          provider: "slack",
          accountId: "work",
          chatType: "direct",
          from: "slack:U123",
          to: "user:U123",
          nativeChannelId: "D123",
          nativeDirectUserId: "U123",
        },
      },
      expectedChannel: "discord",
      expectedAccountId: undefined,
      expectedConversationId: undefined,
      expectedSenderId: undefined,
    },
  ])(
    "$name",
    async ({
      sessionEntry,
      expectedChannel,
      expectedAccountId,
      expectedConversationId,
      expectedSenderId,
    }) => {
      const sessionKey = "agent:team-ops:main";
      let resolvedChannel: string | undefined;
      let resolvedAccountId: string | null | undefined;
      let resolvedConversationId: string | null | undefined;
      let resolvedSenderId: string | null | undefined;

      await expect(
        resolvePersistedConversationIdentityContext({
          cfg: identityConfig,
          agentId: "team-ops",
          sessionKey,
          sessionEntry,
          audienceless: "deny",
          resolvePluginRoute: async (params) => {
            resolvedChannel = params.channel;
            resolvedAccountId = params.accountId;
            resolvedConversationId = params.conversationId;
            resolvedSenderId = params.senderId;
            return {
              kind: "resolved",
              route: {
                agentId: "team-ops",
                channel: params.channel,
                accountId: params.accountId ?? "default",
                sessionKey,
                mainSessionKey: sessionKey,
                lastRoutePolicy: "session",
                matchedBy: "binding.peer",
              },
            };
          },
        }),
      ).resolves.toMatchObject({
        decision: {
          mode: "organization",
          allowed: true,
          reason: "bound_service_agent",
        },
      });
      expect(resolvedChannel).toBe(expectedChannel);
      expect(resolvedAccountId).toBe(expectedAccountId);
      expect(resolvedConversationId).toBe(expectedConversationId);
      expect(resolvedSenderId).toBe(expectedSenderId);
    },
  );

  it("treats persisted internal transport metadata as audienceless", async () => {
    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey: "agent:team-ops:main",
        sessionEntry: {
          sessionId: "service-main-internal",
          updatedAt: 1,
          chatType: "direct",
          channel: "webchat",
          lastChannel: "sessions_send",
          lastTo: "session:team-ops",
          route: {
            channel: "webchat",
            target: { to: "session:team-ops", chatType: "direct" },
          },
          origin: {
            provider: "webchat",
            surface: "webchat",
            chatType: "direct",
            to: "session:team-ops",
          },
        },
        audienceless: "internal",
      }),
    ).resolves.toMatchObject({ decision: { allowed: true, reason: "internal" } });
  });

  it("keeps an established external audience beneath an internal transport overlay", async () => {
    const sessionKey = "agent:team-ops:main";
    let resolvedConversationId: string | null | undefined;
    let resolvedSenderId: string | null | undefined;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "service-main-external",
          updatedAt: 1,
          chatType: "direct",
          channel: "webchat",
          lastChannel: "slack",
          lastTo: "user:U123",
          lastAccountId: "default",
          route: {
            channel: "webchat",
            target: { to: "session:team-ops", chatType: "direct" },
          },
          origin: {
            provider: "webchat",
            surface: "webchat",
            accountId: "default",
            chatType: "direct",
            to: "session:team-ops",
            nativeChannelId: "D123",
            nativeDirectUserId: "U123",
            nativeProvider: "slack",
          },
        },
        audienceless: "internal",
        resolvePluginRoute: async (params) => {
          resolvedConversationId = params.conversationId;
          resolvedSenderId = params.senderId;
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: params.channel,
              accountId: params.accountId ?? "default",
              sessionKey,
              mainSessionKey: sessionKey,
              lastRoutePolicy: "session",
              matchedBy: "binding.peer",
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.peer",
      messageProvider: "slack",
      chatType: "direct",
    });
    expect(resolvedConversationId).toBe("D123");
    expect(resolvedSenderId).toBe("U123");
  });

  it("does not reuse another channel's native identity after an internal dock overlay", async () => {
    const sessionKey = "agent:team-ops:main";
    let resolvedTarget: string | undefined;
    let resolvedConversationId: string | null | undefined;
    let resolvedSenderId: string | null | undefined;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "service-main-docked",
          updatedAt: 1,
          chatType: "direct",
          channel: "webchat",
          lastChannel: "discord",
          lastTo: "user:U999",
          lastAccountId: "default",
          origin: {
            provider: "webchat",
            surface: "webchat",
            chatType: "direct",
            nativeChannelId: "D123",
            nativeDirectUserId: "U123",
            nativeProvider: "slack",
          },
        },
        audienceless: "internal",
        resolvePluginRoute: async (params) => {
          resolvedTarget = params.target;
          resolvedConversationId = params.conversationId;
          resolvedSenderId = params.senderId;
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: params.channel,
              accountId: params.accountId ?? "default",
              sessionKey,
              mainSessionKey: sessionKey,
              lastRoutePolicy: "session",
              matchedBy: "binding.peer",
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      messageProvider: "discord",
    });
    expect(resolvedTarget).toBe("user:U999");
    expect(resolvedConversationId).toBeUndefined();
    expect(resolvedSenderId).toBeUndefined();
  });

  it("does not reuse an old sender after a same-provider route change", async () => {
    const sessionKey = "agent:personal:slack:direct:U999";

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: {
          agents: { list: [{ id: "personal", default: true }] },
          commands: { ownerAllowFrom: ["slack:U123"] },
        },
        agentId: "personal",
        sessionKey,
        sessionEntry: {
          sessionId: "personal-new-slack-peer",
          updatedAt: 1,
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "user:U999", chatType: "direct" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "direct",
            from: "slack:U123",
            to: "user:U123",
            nativeChannelId: "D123",
            nativeDirectUserId: "U123",
            nativeProvider: "slack",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => ({
          kind: "resolved",
          route: {
            agentId: "personal",
            channel: params.channel,
            accountId: params.accountId ?? "default",
            sessionKey,
            mainSessionKey: "agent:personal:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          },
        }),
      }),
    ).resolves.toMatchObject({
      decision: { mode: "external", allowed: false, reason: "untrusted_direct" },
      senderId: undefined,
      senderIsOwner: false,
    });
  });

  it("does not reuse an old workspace after a same-provider route change", async () => {
    const sessionKey = "agent:team-ops:discord:channel:C999";
    let resolvedGroupSpace: string | null | undefined = "not-called";

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "team-new-discord-channel",
          updatedAt: 1,
          space: "guild-old",
          route: {
            channel: "discord",
            accountId: "default",
            target: { to: "channel:C999", chatType: "channel" },
          },
          origin: {
            provider: "discord",
            accountId: "default",
            chatType: "channel",
            to: "channel:C123",
            nativeChannelId: "C123",
            nativeProvider: "discord",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          resolvedGroupSpace = params.groupSpace;
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: params.channel,
              accountId: params.accountId ?? "default",
              sessionKey,
              mainSessionKey: "agent:team-ops:main",
              lastRoutePolicy: "session",
              matchedBy: "binding.peer",
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: { mode: "organization", allowed: true, reason: "bound_service_agent" },
      groupSpace: undefined,
    });
    expect(resolvedGroupSpace).toBeUndefined();
  });

  it("revalidates a generic runtime binding on the persisted child thread", async () => {
    const threadId = "1710000000.000100";
    const sessionKey = `agent:team-ops:slack:channel:C123:thread:${threadId}`;
    const resolvedConversationIds: string[] = [];
    registerSessionBindingAdapter({
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => {
        resolvedConversationIds.push(conversation.conversationId);
        return conversation.conversationId === threadId
          ? {
              bindingId: `slack:default:${threadId}`,
              targetSessionKey: sessionKey,
              targetKind: "session",
              conversation,
              status: "active",
              boundAt: 1,
            }
          : null;
      },
    });

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "slack-runtime-thread",
          updatedAt: 1,
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:C123", chatType: "channel" },
            thread: { id: threadId },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "channel",
            to: "channel:C123",
            nativeChannelId: "C123",
            nativeProvider: "slack",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => ({ kind: "unsupported" }),
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.channel",
    });
    expect(resolvedConversationIds).toEqual([threadId]);
  });

  it("canonicalizes a global main audience before comparing its live route", async () => {
    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: {
          ...identityConfig,
          session: { scope: "global" },
        },
        agentId: "team-ops",
        sessionKey: "global",
        sessionEntry: {
          sessionId: "team-global-main",
          updatedAt: 1,
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "user:U123", chatType: "direct" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "direct",
            from: "slack:U123",
            to: "user:U123",
            nativeChannelId: "D123",
            nativeDirectUserId: "U123",
            nativeProvider: "slack",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => ({
          kind: "resolved",
          route: {
            agentId: "team-ops",
            channel: "slack",
            accountId: "default",
            sessionKey: "agent:team-ops:main",
            mainSessionKey: "agent:team-ops:main",
            lastRoutePolicy: "main",
            matchedBy: "binding.channel",
          },
        }),
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.channel",
    });
  });

  it("uses the selected route's direct chat type instead of stale group metadata", async () => {
    const sessionKey = "agent:team-ops:main";
    let resolvedChatType: string | undefined;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "service-main-direct-after-group",
          updatedAt: 1,
          chatType: "channel",
          channel: "slack",
          route: {
            channel: "discord",
            accountId: "default",
            target: { to: "user:U999", chatType: "direct" },
          },
          origin: {
            provider: "discord",
            accountId: "default",
            chatType: "direct",
            from: "discord:U999",
            to: "user:U999",
            nativeChannelId: "D999",
            nativeDirectUserId: "U999",
            nativeProvider: "discord",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          resolvedChatType = params.chatType;
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: params.channel,
              accountId: params.accountId ?? "default",
              sessionKey,
              mainSessionKey: sessionKey,
              lastRoutePolicy: "session",
              matchedBy: "binding.peer",
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      chatType: "direct",
    });
    expect(resolvedChatType).toBe("direct");
  });

  it("derives personal ownership only from an explicit stable sender allowlist", () => {
    const normalizeEntry = (entry: string) =>
      entry
        .trim()
        .replace(/^test:/, "")
        .toLowerCase();

    expect(
      resolveStableSenderIsOwner({
        senderId: "OWNER",
        providerAllowFrom: ["test:owner"],
        normalizeEntry,
      }),
    ).toBe(true);
    expect(
      resolveStableSenderIsOwner({
        senderId: "guest",
        providerAllowFrom: ["*"],
        normalizeEntry,
      }),
    ).toBe(false);
    expect(
      resolveStableSenderIsOwner({
        senderId: "OWNER",
        commandOwnerAllowFrom: ["*"],
        providerAllowFrom: ["test:owner"],
        normalizeEntry,
      }),
    ).toBe(true);
    expect(
      resolveStableSenderIsOwner({
        senderId: "paired-user",
        providerAllowFrom: [],
        normalizeEntry,
      }),
    ).toBe(false);
  });

  it("allows an explicit service binding when agents use the implicit legacy registry", () => {
    expect(
      resolveConversationIdentityMode({
        config: {
          bindings: [{ agentId: "team-ops", match: { channel: "slack" } }],
        },
        agentId: "team-ops",
        routeMatchedBy: "binding.channel",
        chatType: "channel",
      }),
    ).toEqual({ mode: "organization", allowed: true, reason: "bound_service_agent" });
  });

  it("revokes a legacy service route after its owning binding is removed", () => {
    expect(
      resolveConversationIdentityMode({
        config: {},
        agentId: "team-ops",
        routeMatchedBy: "binding.channel",
        chatType: "channel",
      }),
    ).toEqual({ mode: "external", allowed: false, reason: "unconfigured_agent" });
  });

  it("keeps trusted internal turns inside their admitted session", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        isInternal: true,
        agentId: "personal",
        routeMatchedBy: "default",
        chatType: "channel",
      }),
    ).toEqual({ mode: "personal", allowed: true, reason: "internal" });
  });

  it("carries the owning ingress decision without reclassifying a scheduled turn", () => {
    const decision = {
      mode: "organization",
      allowed: true,
      reason: "bound_service_agent",
    } as const;
    const profile = resolveConversationCapabilityProfile({
      config: identityConfig,
      conversationIdentity: decision,
      agentId: "team-ops",
      isInternal: true,
      workspaceDir: "/tmp/openclaw-scheduled-profile",
    });

    expect(profile.conversation.identity).toBe(decision);
  });

  it("rejects trusted internal turns targeting a removed agent", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        isInternal: true,
        agentId: "removed-service",
        routeMatchedBy: "binding.channel",
        chatType: "channel",
      }),
    ).toEqual({ mode: "external", allowed: false, reason: "unconfigured_agent" });
  });

  it.each([
    {
      name: "personal to service",
      sourceSessionKey: "agent:personal:main",
      targetAgentId: "team-ops",
      allowed: true,
    },
    {
      name: "service to same service",
      sourceSessionKey: "agent:team-ops:slack:channel:C1",
      targetAgentId: "team-ops",
      allowed: true,
    },
    {
      name: "service to personal",
      sourceSessionKey: "agent:team-ops:slack:channel:C1",
      targetAgentId: "personal",
      allowed: false,
    },
    {
      name: "unscoped source to personal",
      sourceSessionKey: "unknown",
      targetAgentId: "personal",
      allowed: false,
    },
  ])(
    "classifies $name inter-session transitions",
    ({ sourceSessionKey, targetAgentId, allowed }) => {
      expect(
        isInterSessionIdentityTransitionAllowed({
          config: identityConfig,
          sourceSessionKey,
          sourceTool: "sessions_send",
          targetAgentId,
        }),
      ).toBe(allowed);
    },
  );

  it("keeps trusted background completion tools inside their target session", () => {
    expect(
      isInterSessionIdentityTransitionAllowed({
        config: identityConfig,
        sourceSessionKey: "image_generate:task-1",
        sourceTool: "image_generate",
        targetAgentId: "personal",
      }),
    ).toBe(true);
  });

  it("rejects inter-session completion targeting a removed agent", () => {
    expect(
      isInterSessionIdentityTransitionAllowed({
        config: identityConfig,
        sourceSessionKey: "image_generate:task-1",
        sourceTool: "image_generate",
        targetAgentId: "removed-service",
      }),
    ).toBe(false);
  });

  it("fails closed when an external ingress omits audience metadata", () => {
    expect(
      resolveConversationIdentityMode({
        config: identityConfig,
        agentId: "personal",
        routeMatchedBy: "default",
      }),
    ).toEqual({ mode: "external", allowed: false, reason: "unknown_audience" });
  });

  it("uses the canonical channel for sender policy on a tool-policy sub-surface", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        agents: identityConfig.agents,
        tools: {
          toolsBySender: {
            "channel:discord:speaker-1": { deny: ["exec"] },
          },
        },
      },
      agentId: "team-ops",
      routeMatchedBy: "binding.guild",
      messageProvider: "discord-voice",
      messageChannel: "discord",
      chatType: "channel",
      senderId: "speaker-1",
    });

    expect(profile.conversation.messageProvider).toBe("discord-voice");
    expect(profile.policy.senderPolicy).toEqual({ deny: ["exec"] });
  });
});
