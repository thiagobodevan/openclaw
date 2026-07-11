import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
// Discord tests cover outbound session route plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as discordClient from "./client.js";
import * as discordApi from "./internal/api.js";
import {
  resolveDiscordCurrentConversationRoute,
  resolveDiscordOutboundSessionRoute,
} from "./outbound-session-route.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveDiscordOutboundSessionRoute", () => {
  it("revalidates a direct conversation against the current service route", async () => {
    const route = await resolveDiscordCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "direct", id: "user-1" },
            },
          },
        ],
      },
      accountId: "default",
      target: "user:user-1",
      conversationId: "dm-1",
      chatType: "direct",
      senderId: "user-1",
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:main",
      matchedBy: "binding.peer",
    });
  });

  it("revalidates a thread against a service binding inherited from its parent", async () => {
    vi.spyOn(discordClient, "createDiscordRestClient").mockReturnValue({
      token: "test-token",
      rest: {} as never,
      account: {} as never,
    });
    vi.spyOn(discordApi, "getChannel").mockResolvedValue({
      id: "thread-1",
      parent_id: "parent-1",
    } as never);

    const route = await resolveDiscordCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel", id: "parent-1" },
            },
          },
        ],
      },
      accountId: "default",
      target: "channel:thread-1",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      chatType: "channel",
    });

    expect(route).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:discord:channel:thread-1",
      matchedBy: "binding.peer.parent",
    });
  });

  it("rejects a parent-inherited route after the thread moves", async () => {
    vi.spyOn(discordClient, "createDiscordRestClient").mockReturnValue({
      token: "test-token",
      rest: {} as never,
      account: {} as never,
    });
    vi.spyOn(discordApi, "getChannel").mockResolvedValue({
      id: "thread-1",
      parent_id: "other-parent",
    } as never);

    await expect(
      resolveDiscordCurrentConversationRoute({
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
          bindings: [
            {
              agentId: "service",
              match: {
                channel: "discord",
                accountId: "default",
                peer: { kind: "channel", id: "parent-1" },
              },
            },
          ],
        },
        accountId: "default",
        target: "channel:thread-1",
        conversationId: "thread-1",
        parentConversationId: "parent-1",
        chatType: "channel",
      }),
    ).resolves.toBeNull();
  });

  it("re-fetches current member roles before accepting a role-scoped service route", async () => {
    const get = vi.fn();
    vi.spyOn(discordClient, "createDiscordRestClient").mockReturnValue({
      token: "test-token",
      rest: { get } as never,
      account: {} as never,
    });
    vi.spyOn(discordApi, "getGuildMember").mockResolvedValue({
      roles: ["operator"],
    } as never);

    const route = await resolveDiscordCurrentConversationRoute({
      cfg: {
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
      },
      accountId: "default",
      target: "channel:channel-1",
      conversationId: "channel-1",
      chatType: "channel",
      groupSpace: "guild-1",
      senderId: "user-1",
    });

    expect(discordApi.getGuildMember).toHaveBeenCalledWith(expect.anything(), "guild-1", "user-1");
    expect(route).toMatchObject({
      agentId: "service",
      matchedBy: "binding.guild+roles",
    });
  });

  it("fails closed when current Discord role proof is unavailable", async () => {
    vi.spyOn(discordClient, "createDiscordRestClient").mockImplementation(() => {
      throw new Error("unavailable");
    });

    await expect(
      resolveDiscordCurrentConversationRoute({
        cfg: {
          bindings: [
            {
              agentId: "service",
              match: {
                channel: "discord",
                guildId: "guild-1",
                roles: ["operator"],
              },
            },
          ],
        },
        accountId: "default",
        target: "channel:channel-1",
        conversationId: "channel-1",
        chatType: "channel",
        groupSpace: "guild-1",
        senderId: "user-1",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when a role-scoped route has no persisted sender", async () => {
    const createClient = vi.spyOn(discordClient, "createDiscordRestClient");

    await expect(
      resolveDiscordCurrentConversationRoute({
        cfg: {
          agents: {
            list: [
              { id: "personal", default: true },
              { id: "service" },
              { id: "restricted-service" },
            ],
          },
          bindings: [
            {
              agentId: "service",
              match: {
                channel: "discord",
                guildId: "guild-1",
              },
            },
            {
              agentId: "restricted-service",
              match: {
                channel: "discord",
                guildId: "guild-1",
                roles: ["operator"],
              },
            },
          ],
        },
        accountId: "default",
        target: "channel:channel-1",
        conversationId: "channel-1",
        chatType: "channel",
        groupSpace: "guild-1",
      }),
    ).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("does not fetch member roles for an unrelated role-scoped binding", async () => {
    const createClient = vi
      .spyOn(discordClient, "createDiscordRestClient")
      .mockImplementation(() => {
        throw new Error("must not fetch");
      });

    const route = await resolveDiscordCurrentConversationRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel", id: "channel-1" },
            },
          },
          {
            agentId: "other-service",
            match: {
              channel: "discord",
              accountId: "default",
              guildId: "guild-2",
              roles: ["operator"],
            },
          },
        ],
      },
      accountId: "default",
      target: "channel:channel-1",
      conversationId: "channel-1",
      chatType: "channel",
      groupSpace: "guild-1",
      senderId: "user-1",
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(route).toMatchObject({
      agentId: "service",
      matchedBy: "binding.peer",
    });
  });

  it("rejects a non-direct target that disagrees with its native conversation", async () => {
    await expect(
      resolveDiscordCurrentConversationRoute({
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
          bindings: [
            {
              agentId: "service",
              match: {
                channel: "discord",
                accountId: "default",
                peer: { kind: "channel", id: "stale-channel" },
              },
            },
          ],
        },
        accountId: "default",
        target: "channel:current-channel",
        conversationId: "stale-channel",
        chatType: "channel",
      }),
    ).resolves.toBeNull();
  });

  it("rejects direct audience evidence for a shared channel with the same id", async () => {
    await expect(
      resolveDiscordCurrentConversationRoute({
        cfg: {},
        accountId: "default",
        target: "channel:123",
        conversationId: "123",
        chatType: "channel",
        audienceEvidence: [
          { source: "route", value: "channel:123" },
          { source: "origin-native", value: "user:123" },
        ],
        requireAudienceValidation: true,
      }),
    ).resolves.toBeNull();
  });

  it("proves equivalent persisted channel forms with channel-owned parsing", async () => {
    const route = await resolveDiscordCurrentConversationRoute({
      cfg: {},
      accountId: "default",
      target: "channel:current-channel",
      conversationId: "current-channel",
      chatType: "channel",
      audienceEvidence: [
        { source: "route", value: "channel:current-channel" },
        { source: "origin-native", value: "current-channel" },
      ],
      requireAudienceValidation: true,
    });

    expect(route).toMatchObject({
      channel: "discord",
      audienceValidated: true,
    });
  });

  it("keeps explicit delivery thread ids without adding a session suffix", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      threadId: "thread-1",
    });

    expect(route).toEqual({
      baseSessionKey: "agent:main:discord:channel:123",
      chatType: "channel",
      from: "discord:channel:123",
      peer: { kind: "channel", id: "123" },
      sessionKey: "agent:main:discord:channel:123",
      threadId: "thread-1",
      to: "channel:123",
    });
  });

  it("does not promote replyToId into Discord delivery thread metadata", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      replyToId: "message-1",
    });

    expect(route).toEqual({
      baseSessionKey: "agent:main:discord:channel:123",
      chatType: "channel",
      from: "discord:channel:123",
      peer: { kind: "channel", id: "123" },
      sessionKey: "agent:main:discord:channel:123",
      to: "channel:123",
    });
    expect(route?.threadId).toBeUndefined();
  });

  it("treats bare numeric outbound targets as channel routes", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "123",
    });

    expect(route).toMatchObject({
      baseSessionKey: "agent:main:discord:channel:123",
      chatType: "channel",
      from: "discord:channel:123",
      peer: { kind: "channel", id: "123" },
      sessionKey: "agent:main:discord:channel:123",
      to: "channel:123",
    });
  });
});
