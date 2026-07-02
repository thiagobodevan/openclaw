/** Lazy channel-plugin route resolution for persisted sessions. */
import type { ChatType } from "../channels/chat-type.js";
import type { ChannelCurrentConversationRoute } from "../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";

export type PersistedPluginConversationRouteResult =
  | { kind: "unsupported" }
  | { kind: "unresolved" }
  | { kind: "resolved"; route: ChannelCurrentConversationRoute };

export async function resolvePersistedPluginConversationRoute(params: {
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
}): Promise<PersistedPluginConversationRouteResult> {
  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    allowBootstrap: true,
  });
  const resolver = plugin?.messaging?.resolveCurrentConversationRoute;
  if (!resolver) {
    return { kind: "unsupported" };
  }
  const route = await resolver(params);
  if (route === undefined) {
    return { kind: "unsupported" };
  }
  return route ? { kind: "resolved", route } : { kind: "unresolved" };
}
