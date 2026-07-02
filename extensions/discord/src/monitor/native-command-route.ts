// Discord plugin module implements native command route behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  resolveConversationIdentityMode,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import {
  resolveDiscordBoundConversationRoute,
  resolveDiscordEffectiveRoute,
  shouldIgnoreStaleDiscordRouteBinding,
} from "./route-resolution.js";
import type { ThreadBindingRecord } from "./thread-bindings.js";

type ResolvedConfiguredBindingRoute = ReturnType<
  typeof conversationRuntime.resolveConfiguredBindingRoute
>;
type ConfiguredBindingResolution = NonNullable<
  NonNullable<ResolvedConfiguredBindingRoute>["bindingResolution"]
>;

type DiscordNativeInteractionRouteState = {
  route: ResolvedAgentRoute;
  effectiveRoute: ResolvedAgentRoute;
  boundSessionKey?: string;
  configuredRoute: ResolvedConfiguredBindingRoute | null;
  configuredBinding: ConfiguredBindingResolution | null;
  runtimeBinding: ReturnType<
    typeof conversationRuntime.lookupRuntimeConversationBindingRoute
  >["bindingRecord"];
  identityDecision: ReturnType<typeof resolveConversationIdentityMode>;
  bindingReadiness: Awaited<
    ReturnType<typeof conversationRuntime.ensureConfiguredBindingRouteReady>
  > | null;
};

export async function resolveDiscordNativeInteractionRouteState(params: {
  cfg: OpenClawConfig;
  accountId: string;
  guildId?: string;
  memberRoleIds?: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string;
  conversationId: string;
  parentConversationId?: string;
  threadBinding?: ThreadBindingRecord;
  senderIsOwner?: boolean;
  enforceConfiguredBindingReadiness?: boolean;
}): Promise<DiscordNativeInteractionRouteState> {
  const route = resolveDiscordBoundConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: params.guildId,
    memberRoleIds: params.memberRoleIds,
    isDirectMessage: params.isDirectMessage,
    isGroupDm: params.isGroupDm,
    directUserId: params.directUserId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  const runtimeConversationId = params.isDirectMessage
    ? (resolveDiscordConversationIdentity({
        isDirectMessage: true,
        userId: params.directUserId,
      }) ?? `user:${params.directUserId ?? params.conversationId}`)
    : params.conversationId;
  let runtimeRoute = conversationRuntime.lookupRuntimeConversationBindingRoute({
    route,
    conversation: {
      channel: "discord",
      accountId: params.accountId,
      conversationId: runtimeConversationId,
      parentConversationId: params.parentConversationId,
    },
  });
  if (
    shouldIgnoreStaleDiscordRouteBinding({
      bindingRecord: runtimeRoute.bindingRecord,
      route,
    })
  ) {
    runtimeRoute = { bindingRecord: null, route };
  }
  const configuredRoute =
    params.threadBinding == null && runtimeRoute.bindingRecord == null
      ? conversationRuntime.resolveConfiguredBindingRoute({
          cfg: params.cfg,
          route,
          conversation: {
            channel: "discord",
            accountId: params.accountId,
            conversationId: params.conversationId,
            parentConversationId: params.parentConversationId,
          },
        })
      : null;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  const configuredBoundSessionKey = normalizeOptionalString(configuredRoute?.boundSessionKey);
  const boundSessionKey =
    normalizeOptionalString(params.threadBinding?.targetSessionKey) ??
    normalizeOptionalString(runtimeRoute.boundSessionKey) ??
    configuredBoundSessionKey;
  const effectiveRoute =
    runtimeRoute.boundSessionKey && params.threadBinding == null
      ? runtimeRoute.route
      : resolveDiscordEffectiveRoute({
          route,
          boundSessionKey,
          configuredRoute,
          matchedBy:
            params.threadBinding || runtimeRoute.bindingRecord || configuredBinding
              ? "binding.channel"
              : undefined,
        });
  const identityDecision = resolveConversationIdentityMode({
    config: params.cfg,
    agentId: effectiveRoute.agentId,
    routeMatchedBy: effectiveRoute.matchedBy,
    chatType: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    groupId: params.isDirectMessage ? undefined : params.conversationId,
    groupSpace: params.guildId,
    senderIsOwner: params.senderIsOwner,
  });
  const bindingReadiness =
    params.enforceConfiguredBindingReadiness && configuredBinding && identityDecision.allowed
      ? await conversationRuntime.ensureConfiguredBindingRouteReady({
          cfg: params.cfg,
          bindingResolution: configuredBinding,
        })
      : null;
  return {
    route,
    effectiveRoute,
    boundSessionKey,
    configuredRoute,
    configuredBinding,
    runtimeBinding: runtimeRoute.bindingRecord,
    identityDecision,
    bindingReadiness,
  };
}
