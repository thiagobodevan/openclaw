/** Lazy channel-plugin route resolution for persisted sessions. */
import type { ChatType } from "../channels/chat-type.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type {
  ChannelConversationAudienceEvidence,
  ChannelCurrentConversationRoute,
} from "../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import { normalizeAccountId } from "./account-id.js";

export type PersistedPluginConversationRouteResult =
  | { kind: "unsupported"; effectiveAccountId?: string }
  | { kind: "unresolved"; effectiveAccountId?: string }
  | {
      kind: "resolved";
      route: ChannelCurrentConversationRoute;
      effectiveAccountId?: string;
    };

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
  audienceEvidence?: readonly ChannelConversationAudienceEvidence[];
  requireAudienceValidation?: boolean;
}): Promise<PersistedPluginConversationRouteResult> {
  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    allowBootstrap: true,
  });
  const effectiveAccountId = plugin
    ? normalizeAccountId(
        params.accountId ?? resolveChannelDefaultAccountId({ plugin, cfg: params.cfg }),
      )
    : params.accountId == null
      ? undefined
      : normalizeAccountId(params.accountId);
  const resolver = plugin?.messaging?.resolveCurrentConversationRoute;
  if (!resolver) {
    return { kind: "unsupported", effectiveAccountId };
  }
  const route = await resolver({ ...params, accountId: effectiveAccountId });
  if (route === undefined) {
    return { kind: "unsupported", effectiveAccountId };
  }
  return route
    ? { kind: "resolved", route, effectiveAccountId }
    : { kind: "unresolved", effectiveAccountId };
}
