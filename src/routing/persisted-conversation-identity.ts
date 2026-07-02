import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import {
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
} from "../channels/plugins/binding-routing.js";
import type { ChannelCurrentConversationRoute } from "../channels/plugins/types.core.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel-constants.js";
import {
  resolveConversationIdentityMode,
  type ConversationIdentityDecision,
} from "./conversation-identity.js";
import type { PersistedPluginConversationRouteResult } from "./persisted-conversation-identity.runtime.js";
import { resolveAgentRoute, type AgentRouteMatch } from "./resolve-route.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
  parseThreadSessionSuffix,
} from "./session-key.js";

export type PersistedConversationIdentityContext = {
  decision: ConversationIdentityDecision;
  routeMatchedBy?: AgentRouteMatch;
  messageProvider?: string;
  chatType?: ChatType;
  agentAccountId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  senderId?: string;
  senderIsOwner?: boolean;
};

export type PersistedPluginConversationRouteResolver = (params: {
  cfg: OpenClawConfig;
  channel: string;
  agentId?: string;
  accountId?: string | null;
  target: string;
  conversationId?: string | null;
  parentConversationId?: string | null;
  chatType: ChatType;
  groupSpace?: string | null;
  threadId?: string | number | null;
  senderId?: string | null;
}) => Promise<PersistedPluginConversationRouteResult>;

