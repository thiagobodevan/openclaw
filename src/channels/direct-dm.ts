/**
 * Direct-DM dispatch compatibility facade.
 *
 * Routes legacy direct-message ingress through the standard channel reply pipeline.
 */
import {
  resolveConversationIdentityAdmission,
  resolveConversationIdentityContractVersion,
} from "../auto-reply/reply/conversation-identity-admission.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createInboundEnvelopeBuilder,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
} from "../plugin-sdk/inbound-envelope.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../plugin-sdk/reply-payload.js";
import { EXTERNAL_CONVERSATION_IDENTITY_DENIAL } from "../routing/conversation-identity.js";
import type { AgentRouteMatch } from "../routing/resolve-route.js";
import { createChannelReplyPipeline } from "./message/reply-pipeline.js";
import { runPreparedInboundReply } from "./turn/kernel.js";
export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
  type AccessGroupMembershipResolver,
  type DirectDmCommandAuthorizationRuntime,
  type ResolvedInboundDirectDmAccess,
} from "./direct-dm-access.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm-guard-policy.js";

type DirectDmRoutePeer = {
  kind: "direct";
  id: string;
};

type DirectDmRoute = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
  matchedBy?: AgentRouteMatch;
};

type DirectDmRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
        peer: DirectDmRoutePeer;
      }) => DirectDmRoute;
    };
    session: {
      resolveStorePath: typeof import("../config/sessions.js").resolveStorePath;
      readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: typeof import("../channels/session.js").recordInboundSession;
    };
    reply: {
      resolveEnvelopeFormatOptions: (
        cfg: OpenClawConfig,
      ) => ReturnType<typeof import("../auto-reply/envelope.js").resolveEnvelopeFormatOptions>;
      formatAgentEnvelope: typeof import("../auto-reply/envelope.js").formatAgentEnvelope;
      finalizeInboundContext: typeof import("../auto-reply/reply/inbound-context.js").finalizeInboundContext;
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    };
  };
};

/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
export async function dispatchInboundDirectDmWithRuntime(params: {
  cfg: OpenClawConfig;
  runtime: DirectDmRuntime;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  /** Opt into the current fail-closed conversation identity contract. */
  identityContractVersion?: 1;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
}): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  const identityContractVersion = resolveConversationIdentityContractVersion(
    (params as { identityContractVersion?: unknown }).identityContractVersion,
  );
  const legacyResolved =
    identityContractVersion === undefined
      ? resolveInboundRouteEnvelopeBuilderWithRuntime({
          cfg: params.cfg,
          channel: params.channel,
          accountId: params.accountId,
          peer: params.peer,
          runtime: params.runtime.channel,
          sessionStore: params.cfg.session?.store,
        })
      : undefined;
  const route =
    legacyResolved?.route ??
    params.runtime.channel.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      peer: params.peer,
    });
  if (identityContractVersion === 1 && route.matchedBy === undefined) {
    throw new Error("Identity contract v1 requires route provenance.");
  }

  const contextBase = {
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.commandBody ?? params.rawBody,
    From: params.senderAddress,
    To: params.recipientAddress,
    SessionKey: route.sessionKey,
    AgentId: route.agentId,
    AgentRouteMatchedBy: route.matchedBy,
    AccountId: route.accountId ?? params.accountId,
    ChatType: "direct" as const,
    ConversationLabel: params.conversationLabel,
    SenderId: params.senderId,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.channel,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    Timestamp: params.timestamp,
    CommandAuthorized: params.commandAuthorized,
    OriginatingChannel: params.originatingChannel ?? params.channel,
    OriginatingTo: params.originatingTo ?? params.recipientAddress,
  };
  const identityContext = params.runtime.channel.reply.finalizeInboundContext({
    ...contextBase,
    Body: params.rawBody,
    ...params.extraContext,
  });
  if (identityContractVersion === 1) {
    const identityDecision = resolveConversationIdentityAdmission({
      cfg: params.cfg,
      ctx: identityContext,
    });
    if (!identityDecision.allowed) {
      const storePath = params.runtime.channel.session.resolveStorePath(params.cfg.session?.store, {
        agentId: route.agentId,
      });
      await params.deliver({ text: EXTERNAL_CONVERSATION_IDENTITY_DENIAL });
      return { route, storePath, ctxPayload: identityContext };
    }
  }

  const buildEnvelope =
    legacyResolved?.buildEnvelope ??
    createInboundEnvelopeBuilder({
      cfg: params.cfg,
      route,
      sessionStore: params.cfg.session?.store,
      resolveStorePath: params.runtime.channel.session.resolveStorePath,
      readSessionUpdatedAt: params.runtime.channel.session.readSessionUpdatedAt,
      resolveEnvelopeFormatOptions: params.runtime.channel.reply.resolveEnvelopeFormatOptions,
      formatAgentEnvelope: params.runtime.channel.reply.formatAgentEnvelope,
    });
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });

  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    ...contextBase,
    Body: body,
    ...params.extraContext,
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
  });
  await runPreparedInboundReply({
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: params.runtime.channel.session.recordInboundSession,
    record: {
      onRecordError: params.onRecordError,
    },
    identity: identityContractVersion === 1 ? { cfg: params.cfg, contractVersion: 1 } : undefined,
    runDispatch: async () =>
      await params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: params.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: unknown) => {
            const normalized =
              payload && typeof payload === "object"
                ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
                : {};
            return await params.deliver(normalized);
          },
          onError: params.onDispatchError,
        },
        replyOptions: {
          onModelSelected,
          ...(identityContractVersion === undefined ? {} : { identityContractVersion }),
        },
      }),
  });

  return {
    route,
    storePath,
    ctxPayload,
  };
}
