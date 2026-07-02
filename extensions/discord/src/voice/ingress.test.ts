import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionEntry } from "./session.js";

const { agentCommandFromIngressMock, resolveRealtimeBootstrapContextInstructionsMock } = vi.hoisted(
  () => ({
    agentCommandFromIngressMock: vi.fn(async () => ({ payloads: [{ text: "team answer" }] })),
    resolveRealtimeBootstrapContextInstructionsMock: vi.fn(async () => "team instructions"),
  }),
);

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  agentCommandFromIngress: agentCommandFromIngressMock,
}));

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", () => ({
  resolveRealtimeBootstrapContextInstructions: resolveRealtimeBootstrapContextInstructionsMock,
}));

import {
  resolveDiscordVoiceIngressContext,
  resolveDiscordVoiceRealtimeBootstrapContext,
  runDiscordVoiceAgentTurn,
} from "./ingress.js";

const config = {
  agents: {
    list: [{ id: "personal", default: true }, { id: "team-ops" }],
  },
  bindings: [
    {
      agentId: "team-ops",
      match: { channel: "discord", accountId: "operations", guildId: "guild-1" },
    },
  ],
};

function createEntry(params: { agentId: string; matchedBy: "binding.guild" | "default" }) {
  return {
    guildId: "guild-1",
    guildName: "Operations",
    channelId: "channel-1",
    channelName: "team-room",
    sessionChannelId: "channel-1",
    voiceSessionKey: "discord:guild-1:channel-1",
    route: {
      agentId: params.agentId,
      channel: "discord",
      accountId: "operations",
      sessionKey: `agent:${params.agentId}:discord:channel:channel-1`,
      mainSessionKey: `agent:${params.agentId}:main`,
      lastRoutePolicy: "session",
      matchedBy: params.matchedBy,
    },
  } as VoiceSessionEntry;
}

const unusedSpeakerContext = {
  resolveContext: vi.fn(),
  resolveIdentity: vi.fn(),
};

describe("Discord voice identity ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries service binding and sender policy facts into the agent ingress", async () => {
    const entry = createEntry({ agentId: "team-ops", matchedBy: "binding.guild" });

    await expect(
      runDiscordVoiceAgentTurn({
        entry,
        userId: "guest-1",
        message: "status update",
        cfg: config,
        discordConfig: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        context: {
          senderId: "guest-1",
          senderIsOwner: false,
          speakerLabel: "Guest",
          memberRoleIds: ["role-1"],
        },
        fetchGuildName: vi.fn(),
        speakerContext: unusedSpeakerContext as never,
      }),
    ).resolves.toMatchObject({ text: "team answer" });

    expect(agentCommandFromIngressMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "team-ops",
        senderIsOwner: false,
        runContext: {
          messageChannel: "discord",
          accountId: "operations",
          chatType: "channel",
          routeMatchedBy: "binding.guild",
          groupId: "channel-1",
          groupChannel: "team-room",
          groupSpace: "guild-1",
          memberRoleIds: ["role-1"],
          currentChannelId: "channel-1",
          chatId: "channel-1",
          currentInboundAudio: true,
          senderId: "guest-1",
        },
      }),
      expect.anything(),
    );
  });

  it("honors explicit command-owner overrides for admitted voice speakers", async () => {
    const entry = createEntry({ agentId: "team-ops", matchedBy: "binding.guild" });
    entry.guildId = "987654321";
    entry.channelId = "123456789";
    const speakerContext = {
      resolveContext: vi.fn(async () => ({
        id: "provider-owner",
        label: "Provider Owner",
        senderIsOwner: true,
      })),
      resolveIdentity: vi.fn(async () => ({
        id: "provider-owner",
        label: "Provider Owner",
        memberRoleIds: [],
      })),
    };

    await expect(
      resolveDiscordVoiceIngressContext({
        entry,
        userId: "provider-owner",
        cfg: {
          ...config,
          bindings: [
            {
              agentId: "team-ops",
              match: {
                channel: "discord",
                accountId: "operations",
                guildId: "987654321",
              },
            },
          ],
          commands: {
            useAccessGroups: true,
            ownerAllowFrom: ["discord:explicit-owner"],
          },
        },
        discordConfig: {
          groupPolicy: "open",
          allowFrom: ["discord:provider-owner"],
        },
        ownerAllowFrom: ["discord:provider-owner"],
        fetchGuildName: vi.fn(),
        speakerContext: speakerContext as never,
      }),
    ).resolves.toMatchObject({
      senderId: "provider-owner",
      senderIsOwner: false,
      speakerLabel: "Provider Owner",
    });
  });

  it("does not load personal bootstrap context for an unbound shared session", async () => {
    const entry = createEntry({ agentId: "personal", matchedBy: "default" });

    await expect(
      resolveDiscordVoiceRealtimeBootstrapContext({
        entry,
        cfg: config,
        discordConfig: { voice: { realtime: {} } },
      }),
    ).resolves.toBeUndefined();
    expect(resolveRealtimeBootstrapContextInstructionsMock).not.toHaveBeenCalled();
  });

  it("loads bootstrap context for an explicitly bound service agent", async () => {
    const entry = createEntry({ agentId: "team-ops", matchedBy: "binding.guild" });

    await expect(
      resolveDiscordVoiceRealtimeBootstrapContext({
        entry,
        cfg: config,
        discordConfig: { voice: { realtime: {} } },
      }),
    ).resolves.toBe("team instructions");
    expect(resolveRealtimeBootstrapContextInstructionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "team-ops" }),
    );
  });

  it("does not run through a voice route after its service binding changes", async () => {
    const entry = createEntry({ agentId: "team-ops", matchedBy: "binding.guild" });

    await expect(
      runDiscordVoiceAgentTurn({
        entry,
        userId: "guest-1",
        message: "status update",
        cfg: {
          agents: {
            list: [
              { id: "personal", default: true },
              { id: "team-ops" },
              { id: "replacement-ops" },
            ],
          },
          bindings: [
            {
              agentId: "replacement-ops",
              match: { channel: "discord", accountId: "operations", guildId: "guild-1" },
            },
          ],
        },
        discordConfig: {},
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        context: {
          senderId: "guest-1",
          senderIsOwner: false,
          speakerLabel: "Guest",
          memberRoleIds: ["role-1"],
        },
        fetchGuildName: vi.fn(),
        speakerContext: unusedSpeakerContext as never,
      }),
    ).resolves.toBeNull();

    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
  });
});
