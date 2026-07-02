// Feishu plugin module implements session route behavior.
import {
  type ChannelCurrentConversationRouteParams,
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  buildAgentMainSessionKey,
  deriveLastRoutePolicy,
  normalizeAgentId,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { resolveFeishuGroupSession } from "./bot-content.js";
import { buildFeishuBroadcastSessionKey } from "./broadcast-session.js";
import { parseFeishuConversationId, parseFeishuTargetId } from "./conversation-id.js";
import { resolveFeishuGroupConfig } from "./policy.js";

export function resolveFeishuOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "feishu", "lark");
  if (!trimmed) {
    return null;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  let isGroup = false;
  let typeExplicit = false;

  if (lower.startsWith("group:") || lower.startsWith("chat:") || lower.startsWith("channel:")) {
    trimmed = trimmed.replace(/^(group|chat|channel):/i, "").trim();
    isGroup = true;
    typeExplicit = true;
  } else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
    isGroup = false;
    typeExplicit = true;
  }

  if (!typeExplicit) {
    const idLower = normalizeLowercaseStringOrEmpty(trimmed);
    if (idLower.startsWith("ou_") || idLower.startsWith("on_")) {
      isGroup = false;
    }
  }

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "feishu",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: trimmed,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `feishu:group:${trimmed}` : `feishu:${trimmed}`,
    to: trimmed,
  });
}

export function resolveFeishuCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const targetId = parseFeishuTargetId(params.target);
  if (!targetId) {
    return null;
  }
  const isGroup = params.chatType !== "direct";
  const persistedConversationId = parseFeishuTargetId(params.conversationId) ?? targetId;
  const parsedConversation = isGroup
    ? parseFeishuConversationId({
        conversationId: persistedConversationId,
        parentConversationId: params.parentConversationId ?? undefined,
      })
    : null;
  if (isGroup && !parsedConversation) {
    return null;
  }
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!isGroup) {
    const senderId = params.senderId?.trim();
    if (senderId && senderId !== targetId) {
      return null;
    }
    const directRoute = resolveAgentRoute({
      cfg: params.cfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: { kind: "direct", id: targetId },
    });
    const conversation = {
      channel: "feishu",
      accountId: directRoute.accountId,
      conversationId: targetId,
    };
    const configuredRoute = resolveConfiguredBindingRoute({
      cfg: params.cfg,
      route: directRoute,
      conversation,
    });
    const runtimeRoute = lookupRuntimeConversationBindingRoute({
      route: configuredRoute.route,
      conversation,
    });
    return runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey ? null : runtimeRoute.route;
  }
  const chatId = parsedConversation?.chatId ?? targetId;
  const groupConfig = resolveFeishuGroupConfig({ cfg: account.config, groupId: chatId });
  const senderOpenId = params.senderId?.trim() || parsedConversation?.senderOpenId || "";
  const topicId =
    parsedConversation?.topicId || (params.threadId == null ? "" : String(params.threadId).trim());
  const groupSession = resolveFeishuGroupSession({
    chatId,
    senderOpenId,
    messageId: "",
    rootId: topicId || undefined,
    threadId: topicId || undefined,
    groupConfig,
    feishuCfg: account.config,
  });
  if (
    (groupSession.groupSessionScope === "group_sender" ||
      groupSession.groupSessionScope === "group_topic_sender") &&
    !senderOpenId
  ) {
    return null;
  }
  const peer = {
    kind: "group" as const,
    id: groupSession.peerId,
  };
  const baseRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer,
    parentPeer: groupSession.parentPeer ?? undefined,
  });
  const conversation = {
    channel: "feishu",
    accountId: baseRoute.accountId,
    conversationId: groupSession.peerId,
    parentConversationId: groupSession.parentPeer?.id ?? chatId,
  };
  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route: baseRoute,
    conversation,
  });
  const runtimeRoute = lookupRuntimeConversationBindingRoute({
    route: configuredRoute.route,
    conversation,
  });
  const targetAgentId = params.agentId?.trim();
  const broadcastAgents = params.cfg.broadcast?.[chatId];
  const isBroadcastTarget =
    targetAgentId &&
    Array.isArray(broadcastAgents) &&
    broadcastAgents.some(
      (agentId) => normalizeAgentId(agentId) === normalizeAgentId(targetAgentId),
    );
  if (isBroadcastTarget) {
    const agentId = normalizeAgentId(targetAgentId);
    const sessionKey = buildFeishuBroadcastSessionKey(
      runtimeRoute.route.sessionKey,
      runtimeRoute.route.agentId,
      agentId,
    );
    const mainSessionKey = buildAgentMainSessionKey({ agentId, mainKey: "main" });
    return {
      ...runtimeRoute.route,
      agentId,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
      matchedBy: "config.agent" as const,
    };
  }
  if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) {
    // Plugin-owned handoffs require the owning plugin; persisted metadata
    // cannot authorize work on their unmaterialized target.
    return null;
  }
  return runtimeRoute.route;
}
