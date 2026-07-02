import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Discord plugin module implements message handler.routing preflight behavior.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { User } from "../internal/discord.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import { resolveDiscordConversationBindingRoute } from "./route-resolution.js";

const loadConversationRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/conversation-binding-runtime"),
);

export async function resolveDiscordPreflightRoute(params: {
  preflight: DiscordMessagePreflightParams;
  author: User;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  messageChannelId: string;
  memberRoleIds: string[];
  earlyThreadParentId?: string;
}) {
  const conversationRuntime = await loadConversationRuntime();
  const routeState = resolveDiscordConversationBindingRoute({
    cfg: params.preflight.cfg,
    accountId: params.preflight.accountId,
    guildId: params.preflight.data.guild_id ?? undefined,
    memberRoleIds: params.memberRoleIds,
    isDirectMessage: params.isDirectMessage,
    isGroupDm: params.isGroupDm,
    directUserId: params.author.id,
    conversationId: params.messageChannelId,
    configuredConversationId: params.messageChannelId,
    parentConversationId: params.earlyThreadParentId,
    runtime: conversationRuntime,
  });
  if (routeState.staleRuntimeBinding) {
    logVerbose(
      `discord: ignoring stale route binding for conversation ${routeState.bindingConversationId} (${routeState.ignoredRuntimeBinding?.targetSessionKey} -> ${routeState.route.sessionKey})`,
    );
  }

  return {
    conversationRuntime,
    runtimeBinding: routeState.runtimeBinding,
    threadBinding: routeState.threadBinding,
    configuredBinding: routeState.configuredBinding,
    boundSessionKey: routeState.boundSessionKey,
    effectiveRoute: routeState.effectiveRoute,
    boundAgentId: routeState.boundAgentId,
    baseSessionKey: routeState.effectiveRoute.sessionKey,
  };
}
