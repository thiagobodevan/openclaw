// Nextcloud Talk plugin module implements session route behavior.
import type { ChannelCurrentConversationRouteParams } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { buildOutboundBaseSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";
import type { CoreConfig } from "./types.js";

type NextcloudTalkOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
};

export function resolveNextcloudTalkOutboundSessionRoute(
  params: NextcloudTalkOutboundSessionRouteParams,
) {
  const roomId = stripNextcloudTalkTargetPrefix(params.target);
  if (!roomId) {
    return null;
  }
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    peer: {
      kind: "group",
      id: roomId,
    },
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer: {
      kind: "group" as const,
      id: roomId,
    },
    chatType: "group" as const,
    from: `nextcloud-talk:room:${roomId}`,
    to: `nextcloud-talk:${roomId}`,
  };
}

function normalizeNextcloudTalkAudienceId(raw: string | null | undefined): string | undefined {
  const id = raw ? stripNextcloudTalkTargetPrefix(raw) : undefined;
  return id?.toLowerCase();
}

function validateNextcloudTalkDirectAudience(
  params: ChannelCurrentConversationRouteParams,
  senderId: string,
): boolean {
  const senderEvidence = new Set<string>();
  const roomEvidence = new Set<string>();
  const nativeRoomId = normalizeNextcloudTalkAudienceId(params.conversationId);
  if (nativeRoomId) {
    roomEvidence.add(nativeRoomId);
  }
  for (const evidence of params.audienceEvidence ?? []) {
    const id = normalizeNextcloudTalkAudienceId(evidence.value);
    if (!id || evidence.source === "group") {
      return false;
    }
    if (
      evidence.source === "route" ||
      evidence.source === "delivery" ||
      evidence.source === "last"
    ) {
      senderEvidence.add(id);
    } else {
      roomEvidence.add(id);
    }
  }
  // Direct sessions route by sender, while the webhook's native destination is
  // the room token. Certify the persisted pair without recasting either id.
  return senderEvidence.size === 1 && senderEvidence.has(senderId) && roomEvidence.size === 1;
}

export function resolveNextcloudTalkCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const targetId = normalizeNextcloudTalkAudienceId(params.target);
  if (!targetId || (params.chatType !== "direct" && params.chatType !== "group")) {
    return null;
  }
  const isDirect = params.chatType === "direct";
  const senderId = normalizeNextcloudTalkAudienceId(params.senderId);
  if (isDirect && (!senderId || senderId !== targetId)) {
    return null;
  }
  const nativeConversationId = normalizeNextcloudTalkAudienceId(params.conversationId);
  if (!isDirect && nativeConversationId && nativeConversationId !== targetId) {
    return null;
  }
  if (params.requireAudienceValidation) {
    let audienceMatches: boolean;
    if (isDirect) {
      if (!senderId) {
        return null;
      }
      audienceMatches = validateNextcloudTalkDirectAudience(params, senderId);
    } else {
      audienceMatches =
        params.audienceEvidence !== undefined &&
        params.audienceEvidence.length > 0 &&
        params.audienceEvidence.every(
          (evidence) => normalizeNextcloudTalkAudienceId(evidence.value) === targetId,
        );
    }
    if (!audienceMatches) {
      return null;
    }
  }
  const account = resolveNextcloudTalkAccount({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "nextcloud-talk",
    accountId: account.accountId,
    peer: { kind: params.chatType, id: targetId },
  });
  const conversation = {
    channel: "nextcloud-talk",
    accountId: route.accountId,
    conversationId: targetId,
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