type PersistedConversationAudience = {
  channel: string;
  accountId?: string;
  target: string;
  conversationId?: string;
  parentConversationId?: string;
  bindingConversationId?: string;
  peerId: string;
  chatType: ChatType;
  threadId?: string | number;
  senderId?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

function deniedStaleRoute(): PersistedConversationIdentityContext {
  return {
    decision: { mode: "external", allowed: false, reason: "stale_route" },
  };
}

function stripPersistedAddressPrefix(raw: string | undefined, channel: string): string | undefined {
  let value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  const providerPrefix = `${channel}:`;
  if (value.toLowerCase().startsWith(providerPrefix.toLowerCase())) {
    value = value.slice(providerPrefix.length);
  }
  return normalizeOptionalString(value.replace(/^(?:user|direct|dm|group|channel|room):/i, ""));
}

function parseCompactDirectPeer(sessionKey: string): string | undefined {
  const rest = parseAgentSessionKey(sessionKey)?.rest;
  if (!rest?.toLowerCase().startsWith("direct:")) {
    return undefined;
  }
  return normalizeOptionalString(rest.slice("direct:".length));
}

function hasPersistedAudienceMetadata(entry: SessionEntry | undefined): boolean {
  return Boolean(
    entry?.chatType ||
    entry?.channel ||
    entry?.groupId ||
    entry?.groupChannel ||
    entry?.space ||
    entry?.route ||
    entry?.origin ||
    entry?.lastChannel ||
    entry?.lastTo ||
    entry?.lastAccountId ||
    entry?.lastThreadId != null,
  );
}

function isInternalPersistedChannel(channel: string): boolean {
  return channel === INTERNAL_MESSAGE_CHANNEL || isInternalNonDeliveryChannel(channel);
}

function resolvePersistedConversationAudience(params: {
  sessionKey: string;
  sessionEntry?: SessionEntry;
}): PersistedConversationAudience | null | undefined {
  const entry = params.sessionEntry;
  const delivery = parseSessionDeliveryRoute(params.sessionKey);
  const compactDirectPeer = parseCompactDirectPeer(params.sessionKey);
  if (!delivery && !compactDirectPeer && !hasPersistedAudienceMetadata(entry)) {
    return undefined;
  }

  const deliveryChannel = normalizeOptionalLowercaseString(delivery?.channel);
  const routeChannel = normalizeOptionalLowercaseString(entry?.route?.channel);
  const originProvider = normalizeOptionalLowercaseString(entry?.origin?.provider);
  const originSurface = normalizeOptionalLowercaseString(entry?.origin?.surface);
  const entryChannel = normalizeOptionalLowercaseString(entry?.channel);
  const lastChannel = normalizeOptionalLowercaseString(entry?.lastChannel);
  const channel = [
    deliveryChannel,
    routeChannel,
    originProvider,
    originSurface,
    entryChannel,
    lastChannel,
  ].find((candidate) => candidate && !isInternalPersistedChannel(candidate));
  if (!channel) {
    // Internal transport metadata does not turn an agent/main or named session
    // into a channel audience. The caller's audienceless policy still applies.
    return undefined;
  }
  const originMatchesChannel = originProvider === channel || originSurface === channel;
  const originNativeProvider = normalizeOptionalLowercaseString(entry?.origin?.nativeProvider);
  const routeTarget =
    routeChannel === channel ? normalizeOptionalString(entry?.route?.target?.to) : undefined;
  const deliveryTarget =
    deliveryChannel === channel ? normalizeOptionalString(delivery?.peerId) : undefined;
  const lastTarget = lastChannel === channel ? normalizeOptionalString(entry?.lastTo) : undefined;
  const explicitPeerIds = [routeTarget, deliveryTarget, lastTarget]
    .map((target) => stripPersistedAddressPrefix(target, channel))
    .filter((target): target is string => Boolean(target));
  const originNativePeerIds = [entry?.origin?.nativeChannelId, entry?.origin?.nativeDirectUserId]
    .map((target) => stripPersistedAddressPrefix(target, channel))
    .filter((target): target is string => Boolean(target));
  const originTransportPeerIds = [entry?.origin?.to, entry?.origin?.from]
    .map((target) => stripPersistedAddressPrefix(target, channel))
    .filter((target): target is string => Boolean(target));
  const originPeerIds = [...new Set([...originNativePeerIds, ...originTransportPeerIds])];
  // Older direct-message entries can pair a native conversation id with the
  // delivery user only in origin.to/from. Trust that pairing only while the
  // origin provider still owns the selected audience, never after an overlay.
  const nativeAudiencePeerIds = originMatchesChannel ? originPeerIds : originNativePeerIds;
  const explicitAccountIds = [
    routeTarget ? entry?.route?.accountId : undefined,
    deliveryTarget ? delivery?.accountId : undefined,
    lastTarget ? entry?.lastAccountId : undefined,
  ]
    .map(normalizeOptionalString)
    .filter((accountId): accountId is string => Boolean(accountId));
  const originAccountId = normalizeOptionalString(entry?.origin?.accountId);
  const explicitPeersMatchOrigin =
    explicitPeerIds.length === 0 ||
    explicitPeerIds.every((peerId) => originPeerIds.includes(peerId));
  const explicitPeersMatchNativeOrigin =
    nativeAudiencePeerIds.length > 0 &&
    (explicitPeerIds.length === 0 ||
      explicitPeerIds.every((peerId) => nativeAudiencePeerIds.includes(peerId)));
  const explicitAccountsMatchOrigin =
    explicitAccountIds.length === 0 ||
    (originAccountId !== undefined &&
      explicitAccountIds.every((accountId) => accountId === originAccountId));
  const originOwnsSelectedAudience =
    originMatchesChannel && explicitPeersMatchOrigin && explicitAccountsMatchOrigin;
  // Internal overlays can retain native ids from an earlier channel while
  // route metadata selects another audience on the same provider. Reuse
  // origin identity only when provider, account, and native peer still agree.
  const originNativeMatchesAudience = originNativeProvider
    ? originNativeProvider === channel &&
      explicitPeersMatchNativeOrigin &&
      explicitAccountsMatchOrigin
    : originOwnsSelectedAudience;
  const chatType = normalizeChatType(
    (routeChannel === channel ? entry?.route?.target?.chatType : undefined) ??
      (originOwnsSelectedAudience ? entry?.origin?.chatType : undefined) ??
      (deliveryChannel === channel ? delivery?.peerKind : undefined) ??
      (compactDirectPeer ? "direct" : undefined) ??
      entry?.chatType,
  );
  if (!channel || !chatType) {
    return null;
  }

  const originTarget = originOwnsSelectedAudience
    ? normalizeOptionalString(entry?.origin?.to)
    : undefined;

  const originNativeChannelId = originNativeMatchesAudience
    ? normalizeOptionalString(entry?.origin?.nativeChannelId)
    : undefined;
  const originNativeDirectUserId = originNativeMatchesAudience
    ? normalizeOptionalString(entry?.origin?.nativeDirectUserId)
    : undefined;
  const originNativeSenderId = originNativeMatchesAudience
    ? normalizeOptionalString(entry?.origin?.nativeSenderId)
    : undefined;
  const originParentConversationId = originNativeMatchesAudience
    ? normalizeOptionalString(entry?.origin?.parentConversationId)
    : undefined;
  const routeDirectPeer =
    originNativeDirectUserId ??
    (deliveryChannel === channel && normalizeChatType(delivery?.peerKind) === "direct"
      ? normalizeOptionalString(delivery.peerId)
      : undefined) ??
    compactDirectPeer;
  const target =
    routeTarget ??
    (chatType === "direct" ? routeDirectPeer : originNativeChannelId) ??
    deliveryTarget ??
    originTarget ??
    lastTarget ??
    normalizeOptionalString(entry?.groupId) ??
    (chatType === "direct" && originOwnsSelectedAudience
      ? stripPersistedAddressPrefix(entry?.origin?.from, channel)
      : undefined);
  if (!target) {
    return null;
  }

  const peerId = stripPersistedAddressPrefix(target, channel);
  if (!peerId) {
    return null;
  }
  const senderId =
    originNativeSenderId ??
    originNativeDirectUserId ??
    (originOwnsSelectedAudience
      ? stripPersistedAddressPrefix(entry?.origin?.from, channel)
      : undefined) ??
    undefined;
  const groupId =
    chatType === "direct"
      ? undefined
      : (normalizeOptionalString(entry?.groupId) ?? originNativeChannelId ?? peerId);
  const bindingConversationId =
    chatType === "direct" ? (routeTarget ?? originTarget ?? lastTarget ?? target) : undefined;
  return {
    channel,
    accountId:
      (deliveryChannel === channel ? normalizeOptionalString(delivery?.accountId) : undefined) ??
      (routeChannel === channel ? normalizeOptionalString(entry?.route?.accountId) : undefined) ??
      (lastChannel === channel ? normalizeOptionalString(entry?.lastAccountId) : undefined) ??
      (originOwnsSelectedAudience ? originAccountId : undefined),
    target,
    // Plugin routes retain the native conversation id. Generic direct
    // bindings use the provider-native delivery identity separately.
    conversationId: originNativeChannelId,
    parentConversationId: originParentConversationId,
    bindingConversationId,
    peerId,
    chatType,
    threadId:
      (routeChannel === channel ? entry?.route?.thread?.id : undefined) ??
      (lastChannel === channel ? entry?.lastThreadId : undefined) ??
      (originOwnsSelectedAudience ? entry?.origin?.threadId : undefined) ??
      (deliveryChannel === channel ? delivery?.threadId : undefined),
    senderId,
    groupId,
    groupChannel: normalizeOptionalString(entry?.groupChannel),
    // Workspace ids are owned by the same persisted origin as native peer ids.
    // A newer peer route must not inherit an older guild/team binding scope.
    groupSpace: originNativeMatchesAudience ? normalizeOptionalString(entry?.space) : undefined,
  };
}

function resolveGenericCurrentRoute(params: {
  cfg: OpenClawConfig;
  audience: PersistedConversationAudience;
}): ChannelCurrentConversationRoute | null {
  const { audience } = params;
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: audience.channel,
    accountId: audience.accountId,
    peer: { kind: audience.chatType, id: audience.peerId },
    guildId: audience.groupSpace,
    teamId: audience.groupSpace,
  });
  const baseConversationId =
    audience.bindingConversationId ?? audience.conversationId ?? audience.peerId;
  const resolveConversation = (conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  }) => {
    const configured = resolveConfiguredBindingRoute({
      cfg: params.cfg,
      route,
      conversation,
    });
    const runtime = lookupRuntimeConversationBindingRoute({
      route: configured.route,
      conversation,
    });
    return {
      invalid: Boolean(runtime.bindingRecord && !runtime.boundSessionKey),
      matched: Boolean(configured.bindingResolution || runtime.boundSessionKey),
      route: runtime.route,
    };
  };
  const threadId = normalizeOptionalString(
    audience.threadId == null ? undefined : String(audience.threadId),
  );
  if (threadId && threadId !== baseConversationId) {
    const child = resolveConversation({
      channel: audience.channel,
      accountId: route.accountId,
      conversationId: threadId,
      parentConversationId: audience.parentConversationId ?? baseConversationId,
    });
    if (child.invalid) {
      return null;
    }
    if (child.matched) {
      return child.route;
    }
  }
  const base = resolveConversation({
    channel: audience.channel,
    accountId: route.accountId,
    conversationId: baseConversationId,
    ...(audience.parentConversationId
      ? { parentConversationId: audience.parentConversationId }
      : {}),
  });
  if (base.invalid) {
    return null;
  }
  return base.route;
}

