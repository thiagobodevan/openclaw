// Discord tests cover monitor.agent components plugin behavior.
import { ChannelType } from "discord-api-types/v10";
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationBindingRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { peekSystemEvents, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as discordClient from "../client.js";
import * as discordApi from "../internal/api.js";
import type {
  ButtonInteraction,
  ComponentData,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import {
  enqueueSystemEventMock,
  readAllowFromStoreMock,
  requestHeartbeatMock,
  resetDiscordComponentRuntimeMocks,
  upsertPairingRequestMock,
} from "../test-support/component-runtime.js";
import {
  resolveAgentComponentRoute,
  resolveAgentComponentRouteReady,
  resolveComponentInteractionContext,
} from "./agent-components-helpers.js";
import { testing as componentDispatchTesting } from "./agent-components.dispatch.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  resolveDiscordComponentOriginatingTo,
} from "./agent-components.js";

describe("agent components", () => {
  const defaultDmSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "discord",
    accountId: "default",
    peer: { kind: "direct", id: "123456789" },
  });
  const defaultGroupDmSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "discord",
    accountId: "default",
    peer: { kind: "group", id: "group-dm-channel" },
  });

  const createCfg = (): OpenClawConfig => ({}) as OpenClawConfig;
  const createBaseDmInteraction = (overrides: Record<string, unknown> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { id: "interaction-1", channel_id: "dm-channel" },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      defer,
      reply,
      ...overrides,
    };
    return { interaction, defer, reply };
  };

  const createDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction(
      overrides as Record<string, unknown>,
    );
    return {
      interaction: interaction as unknown as ButtonInteraction,
      defer,
      reply,
    };
  };

  const createDmSelectInteraction = (overrides: Partial<StringSelectMenuInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction({
      values: ["alpha"],
      ...(overrides as Record<string, unknown>),
    });
    return {
      interaction: interaction as unknown as StringSelectMenuInteraction,
      defer,
      reply,
    };
  };

  const createGuildButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: {
        id: "interaction-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        member: { roles: ["operator"] },
      },
      channel: {
        id: "channel-1",
        type: ChannelType.GuildText,
        name: "operations",
      },
      guild: { id: "guild-1", name: "Operations" },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      reply,
      ...overrides,
    };
    return { interaction: interaction as unknown as ButtonInteraction, reply };
  };

  const firstReplyContent = (reply: ReturnType<typeof vi.fn>): string => {
    const [call] = reply.mock.calls;
    if (!call) {
      throw new Error("expected interaction reply call");
    }
    const [payload] = call;
    if (!payload || typeof payload !== "object" || !("content" in payload)) {
      throw new Error("expected interaction reply content");
    }
    const { content } = payload as { content?: unknown };
    if (typeof content !== "string") {
      throw new Error("expected interaction reply content to be a string");
    }
    return content;
  };

  const createBaseGroupDmInteraction = (overrides: Record<string, unknown> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { id: "interaction-1", channel_id: "group-dm-channel" },
      channel: {
        id: "group-dm-channel",
        type: ChannelType.GroupDM,
        name: "incident-room",
      },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      defer,
      reply,
      ...overrides,
    };
    return { interaction, defer, reply };
  };

  const createGroupDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseGroupDmInteraction(
      overrides as Record<string, unknown>,
    );
    return {
      interaction: interaction as unknown as ButtonInteraction,
      defer,
      reply,
    };
  };

  async function expectRejectedDmButtonInteraction(params: {
    dmPolicy: "pairing" | "open";
    expectPairingStoreRead: boolean;
    allowFrom?: string[];
  }) {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom,
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    if (params.expectPairingStoreRead) {
      expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
    } else {
      expect(readAllowFromStoreMock).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    resetDiscordComponentRuntimeMocks();
    resetSystemEventsForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    vi.restoreAllMocks();
  });

  it("uses the live runtime binding for shared component callbacks", () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) =>
        conversation.conversationId === "thread-1"
          ? {
              bindingId: "discord:default:thread-1",
              targetSessionKey: "agent:service:subagent:bound",
              targetKind: "subagent",
              conversation,
              status: "active",
              boundAt: 1,
              metadata: { boundBy: "owner" },
            }
          : null,
    });

    const route = resolveAgentComponentRoute({
      ctx: {
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        },
        accountId: "default",
      },
      rawGuildId: "guild-1",
      memberRoleIds: [],
      isDirectMessage: false,
      isGroupDm: false,
      userId: "user-1",
      channelId: "thread-1",
      parentId: "channel-1",
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:subagent:bound",
      matchedBy: "binding.channel",
    });
  });

  it("rejects plugin-owned bindings before component enqueue and wake", async () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) =>
        conversation.conversationId === "user:123456789"
          ? {
              bindingId: "discord:default:user:123456789",
              targetSessionKey: "agent:service:plugin:owned",
              targetKind: "session",
              conversation,
              status: "active",
              boundAt: 1,
              metadata: {
                pluginBindingOwner: "plugin",
                pluginId: "service-plugin",
                pluginRoot: "/plugins/service",
              },
            }
          : null,
    });
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("ignores persisted component routing that no longer matches the live binding", () => {
    const route = {
      agentId: "personal",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:personal:discord:channel:thread-1",
      mainSessionKey: "agent:personal:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    };

    expect(
      componentDispatchTesting.applyMatchingDiscordComponentRouteOverrides(route, {
        agentId: "service",
        sessionKey: "agent:service:subagent:stale",
      }),
    ).toBeNull();
  });

  it("resolves and readies configured service bindings for component callbacks", async () => {
    const serviceRoute = {
      agentId: "service",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:service:acp:binding:discord:default:thread-1",
      mainSessionKey: "agent:service:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.channel" as const,
    };
    const bindingResolution = {
      statefulTarget: {
        agentId: "service",
        sessionKey: serviceRoute.sessionKey,
      },
    };
    vi.spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute").mockReturnValue({
      route: serviceRoute,
      boundAgentId: "service",
      boundSessionKey: serviceRoute.sessionKey,
      bindingResolution,
    } as never);
    const ensureReady = vi
      .spyOn(conversationBindingRuntime, "ensureConfiguredBindingRouteReady")
      .mockResolvedValue({ ok: true });

    const route = await resolveAgentComponentRouteReady({
      ctx: {
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        },
        accountId: "default",
      },
      rawGuildId: "guild-1",
      memberRoleIds: [],
      isDirectMessage: false,
      isGroupDm: false,
      userId: "user-1",
      channelId: "thread-1",
      parentId: "channel-1",
    });

    expect(route).toEqual(serviceRoute);
    expect(ensureReady).toHaveBeenCalledOnce();
  });

  it("rejects shared personal component bindings before preparing their runtime", async () => {
    const personalRoute = {
      agentId: "personal",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:personal:acp:binding:discord:default:thread-1",
      mainSessionKey: "agent:personal:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.channel" as const,
    };
    vi.spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute").mockReturnValue({
      route: personalRoute,
      boundAgentId: "personal",
      boundSessionKey: personalRoute.sessionKey,
      bindingResolution: {
        statefulTarget: {
          agentId: "personal",
          sessionKey: personalRoute.sessionKey,
        },
      },
    } as never);
    const ensureReady = vi.spyOn(conversationBindingRuntime, "ensureConfiguredBindingRouteReady");

    await expect(
      resolveAgentComponentRouteReady({
        ctx: {
          cfg: { agents: { list: [{ id: "personal", default: true }] } },
          accountId: "default",
        },
        rawGuildId: "guild-1",
        memberRoleIds: [],
        isDirectMessage: false,
        isGroupDm: false,
        userId: "user-1",
        channelId: "thread-1",
        parentId: "channel-1",
      }),
    ).resolves.toBeNull();
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("rejects unbound shared component routes before preparing their runtime", async () => {
    const personalRoute = {
      agentId: "personal",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:personal:discord:channel:thread-1",
      mainSessionKey: "agent:personal:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "default" as const,
    };
    vi.spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute").mockReturnValue({
      route: personalRoute,
      boundAgentId: null,
      boundSessionKey: null,
      bindingResolution: null,
    } as never);
    const ensureReady = vi.spyOn(conversationBindingRuntime, "ensureConfiguredBindingRouteReady");

    await expect(
      resolveAgentComponentRouteReady({
        ctx: {
          cfg: { agents: { list: [{ id: "personal", default: true }] } },
          accountId: "default",
        },
        rawGuildId: "guild-1",
        memberRoleIds: [],
        isDirectMessage: false,
        isGroupDm: false,
        userId: "user-1",
        channelId: "thread-1",
        parentId: "channel-1",
      }),
    ).resolves.toBeNull();
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("denies an unbound personal DM before reading or writing pairing state", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("keeps pairing available on an explicitly bound service DM", async () => {
    const serviceRoute = {
      agentId: "service",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:service:discord:direct:123456789",
      mainSessionKey: "agent:service:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.peer" as const,
    };
    vi.spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute").mockReturnValue({
      route: serviceRoute,
      boundAgentId: "service",
      boundSessionKey: serviceRoute.sessionKey,
      bindingResolution: null,
    } as never);
    const button = createAgentComponentButton({
      cfg: { agents: { list: [{ id: "personal", default: true }, { id: "service" }] } },
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    const pairingText = firstReplyContent(reply);
    const code = expectPairingReplyText(pairingText, {
      channel: "discord",
      idLine: "Your Discord user id: 123456789",
    });
    expect(pairingText).toContain(`openclaw pairing approve discord ${code}`);
    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
  });

  it("blocks DM interactions in allowlist mode when sender is not in configured allowFrom", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("classifies Group DM component interactions separately from direct messages", async () => {
    const { interaction, defer } = createGroupDmButtonInteraction();

    const ctx = await resolveComponentInteractionContext({
      interaction,
      label: "group-dm-test",
      defer: false,
    });

    expect(defer).not.toHaveBeenCalled();
    expect(ctx).toEqual({
      channelId: "group-dm-channel",
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      username: "Alice#1234",
      userId: "123456789",
      replyOpts: { ephemeral: true },
      isDirectMessage: false,
      isGroupDm: true,
      memberRoleIds: [],
      rawGuildId: undefined,
    });
  });

  it("blocks Group DM interactions that are not allowlisted even when dmPolicy is open", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "open",
      discordConfig: {
        dm: {
          groupEnabled: true,
          groupChannels: ["other-group-dm"],
        },
      } as DiscordAccountConfig,
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultGroupDmSessionKey)).toStrictEqual([]);
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("does not route an allowlisted Group DM interaction to the personal session", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "disabled",
      discordConfig: {
        dm: {
          groupEnabled: true,
          groupChannels: ["group-dm-channel"],
        },
      } as DiscordAccountConfig,
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("does not treat pairing-store entries as personal owners", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    await expectRejectedDmButtonInteraction({
      dmPolicy: "pairing",
      expectPairingStoreRead: false,
    });
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("does not treat open-mode wildcard access as personal ownership", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    await expectRejectedDmButtonInteraction({
      dmPolicy: "open",
      expectPairingStoreRead: false,
      allowFrom: ["*"],
    });
  });

  it("uses user conversation ids for direct-message component originating targets", () => {
    expect(
      resolveDiscordComponentOriginatingTo({
        isDirectMessage: true,
        userId: "123456789",
        channelId: "dm-channel",
      }),
    ).toBe("user:123456789");
    expect(
      resolveDiscordComponentOriginatingTo({
        isDirectMessage: false,
        userId: "123456789",
        channelId: "guild-channel",
      }),
    ).toBe("channel:guild-channel");
  });

  it("blocks DM component interactions in disabled mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "disabled",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("does not use display-name allowlist matches as personal ownership", async () => {
    const select = createAgentSelectMenu({
      cfg: createCfg(),
      accountId: "default",
      discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
      dmPolicy: "allowlist",
      allowFrom: ["Alice#1234"],
    });
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this select menu.",
      ephemeral: true,
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("accepts cid payloads for agent button interactions", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello_cid" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello_cid clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello_cid:123456789:interaction-1",
        contextMode: "exact",
        actor: { channel: "discord", accountId: "default", senderId: "123456789" },
        deliveryContext: {
          channel: "discord",
          to: "user:123456789",
          accountId: "default",
        },
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "channel-interaction",
      intent: "immediate",
      reason: "hook:discord-interaction",
      agentId: "main",
      sessionKey: defaultDmSessionKey,
      heartbeat: { target: "last" },
      conversation: expect.objectContaining({
        messageChannel: "discord",
        accountId: "default",
        routeMatchedBy: "default",
        chatType: "direct",
        systemEventContextKey: "discord:agent-button:dm-channel:hello_cid:123456789:interaction-1",
        senderId: "123456789",
        resolveCurrentRoute: expect.any(Function),
      }),
    });
    const currentRoute = await (
      requestHeartbeatMock.mock.calls[0]?.[0] as {
        conversation: { resolveCurrentRoute: (cfg: OpenClawConfig) => Promise<unknown> };
      }
    ).conversation.resolveCurrentRoute(createCfg());
    expect(currentRoute).toMatchObject({
      agentId: "main",
      sessionKey: defaultDmSessionKey,
      matchedBy: "default",
    });
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("uses one agent-qualified component queue key for a global service main", async () => {
    const serviceRoute = {
      agentId: "service",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:service:main",
      mainSessionKey: "global",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.peer" as const,
    };
    vi.spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute").mockReturnValue({
      route: serviceRoute,
      boundAgentId: "service",
      boundSessionKey: serviceRoute.sessionKey,
      bindingResolution: null,
    } as never);
    const button = createAgentComponentButton({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        session: { scope: "global", mainKey: "work" },
      },
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionKey: "agent:service:work" }),
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "service",
        sessionKey: "agent:service:work",
      }),
    );
    const currentRoute = await (
      requestHeartbeatMock.mock.calls[0]?.[0] as {
        conversation: { resolveCurrentRoute: (cfg: OpenClawConfig) => Promise<unknown> };
      }
    ).conversation.resolveCurrentRoute({
      agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      session: { scope: "global", mainKey: "work" },
    });
    expect(currentRoute).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:work",
    });
  });

  it.each([
    { name: "role removal", memberRoles: [] as string[], lookupError: false },
    { name: "role lookup failure", memberRoles: [] as string[], lookupError: true },
  ])("revalidates deferred component admission after $name", async (testCase) => {
    vi.spyOn(discordClient, "createDiscordRestClient").mockReturnValue({
      token: "test-token",
      rest: { get: vi.fn() } as never,
      account: {} as never,
    });
    const getMember = vi.spyOn(discordApi, "getGuildMember");
    if (testCase.lookupError) {
      getMember.mockRejectedValue(new Error("unavailable"));
    } else {
      getMember.mockResolvedValue({ roles: testCase.memberRoles } as never);
    }
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      bindings: [
        {
          agentId: "service",
          match: {
            channel: "discord",
            accountId: "default",
            guildId: "guild-1",
            roles: ["operator"],
          },
        },
      ],
    };
    const button = createAgentComponentButton({
      cfg,
      accountId: "default",
      discordConfig: { groupPolicy: "open" } as DiscordAccountConfig,
    });
    const { interaction } = createGuildButtonInteraction();

    await button.run(interaction, { componentId: "restart" } as ComponentData);

    expect(requestHeartbeatMock).toHaveBeenCalledOnce();
    const wake = requestHeartbeatMock.mock.calls[0]?.[0] as {
      agentId: string;
      conversation: {
        resolveCurrentRoute: (currentCfg: OpenClawConfig) => Promise<{
          agentId: string;
        } | null>;
      };
    };
    expect(wake.agentId).toBe("service");
    const currentRoute = await wake.conversation.resolveCurrentRoute(cfg);
    expect(discordApi.getGuildMember).toHaveBeenCalledWith(
      expect.anything(),
      "guild-1",
      "123456789",
    );
    if (testCase.lookupError) {
      expect(currentRoute).toBeNull();
    } else {
      expect(currentRoute).toMatchObject({ agentId: "personal" });
    }
  });

  it("isolates repeated component events by interaction id", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const first = createDmButtonInteraction();
    const second = createDmButtonInteraction({
      rawData: { id: "interaction-2", channel_id: "dm-channel" },
    } as Partial<ButtonInteraction>);

    await button.run(first.interaction, { componentId: "hello" } as ComponentData);
    await button.run(second.interaction, { componentId: "hello" } as ComponentData);

    expect(enqueueSystemEventMock.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({
        contextKey: "discord:agent-button:dm-channel:hello:123456789:interaction-1",
      }),
      expect.objectContaining({
        contextKey: "discord:agent-button:dm-channel:hello:123456789:interaction-2",
      }),
    ]);
    expect(requestHeartbeatMock.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({
        conversation: expect.objectContaining({
          systemEventContextKey: "discord:agent-button:dm-channel:hello:123456789:interaction-1",
        }),
      }),
      expect.objectContaining({
        conversation: expect.objectContaining({
          systemEventContextKey: "discord:agent-button:dm-channel:hello:123456789:interaction-2",
        }),
      }),
    ]);
  });

  it("keeps malformed percent cid values without throwing", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello%2G" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello%2G clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello%2G:123456789:interaction-1",
        contextMode: "exact",
        actor: { channel: "discord", accountId: "default", senderId: "123456789" },
        deliveryContext: {
          channel: "discord",
          to: "user:123456789",
          accountId: "default",
        },
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });
});
