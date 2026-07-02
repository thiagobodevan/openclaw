import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupRuntimeConversationBindingRouteMock, resolveAgentRouteMock } = vi.hoisted(() => ({
  lookupRuntimeConversationBindingRouteMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(() => ({
    agentId: "team-ops",
    channel: "discord",
    accountId: "operations",
    sessionKey: "agent:team-ops:discord:channel:voice-1",
    mainSessionKey: "agent:team-ops:main",
    lastRoutePolicy: "session" as const,
    matchedBy: "binding.channel" as const,
  })),
}));

vi.mock("openclaw/plugin-sdk/routing", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/routing")>(
    "openclaw/plugin-sdk/routing",
  );
  return { ...actual, resolveAgentRoute: resolveAgentRouteMock };
});

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/conversation-binding-runtime")
  >("openclaw/plugin-sdk/conversation-binding-runtime");
  return {
    ...actual,
    lookupRuntimeConversationBindingRoute: lookupRuntimeConversationBindingRouteMock,
  };
});

vi.mock("../monitor/route-resolution.js", () => ({
  shouldIgnoreStaleDiscordRouteBinding: () => false,
}));

import { resolveDiscordVoiceAgentRoute } from "./route.js";

describe("resolveDiscordVoiceAgentRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupRuntimeConversationBindingRouteMock.mockImplementation(({ route }) => ({
      bindingRecord: {
        bindingId: "plugin-binding",
        targetSessionKey: "plugin-binding:thread-1",
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "team-runtime",
          pluginRoot: "/tmp/team-runtime",
        },
      },
      route,
    }));
  });

  it.each([
    { target: "user:42", conversationId: "user:42" },
    { target: "channel:44", conversationId: "44" },
  ])("checks the canonical binding identity for $target", ({ target, conversationId }) => {
    expect(() =>
      resolveDiscordVoiceAgentRoute({
        cfg: {},
        accountId: "operations",
        guildId: "guild-1",
        sessionChannelId: "voice-1",
        voiceConfig: { agentSession: { mode: "target", target } },
      }),
    ).toThrow("Discord voice cannot dispatch a plugin-owned conversation binding");

    expect(lookupRuntimeConversationBindingRouteMock).toHaveBeenCalledWith({
      route: expect.any(Object),
      conversation: {
        channel: "discord",
        accountId: "operations",
        conversationId,
      },
    });
  });
});
