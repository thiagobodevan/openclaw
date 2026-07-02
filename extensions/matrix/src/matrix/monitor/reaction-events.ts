import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveConversationIdentityAdmission } from "openclaw/plugin-sdk/routing";
// Matrix plugin module implements reaction events behavior.
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import {
  resolveMatrixApprovalReactionTargetWithPersistence,
  unregisterMatrixApprovalReactionTarget,
} from "../../approval-reactions.js";
import { ensureConfiguredAcpBindingReady } from "../../runtime-api.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { extractMatrixReactionAnnotation } from "../reaction-common.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixInboundRoute } from "./route.js";
import type { PluginRuntime } from "./runtime-api.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadRouting } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";

const loadApprovalReactionAuth = createLazyRuntimeModule(
  () => import("../../approval-reaction-auth.js"),
);

const loadExecApprovalResolver = createLazyRuntimeModule(
  () => import("../../exec-approval-resolver.js"),
);

export type MatrixReactionNotificationMode = "off" | "own";

async function resolveAdmittedMatrixReactionRoute(params: {
  cfg: CoreConfig;
  core: PluginRuntime;
  accountId: string;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  dmSessionScope?: "per-user" | "per-room";
  threadId?: string;
  eventTs?: number;
  preparedRoute?: ReturnType<typeof resolveMatrixInboundRoute>;
}) {
  const resolved =
    params.preparedRoute ??
    resolveMatrixInboundRoute({
      cfg: params.cfg,
      accountId: params.accountId,
      roomId: params.roomId,
      senderId: params.senderId,
      isDirectMessage: params.isDirectMessage,
      dmSessionScope: params.dmSessionScope,
      threadId: params.threadId,
      eventTs: params.eventTs,
      resolveAgentRoute: params.core.channel.routing.resolveAgentRoute,
    });
  const identity = resolveConversationIdentityAdmission({
    cfg: params.cfg,
    ctx: {
      AgentId: resolved.route.agentId,
      AgentRouteMatchedBy: resolved.route.matchedBy,
      SessionKey: resolved.route.sessionKey,
      AccountId: resolved.route.accountId,
      ChatType: params.isDirectMessage ? "direct" : "channel",
      ChatId: params.isDirectMessage ? undefined : params.roomId,
      SenderId: params.senderId,
      Provider: "matrix",
      Surface: "matrix",
      CommandAuthorized: true,
    },
  });
  if (!identity.allowed) {
    return null;
  }
  if (resolved.configuredBinding) {
    const readiness = await ensureConfiguredAcpBindingReady({
      cfg: params.cfg,
      configuredBinding: resolved.configuredBinding,
    });
    if (!readiness.ok) {
      return null;
    }
  }
  return resolved;
}

export function resolveMatrixReactionNotificationMode(params: {
  cfg: CoreConfig;
  accountId: string;
}): MatrixReactionNotificationMode {
  const matrixConfig = params.cfg.channels?.matrix;
  const accountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return accountConfig.reactionNotifications ?? matrixConfig?.reactionNotifications ?? "own";
}

async function maybeResolveMatrixApprovalReaction(params: {
  cfg: CoreConfig;
  accountId: string;
  senderId: string;
  target: Awaited<ReturnType<typeof resolveMatrixApprovalReactionTargetWithPersistence>>;
  targetEventId: string;
  roomId: string;
  logVerboseMessage: (message: string) => void;
}): Promise<boolean> {
  if (!params.target) {
    return false;
  }
  const approvalKind = params.target.approvalId.startsWith("plugin:") ? "plugin" : "exec";
  const { isMatrixApprovalReactionAuthorizedSender } = await loadApprovalReactionAuth();
  if (!isMatrixApprovalReactionAuthorizedSender({ ...params, approvalKind })) {
    return false;
  }
  const { isApprovalNotFoundError, resolveMatrixApproval } = await loadExecApprovalResolver();
  try {
    await resolveMatrixApproval({
      cfg: params.cfg,
      approvalId: params.target.approvalId,
      decision: params.target.decision,
      senderId: params.senderId,
    });
    params.logVerboseMessage(
      `matrix: approval reaction resolved id=${params.target.approvalId} sender=${params.senderId} decision=${params.target.decision}`,
    );
    return true;
  } catch (err) {
    if (isApprovalNotFoundError(err)) {
      unregisterMatrixApprovalReactionTarget({
        roomId: params.roomId,
        eventId: params.targetEventId,
      });
      params.logVerboseMessage(
        `matrix: approval reaction ignored for expired approval id=${params.target.approvalId} sender=${params.senderId}`,
      );
      return true;
    }
    params.logVerboseMessage(
      `matrix: approval reaction failed id=${params.target.approvalId} sender=${params.senderId}: ${String(err)}`,
    );
    return true;
  }
}

