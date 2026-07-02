// Slack plugin module implements system event context behavior.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { authorizeSlackSystemEventSender, resolveSlackSenderIsOwner } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext, SlackSystemEventRoute } from "../context.js";

type SlackAuthorizedSystemEventContext = {
  channelLabel: string;
  sessionKey: string;
};

export function resolveSlackSystemEventIdentityPreflight(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  threadTs?: string;
  eventKind: string;
}): SlackSystemEventRoute | null {
  const { ctx, senderId, channelId, channelType, threadTs, eventKind } = params;
  const admittedSenderId = senderId?.trim();
  if (!admittedSenderId) {
    return null;
  }
  const route = ctx.resolveSlackSystemEventIdentityRoute({
    channelId,
    channelType,
    senderId: admittedSenderId,
    senderIsOwner: resolveSlackSenderIsOwner(ctx, admittedSenderId),
    threadTs,
  });
  if (!route) {
    logVerbose(
      `slack: drop ${eventKind} sender ${admittedSenderId} channel=${channelId ?? "unknown"} reason=identity-not-admitted`,
    );
  }
  return route;
}

export async function authorizeAndResolveSlackSystemEventContext(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  threadTs?: string;
  eventKind: string;
}): Promise<SlackAuthorizedSystemEventContext | undefined> {
  const { ctx, senderId, channelId, channelType, threadTs, eventKind } = params;
  const identityRoute = resolveSlackSystemEventIdentityPreflight({
    ctx,
    senderId,
    channelId,
    channelType,
    threadTs,
    eventKind,
  });
  if (!identityRoute) {
    return undefined;
  }
  const auth = await authorizeSlackSystemEventSender({
    ctx,
    senderId,
    channelId,
    channelType,
  });
  if (!auth.allowed) {
    logVerbose(
      `slack: drop ${eventKind} sender ${senderId ?? "unknown"} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`,
    );
    return undefined;
  }
  const admittedSenderId = senderId?.trim() as string;

  const channelLabel = resolveSlackChannelLabel({
    channelId,
    channelName: auth.channelName,
  });
  const route = await ctx.resolveSlackSystemEventRouteReady({
    channelId,
    channelType: auth.channelType,
    senderId: admittedSenderId,
    senderIsOwner: resolveSlackSenderIsOwner(ctx, admittedSenderId),
    threadTs,
  });
  if (!route) {
    logVerbose(
      `slack: drop ${eventKind} sender ${admittedSenderId} channel=${channelId ?? "unknown"} reason=identity-not-admitted`,
    );
    return undefined;
  }
  return {
    channelLabel,
    sessionKey: route.sessionKey,
  };
}
