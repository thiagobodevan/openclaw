// Matrix plugin module implements session route behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  type ChannelCurrentConversationRouteParams,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { parseThreadSessionSuffix, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveMatrixAccountConfig } from "./matrix/account-config.js";
import { resolveDefaultMatrixAccountId } from "./matrix/accounts.js";
import { resolveMatrixInboundRoute } from "./matrix/monitor/route.js";
import { resolveMatrixStoredSessionMeta } from "./matrix/session-store-metadata.js";
import {
  isMatrixQualifiedRoomTarget,
  isMatrixQualifiedUserId,
  resolveMatrixTargetIdentity,
} from "./matrix/target-ids.js";

function resolveEffectiveMatrixAccountId(
  params: Pick<ChannelOutboundSessionRouteParams, "cfg" | "accountId">,
): string {
  return normalizeAccountId(params.accountId ?? resolveDefaultMatrixAccountId(params.cfg));
}

function resolveMatrixDmSessionScope(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  accountId: string;
}): "per-user" | "per-room" {
  return (
    resolveMatrixAccountConfig({
      cfg: params.cfg,
      accountId: params.accountId,
    }).dm?.sessionScope ?? "per-user"
  );
}

function resolveMatrixCurrentDmRoomId(params: {
  cfg: ChannelOutboundSessionRouteParams["cfg"];
  agentId: string;
  accountId: string;
  currentSessionKey?: string;
  targetUserId: string;
}): string | undefined {
  const sessionKey =
    parseThreadSessionSuffix(params.currentSessionKey).baseSessionKey ??
    params.currentSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    const existing = getSessionEntry({
      storePath,
      sessionKey,
    });
    const currentSession = resolveMatrixStoredSessionMeta(existing);
    if (!currentSession) {
      return undefined;
    }
    if (currentSession.accountId && currentSession.accountId !== params.accountId) {
      return undefined;
    }
    if (!currentSession.directUserId || currentSession.directUserId !== params.targetUserId) {
      return undefined;
    }
    return currentSession.roomId;
  } catch {
    return undefined;
  }
}

export function resolveMatrixOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const target =
    resolveMatrixTargetIdentity(params.resolvedTarget?.to ?? params.target) ??
    resolveMatrixTargetIdentity(params.target);
  if (!target) {
    return null;
  }
  const effectiveAccountId = resolveEffectiveMatrixAccountId(params);
  const roomScopedDmId =
    target.kind === "user" &&
    resolveMatrixDmSessionScope({
      cfg: params.cfg,
      accountId: effectiveAccountId,
    }) === "per-room"
      ? resolveMatrixCurrentDmRoomId({
          cfg: params.cfg,
          agentId: params.agentId,
          accountId: effectiveAccountId,
          currentSessionKey: params.currentSessionKey,
          targetUserId: target.id,
        })
      : undefined;
  const peer =
    roomScopedDmId !== undefined
      ? { kind: "channel" as const, id: roomScopedDmId }
      : {
          kind: target.kind === "user" ? ("direct" as const) : ("channel" as const),
          id: target.id,
        };
  const chatType = target.kind === "user" ? "direct" : "channel";
  const from = target.kind === "user" ? `matrix:${target.id}` : `matrix:channel:${target.id}`;
  const to =
    roomScopedDmId !== undefined
      ? `room:${roomScopedDmId}`
      : target.kind === "user"
        ? `user:${target.id}`
        : `room:${target.id}`;

  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "matrix",
    accountId: effectiveAccountId,
    peer,
    chatType,
    from,
    to,
  });
  return buildThreadAwareOutboundSessionRoute({
    route: baseRoute,
    replyToId: params.replyToId,
    threadId: params.threadId,
    currentSessionKey: params.currentSessionKey,
    normalizeThreadId: (threadId) => threadId,
    canRecoverCurrentThread: ({ route }) =>
      route.peer.kind !== "direct" || (params.cfg.session?.dmScope ?? "main") !== "main",
  });
}

export function resolveMatrixCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const target = resolveMatrixTargetIdentity(params.target);
  const nativeConversationId = params.conversationId?.trim();
  const parsedNativeConversation = nativeConversationId
    ? resolveMatrixTargetIdentity(nativeConversationId)
    : undefined;
  const isDirectMessage = params.chatType === "direct";
  if (
    !target ||
    (nativeConversationId !== undefined &&
      (parsedNativeConversation?.kind !== "room" ||
        !isMatrixQualifiedRoomTarget(parsedNativeConversation.id)))
  ) {
    return null;
  }
  const nativeConversation =
    parsedNativeConversation?.kind === "room" ? parsedNativeConversation : undefined;
  // Older room sessions may lack duplicate native metadata. A qualified room
  // target is sufficient, but any retained native identity must still agree.
  if (
    !isDirectMessage &&
    (target.kind !== "room" ||
      (nativeConversation !== undefined &&
        (nativeConversation.kind !== "room" || target.id !== nativeConversation.id)))
  ) {
    return null;
  }
  const room = nativeConversation ?? target;
  if (room.kind !== "room" || !isMatrixQualifiedRoomTarget(room.id)) {
    return null;
  }
  const sender = isDirectMessage ? resolveMatrixTargetIdentity(params.senderId ?? "") : undefined;
  if (isDirectMessage && sender?.kind !== "user") {
    return null;
  }
  if (params.requireAudienceValidation) {
    const audienceMatches =
      params.audienceEvidence !== undefined &&
      params.audienceEvidence.length > 0 &&
      params.audienceEvidence.every((evidence) => {
        const identity = resolveMatrixTargetIdentity(evidence.value);
        if (!identity) {
          return false;
        }
        if (!isDirectMessage) {
          return identity.kind === "room" && identity.id === room.id;
        }
        if (identity.kind === "room") {
          return identity.id === room.id;
        }
        return isMatrixQualifiedUserId(identity.id) && identity.id === sender?.id;
      });
    if (!audienceMatches) {
      return null;
    }
  }
  const accountId = resolveEffectiveMatrixAccountId(params);
  const { route } = resolveMatrixInboundRoute({
    cfg: params.cfg,
    accountId,
    roomId: room.id,
    senderId: sender?.id ?? params.senderId ?? "",
    isDirectMessage,
    dmSessionScope: resolveMatrixDmSessionScope({ cfg: params.cfg, accountId }),
    threadId: params.threadId == null ? undefined : String(params.threadId),
    resolveAgentRoute,
  });
  return params.requireAudienceValidation ? { ...route, audienceValidated: true } : route;
}
