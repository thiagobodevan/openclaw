// Imessage plugin module implements conversation route behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
  touchRuntimeConversationBindingRoute,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveIMessageInboundConversationId } from "./conversation-id.js";

type IMessageConversationRouteParams = {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  peerId: string;
  sender: string;
  chatId?: number;
};

export function lookupIMessageConversationRoute(params: IMessageConversationRouteParams): {
  route: ReturnType<typeof resolveAgentRoute>;
  runtimeBinding: SessionBindingRecord | null;
} {
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.peerId,
    },
  });

  const conversationId = resolveIMessageInboundConversationId({
    isGroup: params.isGroup,
    sender: params.sender,
    chatId: params.chatId,
  });
  if (!conversationId) {
    return { route, runtimeBinding: null };
  }

  route = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: {
      channel: "imessage",
      accountId: params.accountId,
      conversationId,
    },
  }).route;

  const runtimeRoute = lookupRuntimeConversationBindingRoute({
    route,
    conversation: {
      channel: "imessage",
      accountId: params.accountId,
      conversationId,
    },
  });
  route = runtimeRoute.route;
  if (runtimeRoute.bindingRecord && !runtimeRoute.boundSessionKey) {
    logVerbose(`imessage: plugin-bound conversation ${conversationId}`);
  } else if (runtimeRoute.boundSessionKey) {
    logVerbose(
      `imessage: routed via bound conversation ${conversationId} -> ${runtimeRoute.boundSessionKey}`,
    );
  }
  return { route, runtimeBinding: runtimeRoute.bindingRecord };
}

export function resolveIMessageConversationRoute(
  params: IMessageConversationRouteParams,
): ReturnType<typeof resolveAgentRoute> {
  const state = lookupIMessageConversationRoute(params);
  touchRuntimeConversationBindingRoute({ bindingRecord: state.runtimeBinding });
  return state.route;
}
