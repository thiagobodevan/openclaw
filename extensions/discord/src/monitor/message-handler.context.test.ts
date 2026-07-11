import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as discordClient from "../client.js";
import * as discordApi from "../internal/api.js";
import { resolveDiscordCurrentConversationRoute } from "../outbound-session-route.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import {
  createBaseDiscordMessageContext,
  createDiscordDirectMessageContextOverrides,
} from "./message-handler.test-harness.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discord buildDiscordMessageProcessContext sender bot status", () => {
  it("forwards bot author status to ctxPayload.SenderIsBot", async () => {
    const ctx = await createBaseDiscordMessageContext({
      author: { id: "U1", username: "alice", discriminator: "0", globalName: "Alice", bot: true },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.SenderIsBot).toBe(true);
    expect(result.ctxPayload.AgentRouteMatchedBy).toBe("default");
  });

  it("omits SenderIsBot for human authors", async () => {
    const ctx = await createBaseDiscordMessageContext();

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.SenderIsBot).toBeUndefined();
    expect(result.ctxPayload.NativeSenderId).toBe("U1");
  });

  it("carries native DM identities into persisted session metadata", async () => {
    const ctx = await createBaseDiscordMessageContext({
      ...createDiscordDirectMessageContextOverrides(),
      messageChannelId: "dm-1",
      message: {
        id: "m1",
        channelId: "dm-1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.NativeChannelId).toBe("dm-1");
    expect(result.ctxPayload.NativeSenderId).toBe("U1");
    expect(result.ctxPayload.NativeDirectUserId).toBe("U1");
  });

  it("round-trips an auto-created thread through current service-route validation", async () => {
    const cfg = {
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
    } satisfies OpenClawConfig;
    const ctx = await createBaseDiscordMessageContext({
      cfg,
      channelConfig: { autoThread: true },
      client: { rest: { post: async () => ({ id: "thread-1" }) } },
      messageChannelId: "parent-1",
      message: {
        id: "m1",
        channelId: "parent-1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      baseSessionKey: "agent:service:discord:channel:parent-1",
      route: {
        agentId: "service",
        channel: "discord",
        accountId: "default",
        matchedBy: "binding.peer",
        sessionKey: "agent:service:discord:channel:parent-1",
        mainSessionKey: "agent:service:main",
      },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload).toMatchObject({
      To: "channel:thread-1",
      SessionKey: "agent:service:discord:channel:thread-1",
      NativeChannelId: "thread-1",
      ThreadParentId: "parent-1",
    });
    vi.spyOn(discordClient, "createDiscordRestClient").mockReturnValue({
      token: "test-token",
      rest: {} as never,
      account: {} as never,
    });
    vi.spyOn(discordApi, "getChannel").mockResolvedValue({
      id: "thread-1",
      parent_id: "parent-1",
    } as never);
    await expect(
      resolveDiscordCurrentConversationRoute({
        cfg,
        accountId: "default",
        target: result.ctxPayload.To ?? "",
        conversationId: result.ctxPayload.NativeChannelId,
        parentConversationId: result.ctxPayload.ThreadParentId,
        chatType: "channel",
      }),
    ).resolves.toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:discord:channel:thread-1",
      matchedBy: "binding.peer.parent",
    });
  });

  it("round-trips the native guild id without substituting its display slug", async () => {
    const cfg = {
      agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      bindings: [
        {
          agentId: "service",
          match: { channel: "discord", accountId: "default", guildId: "guild-1" },
        },
      ],
    } satisfies OpenClawConfig;
    const ctx = await createBaseDiscordMessageContext({
      cfg,
      data: {
        guild_id: "guild-1",
        guild: { id: "guild-1", name: "Display Guild" },
      },
      guildInfo: null,
      guildSlug: "display-guild",
      route: {
        agentId: "service",
        channel: "discord",
        accountId: "default",
        matchedBy: "binding.guild",
        sessionKey: "agent:service:discord:channel:c1",
        mainSessionKey: "agent:service:main",
      },
      baseSessionKey: "agent:service:discord:channel:c1",
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.GroupSpace).toBe("guild-1");
    await expect(
      resolveDiscordCurrentConversationRoute({
        cfg,
        accountId: "default",
        target: result.ctxPayload.To ?? "",
        conversationId: result.ctxPayload.NativeChannelId,
        chatType: "channel",
        groupSpace: result.ctxPayload.GroupSpace,
      }),
    ).resolves.toMatchObject({
      agentId: "service",
      matchedBy: "binding.guild",
    });
  });

  it("omits SenderIsBot for PluralKit proxy senders despite the bot author", async () => {
    const ctx = await createBaseDiscordMessageContext({
      author: { id: "U1", username: "pk", discriminator: "0", globalName: "PK", bot: true },
      sender: { label: "user", name: "Member", tag: "member", isPluralKit: true },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.SenderIsBot).toBeUndefined();
  });
});
