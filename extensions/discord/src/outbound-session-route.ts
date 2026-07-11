// Discord plugin module implements outbound session route behavior.
import {
  buildThreadAwareOutboundSessionRoute,
  type ChannelCurrentConversationRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import { createDiscordRestClient } from "./client.js";
import { getChannel, getGuildMember } from "./internal/api.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationBindingRoute,
  resolveDiscordConversationRoute,
} from "./monitor/route-resolution.js";
import { parseDiscordTarget } from "./target-parsing.js";

export type ResolveDiscordOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  replyToId?: string | null;
  threadId?: string | number | null;
};

export function resolveDiscordOutboundSessionRoute(
  params: ResolveDiscordOutboundSessionRouteParams,
) {
  const parsed = parseDiscordTarget(params.target, {
    defaultKind: resolveDiscordOutboundTargetKindHint(params),
  });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  const peer: RoutePeer = {
    kind: isDm ? "direct" : "channel",
    id: parsed.id,
  };
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "discord",
    accountId: params.accountId,
    peer,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: {
      sessionKey: baseSessionKey,
      baseSessionKey,
      peer,
      chatType: isDm ? ("direct" as const) : ("channel" as const),
      from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
      to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`,
    },
    threadId: params.threadId,
    precedence: ["threadId"],
    useSuffix: false,
  });
}

export async function resolveDiscordCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  let parsed: ReturnType<typeof parseDiscordTarget>;
  try {
    parsed = parseDiscordTarget(params.target, {
      defaultKind: params.chatType === "direct" ? "user" : "channel",
    });
  } catch {
    return null;
  }
  if (!parsed) {
    return null;
  }
  const isDirectMessage = params.chatType === "direct";
  const isGroupDm = params.chatType === "group";
  if ((isDirectMessage && parsed.kind !== "user") || (!isDirectMessage && parsed.kind === "user")) {
    return null;
  }
  const senderId = params.senderId?.trim();
  if (isDirectMessage && senderId && senderId !== parsed.id) {
    return null;
  }
  const nativeConversationId = params.conversationId?.trim();
  if (!isDirectMessage && nativeConversationId && nativeConversationId !== parsed.id) {
    return null;
  }
  if (params.requireAudienceValidation) {
    const audienceMatches =
      params.audienceEvidence !== undefined &&
      params.audienceEvidence.length > 0 &&
      params.audienceEvidence.every((evidence) => {
        try {
          const candidate = parseDiscordTarget(evidence.value, {
            defaultKind: isDirectMessage ? "user" : "channel",
          });
          return candidate?.id === parsed.id && candidate.kind === parsed.kind;
        } catch {
          return false;
        }
      });
    if (!audienceMatches) {
      return null;
    }
  }
  const conversationId = isDirectMessage ? (nativeConversationId ?? parsed.id) : parsed.id;
  const parentConversationId = params.parentConversationId?.trim();
  let restClient: ReturnType<typeof createDiscordRestClient> | undefined;
  const getRest = () =>
    (restClient ??= createDiscordRestClient({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    })).rest;
  if (parentConversationId) {
    if (isDirectMessage) {
      return null;
    }
    try {
      const channel = await getChannel(getRest(), parsed.id);
      const liveParentId =
        "parent_id" in channel && typeof channel.parent_id === "string"
          ? channel.parent_id.trim()
          : "";
      if (liveParentId !== parentConversationId) {
        return null;
      }
    } catch {
      // Parent-inherited routes require a live child-parent proof. Otherwise a
      // moved or deleted thread could retain the former parent's service agent.
      return null;
    }
  }
  let memberRoleIds: string[] | undefined;
  const guildId = params.groupSpace?.trim();
  const peer = buildDiscordRoutePeer({
    isDirectMessage,
    isGroupDm,
    directUserId: isDirectMessage ? (senderId ?? parsed.id) : undefined,
    conversationId,
  });
  const configuredRoleIds = [
    ...new Set(
      (params.cfg.bindings ?? []).flatMap((binding) =>
        binding.match?.channel?.trim().toLowerCase() === "discord"
          ? (binding.match.roles ?? []).map((roleId) => roleId.trim()).filter(Boolean)
          : [],
      ),
    ),
  ];
  const routeWithoutRoleProof = resolveDiscordConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId,
    peer,
    parentConversationId,
  });
  const routeWithAllConfiguredRoles =
    configuredRoleIds.length > 0
      ? resolveDiscordConversationRoute({
          cfg: params.cfg,
          accountId: params.accountId,
          guildId,
          memberRoleIds: configuredRoleIds,
          peer,
          parentConversationId,
        })
      : routeWithoutRoleProof;
  const requiresMemberRoleProof =
    routeWithAllConfiguredRoles.agentId !== routeWithoutRoleProof.agentId ||
    routeWithAllConfiguredRoles.sessionKey !== routeWithoutRoleProof.sessionKey ||
    routeWithAllConfiguredRoles.matchedBy !== routeWithoutRoleProof.matchedBy;
  if (requiresMemberRoleProof) {
    if (!guildId || !senderId) {
      return null;
    }
    try {
      const member = await getGuildMember(getRest(), guildId, senderId);
      memberRoleIds = [...member.roles];
    } catch {
      // Role-scoped routes require current provider proof. A failed read cannot
      // safely fall back to a broader guild, account, or default route.
      return null;
    }
  }
  const runtime = await import("openclaw/plugin-sdk/conversation-binding-runtime");
  const routeState = resolveDiscordConversationBindingRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    directUserId: isDirectMessage ? (senderId ?? parsed.id) : undefined,
    conversationId,
    configuredConversationId: isDirectMessage ? nativeConversationId : conversationId,
    parentConversationId,
    runtime,
  });
  // Plugin-owned targets require their owner handoff and cannot authorize a
  // new agent turn from persisted channel metadata alone.
  if (routeState.pluginOwnedBinding) {
    return null;
  }
  return params.requireAudienceValidation
    ? { ...routeState.effectiveRoute, audienceValidated: true }
    : routeState.effectiveRoute;
}

function resolveDiscordOutboundTargetKindHint(params: {
  target: string;
  resolvedTarget?: { kind: string };
}): "user" | "channel" | undefined {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "user";
  }
  if (resolvedKind === "group" || resolvedKind === "channel") {
    return "channel";
  }

  const target = params.target.trim();
  if (/^channel:/i.test(target)) {
    return "channel";
  }
  if (/^(user:|discord:|@|<@!?)/i.test(target)) {
    return "user";
  }
  return "channel";
}
