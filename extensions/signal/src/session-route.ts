// Signal plugin module implements persisted session route revalidation.
import type { ChannelCurrentConversationRouteParams } from "openclaw/plugin-sdk/channel-core";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveSignalAccount } from "./accounts.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { resolveSignalOutboundTarget } from "./outbound-session.js";

function resolveSignalAudience(raw: string) {
  const normalized = normalizeSignalMessagingTarget(raw);
  return normalized ? resolveSignalOutboundTarget(normalized) : null;
}

export function resolveSignalCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const target = resolveSignalAudience(params.target);
  if (!target || target.chatType !== params.chatType) {
    return null;
  }
  const conversation = params.conversationId
    ? resolveSignalAudience(params.conversationId)
    : undefined;
  if (
    params.conversationId &&
    (!conversation ||
      conversation.chatType !== target.chatType ||
      conversation.peer.id !== target.peer.id)
  ) {
    return null;
  }
  if (params.chatType === "direct") {
    const sender = resolveSignalAudience(params.senderId ?? "");
    if (!sender || sender.chatType !== "direct" || sender.peer.id !== target.peer.id) {
      return null;
    }
  }
  if (params.requireAudienceValidation) {
    const audienceMatches =
      params.audienceEvidence !== undefined &&
      params.audienceEvidence.length > 0 &&
      params.audienceEvidence.every((evidence) => {
        const identity = resolveSignalAudience(evidence.value);
        return identity?.chatType === target.chatType && identity.peer.id === target.peer.id;
      });
    if (!audienceMatches) {
      return null;
    }
  }
  const account = resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId });
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "signal",
    accountId: account.accountId,
    peer: target.peer,
  });
  const conversationRef = {
    channel: "signal",
    accountId: route.accountId,
    conversationId: target.peer.id,
  };
  const configured = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: conversationRef,
  });
  const runtime = lookupRuntimeConversationBindingRoute({
    route: configured.route,
    conversation: conversationRef,
  });
  if (runtime.bindingRecord && !runtime.boundSessionKey) {
    return null;
  }
  return params.requireAudienceValidation
    ? { ...runtime.route, audienceValidated: true }
    : runtime.route;
}
