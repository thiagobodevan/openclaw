// Imessage plugin module implements persisted session route revalidation.
import type { ChannelCurrentConversationRouteParams } from "openclaw/plugin-sdk/channel-core";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveIMessageAccount } from "./accounts.js";
import { normalizeIMessageHandle, parseIMessageTarget } from "./targets.js";

type IMessageAudience = {
  id: string;
  kind: "direct" | "group";
};

function resolveIMessageAudience(raw: string, expectedKind: IMessageAudience["kind"]) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = parseIMessageTarget(trimmed);
    if (parsed.kind === "handle") {
      if (expectedKind === "group" && /^(?:imessage|sms|auto):/i.test(trimmed)) {
        return null;
      }
      const id = expectedKind === "direct" ? normalizeIMessageHandle(parsed.to) : trimmed;
      return id ? ({ id, kind: expectedKind } satisfies IMessageAudience) : null;
    }
    if (expectedKind !== "group") {
      return null;
    }
    const id =
      parsed.kind === "chat_id"
        ? String(parsed.chatId)
        : parsed.kind === "chat_guid"
          ? parsed.chatGuid
          : parsed.chatIdentifier;
    return id ? ({ id, kind: "group" } satisfies IMessageAudience) : null;
  } catch {
    return null;
  }
}

export function resolveIMessageCurrentConversationRoute(
  params: ChannelCurrentConversationRouteParams,
) {
  const expectedKind = params.chatType === "direct" ? "direct" : "group";
  if (params.chatType === "channel") {
    return null;
  }
  const target = resolveIMessageAudience(params.target, expectedKind);
  if (!target) {
    return null;
  }
  const nativeConversation = params.conversationId
    ? resolveIMessageAudience(params.conversationId, "group")
    : undefined;
  if (params.conversationId && !nativeConversation) {
    return null;
  }
  if (expectedKind === "direct") {
    const sender = resolveIMessageAudience(params.senderId ?? "", "direct");
    if (!sender || sender.id !== target.id) {
      return null;
    }
  } else if (nativeConversation && nativeConversation.id !== target.id) {
    return null;
  }
  if (params.requireAudienceValidation) {
    const audienceMatches =
      params.audienceEvidence !== undefined &&
      params.audienceEvidence.length > 0 &&
      params.audienceEvidence.every((evidence) => {
        if (expectedKind === "direct" && evidence.source === "origin-native") {
          const identity = resolveIMessageAudience(evidence.value, "group");
          return identity?.id === nativeConversation?.id;
        }
        const identity = resolveIMessageAudience(evidence.value, expectedKind);
        return identity?.id === target.id;
      });
    if (!audienceMatches) {
      return null;
    }
  }
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.accountId });
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "imessage",
    accountId: account.accountId,
    peer: { kind: expectedKind, id: target.id },
  });
  const conversation = {
    channel: "imessage",
    accountId: route.accountId,
    conversationId: target.id,
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
