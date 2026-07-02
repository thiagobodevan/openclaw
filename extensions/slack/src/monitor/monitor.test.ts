// Slack tests cover monitor plugin behavior.
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { createSlackMonitorContext, normalizeSlackChannelType } from "./context.js";

type SlackChannelConfigResult = ReturnType<typeof resolveSlackChannelConfig>;

function expectSlackChannelConfig(
  res: SlackChannelConfigResult,
  expected: {
    allowed?: boolean;
    requireMention?: boolean;
    matchKey?: string;
    matchSource?: "direct" | "wildcard";
  },
) {
  if (!res) {
    throw new Error("expected Slack channel config result");
  }
  if (expected.allowed !== undefined) {
    expect(res.allowed).toBe(expected.allowed);
  }
  if (expected.requireMention !== undefined) {
    expect(res.requireMention).toBe(expected.requireMention);
  }
  if (expected.matchKey !== undefined) {
    expect(res.matchKey).toBe(expected.matchKey);
  }
  if (expected.matchSource !== undefined) {
    expect(res.matchSource).toBe(expected.matchSource);
  }
}

describe("resolveSlackChannelConfig", () => {
  it("uses defaultRequireMention when channels config is empty", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
      defaultRequireMention: false,
    });
    expect(res).toEqual({ allowed: true, requireMention: false });
  });

  it("defaults defaultRequireMention to true when not provided", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
    });
    expect(res).toEqual({ allowed: true, requireMention: true });
  });

  it("prefers explicit channel/fallback requireMention over defaultRequireMention", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { requireMention: true } },
      defaultRequireMention: false,
    });
    expectSlackChannelConfig(res, { requireMention: true });
  });

  it("uses wildcard entries when no direct channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expectSlackChannelConfig(res, {
      allowed: true,
      requireMention: false,
      matchKey: "*",
      matchSource: "wildcard",
    });
  });

  it("merges direct bot loop protection over wildcard defaults field-by-field", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {
        "*": {
          botLoopProtection: {
            windowSeconds: 120,
            cooldownSeconds: 240,
          },
        },
        C1: {
          botLoopProtection: {
            maxEventsPerWindow: 3,
          },
        },
      },
      defaultRequireMention: true,
    });

    expect(res?.botLoopProtection).toEqual({
      maxEventsPerWindow: 3,
      windowSeconds: 120,
      cooldownSeconds: 240,
    });
  });

  it("uses direct match metadata when channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { C1: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expectSlackChannelConfig(res, {
      matchKey: "C1",
      matchSource: "direct",
    });
  });

  it("matches channel config key stored in lowercase when Slack delivers uppercase channel ID", () => {
    // Slack always delivers channel IDs in uppercase (e.g. C0ABC12345).
    // Users commonly copy them in lowercase from docs or older CLI output.
    const res = resolveSlackChannelConfig({
      channelId: "C0ABC12345", // pragma: allowlist secret
      channels: { c0abc12345: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expectSlackChannelConfig(res, { allowed: true, requireMention: false });
  });

  it("matches channel config key stored in uppercase when user types lowercase channel ID", () => {
    // Defensive: also handle the inverse direction.
    const res = resolveSlackChannelConfig({
      channelId: "c0abc12345", // pragma: allowlist secret
      channels: { C0ABC12345: { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expectSlackChannelConfig(res, { allowed: true, requireMention: false });
  });

  it("matches channel-prefixed config keys when Slack delivers a bare channel ID", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C0AJYR3BVTJ",
      channels: { "channel:C0AJYR3BVTJ": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expectSlackChannelConfig(res, {
      allowed: true,
      requireMention: false,
      matchKey: "channel:C0AJYR3BVTJ",
      matchSource: "direct",
    });
  });

  it("matches lowercase channel-prefixed config keys when Slack delivers uppercase channel IDs", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C0AJYR3BVTJ",
      channels: { "channel:c0ajyr3bvtj": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expectSlackChannelConfig(res, {
      allowed: true,
      requireMention: false,
      matchKey: "channel:c0ajyr3bvtj",
      matchSource: "direct",
    });
  });

  it("blocks channel-name route matches by default", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channelName: "ops-room",
      channels: { "ops-room": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expectSlackChannelConfig(res, { allowed: false, requireMention: true });
  });

  it("allows channel-name route matches when dangerous name matching is enabled", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channelName: "ops-room",
      channels: { "ops-room": { enabled: true, requireMention: false } },
      defaultRequireMention: true,
      allowNameMatching: true,
    });
    expectSlackChannelConfig(res, {
      allowed: true,
      requireMention: false,
      matchKey: "ops-room",
      matchSource: "direct",
    });
  });
});

const baseParams = () => ({
  cfg: {} as OpenClawConfig,
  accountId: "default",
  botToken: "token",
  app: { client: {} } as App,
  runtime: {} as RuntimeEnv,
  botUserId: "B1",
  botId: "B1",
  teamId: "T1",
  apiAppId: "A1",
  historyLimit: 0,
  sessionScope: "per-sender" as const,
  mainKey: "main",
  dmEnabled: true,
  dmPolicy: "open" as const,
  allowFrom: [],
  allowNameMatching: false,
  groupDmEnabled: true,
  groupDmChannels: [],
  defaultRequireMention: true,
  groupPolicy: "open" as const,
  useAccessGroups: false,
  reactionMode: "off" as const,
  reactionAllowlist: [],
  replyToMode: "off" as const,
  slashCommand: {
    enabled: false,
    name: "openclaw",
    sessionPrefix: "slack:slash",
    ephemeral: true,
  },
  textLimit: 4000,
  ackReactionScope: "group-mentions",
  typingReaction: "",
  mediaMaxBytes: 1,
  threadHistoryScope: "thread" as const,
  threadInheritParent: false,
  threadRequireExplicitMention: false,
  removeAckAfterReply: false,
});

function createListedChannelsContext(groupPolicy: "open" | "allowlist") {
  return createSlackMonitorContext({
    ...baseParams(),
    groupPolicy,
    channelsConfig: {
      C_LISTED: { requireMention: true },
    },
  });
}

describe("normalizeSlackChannelType", () => {
  it("infers channel types from ids when missing", () => {
    expect(normalizeSlackChannelType(undefined, "C123")).toBe("channel");
    expect(normalizeSlackChannelType(undefined, "D123")).toBe("im");
    expect(normalizeSlackChannelType(undefined, "G123")).toBe("group");
  });

  it("prefers explicit channel_type values", () => {
    expect(normalizeSlackChannelType("mpim", "C123")).toBe("mpim");
  });

  it("overrides wrong channel_type for D-prefix DM channels", () => {
    // Slack DM channel IDs always start with "D" — if the event
    // reports a wrong channel_type, the D-prefix should win.
    expect(normalizeSlackChannelType("channel", "D123")).toBe("im");
    expect(normalizeSlackChannelType("group", "D456")).toBe("im");
    expect(normalizeSlackChannelType("mpim", "D789")).toBe("im");
  });

  it("preserves correct channel_type for D-prefix DM channels", () => {
    expect(normalizeSlackChannelType("im", "D123")).toBe("im");
  });

  it("does not override G-prefix channel_type (ambiguous prefix)", () => {
    // G-prefix can be either "group" (private channel) or "mpim" (group DM)
    // — trust the provided channel_type since the prefix is ambiguous.
    expect(normalizeSlackChannelType("group", "G123")).toBe("group");
    expect(normalizeSlackChannelType("mpim", "G456")).toBe("mpim");
  });
});

describe("resolveSlackSystemEventSessionKey", () => {
  it("defaults missing channel_type to channel sessions", () => {
    const ctx = createSlackMonitorContext(baseParams());
    expect(ctx.resolveSlackSystemEventSessionKey({ channelId: "C123" })).toBe(
      "agent:main:slack:channel:c123",
    );
  });

  it("uses the configured default agent for fallback system-event sessions", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      cfg: {
        agents: { list: [{ id: "ops", default: true }] },
      },
    });
    expect(ctx.resolveSlackSystemEventSessionKey({ channelId: "C123" })).toBe(
      "agent:ops:slack:channel:c123",
    );
  });

  it("routes channel system events through account bindings", () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
      bindings: [
        {
          agentId: "ops",
          match: {
            channel: "slack",
            accountId: "work",
          },
        },
      ],
    } satisfies OpenClawConfig;
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg,
    });
    expect(
      ctx.resolveSlackSystemEventSessionKey({ channelId: "C123", channelType: "channel" }),
    ).toBe("agent:ops:slack:channel:c123");
    expect(
      ctx.resolveSlackSystemEventRoute({ channelId: "C123", channelType: "channel" }),
    ).toMatchObject({
      agentId: "ops",
      matchedBy: "binding.account",
      chatType: "channel",
    });
    const expectedThreadRoute = ctx.resolveSlackSystemEventRoute({
      channelId: "C123",
      channelType: "channel",
      threadTs: "100.200",
    });
    expect(
      ctx.resolveSlackSystemEventCurrentRoute?.({
        cfg,
        channelId: "C123",
        channelType: "channel",
        threadTs: "100.200",
      }),
    ).toEqual(expectedThreadRoute);
    expect(
      ctx.resolveSlackSystemEventCurrentRoute?.({
        cfg: { agents: cfg.agents },
        channelId: "C123",
        channelType: "channel",
        threadTs: "100.200",
      }),
    ).not.toEqual(expectedThreadRoute);
  });

  it.each([
    {
      channelId: "C_TARGET",
      channelType: "channel",
      senderId: "U_GUEST",
      peer: { kind: "channel", id: "channel:C_TARGET" },
    },
    {
      channelId: "D_TARGET",
      channelType: "im",
      senderId: "U_TARGET",
      peer: { kind: "direct", id: "user:U_TARGET" },
    },
  ] as const)(
    "admits target-form $peer.kind service bindings for protected event routes",
    async ({ channelId, channelType, senderId, peer }) => {
      const ctx = createSlackMonitorContext({
        ...baseParams(),
        accountId: "work",
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
          bindings: [
            {
              agentId: "service",
              match: { channel: "slack", accountId: "work", peer },
            },
          ],
        },
      });

      await expect(
        ctx.resolveSlackSystemEventRouteReady({
          channelId,
          channelType,
          senderId,
          senderIsOwner: false,
        }),
      ).resolves.toMatchObject({ agentId: "service", matchedBy: "binding.peer" });
    },
  );

  it("routes DM system events through direct-peer bindings when sender is known", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: {
        bindings: [
          {
            agentId: "ops-dm",
            match: {
              channel: "slack",
              accountId: "work",
              peer: { kind: "direct", id: "U123" },
            },
          },
        ],
      },
    });
    expect(
      ctx.resolveSlackSystemEventSessionKey({
        channelId: "D123",
        channelType: "im",
        senderId: "U123",
      }),
    ).toBe("agent:ops-dm:main");
    expect(
      ctx.resolveSlackSystemEventRoute({
        channelId: "D123",
        channelType: "im",
        senderId: "U123",
      }),
    ).toMatchObject({
      agentId: "ops-dm",
      matchedBy: "binding.peer",
      chatType: "direct",
    });
  });

  it("admits only owner direct events on the unbound personal route", async () => {
    const ctx = createSlackMonitorContext(baseParams());

    await expect(
      ctx.resolveSlackSystemEventRouteReady({
        channelId: "D123",
        channelType: "im",
        senderId: "U_OWNER",
        senderIsOwner: true,
      }),
    ).resolves.toMatchObject({ agentId: "main", matchedBy: "default", chatType: "direct" });
    await expect(
      ctx.resolveSlackSystemEventRouteReady({
        channelId: "D123",
        channelType: "im",
        senderId: "U_GUEST",
        senderIsOwner: false,
      }),
    ).resolves.toBeNull();
    await expect(
      ctx.resolveSlackSystemEventRouteReady({
        channelId: "C123",
        channelType: "channel",
        senderId: "U_OWNER",
        senderIsOwner: true,
      }),
    ).resolves.toBeNull();
  });

  it("renews runtime bindings only after protected event identity admission", async () => {
    const touch = vi.fn();
    conversationRuntime.testing.resetSessionBindingAdaptersForTests();
    conversationRuntime.registerSessionBindingAdapter({
      channel: "slack",
      accountId: "work",
      listBySession: () => [],
      resolveByConversation: (conversation) => {
        const agentId = conversation.conversationId === "C_ALLOWED" ? "service" : "personal";
        return {
          bindingId: `binding-${agentId}`,
          targetSessionKey: `agent:${agentId}:slack:channel:${conversation.conversationId}`,
          targetKind: "session",
          conversation,
          status: "active",
          boundAt: 1,
        };
      },
      touch,
    });
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      },
    });

    try {
      await expect(
        ctx.resolveSlackSystemEventRouteReady({
          channelId: "C_DENIED",
          channelType: "channel",
          senderId: "U_GUEST",
          senderIsOwner: false,
        }),
      ).resolves.toBeNull();
      expect(touch).not.toHaveBeenCalled();

      expect(
        ctx.resolveSlackSystemEventIdentityRoute({
          channelId: "C_ALLOWED",
          channelType: "channel",
          senderId: "U_GUEST",
          senderIsOwner: false,
        }),
      ).toMatchObject({ agentId: "service", matchedBy: "binding.channel" });
      expect(touch).not.toHaveBeenCalled();

      expect(
        ctx.resolveSlackSystemEventCurrentRoute?.({
          cfg: { agents: { list: [{ id: "personal", default: true }, { id: "service" }] } },
          channelId: "C_ALLOWED",
          channelType: "channel",
          senderId: "U_GUEST",
        }),
      ).toMatchObject({ agentId: "service", matchedBy: "binding.channel" });
      expect(touch).not.toHaveBeenCalled();

      await expect(
        ctx.resolveSlackSystemEventRouteReady({
          channelId: "C_ALLOWED",
          channelType: "channel",
          senderId: "U_GUEST",
          senderIsOwner: false,
        }),
      ).resolves.toMatchObject({ agentId: "service", matchedBy: "binding.channel" });
      expect(touch).toHaveBeenCalledOnce();
      expect(touch).toHaveBeenCalledWith("binding-service", undefined);
    } finally {
      conversationRuntime.testing.resetSessionBindingAdaptersForTests();
    }
  });

  it("fails closed instead of admitting a legacy personal route after binding resolution errors", async () => {
    const resolveRuntimeBinding = vi
      .spyOn(conversationRuntime, "lookupRuntimeConversationBindingRoute")
      .mockImplementation(() => {
        throw new Error("binding store unavailable");
      });
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        bindings: [
          {
            agentId: "service",
            match: {
              channel: "slack",
              accountId: "work",
              peer: { kind: "direct", id: "U_OWNER" },
            },
          },
        ],
      },
    });

    try {
      expect(
        ctx.resolveSlackSystemEventRoute({
          channelId: "D123",
          channelType: "im",
          senderId: "U_OWNER",
        }),
      ).toMatchObject({ agentId: "personal", matchedBy: "default" });
      await expect(
        ctx.resolveSlackSystemEventRouteReady({
          channelId: "D123",
          channelType: "im",
          senderId: "U_OWNER",
          senderIsOwner: true,
        }),
      ).resolves.toBeNull();
    } finally {
      resolveRuntimeBinding.mockRestore();
    }
  });

  it("resolves and readies configured service bindings for interaction events", async () => {
    const serviceRoute = {
      agentId: "service",
      channel: "slack",
      accountId: "work",
      sessionKey: "agent:service:acp:binding:slack:work:c123",
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
    const resolveConfigured = vi
      .spyOn(conversationRuntime, "resolveConfiguredBindingRoute")
      .mockReturnValue({
        route: serviceRoute,
        boundAgentId: "service",
        boundSessionKey: serviceRoute.sessionKey,
        bindingResolution,
      } as never);
    const ensureReady = vi
      .spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady")
      .mockResolvedValue({ ok: true });
    const cfg = {
      agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
    } satisfies OpenClawConfig;
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg,
    });

    expect(
      ctx.resolveSlackSystemEventCurrentRoute?.({
        cfg,
        channelId: "C123",
        channelType: "channel",
        senderId: "U123",
      }),
    ).toMatchObject({
      agentId: "service",
      sessionKey: serviceRoute.sessionKey,
      matchedBy: "binding.channel",
    });
    expect(ensureReady).not.toHaveBeenCalled();

    expect(
      await ctx.resolveSlackSystemEventRouteReady({
        channelId: "C123",
        channelType: "channel",
        senderId: "U123",
      }),
    ).toMatchObject({
      agentId: "service",
      sessionKey: serviceRoute.sessionKey,
      matchedBy: "binding.channel",
    });
    expect(resolveConfigured).toHaveBeenCalledTimes(2);
    expect(ensureReady).toHaveBeenCalledOnce();
    resolveConfigured.mockRestore();
    ensureReady.mockRestore();
  });

  it("rejects shared personal bindings before preparing their runtime", async () => {
    const personalRoute = {
      agentId: "personal",
      channel: "slack",
      accountId: "work",
      sessionKey: "agent:personal:acp:binding:slack:work:c123",
      mainSessionKey: "agent:personal:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.channel" as const,
    };
    const resolveConfigured = vi
      .spyOn(conversationRuntime, "resolveConfiguredBindingRoute")
      .mockReturnValue({
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
    const ensureReady = vi.spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady");
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      accountId: "work",
      cfg: { agents: { list: [{ id: "personal", default: true }] } },
    });

    await expect(
      ctx.resolveSlackSystemEventRouteReady({
        channelId: "C123",
        channelType: "channel",
        senderId: "U123",
      }),
    ).resolves.toBeNull();
    expect(ensureReady).not.toHaveBeenCalled();
    resolveConfigured.mockRestore();
    ensureReady.mockRestore();
  });
});

describe("isChannelAllowed with groupPolicy and channelsConfig", () => {
  it("allows unlisted channels when groupPolicy is open even with channelsConfig entries", () => {
    // Bug fix: when groupPolicy="open" and channels has some entries,
    // unlisted channels should still be allowed (not blocked)
    const ctx = createListedChannelsContext("open");
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should ALSO be allowed when policy is "open"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", () => {
    const ctx = createListedChannelsContext("allowlist");
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should be blocked when policy is "allowlist"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(false);
  });

  it("blocks explicitly denied channels even when groupPolicy is open", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: {
        C_ALLOWED: { enabled: true },
        C_DENIED: { enabled: false },
      },
    });
    // Explicitly allowed channel
    expect(ctx.isChannelAllowed({ channelId: "C_ALLOWED", channelType: "channel" })).toBe(true);
    // Explicitly denied channel should be blocked even with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
    // Unlisted channel should be allowed with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("allows all channels when groupPolicy is open and channelsConfig is empty", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: undefined,
    });
    expect(ctx.isChannelAllowed({ channelId: "C_ANY", channelType: "channel" })).toBe(true);
  });
});
