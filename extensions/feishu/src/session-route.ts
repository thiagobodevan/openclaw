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

function parseFeishuAudienceTarget(raw: unknown): {
  id: string;
  kind: "direct" | "group" | "unknown";
} | null {
  const id = parseFeishuTargetId(raw);
  if (!id || typeof raw !== "string") {
    return null;
  }
  const withoutProvider = raw
    .trim()
    .replace(/^(feishu|lark):/i, "")
    .trim();
  const prefix = /^(chat|group|channel|user|dm|open_id):/i.exec(withoutProvider)?.[1];
  const normalizedPrefix = prefix?.toLowerCase();
  // Native Feishu id families own the audience kind. A conflicting generic
  // prefix must not recast a shared chat as a user, or a user as a chat.
  if (id.startsWith("oc_")) {
    return { id, kind: "group" };
  }
  if (id.startsWith("ou_") || id.startsWith("on_")) {
    return { id, kind: "direct" };
  }
  if (normalizedPrefix === "user" || normalizedPrefix === "dm" || normalizedPrefix === "open_id") {
    return { id, kind: "direct" };
  }
  if (
    normalizedPrefix === "chat" ||
    normalizedPrefix === "group" ||
    normalizedPrefix === "channel"
  ) {
    return { id, kind: "group" };
  }
  return {
    id,
    kind: "unknown",
  };
}

export function resolveFeishuCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const target = parseFeishuAudienceTarget(params.target);
  if (!target) {
    return null;
  }
  const targetId = target.id;
  const isGroup = params.chatType !== "direct";
  const ambientSenderId = params.senderId?.trim() || undefined;
  const targetIsDirect =
    target.kind === "direct" ||
    (target.kind === "unknown" && ambientSenderId !== undefined && ambientSenderId === targetId);
  if ((isGroup && target.kind === "direct") || (!isGroup && !targetIsDirect)) {
    return null;
  }
  const persistedTarget = params.conversationId
    ? parseFeishuAudienceTarget(params.conversationId)
    : undefined;
  if (
    params.conversationId &&
    (!persistedTarget ||
      (isGroup && persistedTarget.kind === "direct") ||
      (!isGroup &&
        (persistedTarget.id !== targetId ||
          (persistedTarget.kind !== "direct" &&
            !(persistedTarget.kind === "unknown" && ambientSenderId === targetId)))))
  ) {
    return null;
  }
  const persistedConversationId = persistedTarget?.id ?? targetId;
  const parsedConversation = isGroup
    ? parseFeishuConversationId({
        conversationId: persistedConversationId,
        parentConversationId: params.parentConversationId ?? undefined,
      })
    : null;
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!isGroup) {
    if (ambientSenderId !== targetId) {
      return null;
    }
    if (params.requireAudienceValidation) {
      const identities = params.audienceEvidence?.map((evidence) =>
        parseFeishuAudienceTarget(evidence.value),
      );
      if (
        !identities?.length ||
        !identities.every(
          (identity) =>
            identity?.id === targetId &&
            (identity.kind === "direct" ||
              (identity.kind === "unknown" && ambientSenderId === targetId)),
        )
      ) {
        return null;
      }
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
    if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) {
      return null;
    }
    return params.requireAudienceValidation
      ? { ...runtimeRoute.route, audienceValidated: true }
      : runtimeRoute.route;
  }
  const chatId = parsedConversation?.chatId ?? targetId;
  const parsedTarget = parseFeishuConversationId({ conversationId: targetId });
  if (!parsedConversation || parsedTarget?.chatId !== chatId) {
    return null;
  }
  const groupConfig = resolveFeishuGroupConfig({ cfg: account.config, groupId: chatId });
  const ambientThreadId =
    params.threadId == null ? undefined : String(params.threadId).trim() || undefined;
  const senderOpenId =
    ambientSenderId || parsedTarget.senderOpenId || parsedConversation.senderOpenId || "";
  const canonicalTopicId = parsedTarget.topicId || parsedConversation.topicId;
  const topicId = canonicalTopicId || ambientThreadId;
  const groupSession = resolveFeishuGroupSession({
    chatId,
    senderOpenId,
    messageId: "",
    rootId: topicId || undefined,
    threadId: topicId || undefined,
    groupConfig,
    feishuCfg: account.config,
  });
  const selectedConversation = parseFeishuConversationId({ conversationId: groupSession.peerId });
  if (!selectedConversation) {
    return null;
  }
  const scopeUsesTopic =
    groupSession.groupSessionScope === "group_topic" ||
    groupSession.groupSessionScope === "group_topic_sender";
  const scopeUsesSender =
    groupSession.groupSessionScope === "group_sender" ||
    groupSession.groupSessionScope === "group_topic_sender";
  const selectedTopics = new Set(
    [
      parsedTarget.topicId,
      parsedConversation.topicId,
      scopeUsesTopic && !canonicalTopicId ? ambientThreadId : undefined,
    ].filter((topic): topic is string => Boolean(topic)),
  );
  const selectedSenders = new Set(
    [
      parsedTarget.senderOpenId,
      parsedConversation.senderOpenId,
      scopeUsesSender ? ambientSenderId : undefined,
    ].filter((sender): sender is string => Boolean(sender)),
  );
  if (
    selectedTopics.size > 1 ||
    selectedSenders.size > 1 ||
    (!scopeUsesTopic && selectedTopics.size > 0) ||
    (!scopeUsesSender && selectedSenders.size > 0) ||
    (selectedTopics.size > 0 && !selectedTopics.has(selectedConversation.topicId ?? "")) ||
    (selectedSenders.size > 0 && !selectedSenders.has(selectedConversation.senderOpenId ?? ""))
  ) {
    return null;
  }
  if (params.requireAudienceValidation) {
    const identities = params.audienceEvidence?.map((evidence) => {
      const candidate = parseFeishuAudienceTarget(evidence.value);
      return candidate && candidate.kind !== "direct"
        ? parseFeishuConversationId({ conversationId: candidate.id })
        : null;
    });
    if (
      !identities?.length ||
      !identities.every(
        (identity) =>
          identity?.chatId === chatId &&
          (!identity.topicId ||
            (scopeUsesTopic && identity.topicId === selectedConversation.topicId)) &&
          (!identity.senderOpenId ||
            (scopeUsesSender && identity.senderOpenId === selectedConversation.senderOpenId)),
      )
    ) {
      return null;
    }
  }
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
      ...(params.requireAudienceValidation ? { audienceValidated: true } : {}),
    };
  }
  if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) {
    // Plugin-owned handoffs require the owning plugin; persisted metadata
    // cannot authorize work on their unmaterialized target.
    return null;
  }
  return params.requireAudienceValidation
    ? { ...runtimeRoute.route, audienceValidated: true }
    : runtimeRoute.route;
}
