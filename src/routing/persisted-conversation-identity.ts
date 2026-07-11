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
import type {
  ChannelConversationAudienceEvidence,
  ChannelCurrentConversationRoute,
} from "../channels/plugins/types.core.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import { normalizeSessionPeerId } from "../sessions/session-key-utils.js";
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
  normalizeAccountId,
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
  audienceEvidence?: readonly ChannelConversationAudienceEvidence[];
  requireAudienceValidation?: boolean;
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
  requiresChannelOwnedAudienceResolution?: boolean;
  audienceEvidence?: ChannelConversationAudienceEvidence[];
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

function resolvePersistedAudienceKind(
  raw: string | undefined,
  channel: string,
): "direct" | "shared" | undefined {
  let value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  const providerPrefix = `${channel}:`;
  if (value.toLowerCase().startsWith(providerPrefix.toLowerCase())) {
    value = value.slice(providerPrefix.length).trim();
  }
  const match = /^(user|direct|dm|group|channel|room):/i.exec(value);
  const kind = match?.[1]?.toLowerCase();
  if (kind === "user" || kind === "direct" || kind === "dm") {
    return "direct";
  }
  // Providers commonly address the same shared conversation as either a
  // group or channel. Only a direct/shared conflict changes the audience.
  return kind === "group" || kind === "channel" || kind === "room" ? "shared" : undefined;
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
    const declaredChannels = [
      deliveryChannel,
      routeChannel,
      originProvider,
      originSurface,
      entryChannel,
      lastChannel,
    ].filter((candidate): candidate is string => Boolean(candidate));
    return declaredChannels.length > 0 && declaredChannels.every(isInternalPersistedChannel)
      ? undefined
      : null;
  }
  const originMatchesChannel = originProvider === channel || originSurface === channel;
  // Older session entries may omit `channel`; their origin still owns adjacent
  // group metadata. A conflicting channel must never donate policy inputs.
  const entryMetadataOwnedByChannel =
    entryChannel === channel || (entryChannel === undefined && originMatchesChannel);
  const originNativeProvider = normalizeOptionalLowercaseString(entry?.origin?.nativeProvider);
  // Native audience ids belong only to their declared provider. Reusing one
  // across a later channel overlay could admit a different conversation.
  const originNativeOwnedByChannel = originNativeProvider
    ? originNativeProvider === channel
    : originMatchesChannel;
  const directProofOwnedByChannel = originMatchesChannel || originNativeProvider === channel;
  const routeTarget =
    routeChannel === channel ? normalizeOptionalString(entry?.route?.target?.to) : undefined;
  const deliveryTarget =
    deliveryChannel === channel ? normalizeOptionalString(delivery?.peerId) : undefined;
  const lastTarget = lastChannel === channel ? normalizeOptionalString(entry?.lastTo) : undefined;
  // An internal overlay can hide the selected provider's entry metadata. Only
  // an explicit selected target prefix may recover its audience kind.
  const lastTargetKind = resolvePersistedAudienceKind(lastTarget, channel);
  const persistedRouteChatType = normalizeChatType(
    (routeChannel === channel ? entry?.route?.target?.chatType : undefined) ??
      (compactDirectPeer ? "direct" : undefined) ??
      (originMatchesChannel ? entry?.origin?.chatType : undefined) ??
      (deliveryChannel === channel ? delivery?.peerKind : undefined) ??
      (lastTargetKind === "direct"
        ? "direct"
        : lastTargetKind === "shared"
          ? "channel"
          : undefined) ??
      (entryMetadataOwnedByChannel ? entry?.chatType : undefined),
  );
  const isGroupAudience =
    persistedRouteChatType === "group" || persistedRouteChatType === "channel";
  const originNativePeerIds = (
    originNativeOwnedByChannel
      ? [
          entry?.origin?.nativeChannelId,
          ...(isGroupAudience ? [] : [entry?.origin?.nativeDirectUserId]),
        ]
      : []
  )
    .map((target) => stripPersistedAddressPrefix(target, channel))
    .filter((target): target is string => Boolean(target));
  const originTransportPeerIds = [
    entry?.origin?.to,
    ...(isGroupAudience ? [] : [entry?.origin?.from]),
  ]
    .map((target) => stripPersistedAddressPrefix(target, channel))
    .filter((target): target is string => Boolean(target));
  const ownedGroupId = entryMetadataOwnedByChannel
    ? normalizeOptionalString(entry?.groupId)
    : undefined;
  const persistedGroupPeerId = isGroupAudience
    ? stripPersistedAddressPrefix(ownedGroupId, channel)
    : undefined;
  const originPeerIds = [...new Set([...originNativePeerIds, ...originTransportPeerIds])];
  const normalizeDirectPeer = (raw: string | undefined, peerKind: string) => {
    const peerId = stripPersistedAddressPrefix(raw, channel);
    if (!peerId) {
      return undefined;
    }
    return normalizeSessionPeerId({
      channel,
      peerKind,
      peerId,
    });
  };
  const resolveDirectTargetEvidence = (
    raw: string | undefined,
    fallbackKind: string | null | undefined,
  ) => {
    const declaredKind = resolvePersistedAudienceKind(raw, channel);
    const proofKind =
      declaredKind === "direct" ||
      (declaredKind === undefined && normalizeChatType(fallbackKind ?? undefined) === "direct")
        ? ("sender" as const)
        : ("conversation" as const);
    const peerId = normalizeDirectPeer(raw, proofKind === "sender" ? "direct" : "channel");
    return peerId ? { peerId, proofKind } : undefined;
  };
  const directSenderPeerIds = (
    !isGroupAudience
      ? [
          ...(originNativeOwnedByChannel
            ? [entry?.origin?.nativeDirectUserId, entry?.origin?.nativeSenderId]
            : []),
          ...(originMatchesChannel ? [entry?.origin?.from] : []),
        ]
      : []
  )
    .map((target) => normalizeDirectPeer(target, "direct"))
    .filter((target): target is string => Boolean(target));
  const directConversationPeerIds = (
    !isGroupAudience && originNativeOwnedByChannel ? [entry?.origin?.nativeChannelId] : []
  )
    .map((target) => normalizeDirectPeer(target, "channel"))
    .filter((target): target is string => Boolean(target));
  const directTargetEvidence = [
    resolveDirectTargetEvidence(routeTarget, persistedRouteChatType),
    resolveDirectTargetEvidence(deliveryTarget, delivery?.peerKind ?? persistedRouteChatType),
    resolveDirectTargetEvidence(lastTarget, persistedRouteChatType),
    ...(originMatchesChannel
      ? [resolveDirectTargetEvidence(entry?.origin?.to, persistedRouteChatType)]
      : []),
  ].filter((target): target is NonNullable<typeof target> => Boolean(target));
  const directSenderPeerIdSet = new Set(directSenderPeerIds);
  const directConversationPeerIdSet = new Set(directConversationPeerIds);
  // Sender ids share one provider-owned namespace. Once persisted sender facts
  // disagree, choosing one would hide stale owner and per-sender policy state.
  if (directSenderPeerIdSet.size > 1) {
    return null;
  }
  const directSenderTargetPeerIds = new Set(
    directTargetEvidence
      .filter((evidence) => evidence.proofKind === "sender")
      .map((evidence) => evidence.peerId),
  );
  const directConversationTargetPeerIds = new Set(
    directTargetEvidence
      .filter((evidence) => evidence.proofKind === "conversation")
      .map((evidence) => evidence.peerId),
  );
  const directTargetClasses =
    Number(directSenderTargetPeerIds.size > 0) + Number(directConversationTargetPeerIds.size > 0);
  // A shared-form address cannot prove a direct audience without a matching
  // provider-owned native conversation. The channel owner must certify it.
  const directAudiencePeersMatch =
    directSenderTargetPeerIds.size <= 1 &&
    directConversationTargetPeerIds.size <= 1 &&
    directTargetClasses <= 1 &&
    (directProofOwnedByChannel
      ? directSenderPeerIdSet.size <= 1 &&
        directConversationPeerIdSet.size <= 1 &&
        directTargetEvidence.every(({ peerId, proofKind }) =>
          proofKind === "sender"
            ? directSenderPeerIdSet.has(peerId)
            : directConversationPeerIdSet.has(peerId),
        )
      : directConversationTargetPeerIds.size === 0);
  // Older direct-message entries can pair a native conversation id with the
  // delivery user only in origin.to/from. Trust that pairing only while the
  // origin provider still owns the selected audience, never after an overlay.
  const nativeAudiencePeerIds = originMatchesChannel ? originPeerIds : originNativePeerIds;
  const explicitAccountIds = [
    routeChannel === channel ? entry?.route?.accountId : undefined,
    deliveryChannel === channel ? delivery?.accountId : undefined,
    lastChannel === channel ? entry?.lastAccountId : undefined,
  ]
    .map(normalizeOptionalString)
    .filter((accountId): accountId is string => Boolean(accountId));
  const originAccountId = normalizeOptionalString(entry?.origin?.accountId);
  // Account ids are generic route ownership facts. Priority-picking one would
  // hide a stale cross-account session before the channel owner can validate it.
  const normalizedExplicitAccountIds = explicitAccountIds.map(normalizeAccountId);
  if (new Set(normalizedExplicitAccountIds).size > 1) {
    return null;
  }
  // Group providers can encode the same audience as a parent/child or
  // organization/conversation pair. Core preserves conflicts for the channel
  // owner to interpret instead of treating provider-specific strings as equal.
  const groupAudienceEvidence: ChannelConversationAudienceEvidence[] = isGroupAudience
    ? [
        ...(routeTarget ? [{ source: "route" as const, value: routeTarget }] : []),
        ...(deliveryTarget ? [{ source: "delivery" as const, value: deliveryTarget }] : []),
        ...(lastTarget ? [{ source: "last" as const, value: lastTarget }] : []),
        ...(originNativeOwnedByChannel && entry?.origin?.nativeChannelId
          ? [{ source: "origin-native" as const, value: entry.origin.nativeChannelId }]
          : []),
        ...(originMatchesChannel && entry?.origin?.to
          ? [{ source: "origin-target" as const, value: entry.origin.to }]
          : []),
        ...(ownedGroupId ? [{ source: "group" as const, value: ownedGroupId }] : []),
      ]
    : [];
  const directAudienceEvidence: ChannelConversationAudienceEvidence[] = !isGroupAudience
    ? [
        ...(routeTarget ? [{ source: "route" as const, value: routeTarget }] : []),
        ...(deliveryTarget ? [{ source: "delivery" as const, value: deliveryTarget }] : []),
        ...(lastTarget ? [{ source: "last" as const, value: lastTarget }] : []),
        ...(originNativeOwnedByChannel && entry?.origin?.nativeChannelId
          ? [{ source: "origin-native" as const, value: entry.origin.nativeChannelId }]
          : []),
        ...(originMatchesChannel && entry?.origin?.to
          ? [{ source: "origin-target" as const, value: entry.origin.to }]
          : []),
      ]
    : [];
  const groupAudiencePeerIds = groupAudienceEvidence.map((evidence) =>
    normalizeSessionPeerId({
      channel,
      peerKind: persistedRouteChatType,
      peerId: stripPersistedAddressPrefix(evidence.value, channel),
    }),
  );
  const groupAudienceKinds = new Set(
    groupAudienceEvidence.flatMap(
      (evidence) => resolvePersistedAudienceKind(evidence.value, channel) ?? [],
    ),
  );
  // Equal provider ids can name different audience kinds. Keep that conflict
  // for the channel owner instead of treating the persisted route as proven.
  const groupAudiencePeersAgree =
    new Set(groupAudiencePeerIds).size <= 1 &&
    groupAudienceKinds.size <= 1 &&
    [...groupAudienceKinds].every((kind) => kind === "shared");
  const requiresChannelOwnedAudienceResolution = isGroupAudience
    ? !groupAudiencePeersAgree
    : !directAudiencePeersMatch;
  const explicitPeersMatchOrigin = isGroupAudience
    ? originPeerIds.length > 0 || persistedGroupPeerId !== undefined
    : originPeerIds.length > 0 && directAudiencePeersMatch;
  const explicitPeersMatchNativeOrigin = isGroupAudience
    ? nativeAudiencePeerIds.length > 0
    : nativeAudiencePeerIds.length > 0 && directAudiencePeersMatch;
  const originPeerMatchesSelectedAudience =
    originMatchesChannel && (isGroupAudience || explicitPeersMatchOrigin);
  const persistedAccountIds = [
    ...normalizedExplicitAccountIds,
    ...(originMatchesChannel && originAccountId ? [normalizeAccountId(originAccountId)] : []),
  ];
  if (new Set(persistedAccountIds).size > 1) {
    return null;
  }
  const explicitAccountsMatchOrigin =
    explicitAccountIds.length === 0 ||
    (originAccountId !== undefined &&
      explicitAccountIds.every(
        (accountId) => normalizeAccountId(accountId) === normalizeAccountId(originAccountId),
      ));
  const originOwnsSelectedAudience =
    originPeerMatchesSelectedAudience && explicitAccountsMatchOrigin;
  // Internal overlays can retain native ids from an earlier channel while
  // route metadata selects another audience on the same provider. Reuse
  // origin identity only when provider, account, and native peer still agree.
  const originNativeMatchesAudience = originNativeProvider
    ? originNativeProvider === channel &&
      (isGroupAudience || explicitPeersMatchNativeOrigin) &&
      explicitAccountsMatchOrigin
    : originOwnsSelectedAudience;
  const originAvailableForValidation =
    requiresChannelOwnedAudienceResolution && !isGroupAudience && originNativeOwnedByChannel;
  const chatType = persistedRouteChatType;
  if (!channel || !chatType) {
    return null;
  }

  const originTarget =
    originOwnsSelectedAudience || (originAvailableForValidation && originMatchesChannel)
      ? normalizeOptionalString(entry?.origin?.to)
      : undefined;

  const originNativeChannelId =
    originNativeMatchesAudience || originAvailableForValidation
      ? normalizeOptionalString(entry?.origin?.nativeChannelId)
      : undefined;
  const originNativeDirectUserId =
    originNativeMatchesAudience || originAvailableForValidation
      ? normalizeOptionalString(entry?.origin?.nativeDirectUserId)
      : undefined;
  const originNativeSenderId =
    originNativeMatchesAudience || originAvailableForValidation
      ? normalizeOptionalString(entry?.origin?.nativeSenderId)
      : undefined;
  const originParentConversationId =
    originNativeMatchesAudience || originAvailableForValidation
      ? normalizeOptionalString(entry?.origin?.parentConversationId)
      : undefined;
  const routeDirectPeer =
    originNativeDirectUserId ??
    (delivery && deliveryChannel === channel && normalizeChatType(delivery.peerKind) === "direct"
      ? normalizeOptionalString(delivery.peerId)
      : undefined) ??
    compactDirectPeer;
  const target =
    routeTarget ??
    (chatType === "direct" ? routeDirectPeer : undefined) ??
    deliveryTarget ??
    originTarget ??
    lastTarget ??
    ownedGroupId ??
    originNativeChannelId ??
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
  const sessionThreadId = normalizeOptionalString(
    parseThreadSessionSuffix(params.sessionKey).threadId,
  );
  const persistedNativeThreadIds = [
    routeChannel === channel ? entry?.route?.thread?.id : undefined,
    lastChannel === channel ? entry?.lastThreadId : undefined,
    originOwnsSelectedAudience || originAvailableForValidation
      ? entry?.origin?.threadId
      : undefined,
  ]
    .map((threadId) => (threadId == null ? undefined : normalizeOptionalString(String(threadId))))
    .filter((threadId): threadId is string => Boolean(threadId));
  // Native persisted facts must agree exactly. A session suffix may add the
  // exact peer as collision scope, but only when a native fact proves its tail.
  if (new Set(persistedNativeThreadIds).size > 1) {
    return null;
  }
  const nativeThreadId = persistedNativeThreadIds[0];
  if (sessionThreadId?.includes(":") && !nativeThreadId) {
    return null;
  }
  if (
    sessionThreadId &&
    nativeThreadId &&
    sessionThreadId !== nativeThreadId &&
    sessionThreadId !== `${peerId}:${nativeThreadId}`
  ) {
    return null;
  }
  const threadId = nativeThreadId ?? sessionThreadId;
  const senderId =
    originNativeSenderId ??
    originNativeDirectUserId ??
    (originOwnsSelectedAudience || originAvailableForValidation
      ? stripPersistedAddressPrefix(entry?.origin?.from, channel)
      : undefined) ??
    undefined;
  const groupId =
    chatType === "direct" ? undefined : (ownedGroupId ?? originNativeChannelId ?? peerId);
  const bindingConversationId =
    chatType === "direct" ? (routeTarget ?? originTarget ?? lastTarget ?? target) : undefined;
  return {
    channel,
    accountId: persistedAccountIds[0],
    target,
    // Plugin routes retain the native conversation id. Generic direct
    // bindings use the provider-native delivery identity separately.
    conversationId: originNativeChannelId,
    parentConversationId: originParentConversationId,
    bindingConversationId,
    peerId,
    chatType,
    threadId,
    senderId,
    groupId,
    groupChannel: entryMetadataOwnedByChannel
      ? normalizeOptionalString(entry?.groupChannel)
      : undefined,
    // Workspace ids are owned by the same persisted origin as native peer ids.
    // A newer peer route must not inherit an older guild/team binding scope.
    groupSpace: originNativeMatchesAudience ? normalizeOptionalString(entry?.space) : undefined,
    requiresChannelOwnedAudienceResolution,
    audienceEvidence: requiresChannelOwnedAudienceResolution
      ? isGroupAudience
        ? groupAudienceEvidence
        : directAudienceEvidence
      : undefined,
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
    audienceEvidence: params.audience.audienceEvidence,
    requireAudienceValidation: params.audience.requiresChannelOwnedAudienceResolution,
  });
  if (pluginResult.kind === "resolved") {
    if (
      pluginResult.effectiveAccountId !== undefined &&
      normalizeAccountId(pluginResult.route.accountId) !==
        normalizeAccountId(pluginResult.effectiveAccountId)
    ) {
      return null;
    }
    return params.audience.requiresChannelOwnedAudienceResolution &&
      pluginResult.route.audienceValidated !== true
      ? null
      : pluginResult.route;
  }
  if (pluginResult.kind === "unresolved") {
    return null;
  }
  if (params.audience.requiresChannelOwnedAudienceResolution) {
    // Conflicting persisted group forms need the channel's target grammar.
    // Generic fallback must not discard one form and revive stale authority.
    return null;
  }
  return resolveGenericCurrentRoute({
    cfg: params.cfg,
    audience: {
      ...params.audience,
      accountId: pluginResult.effectiveAccountId ?? params.audience.accountId,
    },
  });
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
    normalizeOptionalLowercaseString(currentRoute.channel) !== audience.channel ||
    (audience.accountId !== undefined &&
      normalizeAccountId(currentRoute.accountId) !== normalizeAccountId(audience.accountId)) ||
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