export async function handleInboundMatrixReaction(params: {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  event: MatrixRawEvent;
  senderId: string;
  senderLabel: string;
  selfUserId: string;
  isDirectMessage: boolean;
  preparedRoute?: ReturnType<typeof resolveMatrixInboundRoute>;
  logVerboseMessage: (message: string) => void;
}): Promise<void> {
  const reaction = extractMatrixReactionAnnotation(params.event.content);
  if (!reaction?.eventId) {
    return;
  }
  if (params.senderId === params.selfUserId) {
    return;
  }
  const approvalTarget = await resolveMatrixApprovalReactionTargetWithPersistence({
    roomId: params.roomId,
    eventId: reaction.eventId,
    reactionKey: reaction.key,
  });
  if (
    await maybeResolveMatrixApprovalReaction({
      cfg: params.cfg,
      accountId: params.accountId,
      senderId: params.senderId,
      target: approvalTarget,
      targetEventId: reaction.eventId,
      roomId: params.roomId,
      logVerboseMessage: params.logVerboseMessage,
    })
  ) {
    return;
  }
  const notificationMode = resolveMatrixReactionNotificationMode({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (notificationMode === "off") {
    return;
  }

  const accountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const initialRoute = await resolveAdmittedMatrixReactionRoute({
    cfg: params.cfg,
    core: params.core,
    accountId: params.accountId,
    roomId: params.roomId,
    senderId: params.senderId,
    isDirectMessage: params.isDirectMessage,
    dmSessionScope: accountConfig.dm?.sessionScope ?? "per-user",
    eventTs: params.event.origin_server_ts,
    preparedRoute: params.preparedRoute,
  });
  if (!initialRoute) {
    return;
  }

  const targetEvent = await params.client
    .getEvent(params.roomId, reaction.eventId)
    .catch((err: unknown) => {
      params.logVerboseMessage(
        `matrix: failed resolving reaction target room=${params.roomId} id=${reaction.eventId}: ${String(err)}`,
      );
      return null;
    });
  const targetSender =
    targetEvent && typeof targetEvent.sender === "string" ? targetEvent.sender.trim() : "";
  if (!targetSender) {
    return;
  }
  if (notificationMode === "own" && targetSender !== params.selfUserId) {
    return;
  }

  const targetContent =
    targetEvent && targetEvent.content && typeof targetEvent.content === "object"
      ? (targetEvent.content as RoomMessageEventContent)
      : undefined;
  const threadRootId = targetContent
    ? resolveMatrixThreadRootId({
        event: targetEvent as MatrixRawEvent,
        content: targetContent,
      })
    : undefined;
  const thread = resolveMatrixThreadRouting({
    isDirectMessage: params.isDirectMessage,
    threadReplies: accountConfig.threadReplies ?? "inbound",
    dmThreadReplies: accountConfig.dm?.threadReplies,
    messageId: reaction.eventId,
    threadRootId,
  });
  const exactRoute = thread.threadId
    ? await resolveAdmittedMatrixReactionRoute({
        cfg: params.cfg,
        core: params.core,
        accountId: params.accountId,
        roomId: params.roomId,
        senderId: params.senderId,
        isDirectMessage: params.isDirectMessage,
        dmSessionScope: accountConfig.dm?.sessionScope ?? "per-user",
        threadId: thread.threadId,
        eventTs: params.event.origin_server_ts,
      })
    : initialRoute;
  if (!exactRoute) {
    return;
  }
  const { route, runtimeBindingId } = exactRoute;
  if (runtimeBindingId) {
    getSessionBindingService().touch(runtimeBindingId, params.event.origin_server_ts);
  }
  const text = `Matrix reaction added: ${reaction.key} by ${params.senderLabel} on msg ${reaction.eventId}`;
  params.core.system.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    contextKey: `matrix:reaction:add:${params.roomId}:${reaction.eventId}:${params.senderId}:${reaction.key}`,
    actor: { channel: "matrix", accountId: params.accountId, senderId: params.senderId },
  });
  params.logVerboseMessage(
    `matrix: reaction event enqueued room=${params.roomId} target=${reaction.eventId} sender=${params.senderId} emoji=${reaction.key}`,
  );
}
