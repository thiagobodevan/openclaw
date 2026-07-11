// Msteams plugin module implements session route behavior.
import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelCurrentConversationRouteParams,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

function parseMSTeamsSessionTarget(target: string) {
  const trimmed = stripChannelTargetPrefix(target, "msteams", "teams");
  if (!trimmed) {
    return null;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const targetKind = /^(user|dm|conversation|group|channel|room):/.exec(lower)?.[1] as
    | "user"
    | "dm"
    | "conversation"
    | "group"
    | "channel"
    | "room"
    | undefined;
  const isUser = targetKind === "user" || targetKind === "dm";
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isChannel =
    targetKind === "channel" ||
    (targetKind !== "group" && !isUser && /@thread\.tacv2/i.test(conversationId));
  return { conversationId, isChannel, isUser, targetKind };
}

function resolveMSTeamsAudience(raw: string, teamId?: string) {
  const parsed = parseMSTeamsSessionTarget(raw);
  if (!parsed) {
    return null;
  }
  const compositePrefix = teamId ? `${teamId}/` : undefined;
  const isTeamQualifiedChannel =
    parsed.targetKind === undefined &&
    compositePrefix !== undefined &&
    parsed.conversationId.startsWith(compositePrefix);
  const conversationId =
    compositePrefix && parsed.conversationId.startsWith(compositePrefix)
      ? parsed.conversationId.slice(compositePrefix.length)
      : parsed.conversationId;
  return {
    ...parsed,
    conversationId,
    ...(isTeamQualifiedChannel ? { isChannel: true, targetKind: "channel" as const } : {}),
  };
}

function msteamsTargetKindMatchesChatType(
  targetKind: "user" | "dm" | "conversation" | "group" | "channel" | "room" | undefined,
  chatType: ChannelCurrentConversationRouteParams["chatType"],
): boolean {
  if (!targetKind) {
    // Bare Teams targets use the outbound conversation grammar. Direct
    // revalidation requires an explicit user/dm identity.
    return chatType !== "direct";
  }
  if (targetKind === "conversation") {
    return chatType !== "direct";
  }
  // Unsupported room-like prefixes must not become ambiguous after their kind
  // prefix is stripped from the opaque conversation id.
  return (
    ((targetKind === "user" || targetKind === "dm") && chatType === "direct") ||
    (targetKind === "group" && chatType === "group") ||
    (targetKind === "channel" && chatType === "channel")
  );
}

export function resolveMSTeamsOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseMSTeamsSessionTarget(params.target);
  if (!parsed) {
    return null;
  }
  const { conversationId, isChannel, isUser } = parsed;
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "msteams",
    accountId: params.accountId,
    peer: {
      kind: isUser ? "direct" : isChannel ? "channel" : "group",
      id: conversationId,
    },
    chatType: isUser ? "direct" : isChannel ? "channel" : "group",
    from: isUser
      ? `msteams:${conversationId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`,
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  });
}

export function resolveMSTeamsCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const parsed = parseMSTeamsSessionTarget(params.target);
  if (!parsed) {
    return null;
  }
  const isDirect = params.chatType === "direct";
  if (!msteamsTargetKindMatchesChatType(parsed.targetKind, params.chatType)) {
    return null;
  }
  const nativeConversationId = params.conversationId?.trim();
  if (!isDirect && nativeConversationId) {
    const teamId = params.groupSpace?.trim();
    const nativeMatchesTarget =
      nativeConversationId === parsed.conversationId ||
      (teamId !== undefined && nativeConversationId === `${teamId}/${parsed.conversationId}`);
    if (!nativeMatchesTarget) {
      return null;
    }
  }
  const senderId = params.senderId?.trim();
  if (isDirect && senderId && senderId !== parsed.conversationId) {
    return null;
  }
  if (params.requireAudienceValidation) {
    const teamId = params.groupSpace?.trim();
    const audienceMatches =
      params.audienceEvidence !== undefined &&
      params.audienceEvidence.length > 0 &&
      params.audienceEvidence.every((evidence) => {
        const candidate = resolveMSTeamsAudience(evidence.value, teamId);
        return (
          candidate?.conversationId === parsed.conversationId &&
          msteamsTargetKindMatchesChatType(candidate.targetKind, params.chatType)
        );
      });
    if (!audienceMatches) {
      return null;
    }
  }
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "msteams",
    accountId: params.accountId,
    teamId: params.groupSpace,
    peer: {
      kind: params.chatType,
      id: parsed.conversationId,
    },
  });
  const conversation = {
    channel: "msteams",
    accountId: route.accountId,
    conversationId: parsed.conversationId,
  };
  const configured = resolveConfiguredBindingRoute({ cfg: params.cfg, route, conversation });
  const runtime = lookupRuntimeConversationBindingRoute({
    route: configured.route,
    conversation,
  });
  if (runtime.bindingRecord && !runtime.boundSessionKey) {
    return null;
  }
  return params.requireAudienceValidation
    ? { ...runtime.route, audienceValidated: true }
    : runtime.route;
}
