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
import {
  createChannelTestPluginBase,
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
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
    let currentSenderId: string | null | undefined;

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
              compileConfiguredBinding: ({
                conversationId: configuredId,
              }: {
                conversationId: string;
              }) => ({ conversationId: configuredId }),
              matchInboundConversation: ({
                compiledBinding,
                conversationId: incomingId,
              }: {
                compiledBinding: { conversationId: string };
                conversationId: string;
              }) =>
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
          chatType: "direct" as const,
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
          chatType: "direct" as const,
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
          expect(params.requireAudienceValidation).toBe(true);
          expect(params.audienceEvidence).toEqual(
            expect.arrayContaining([
              { source: "route", value: "room:@alice:example.org" },
              { source: "origin-native", value: "!dm:example.org" },
            ]),
          );
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
              audienceValidated: true,
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

  it("accepts a canonical shared address when the provider has no current-route resolver", async () => {
    const sessionKey = "agent:team-ops:slack:group:g123";

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: {
          agents: identityConfig.agents,
          bindings: [{ agentId: "team-ops", match: { channel: "slack" } }],
        },
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "slack-shared-canonical-address",
          updatedAt: 1,
          chatType: "group",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:G123", chatType: "group" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "group",
            from: "slack:group:G123",
            to: "channel:G123",
            nativeChannelId: "G123",
            nativeProvider: "slack",
          },
          groupId: "G123",
        },
        audienceless: "deny",
        resolvePluginRoute: async () => ({
          kind: "unsupported",
          effectiveAccountId: "default",
        }),
      }),
    ).resolves.toMatchObject({
      decision: {
        mode: "organization",
        allowed: true,
        reason: "bound_service_agent",
      },
      routeMatchedBy: "binding.account",
      messageProvider: "slack",
      chatType: "group",
    });
  });

  it("requires provider proof before treating a shared address as direct", async () => {
    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: {
          agents: identityConfig.agents,
          bindings: [{ agentId: "team-ops", match: { channel: "slack" } }],
        },
        agentId: "team-ops",
        sessionKey: "agent:team-ops:main",
        sessionEntry: {
          sessionId: "slack-shared-address-marked-direct",
          updatedAt: 1,
          chatType: "direct",
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:C123", chatType: "direct" },
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          expect(params.requireAudienceValidation).toBe(true);
          expect(params.audienceEvidence).toEqual([{ source: "route", value: "channel:C123" }]);
          return { kind: "unsupported", effectiveAccountId: "default" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
  });

  it("prefers the direct session route over stale top-level group metadata", async () => {
    const sessionKey = "agent:team-ops:slack:direct:U123";
    let resolvedChatType: string | undefined;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: {
          agents: identityConfig.agents,
          bindings: [{ agentId: "team-ops", match: { channel: "slack" } }],
        },
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "slack-direct-after-shared",
          updatedAt: 1,
          channel: "slack",
          chatType: "channel",
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          resolvedChatType = params.chatType;
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: "slack",
              accountId: "default",
              sessionKey,
              mainSessionKey: "agent:team-ops:main",
              lastRoutePolicy: "session",
              matchedBy: "binding.channel",
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: { mode: "organization", allowed: true, reason: "bound_service_agent" },
      chatType: "direct",
    });
    expect(resolvedChatType).toBe("direct");
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
          chatType: "direct" as const,
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
          chatType: "direct" as const,
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

  it("ignores an internal overlay target when proving an external group audience", async () => {
    const sessionKey = "agent:team-ops:main";

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "service-main-external-group",
          updatedAt: 1,
          chatType: "channel",
          channel: "webchat",
          groupId: "C123",
          space: "G123",
          lastChannel: "discord",
          lastTo: "channel:C123",
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
            nativeChannelId: "C123",
            nativeProvider: "discord",
          },
        },
        audienceless: "internal",
        resolvePluginRoute: async (params) => {
          expect(params).toMatchObject({
            channel: "discord",
            target: "channel:C123",
            conversationId: "C123",
            groupSpace: "G123",
          });
          expect(params.requireAudienceValidation).toBeFalsy();
          expect(params.audienceEvidence).toBeUndefined();
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: "discord",
              accountId: "default",
              sessionKey,
              mainSessionKey: sessionKey,
              lastRoutePolicy: "session",
              matchedBy: "binding.guild",
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
      routeMatchedBy: "binding.guild",
      messageProvider: "discord",
      chatType: "channel",
    });
  });

  it("does not use native group evidence owned by another provider", async () => {
    const sessionKey = "agent:team-ops:main";

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "service-main-other-native-group",
          updatedAt: 1,
          chatType: "channel",
          channel: "webchat",
          groupId: "C-old",
          groupChannel: "#stale-other-provider",
          lastChannel: "discord",
          lastTo: "channel:C999",
          lastAccountId: "default",
          origin: {
            provider: "webchat",
            surface: "webchat",
            chatType: "direct",
            to: "session:team-ops",
            nativeChannelId: "C123",
            nativeProvider: "slack",
          },
        },
        audienceless: "internal",
        resolvePluginRoute: async (params) => {
          expect(params).toMatchObject({
            channel: "discord",
            target: "channel:C999",
          });
          expect(params.conversationId).toBeUndefined();
          expect(params.requireAudienceValidation).toBeFalsy();
          expect(params.audienceEvidence).toBeUndefined();
          return {
            kind: "resolved",
            route: {
              agentId: "team-ops",
              channel: "discord",
              accountId: "default",
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
      chatType: "channel",
    });
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
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
  });

  it("resolves an omitted account through the channel default", async () => {
    const sessionKey = "agent:personal:slack:direct:U999";
    let resolvedAccountId: string | null | undefined;
    const plugin = createOutboundTestPlugin({
      id: "slack",
      outbound: createDirectOutboundTestAdapter({ channel: "slack" }),
      messaging: {
        resolveCurrentConversationRoute: (params) => {
          resolvedAccountId = params.accountId;
          return {
            agentId: "personal",
            channel: "slack",
            accountId: params.accountId ?? "unexpected",
            sessionKey,
            matchedBy: "default" as const,
          };
        },
      },
    });
    plugin.config.listAccountIds = () => ["primary", "work"];
    plugin.config.defaultAccountId = () => "primary";
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin,
        },
      ]),
    );

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "personal",
        sessionKey,
        sessionEntry: {
          sessionId: "personal-new-peer-with-old-account",
          updatedAt: 1,
          route: {
            channel: "slack",
            target: { to: "user:U999", chatType: "direct" },
          },
          origin: {
            provider: "slack",
            chatType: "direct",
            from: "slack:U999",
            to: "user:U999",
            nativeChannelId: "D999",
            nativeDirectUserId: "U999",
            nativeProvider: "slack",
          },
        },
        audienceless: "deny",
      }),
    ).resolves.toMatchObject({
      decision: { mode: "external", allowed: false, reason: "untrusted_direct" },
    });
    expect(resolvedAccountId).toBe("primary");
  });

  it("requires channel-owned proof when direct peer facts conflict", async () => {
    let routeLookupCalled = false;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "personal",
        sessionKey: "agent:personal:main",
        sessionEntry: {
          sessionId: "personal-conflicting-direct-peer",
          updatedAt: 1,
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "user:D999", chatType: "direct" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "direct",
            from: "slack:U999",
            to: "user:D999",
            nativeChannelId: "D999",
            nativeDirectUserId: "U999",
            nativeSenderId: "U999",
            nativeProvider: "slack",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => {
          routeLookupCalled = true;
          return { kind: "unsupported" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
    expect(routeLookupCalled).toBe(true);
  });

  it("rejects contradictory persisted direct senders before route lookup", async () => {
    let routeLookupCalled = false;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "personal",
        sessionKey: "agent:personal:matrix:channel:!dm:example.org",
        sessionEntry: {
          sessionId: "matrix-conflicting-direct-senders",
          updatedAt: 1,
          channel: "matrix",
          chatType: "group",
          origin: {
            provider: "matrix",
            accountId: "default",
            chatType: "direct",
            from: "matrix:@bob:example.org",
            to: "room:!dm:example.org",
            nativeChannelId: "!dm:example.org",
            nativeDirectUserId: "@alice:example.org",
            nativeSenderId: "@alice:example.org",
            nativeProvider: "matrix",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => {
          routeLookupCalled = true;
          return { kind: "unsupported" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
    expect(routeLookupCalled).toBe(false);
  });

  it("requires channel-owned proof when persisted direct targets disagree without origin metadata", async () => {
    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "personal",
        sessionKey: "agent:personal:main",
        sessionEntry: {
          sessionId: "personal-conflicting-direct-targets",
          updatedAt: 1,
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "user:U123", chatType: "direct" },
          },
          lastChannel: "slack",
          lastAccountId: "default",
          lastTo: "user:U999",
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          expect(params).toMatchObject({
            channel: "slack",
            target: "user:U123",
            requireAudienceValidation: true,
            audienceEvidence: [
              { source: "route", value: "user:U123" },
              { source: "last", value: "user:U999" },
            ],
          });
          return { kind: "unsupported" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
  });

  it("requires channel-owned proof for conflicting group audience evidence", async () => {
    const sessionKey = "agent:team-ops:discord:channel:C999";
    const sessionEntry = {
      sessionId: "team-new-discord-channel",
      updatedAt: 1,
      groupId: "C999",
      space: "guild-old",
      route: {
        channel: "discord",
        accountId: "default",
        target: { to: "channel:C999", chatType: "channel" as const },
      },
      origin: {
        provider: "discord",
        accountId: "default",
        chatType: "channel" as const,
        to: "channel:C999",
        nativeChannelId: "C123",
        nativeProvider: "discord",
      },
    };
    const currentRoute = {
      agentId: "team-ops",
      channel: "discord",
      accountId: "default",
      sessionKey,
      mainSessionKey: "agent:team-ops:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.guild" as const,
    };
    const blindResult = await resolvePersistedConversationIdentityContext({
      cfg: identityConfig,
      agentId: "team-ops",
      sessionKey,
      sessionEntry,
      audienceless: "deny",
      resolvePluginRoute: async (params) => {
        expect(params).toMatchObject({
          target: "channel:C999",
          conversationId: "C123",
          groupSpace: "guild-old",
          requireAudienceValidation: true,
          audienceEvidence: expect.arrayContaining([
            { source: "route", value: "channel:C999" },
            { source: "origin-native", value: "C123" },
          ]),
        });
        return { kind: "resolved", route: currentRoute };
      },
    });
    expect(blindResult).toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry,
        audienceless: "deny",
        resolvePluginRoute: async () => ({
          kind: "resolved",
          route: { ...currentRoute, audienceValidated: true },
        }),
      }),
    ).resolves.toMatchObject({
      decision: { mode: "organization", allowed: true, reason: "bound_service_agent" },
      routeMatchedBy: "binding.guild",
    });

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry,
        audienceless: "deny",
        resolvePluginRoute: async () => ({
          kind: "resolved",
          route: {
            ...currentRoute,
            accountId: "other",
            audienceValidated: true,
          },
        }),
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
  });

  it("treats equivalent explicit shared target kinds as one audience", async () => {
    const sessionKey = "agent:team-ops:msteams:group:19:conversation@thread.tacv2";

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey,
        sessionEntry: {
          sessionId: "teams-explicit-kind-conflict",
          updatedAt: 1,
          groupId: "19:conversation@thread.tacv2",
          route: {
            channel: "msteams",
            accountId: "default",
            target: {
              to: "group:19:conversation@thread.tacv2",
              chatType: "group",
            },
          },
          origin: {
            provider: "msteams",
            accountId: "default",
            chatType: "group",
            nativeChannelId: "channel:19:conversation@thread.tacv2",
            nativeProvider: "msteams",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          expect(params.requireAudienceValidation).toBe(false);
          expect(params.audienceEvidence).toBeUndefined();
          return { kind: "unresolved" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
  });

  it("rejects conflicting persisted account ownership before route lookup", async () => {
    let routeLookupCalled = false;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey: "agent:team-ops:matrix:channel:room-1",
        sessionEntry: {
          sessionId: "matrix-account-conflict",
          updatedAt: 1,
          route: {
            channel: "matrix",
            accountId: "default",
            target: { to: "room:room-1", chatType: "channel" },
          },
          lastChannel: "matrix",
          lastTo: "room:room-1",
          lastAccountId: "other",
          origin: {
            provider: "matrix",
            accountId: "default",
            chatType: "channel",
            nativeChannelId: "room-1",
            nativeProvider: "matrix",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => {
          routeLookupCalled = true;
          return { kind: "unsupported" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
    expect(routeLookupCalled).toBe(false);
  });

  it("rejects a selected-provider account conflict even when direct peers disagree", async () => {
    let routeLookupCalled = false;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "personal",
        sessionKey: "agent:personal:main",
        sessionEntry: {
          sessionId: "slack-account-and-peer-conflict",
          updatedAt: 1,
          route: {
            channel: "slack",
            accountId: "primary",
            target: { to: "user:U123", chatType: "direct" },
          },
          origin: {
            provider: "slack",
            accountId: "other",
            chatType: "direct",
            from: "slack:U999",
            to: "user:U999",
            nativeDirectUserId: "U999",
            nativeSenderId: "U999",
            nativeProvider: "slack",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => {
          routeLookupCalled = true;
          return { kind: "unsupported" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
    expect(routeLookupCalled).toBe(false);
  });

  it("rejects conflicting persisted thread ownership before route lookup", async () => {
    let routeLookupCalled = false;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "team-ops",
        sessionKey: "agent:team-ops:slack:channel:C123:thread:thread-a",
        sessionEntry: {
          sessionId: "slack-thread-conflict",
          updatedAt: 1,
          route: {
            channel: "slack",
            accountId: "default",
            target: { to: "channel:C123", chatType: "channel" },
            thread: { id: "thread-b" },
          },
          origin: {
            provider: "slack",
            accountId: "default",
            chatType: "channel",
            nativeChannelId: "C123",
            nativeProvider: "slack",
            threadId: "thread-a",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => {
          routeLookupCalled = true;
          return { kind: "unsupported" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
    expect(routeLookupCalled).toBe(false);
  });

  it("normalizes a peer-scoped direct topic before comparing native thread facts", async () => {
    const sessionKey = "agent:personal:telegram:direct:1234:thread:1234:42";
    let resolvedThreadId: string | number | null | undefined;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "personal",
        sessionKey,
        sessionEntry: {
          sessionId: "telegram-direct-topic",
          updatedAt: 1,
          route: {
            channel: "telegram",
            accountId: "default",
            target: { to: "user:1234", chatType: "direct" },
            thread: { id: 42 },
          },
          lastChannel: "telegram",
          lastTo: "user:1234",
          lastAccountId: "default",
          lastThreadId: 42,
          origin: {
            provider: "telegram",
            accountId: "default",
            chatType: "direct",
            from: "telegram:1234",
            to: "user:1234",
            nativeChannelId: "1234",
            nativeDirectUserId: "1234",
            nativeSenderId: "1234",
            nativeProvider: "telegram",
            threadId: 42,
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async (params) => {
          resolvedThreadId = params.threadId;
          return {
            kind: "resolved",
            route: {
              agentId: "personal",
              channel: "telegram",
              accountId: "default",
              sessionKey,
              mainSessionKey: "agent:personal:main",
              lastRoutePolicy: "session",
              matchedBy: "default",
              senderIsOwner: true,
            },
          };
        },
      }),
    ).resolves.toMatchObject({
      decision: { mode: "personal", allowed: true, reason: "owner_direct" },
    });
    expect(resolvedThreadId).toBe("42");
  });

  it("rejects an unproven peer-scoped thread suffix", async () => {
    let routeLookupCalled = false;

    await expect(
      resolvePersistedConversationIdentityContext({
        cfg: identityConfig,
        agentId: "personal",
        sessionKey: "agent:personal:telegram:direct:1234:thread:9999:42",
        sessionEntry: {
          sessionId: "telegram-unproven-direct-topic",
          updatedAt: 1,
          route: {
            channel: "telegram",
            accountId: "default",
            target: { to: "user:1234", chatType: "direct" },
          },
          origin: {
            provider: "telegram",
            accountId: "default",
            chatType: "direct",
            from: "telegram:1234",
            to: "user:1234",
            nativeChannelId: "1234",
            nativeDirectUserId: "1234",
            nativeSenderId: "1234",
            nativeProvider: "telegram",
          },
        },
        audienceless: "deny",
        resolvePluginRoute: async () => {
          routeLookupCalled = true;
          return { kind: "unsupported" };
        },
      }),
    ).resolves.toEqual({
      decision: { mode: "external", allowed: false, reason: "stale_route" },
    });
    expect(routeLookupCalled).toBe(false);
  });

  it.each([
    {
      name: "direct evidence for a shared route",
      routeTarget: "group:shared-1",
      originTarget: "user:shared-1",
      requiresChannelProof: true,
    },
    {
      name: "a channel target for a group route",
      routeTarget: "channel:shared-1",
      originTarget: "shared-1",
      requiresChannelProof: false,
    },
  ])(
    "classifies $name before channel proof",
    async ({ routeTarget, originTarget, requiresChannelProof }) => {
      const sessionKey = "agent:team-ops:msteams:group:shared-1";

      await expect(
        resolvePersistedConversationIdentityContext({
          cfg: identityConfig,
          agentId: "team-ops",
          sessionKey,
          sessionEntry: {
            sessionId: "teams-generic-kind-conflict",
            updatedAt: 1,
            groupId: "shared-1",
            route: {
              channel: "msteams",
              accountId: "default",
              target: { to: routeTarget, chatType: "group" },
            },
            origin: {
              provider: "msteams",
              accountId: "default",
              chatType: "group",
              nativeChannelId: originTarget,
              nativeProvider: "msteams",
            },
          },
          audienceless: "deny",
          resolvePluginRoute: async (params) => {
            expect(params.requireAudienceValidation).toBe(requiresChannelProof);
            if (requiresChannelProof) {
              expect(params.audienceEvidence).toEqual(
                expect.arrayContaining([
                  { source: "route", value: routeTarget },
                  { source: "origin-native", value: originTarget },
                ]),
              );
            } else {
              expect(params.audienceEvidence).toBeUndefined();
            }
            return { kind: "unresolved" };
          },
        }),
      ).resolves.toEqual({
        decision: { mode: "external", allowed: false, reason: "stale_route" },
      });
    },
  );

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
