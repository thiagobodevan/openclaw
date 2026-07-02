import {
  ensureConfiguredBindingRouteReady,
  lookupRuntimeConversationBindingRoute,
  resolveConfiguredBindingRoute,
  touchRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
// Feishu plugin module implements comment handler behavior.
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  EXTERNAL_CONVERSATION_IDENTITY_DENIAL,
  resolveConversationIdentityAdmission,
} from "openclaw/plugin-sdk/routing";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";
import {
  createChannelPairingController,
  type ClawdbotConfig,
  type RuntimeEnv,
} from "./comment-handler-runtime-api.js";
import { buildFeishuCommentTarget } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import {
  resolveDriveCommentNoticeFacts,
  resolveDriveCommentEventTurn,
  type FeishuDriveCommentNoticeEvent,
} from "./monitor.comment.js";
import { resolveFeishuDmIngressAccess } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";

type HandleFeishuCommentEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  event: FeishuDriveCommentNoticeEvent;
  botOpenId?: string;
};

function parseTimestampMs(value: string | undefined): number {
  return parseStrictNonNegativeInteger(value) ?? Date.now();
}

export async function handleFeishuCommentEvent(
  params: HandleFeishuCommentEventParams,
): Promise<void> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const core = getFeishuRuntime();
  const log = params.runtime?.log ?? console.log;
  const error = params.runtime?.error ?? console.error;
  const runtime = (params.runtime ?? { log, error }) as RuntimeEnv;
  const notice = resolveDriveCommentNoticeFacts({
    event: params.event,
    accountId: account.accountId,
    botOpenId: params.botOpenId,
    logger: log,
  });
  if (!notice) {
    log(
      `feishu[${account.accountId}]: drive comment notice skipped ` +
        `event=${params.event.event_id ?? "unknown"} comment=${params.event.comment_id ?? "unknown"}`,
    );
    return;
  }

  const audienceId = `comment-doc:${notice.fileType}:${notice.fileToken}`;
  const commentTarget = buildFeishuCommentTarget(notice);
  const pairing = createChannelPairingController({
    core,
    channel: "feishu",
    accountId: account.accountId,
  });
  const admitCommentRoute = async (candidateCfg: ClawdbotConfig) => {
    let route = core.channel.routing.resolveAgentRoute({
      cfg: candidateCfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: "channel",
        id: audienceId,
      },
    });
    const conversation = {
      channel: "feishu",
      accountId: account.accountId,
      conversationId: audienceId,
    };
    const configuredRoute = resolveConfiguredBindingRoute({
      cfg: candidateCfg,
      route,
      conversation,
    });
    route = configuredRoute.route;
    let configuredBinding = configuredRoute.bindingResolution;

    const runtimeRoute = lookupRuntimeConversationBindingRoute({ route, conversation });
    route = runtimeRoute.route;
    if (runtimeRoute.bindingRecord) {
      configuredBinding = null;
    }
    const identityDecision = resolveConversationIdentityAdmission({
      cfg: candidateCfg,
      ctx: {
        AgentId: route.agentId,
        SessionKey: route.sessionKey,
        AgentRouteMatchedBy: route.matchedBy,
        ChatType: "channel",
        ChatId: audienceId,
        GroupChannel: audienceId,
        SenderId: notice.senderId,
        Provider: "feishu",
        Surface: "feishu-comment",
        CommandAuthorized: false,
      },
    });
    if (!identityDecision.allowed) {
      log(
        `feishu[${account.accountId}]: blocked comment audience ${audienceId} ` +
          `before document hydration (${identityDecision.reason}): ${EXTERNAL_CONVERSATION_IDENTITY_DENIAL}`,
      );
      return null;
    }
    if (configuredBinding) {
      const ensured = await ensureConfiguredBindingRouteReady({
        cfg: candidateCfg,
        bindingResolution: configuredBinding,
      });
      if (!ensured.ok) {
        log(
          `feishu[${account.accountId}]: blocked comment audience ${audienceId} ` +
            `before document hydration (configured binding unavailable: ${ensured.error})`,
        );
        return null;
      }
    }
    return { route, runtimeBinding: runtimeRoute.bindingRecord };
  };
  const resolveCommentAuthorization = async (candidateCfg: ClawdbotConfig, mayPair: boolean) => {
    const candidateAccount = resolveFeishuRuntimeAccount({
      cfg: candidateCfg,
      accountId: account.accountId,
    });
    const candidateDmPolicy = candidateAccount.config.dmPolicy ?? "pairing";
    const ingress = await resolveFeishuDmIngressAccess({
      cfg: candidateCfg,
      accountId: candidateAccount.accountId,
      dmPolicy: candidateDmPolicy,
      allowFrom: candidateAccount.config.allowFrom ?? [],
      readAllowFromStore: pairing.readAllowFromStore,
      senderOpenId: notice.senderId,
      senderUserId: notice.senderUserId,
      conversationId: audienceId,
      mayPair,
    });
    return { account: candidateAccount, cfg: candidateCfg, dmPolicy: candidateDmPolicy, ingress };
  };
  const rejectCommentAuthorization = async (
    authorization: Awaited<ReturnType<typeof resolveCommentAuthorization>>,
  ) => {
    if (authorization.ingress.ingress.admission === "pairing-required") {
      const client = createFeishuClient(authorization.account);
      await pairing.issueChallenge({
        senderId: notice.senderId,
        senderIdLine: `Your Feishu user id: ${notice.senderId}`,
        meta: { name: notice.senderId },
        onCreated: ({ code }) => {
          log(
            `feishu[${account.accountId}]: comment pairing request sender=${notice.senderId} code=${code}`,
          );
        },
        sendPairingReply: async (text) => {
          await deliverCommentThreadText(client, {
            file_token: notice.fileToken,
            file_type: notice.fileType,
            comment_id: notice.commentId,
            content: text,
          });
        },
        onReplyError: (err) => {
          log(
            `feishu[${account.accountId}]: comment pairing reply failed for ${notice.senderId}: ${String(err)}`,
          );
        },
      });
    } else {
      log(
        `feishu[${account.accountId}]: blocked unauthorized comment sender ${notice.senderId} ` +
          `(dmPolicy=${authorization.dmPolicy}, comment=${notice.commentId})`,
      );
    }
  };
  let routeState = await admitCommentRoute(params.cfg);
  if (!routeState) {
    return;
  }
  const commentAuthorization = await resolveCommentAuthorization(params.cfg, true);
  if (commentAuthorization.ingress.ingress.admission !== "dispatch") {
    await rejectCommentAuthorization(commentAuthorization);
    return;
  }

  let effectiveCfg = params.cfg;
  const currentCfg = core.config.current() as ClawdbotConfig;
  if (currentCfg !== effectiveCfg) {
    const currentRouteState = await admitCommentRoute(currentCfg);
    if (!currentRouteState) {
      return;
    }
    const currentAuthorization = await resolveCommentAuthorization(currentCfg, true);
    if (currentAuthorization.ingress.ingress.admission !== "dispatch") {
      await rejectCommentAuthorization(currentAuthorization);
      return;
    }
    effectiveCfg = currentCfg;
    routeState = currentRouteState;
  }
  const { route } = routeState;
  touchRuntimeConversationBindingRoute({ bindingRecord: routeState.runtimeBinding });

  const turn = await resolveDriveCommentEventTurn({
    cfg: effectiveCfg,
    accountId: account.accountId,
    event: params.event,
    botOpenId: params.botOpenId,
    logger: log,
  });
  if (!turn) {
    return;
  }
  const commentSessionKey = route.sessionKey;
  const bodyForAgent = `[message_id: ${turn.messageId}]\n${turn.prompt}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    CommandBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    From: `feishu:${turn.senderId}`,
    To: commentTarget,
    SessionKey: commentSessionKey,
    AgentId: route.agentId,
    AgentRouteMatchedBy: route.matchedBy,
    AccountId: route.accountId,
    ChatType: "channel",
    ChatId: audienceId,
    GroupChannel: turn.documentTitle,
    ConversationLabel: turn.documentTitle
      ? `Feishu comment · ${turn.documentTitle}`
      : "Feishu comment",
    SenderName: turn.senderId,
    SenderId: turn.senderId,
    Provider: "feishu",
    Surface: "feishu-comment",
    MessageSid: turn.messageId,
    // For Feishu comment turns, MessageThreadId carries the inbound reply_id so
    // comment-aware tools can clean typing reaction before sending visible output.
    MessageThreadId: turn.replyId,
    Timestamp: parseTimestampMs(turn.timestamp),
    WasMentioned: turn.isMentioned,
    CommandAuthorized: false,
    OriginatingChannel: "feishu",
    OriginatingTo: commentTarget,
  });

  const storePath = core.channel.session.resolveStorePath(effectiveCfg.session?.store, {
    agentId: route.agentId,
  });

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete, cleanupTypingReaction } =
    createFeishuCommentReplyDispatcher({
      cfg: effectiveCfg,
      agentId: route.agentId,
      runtime,
      accountId: account.accountId,
      fileToken: turn.fileToken,
      fileType: turn.fileType,
      commentId: turn.commentId,
      replyId: turn.replyId,
      isWholeComment: turn.isWholeComment,
    });

  let dispatchSettledBeforeStart = false;
  try {
    log(
      `feishu[${account.accountId}]: dispatching drive comment to agent ` +
        `(session=${commentSessionKey} comment=${turn.commentId} type=${turn.noticeType})`,
    );
    const turnResult = await core.channel.inbound.run({
      channel: "feishu",
      accountId: route.accountId,
      raw: turn,
      adapter: {
        ingest: () => ({
          id: turn.messageId,
          timestamp: parseTimestampMs(turn.timestamp),
          rawText: ctxPayload.RawBody ?? "",
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: turn,
        }),
        resolveTurn: () => ({
          channel: "feishu",
          accountId: route.accountId,
          routeSessionKey: commentSessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: core.channel.session.recordInboundSession,
          record: {
            onRecordError: (err) => {
              error(
                `feishu[${account.accountId}]: failed to record comment inbound session ${commentSessionKey}: ${String(err)}`,
              );
            },
          },
          onPreDispatchFailure: async () => {
            dispatchSettledBeforeStart = true;
            await core.channel.reply.settleReplyDispatcher({
              dispatcher,
              onSettled: () => {
                markRunComplete();
                markDispatchIdle();
              },
            });
          },
          runDispatch: () =>
            core.channel.reply.withReplyDispatcher({
              dispatcher,
              run: () =>
                core.channel.reply.dispatchReplyFromConfig({
                  ctx: ctxPayload,
                  cfg: effectiveCfg,
                  dispatcher,
                  replyOptions: {
                    ...replyOptions,
                    identityContractVersion: 1,
                  },
                }),
            }),
        }),
      },
    });
    const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
    const queuedFinal = dispatchResult?.queuedFinal ?? false;
    const counts = dispatchResult?.counts ?? { tool: 0, block: 0, final: 0 };
    log(
      `feishu[${account.accountId}]: drive comment dispatch complete ` +
        `(queuedFinal=${queuedFinal}, replies=${counts.final}, session=${commentSessionKey})`,
    );
  } finally {
    if (!dispatchSettledBeforeStart) {
      markRunComplete();
      markDispatchIdle();
    }
    void cleanupTypingReaction();
  }
}
