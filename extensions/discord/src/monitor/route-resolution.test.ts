// Discord tests cover route resolution plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationBindingRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordBoundConversationRoute,
  resolveDiscordConversationBindingRoute,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
  shouldIgnoreStaleDiscordRouteBinding,
} from "./route-resolution.js";

function buildWorkerBindingConfig(peer: {
  kind: "channel" | "direct";
  id: string;
}): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "worker" }],
    },
    bindings: [
      {
        agentId: "worker",
        match: {
          channel: "discord",
          accountId: "default",
          peer,
        },
      },
    ],
  };
}

describe("discord route resolution helpers", () => {
  it("uses the delivery identity for runtime DMs and the native channel for configured DMs", () => {
    const seen = { runtime: "", configured: "" };
    const result = resolveDiscordConversationBindingRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      },
      accountId: "default",
      isDirectMessage: true,
      isGroupDm: false,
      directUserId: "user-1",
      conversationId: "dm-1",
      configuredConversationId: "dm-1",
      runtime: {
        lookupRuntimeConversationBindingRoute: ({ route, conversation }) => {
          seen.runtime = conversation.conversationId;
          return { bindingRecord: null, route };
        },
        resolveConfiguredBindingRoute: ({ route, conversation }) => {
          seen.configured = conversation.conversationId;
          const serviceRoute = {
            ...route,
            agentId: "service",
            sessionKey: "agent:service:discord:direct:user-1",
            matchedBy: "binding.channel" as const,
          };
          return {
            bindingResolution: {
              record: {
                targetSessionKey: serviceRoute.sessionKey,
              },
            } as never,
            boundSessionKey: serviceRoute.sessionKey,
            boundAgentId: "service",
            route: serviceRoute,
          };
        },
        isPluginOwnedSessionBindingRecord: () => false,
      },
    });

    expect(seen).toEqual({ runtime: "user:user-1", configured: "dm-1" });
    expect(result.effectiveRoute).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:discord:direct:user-1",
      matchedBy: "binding.channel",
    });
  });

  it("drops a route-shaped runtime binding after the configured route changes agent", () => {
    const channelId = "channel-stale-route";
    const result = resolveDiscordConversationBindingRoute({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "newagent" }] },
        bindings: [
          {
            agentId: "newagent",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel", id: channelId },
            },
          },
        ],
      },
      accountId: "default",
      isDirectMessage: false,
      isGroupDm: false,
      conversationId: channelId,
      configuredConversationId: channelId,
      runtime: {
        lookupRuntimeConversationBindingRoute: ({ route, conversation }) => ({
          bindingRecord: {
            bindingId: "stale-route",
            targetSessionKey: `agent:oldagent:discord:channel:${channelId}`,
            targetKind: "session",
            conversation,
            status: "active",
            boundAt: 1,
          },
          boundSessionKey: `agent:oldagent:discord:channel:${channelId}`,
          boundAgentId: "oldagent",
          route: {
            ...route,
            agentId: "oldagent",
            sessionKey: `agent:oldagent:discord:channel:${channelId}`,
            matchedBy: "binding.channel",
          },
        }),
        resolveConfiguredBindingRoute: ({ route }) => ({
          bindingResolution: null,
          route,
        }),
        isPluginOwnedSessionBindingRecord: () => false,
      },
    });

    expect(result.staleRuntimeBinding).toBe(true);
    expect(result.runtimeBinding).toBeNull();
    expect(result.effectiveRoute).toMatchObject({
      agentId: "newagent",
      sessionKey: `agent:newagent:discord:channel:${channelId}`,
      matchedBy: "binding.peer",
    });
  });

  it("builds a direct peer from DM metadata", () => {
    expect(
      buildDiscordRoutePeer({
        isDirectMessage: true,
        isGroupDm: false,
        directUserId: "user-1",
        conversationId: "channel-1",
      }),
    ).toEqual({
      kind: "direct",
      id: "user-1",
    });
  });

  it("resolves bound session keys on top of the routed session", () => {
    const route: ResolvedAgentRoute = {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:c1",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    };

    expect(
      resolveDiscordEffectiveRoute({
        route,
        boundSessionKey: "agent:worker:discord:channel:c1",
        matchedBy: "binding.channel",
      }),
    ).toEqual({
      ...route,
      agentId: "worker",
      sessionKey: "agent:worker:discord:channel:c1",
      matchedBy: "binding.channel",
    });
  });

  it("marks native-command runtime thread bindings as explicit channel bindings", async () => {
    const result = await resolveDiscordNativeInteractionRouteState({
      cfg: {
        agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
      },
      accountId: "default",
      guildId: "g1",
      isDirectMessage: false,
      isGroupDm: false,
      conversationId: "thread-1",
      threadBinding: {
        accountId: "default",
        channelId: "channel-1",
        threadId: "thread-1",
        targetKind: "subagent",
        targetSessionKey: "agent:service:subagent:bound",
        agentId: "service",
        boundBy: "owner",
        boundAt: 1,
        lastActivityAt: 1,
      },
    });

    expect(result.effectiveRoute).toMatchObject({
      agentId: "service",
      sessionKey: "agent:service:subagent:bound",
      matchedBy: "binding.channel",
    });
  });

  it("resolves native commands through a live conversation binding without touching its lease", async () => {
    const runtimeBinding = {
      bindingId: "binding-service",
      targetSessionKey: "agent:service:discord:channel:channel-1",
      metadata: { boundBy: "owner" },
    } as never;
    const serviceRoute = {
      agentId: "service",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:service:discord:channel:channel-1",
      mainSessionKey: "agent:service:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.channel" as const,
    };
    const lookup = vi
      .spyOn(conversationBindingRuntime, "lookupRuntimeConversationBindingRoute")
      .mockReturnValue({
        bindingRecord: runtimeBinding,
        boundSessionKey: serviceRoute.sessionKey,
        route: serviceRoute,
      });
    const touch = vi.spyOn(conversationBindingRuntime, "touchRuntimeConversationBindingRoute");

    try {
      const result = await resolveDiscordNativeInteractionRouteState({
        cfg: {
          agents: { list: [{ id: "personal", default: true }, { id: "service" }] },
        },
        accountId: "default",
        guildId: "guild-1",
        isDirectMessage: false,
        isGroupDm: false,
        conversationId: "channel-1",
      });

      expect(result.effectiveRoute).toEqual(serviceRoute);
      expect(result.runtimeBinding).toBe(runtimeBinding);
      expect(result.identityDecision).toMatchObject({
        mode: "organization",
        allowed: true,
      });
      expect(touch).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      touch.mockRestore();
    }
  });

  it("rejects shared personal native bindings before preparing their runtime", async () => {
    const personalRoute = {
      agentId: "personal",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:personal:acp:binding:discord:default:channel-1",
      mainSessionKey: "agent:personal:main",
      lastRoutePolicy: "session" as const,
      matchedBy: "binding.channel" as const,
    };
    const resolveConfigured = vi
      .spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute")
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
    const ensureReady = vi.spyOn(conversationBindingRuntime, "ensureConfiguredBindingRouteReady");

    const result = await resolveDiscordNativeInteractionRouteState({
      cfg: { agents: { list: [{ id: "personal", default: true }] } },
      accountId: "default",
      guildId: "guild-1",
      isDirectMessage: false,
      isGroupDm: false,
      conversationId: "channel-1",
      enforceConfiguredBindingReadiness: true,
    });

    expect(result.identityDecision).toMatchObject({
      mode: "external",
      allowed: false,
      reason: "unbound_shared",
    });
    expect(result.bindingReadiness).toBeNull();
    expect(ensureReady).not.toHaveBeenCalled();
    resolveConfigured.mockRestore();
    ensureReady.mockRestore();
  });

  it("falls back to configured route when no bound session exists", () => {
    const route: ResolvedAgentRoute = {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:c1",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    };
    const configuredRoute = {
      route: {
        ...route,
        agentId: "worker",
        sessionKey: "agent:worker:discord:channel:c1",
        mainSessionKey: "agent:worker:main",
        lastRoutePolicy: "session" as const,
        matchedBy: "binding.peer" as const,
      },
    };

    expect(
      resolveDiscordEffectiveRoute({
        route,
        configuredRoute,
      }),
    ).toEqual(configuredRoute.route);
  });

  it("resolves the same route shape as the inline Discord route inputs", () => {
    const cfg = buildWorkerBindingConfig({ kind: "channel", id: "c1" });

    expect(
      resolveDiscordConversationRoute({
        cfg,
        accountId: "default",
        guildId: "g1",
        memberRoleIds: [],
        peer: { kind: "channel", id: "c1" },
      }),
    ).toEqual({
      agentId: "worker",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:worker:discord:channel:c1",
      mainSessionKey: "agent:worker:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.peer",
    });
  });

  it("composes route building with effective-route overrides", () => {
    const cfg = buildWorkerBindingConfig({ kind: "direct", id: "user-1" });

    expect(
      resolveDiscordBoundConversationRoute({
        cfg,
        accountId: "default",
        isDirectMessage: true,
        isGroupDm: false,
        directUserId: "user-1",
        conversationId: "dm-1",
        boundSessionKey: "agent:worker:discord:direct:user-1",
        matchedBy: "binding.channel",
      }),
    ).toEqual({
      agentId: "worker",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:worker:discord:direct:user-1",
      mainSessionKey: "agent:worker:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    });
  });

  it("ignores stale route-shaped bindings after the configured agent changes", () => {
    const route: ResolvedAgentRoute = {
      agentId: "newagent",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:newagent:discord:channel:c1",
      mainSessionKey: "agent:newagent:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.peer",
    };

    expect(
      shouldIgnoreStaleDiscordRouteBinding({
        route,
        bindingRecord: {
          bindingId: "binding-1",
          targetSessionKey: "agent:oldagent:discord:channel:c1",
          targetKind: "session",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: "c1",
          },
          status: "active",
          boundAt: 1,
        },
      }),
    ).toBe(true);
  });

  it("keeps explicit focus bindings even when their agent differs from routing", () => {
    const route: ResolvedAgentRoute = {
      agentId: "newagent",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:newagent:discord:channel:c1",
      mainSessionKey: "agent:newagent:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.peer",
    };

    expect(
      shouldIgnoreStaleDiscordRouteBinding({
        route,
        bindingRecord: {
          bindingId: "focus-binding",
          targetSessionKey: "agent:oldagent:discord:channel:c1",
          targetKind: "session",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: "c1",
          },
          status: "active",
          boundAt: 1,
          metadata: {
            boundBy: "user-1",
            label: "oldagent",
          },
        },
      }),
    ).toBe(false);
  });
});
