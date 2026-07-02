// Discord plugin module implements ingress behavior.
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ensureConfiguredBindingRouteReady,
  touchRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { resolveConversationIdentityMode } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug } from "../monitor/allow-list.js";
import { buildDiscordGroupSystemPrompt } from "../monitor/inbound-context.js";
import { resolveDiscordStableSenderIsOwner } from "../monitor/native-command-auth.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import { isDiscordVoiceRouteCurrent, resolveDiscordVoiceAgentRoute } from "./route.js";
import type { VoiceSessionEntry } from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

export const DISCORD_VOICE_MESSAGE_PROVIDER = "discord-voice";

const logger = createSubsystemLogger("discord/voice");

export type DiscordVoiceIngressContext = {
  extraSystemPrompt?: string;
  memberRoleIds?: string[];
  senderId?: string;
  senderIsOwner: boolean;
  speakerLabel: string;
};

export type DiscordVoiceAgentTurnResult = {
  context: DiscordVoiceIngressContext;
  text: string;
};

async function admitCurrentDiscordVoiceRoute(params: {
  entry: VoiceSessionEntry;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
}): Promise<boolean> {
  let current;
  try {
    current = resolveDiscordVoiceAgentRoute({
      cfg: params.cfg,
      accountId: params.entry.route.accountId,
      guildId: params.entry.guildId,
      sessionChannelId: params.entry.sessionChannelId,
      voiceConfig: params.discordConfig.voice,
    });
  } catch (error) {
    logger.warn(
      `discord voice: current route unavailable guild=${params.entry.guildId} channel=${params.entry.channelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const identity = resolveConversationIdentityMode({
    config: params.cfg,
    agentId: current.route.agentId,
    routeMatchedBy: current.route.matchedBy,
    chatType: "channel",
    groupId: params.entry.channelId,
    groupChannel: params.entry.channelName,
    groupSpace: params.entry.guildId,
  });
  if (
    !identity.allowed ||
    !isDiscordVoiceRouteCurrent({ expected: params.entry.route, current: current.route })
  ) {
    logger.warn(
      `discord voice: route changed during active session guild=${params.entry.guildId} channel=${params.entry.channelId}`,
    );
    return false;
  }
  if (current.configuredBinding) {
    const readiness = await ensureConfiguredBindingRouteReady({
      cfg: params.cfg,
      bindingResolution: current.configuredBinding,
    });
    if (!readiness.ok) {
      logger.warn(
        `discord voice: configured binding unavailable guild=${params.entry.guildId} channel=${params.entry.channelId}: ${readiness.error}`,
      );
      return false;
    }
  }
  touchRuntimeConversationBindingRoute({ bindingRecord: current.runtimeBinding });
  return true;
}

function summarizeAgentTurnPayloads(payloads: readonly unknown[]): string {
  let textPayloads = 0;
  let nonEmptyTextPayloads = 0;
  let reasoningPayloads = 0;
  let errorPayloads = 0;
  let mediaPayloads = 0;

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const record = payload as Record<string, unknown>;
    const text = record.text;
    if (typeof text === "string") {
      textPayloads += 1;
      if (text.trim()) {
        nonEmptyTextPayloads += 1;
      }
    }
    if (record.isReasoning === true) {
      reasoningPayloads += 1;
    }
    if (record.isError === true) {
      errorPayloads += 1;
    }
    if (
      typeof record.mediaUrl === "string" ||
      (Array.isArray(record.mediaUrls) && record.mediaUrls.length > 0)
    ) {
      mediaPayloads += 1;
    }
  }

  return `payloadCount=${payloads.length} textPayloads=${textPayloads} nonEmptyTextPayloads=${nonEmptyTextPayloads} reasoningPayloads=${reasoningPayloads} errorPayloads=${errorPayloads} mediaPayloads=${mediaPayloads}`;
}

export async function resolveDiscordVoiceIngressContext(params: {
  entry: VoiceSessionEntry;
  userId: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceIngressContext | null> {
  const { entry, userId } = params;
  if (!entry.guildName) {
    entry.guildName = await params.fetchGuildName(entry.guildId);
  }
  const speaker = await params.speakerContext.resolveContext(entry.guildId, userId);
  const speakerIdentity = await params.speakerContext.resolveIdentity(entry.guildId, userId);
  const access = await authorizeDiscordVoiceIngress({
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    guildName: entry.guildName,
    guildId: entry.guildId,
    channelId: entry.channelId,
    channelName: entry.channelName,
    channelSlug: entry.channelName ? normalizeDiscordSlug(entry.channelName) : "",
    channelLabel: formatMention({ channelId: entry.channelId }),
    memberRoleIds: speakerIdentity.memberRoleIds,
    ownerAllowFrom: params.ownerAllowFrom,
    sender: {
      id: speakerIdentity.id,
      name: speakerIdentity.name,
      tag: speakerIdentity.tag,
    },
  });
  if (!access.ok) {
    return null;
  }
  if (
    !(await admitCurrentDiscordVoiceRoute({
      entry,
      cfg: params.cfg,
      discordConfig: params.discordConfig,
    }))
  ) {
    return null;
  }
  return {
    extraSystemPrompt: buildDiscordGroupSystemPrompt(access.channelConfig),
    memberRoleIds: speakerIdentity.memberRoleIds,
    senderId: speakerIdentity.id,
    senderIsOwner: resolveDiscordStableSenderIsOwner({
      cfg: params.cfg,
      providerAllowFrom:
        params.ownerAllowFrom ??
        params.discordConfig.allowFrom ??
        params.discordConfig.dm?.allowFrom,
      sender: {
        id: speakerIdentity.id,
        name: speakerIdentity.name,
        tag: speakerIdentity.tag,
      },
    }),
    speakerLabel: speaker.label,
  };
}

export async function runDiscordVoiceAgentTurn(params: {
  entry: VoiceSessionEntry;
  userId: string;
  message: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  context?: DiscordVoiceIngressContext;
  toolsAllow?: string[];
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceAgentTurnResult | null> {
  const hasPreparedContext = params.context !== undefined;
  const context =
    params.context ??
    (await resolveDiscordVoiceIngressContext({
      entry: params.entry,
      userId: params.userId,
      cfg: params.cfg,
      discordConfig: params.discordConfig,
      ownerAllowFrom: params.ownerAllowFrom,
      fetchGuildName: params.fetchGuildName,
      speakerContext: params.speakerContext,
    }));
  if (!context) {
    return null;
  }
  if (
    hasPreparedContext &&
    !(await admitCurrentDiscordVoiceRoute({
      entry: params.entry,
      cfg: params.cfg,
      discordConfig: params.discordConfig,
    }))
  ) {
    return null;
  }
  const voiceModel = normalizeOptionalString(params.discordConfig.voice?.model);
  const result = await agentCommandFromIngress(
    {
      message: params.message,
      sessionKey: params.entry.route.sessionKey,
      agentId: params.entry.route.agentId,
      messageChannel: "discord",
      messageProvider: DISCORD_VOICE_MESSAGE_PROVIDER,
      extraSystemPrompt: context.extraSystemPrompt,
      allowModelOverride: Boolean(voiceModel),
      model: voiceModel,
      toolsAllow: params.toolsAllow,
      deliver: false,
      senderIsOwner: context.senderIsOwner,
      identityContractVersion: 1,
      runContext: {
        messageChannel: "discord",
        accountId: params.entry.route.accountId,
        chatType: "channel",
        routeMatchedBy: params.entry.route.matchedBy,
        groupId: params.entry.channelId,
        groupChannel: params.entry.channelName,
        groupSpace: params.entry.guildId,
        memberRoleIds: context.memberRoleIds,
        currentChannelId: params.entry.channelId,
        chatId: params.entry.channelId,
        currentInboundAudio: true,
        senderId: context.senderId ?? params.userId,
      },
    },
    params.runtime,
  );
  const payloads = result.payloads ?? [];
  const text = payloads
    .map((payload) => payload.text)
    .filter((entry) => typeof entry === "string" && entry.trim())
    .join("\n")
    .trim();
  if (!text) {
    logger.info(
      `discord voice: agent turn produced no speakable payloads guild=${params.entry.guildId} channel=${params.entry.channelId} voiceSession=${params.entry.voiceSessionKey} supervisorSession=${params.entry.route.sessionKey} agent=${params.entry.route.agentId} user=${params.userId} ${summarizeAgentTurnPayloads(payloads)}`,
    );
  }
  return {
    context,
    text,
  };
}

export async function resolveDiscordVoiceRealtimeBootstrapContext(params: {
  entry: VoiceSessionEntry;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
}): Promise<string | undefined> {
  const realtimeConfig = params.discordConfig.voice?.realtime;
  const files = realtimeConfig?.bootstrapContextFiles;
  if (files?.length === 0) {
    return undefined;
  }
  if (
    !(await admitCurrentDiscordVoiceRoute({
      entry: params.entry,
      cfg: params.cfg,
      discordConfig: params.discordConfig,
    }))
  ) {
    return undefined;
  }
  try {
    return await resolveRealtimeBootstrapContextInstructions({
      config: params.cfg,
      agentId: params.entry.route.agentId,
      sessionKey: params.entry.route.sessionKey,
      files,
      warn: (message) => logger.warn(`discord voice: realtime bootstrap context: ${message}`),
    });
  } catch (error) {
    logger.warn(
      `discord voice: realtime bootstrap context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
