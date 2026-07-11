// Whatsapp plugin module implements session route behavior.
import { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-policy";
import { resolveConfiguredBindingRoute } from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  buildChannelOutboundSessionRoute,
  type ChannelCurrentConversationRoute,
  type ChannelCurrentConversationRouteParams,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import {
  normalizeAgentId,
  resolveAgentRoute,
  resolveStableSenderIsOwner,
} from "openclaw/plugin-sdk/routing";
import { resolveWhatsAppAgentRoute } from "./group-session-key.js";
import { resolveWhatsAppInboundPolicy } from "./inbound-policy.js";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppAllowFromEntry,
  normalizeWhatsAppTarget,
} from "./normalize.js";

export function resolveWhatsAppOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = isWhatsAppGroupJid(normalized);
  const isNewsletter = isWhatsAppNewsletterJid(normalized);
  const chatType = isGroup ? "group" : isNewsletter ? "channel" : "direct";
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    peer: {
      kind: chatType,
      id: normalized,
    },
    chatType,
    from: normalized,
    to: normalized,
  });
}

export async function resolveWhatsAppCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
): Promise<ChannelCurrentConversationRoute | null> {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const targetChatType = isWhatsAppGroupJid(normalized)
    ? "group"
    : isWhatsAppNewsletterJid(normalized)
      ? "channel"
      : "direct";
  if (targetChatType !== params.chatType) {
    return null;
  }
  if (params.requireAudienceValidation) {
    const audienceMatches =
      params.audienceEvidence !== undefined &&
      params.audienceEvidence.length > 0 &&
      params.audienceEvidence.every(
        (evidence) => normalizeWhatsAppTarget(evidence.value) === normalized,
      );
    if (!audienceMatches) {
      return null;
    }
  }
  const policy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route: resolveAgentRoute({
      cfg: params.cfg,
      channel: "whatsapp",
      accountId: policy.account.accountId,
      peer: { kind: targetChatType, id: normalized },
    }),
    channel: "whatsapp",
    accountId: policy.account.accountId,
    conversationId: normalized,
  });
  let route = configuredRoute.route;
  const broadcastAgents = configuredRoute.bindingResolution
    ? undefined
    : params.cfg.broadcast?.[normalized];
  const targetAgentId = params.agentId?.trim();
  if (
    targetAgentId &&
    Array.isArray(broadcastAgents) &&
    broadcastAgents.some((agentId) => normalizeAgentId(agentId) === normalizeAgentId(targetAgentId))
  ) {
    route = resolveWhatsAppAgentRoute({
      cfg: params.cfg,
      route,
      peerId: normalized,
      chatType: targetChatType,
      agentId: targetAgentId,
      matchedBy: "config.agent",
    });
  }
  if (targetChatType !== "direct") {
    return params.requireAudienceValidation ? { ...route, audienceValidated: true } : route;
  }
  const senderId = normalizeWhatsAppTarget(params.senderId ?? "");
  if (!senderId || senderId !== normalized) {
    return null;
  }
  const pairedAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "whatsapp",
    accountId: policy.account.accountId,
    dmPolicy: policy.dmPolicy,
  });
  return {
    ...route,
    ...(params.requireAudienceValidation ? { audienceValidated: true } : {}),
    senderIsOwner: resolveStableSenderIsOwner({
      senderId,
      commandOwnerAllowFrom: params.cfg.commands?.ownerAllowFrom,
      providerAllowFrom: [...policy.dmAllowFrom, ...pairedAllowFrom],
      normalizeEntry: normalizeWhatsAppAllowFromEntry,
    }),
  };
}