async function resolveCurrentRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  audience: PersistedConversationAudience;
  resolvePluginRoute?: PersistedPluginConversationRouteResolver;
}): Promise<ChannelCurrentConversationRoute | null> {
  const resolvePluginRoute =
    params.resolvePluginRoute ??
    (async (input) => {
      const runtime = await import("./persisted-conversation-identity.runtime.js");
      return await runtime.resolvePersistedPluginConversationRoute(input);
    });
  const pluginResult = await resolvePluginRoute({
    cfg: params.cfg,
    channel: params.audience.channel,
    agentId: params.agentId,
    accountId: params.audience.accountId,
    target: params.audience.target,
    conversationId: params.audience.conversationId,
    parentConversationId: params.audience.parentConversationId,
    chatType: params.audience.chatType,
    groupSpace: params.audience.groupSpace,
    threadId: params.audience.threadId,
    senderId: params.audience.senderId,
  });
  if (pluginResult.kind === "resolved") {
    return pluginResult.route;
  }
  if (pluginResult.kind === "unresolved") {
    return null;
  }
  return resolveGenericCurrentRoute(params);
}

/** Revalidates a persisted session against the current agent and channel route owners. */
export async function resolvePersistedConversationIdentityContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  audienceless: "internal" | "owner-direct" | "deny";
  requireAgentSessionKey?: boolean;
  resolvePluginRoute?: PersistedPluginConversationRouteResolver;
}): Promise<PersistedConversationIdentityContext> {
  const currentAgent = resolveConversationIdentityMode({
    config: params.cfg,
    agentId: params.agentId,
    isInternal: true,
  });
  if (!currentAgent.allowed) {
    return { decision: currentAgent };
  }

  const parsedAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (
    (!parsedAgentId && params.requireAgentSessionKey === true) ||
    (parsedAgentId && normalizeAgentId(parsedAgentId) !== normalizeAgentId(params.agentId))
  ) {
    return deniedStaleRoute();
  }

  const audience = resolvePersistedConversationAudience(params);
  if (audience === undefined) {
    // The caller owns the audienceless policy: scheduled internal work stays
    // internal, while authenticated device ingress may select only personal direct.
    if (params.audienceless === "internal") {
      return { decision: currentAgent };
    }
    if (params.audienceless === "owner-direct") {
      const decision = resolveConversationIdentityMode({
        config: params.cfg,
        agentId: params.agentId,
        routeMatchedBy: "default",
        chatType: "direct",
        senderIsOwner: true,
      });
      return {
        decision,
        routeMatchedBy: "default",
        chatType: "direct",
        senderIsOwner: true,
      };
    }
    return deniedStaleRoute();
  }
  if (!audience) {
    return deniedStaleRoute();
  }

  const currentRoute = await resolveCurrentRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    audience,
    resolvePluginRoute: params.resolvePluginRoute,
  });
  const targetBaseSessionKey =
    parseThreadSessionSuffix(params.sessionKey).baseSessionKey ?? params.sessionKey;
  const currentBaseSessionKey = currentRoute
    ? (parseThreadSessionSuffix(currentRoute.sessionKey).baseSessionKey ?? currentRoute.sessionKey)
    : undefined;
  const targetStoreKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: targetBaseSessionKey,
    storeAgentId: params.agentId,
  });
  const currentStoreKey = currentBaseSessionKey
    ? resolveSessionStoreKey({
        cfg: params.cfg,
        sessionKey: currentBaseSessionKey,
        storeAgentId: currentRoute?.agentId,
      })
    : undefined;
  if (
    !currentRoute ||
    normalizeAgentId(currentRoute.agentId) !== normalizeAgentId(params.agentId) ||
    currentStoreKey !== targetStoreKey
  ) {
    return deniedStaleRoute();
  }

  const senderIsOwnerFromConfig = audience.senderId
    ? resolveCommandAuthorization({
        cfg: params.cfg,
        commandAuthorized: false,
        ctx: {
          Provider: audience.channel,
          Surface: audience.channel,
          AccountId: currentRoute.accountId,
          ChatType: audience.chatType,
          SenderId: audience.senderId,
          From: params.sessionEntry?.origin?.from,
          To: params.sessionEntry?.origin?.to,
        },
      }).stableSenderIsOwner
    : false;
  const senderIsOwner = currentRoute.senderIsOwner === true || senderIsOwnerFromConfig;
  const decision = resolveConversationIdentityMode({
    config: params.cfg,
    agentId: currentRoute.agentId,
    routeMatchedBy: currentRoute.matchedBy,
    chatType: audience.chatType,
    groupId: audience.groupId,
    groupChannel: audience.groupChannel,
    groupSpace: audience.groupSpace,
    senderIsOwner,
  });
  return {
    decision,
    routeMatchedBy: currentRoute.matchedBy,
    messageProvider: currentRoute.channel,
    chatType: audience.chatType,
    agentAccountId: currentRoute.accountId,
    groupId: audience.groupId,
    groupChannel: audience.groupChannel,
    groupSpace: audience.groupSpace,
    senderId: audience.senderId,
    senderIsOwner,
  };
}
