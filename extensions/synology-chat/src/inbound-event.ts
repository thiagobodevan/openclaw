// Synology Chat plugin module implements inbound event behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveConversationIdentityAdmission } from "openclaw/plugin-sdk/routing";
import { resolveLegacyWebhookNameToChatUserId, sendMessage } from "./client.js";
import type { SynologyInboundMessage } from "./inbound-context.js";
import { getSynologyRuntime } from "./runtime.js";
import { buildSynologyChatInboundSessionKey } from "./session-key.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const CHANNEL_ID = "synology-chat";

type SynologyChannelLog = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

function resolveSynologyChatInboundRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  userId: string;
}) {
  const rt = getSynologyRuntime();
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: params.userId,
    },
  });
  return {
    rt,
    route,
    sessionKey: buildSynologyChatInboundSessionKey({
      agentId: route.agentId,
      accountId: params.account.accountId,
      userId: params.userId,
      identityLinks: params.cfg.session?.identityLinks,
    }),
  };
}

async function deliverSynologyChatReply(params: {
  account: ResolvedSynologyChatAccount;
  sendUserId: string;
  payload: { text?: string; body?: string };
}): Promise<{ visibleReplySent: boolean }> {
  const text = params.payload.text ?? params.payload.body;
  if (!text) {
    return { visibleReplySent: false };
  }
  const ok = await sendMessage(
    params.account.incomingUrl,
    text,
    params.sendUserId,
    params.account.allowInsecureSsl,
  );
  return { visibleReplySent: ok };
}

export async function dispatchSynologyChatInboundEvent(params: {
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  log?: SynologyChannelLog;
}): Promise<null> {
  const rt = getSynologyRuntime();
  const currentCfg = rt.config.current() as OpenClawConfig;

  const resolved = resolveSynologyChatInboundRoute({
    cfg: currentCfg,
    account: params.account,
    userId: params.msg.from,
  });
  const chatKind =
    params.msg.chatType === "group" || params.msg.chatType === "channel"
      ? params.msg.chatType
      : "direct";
  const identityDecision = resolveConversationIdentityAdmission({
    cfg: currentCfg,
    ctx: {
      AgentId: resolved.route.agentId,
      SessionKey: resolved.sessionKey,
      AgentRouteMatchedBy: resolved.route.matchedBy,
      AccountId: resolved.route.accountId ?? params.account.accountId,
      ChatType: chatKind,
      ChatId: chatKind === "direct" ? undefined : params.msg.from,
      GroupChannel: chatKind === "direct" ? undefined : params.msg.from,
      SenderId: params.msg.from,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      CommandAuthorized: params.msg.commandAuthorized,
    },
  });
  if (!identityDecision.allowed) {
    params.log?.info?.(
      `Blocked Synology Chat inbound identity for ${params.msg.from}: ${identityDecision.reason}`,
    );
    return null;
  }
  // Resolve mutable legacy names only after identity admission. The stable
  // webhook id remains the session and fallback delivery identity.
  const fallbackSendUserId = params.msg.chatUserId ?? params.msg.from;
  const sendUserId = params.account.dangerouslyAllowNameMatching
    ? ((
        await resolveLegacyWebhookNameToChatUserId({
          incomingUrl: params.account.incomingUrl,
          mutableWebhookUsername: params.msg.senderName,
          allowInsecureSsl: params.account.allowInsecureSsl,
          log: params.log?.warn ? { warn: params.log.warn } : undefined,
        })
      )?.toString() ?? fallbackSendUserId)
    : fallbackSendUserId;

  await resolved.rt.channel.inbound.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: params.msg,
    adapter: {
      ingest: (msg) => ({
        id: `${params.account.accountId}:${msg.from}`,
        timestamp: Date.now(),
        rawText: msg.body,
        textForAgent: msg.body,
        textForCommands: msg.body,
        raw: msg,
      }),
      resolveTurn: async (input) => {
        const msgCtx = resolved.rt.channel.inbound.buildContext({
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          timestamp: input.timestamp,
          from: `synology-chat:${params.msg.from}`,
          sender: {
            id: params.msg.from,
            name: params.msg.senderName,
          },
          conversation: {
            kind: chatKind,
            id: params.msg.from,
            label: params.msg.senderName || params.msg.from,
          },
          route: {
            agentId: resolved.route.agentId,
            accountId: params.account.accountId,
            matchedBy: resolved.route.matchedBy,
            routeSessionKey: resolved.sessionKey,
            dispatchSessionKey: resolved.sessionKey,
          },
          reply: {
            to: `synology-chat:${params.msg.from}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            ChatType: params.msg.chatType,
            CommandAuthorized: params.msg.commandAuthorized,
          },
        });
        const storePath = resolved.rt.channel.session.resolveStorePath(currentCfg.session?.store, {
          agentId: resolved.route.agentId,
        });
        return {
          cfg: currentCfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          agentId: resolved.route.agentId,
          routeSessionKey: resolved.route.sessionKey,
          storePath,
          ctxPayload: msgCtx,
          recordInboundSession: resolved.rt.channel.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            resolved.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({
              to: sendUserId,
            }),
            deliver: async (payload) => {
              return await deliverSynologyChatReply({
                account: params.account,
                sendUserId,
                payload,
              });
            },
          },
          dispatcherOptions: {
            onReplyStart: () => {
              params.log?.info?.(`Agent reply started for ${params.msg.from}`);
            },
          },
          replyOptions: { identityContractVersion: 1 },
          record: {
            onRecordError: (err) => {
              params.log?.info?.(`Session metadata update failed for ${params.msg.from}`, err);
            },
          },
        };
      },
    },
  });

  return null;
}
