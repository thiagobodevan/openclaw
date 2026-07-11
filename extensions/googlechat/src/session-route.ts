// Googlechat plugin module implements persisted session route revalidation.
import type { ChannelCurrentConversationRouteParams } from "openclaw/plugin-sdk/channel-core";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveGoogleChatAccount } from "./accounts.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
} from "./targets.js";

type GoogleChatAudience = {
  id: string;
  kind: "space" | "user";
};

function resolveGoogleChatAudience(raw: string): GoogleChatAudience | null {
  const id = normalizeGoogleChatTarget(raw);
  if (!id) {
    return null;
  }
  if (isGoogleChatSpaceTarget(id)) {
    return { id, kind: "space" };
  }
  return isGoogleChatUserTarget(id) ? { id, kind: "user" } : null;
}

export function resolveGoogleChatCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const target = resolveGoogleChatAudience(params.target);
  if (!target || target.kind !== "space") {
    return null;
  }
  const isDirect = params.chatType === "direct";
  if (!isDirect && params.chatType !== "group" && params.chatType !== "channel") {
    return null;
  }
  const conversation = params.conversationId
    ? resolveGoogleChatAudience(params.conversationId)
    : undefined;
  if (
    params.conversationId &&
    (!conversation || conversation.kind !== "space" || conversation.id !== target.id)
  ) {
    return null;
  }
  if (isDirect) {
    const sender = resolveGoogleChatAudience(params.senderId ?? "");
    // Google Chat DMs route by their spaces/* conversation while sender policy
    // uses the distinct users/* identity. Both native facts are required.
    if (!sender || sender.kind !== "user") {
      return null;
    }
  }
  if (params.requireAudienceValidation) {
    const audienceMatches =
      params.audienceEvidence !== undefined &&
      params.audienceEvidence.length > 0 &&
      params.audienceEvidence.every((evidence) => {
        const audience = resolveGoogleChatAudience(evidence.value);
        return audience?.kind === "space" && audience.id === target.id;
      });
    if (!audienceMatches) {
      return null;
    }
  }
  const account = resolveGoogleChatAccount({ cfg: params.cfg, accountId: params.accountId });
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "googlechat",
    accountId: account.accountId,
    peer: { kind: isDirect ? "direct" : "group", id: target.id },
  });
  const conversationRef = {
    channel: "googlechat",
    accountId: route.accountId,
    conversationId: target.id,
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
