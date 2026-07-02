import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type ConversationIdentityDecision,
  isInterSessionIdentityTransitionAllowed,
  resolveConversationIdentityMode,
} from "../../routing/conversation-identity.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { safeJsonStringify } from "../../utils/safe-json.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";

export function resolveConversationIdentityContractVersion(value: unknown): 1 | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 1) {
    throw new Error(
      `Unsupported reply identity contract version: ${safeJsonStringify(value) ?? "unknown"}`,
    );
  }
  return value;
}

export function resolveConversationIdentityAdmission(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): ConversationIdentityDecision {
  const { ctx, cfg } = params;
  const sessionKey = resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    fallbackAgentId: ctx.AgentId,
  });
  const inputProvenance = ctx.InputProvenance;
  const isInterSession = inputProvenance?.kind === "inter_session";
  if (
    isInterSession &&
    !isInterSessionIdentityTransitionAllowed({
      config: cfg,
      sourceSessionKey: inputProvenance.sourceSessionKey,
      sourceTool: inputProvenance.sourceTool,
      targetAgentId: agentId,
    })
  ) {
    return { mode: "external", allowed: false, reason: "disallowed_inter_session" };
  }
  const gatewayScopes = ctx.GatewayClientScopes ?? [];
  const hasGatewayWriteScope =
    gatewayScopes.includes("operator.write") || gatewayScopes.includes("operator.admin");
  const isAuthenticatedGatewayConversation =
    hasGatewayWriteScope &&
    isInternalMessageChannel(ctx.Provider) &&
    isInternalMessageChannel(ctx.Surface);
  // Provenance is attached by OpenClaw runtimes, not parsed from user text.
  // Internal and inter-session continuations stay inside an already-admitted session.
  const isInternal =
    inputProvenance?.kind === "internal_system" ||
    isInterSession ||
    isAuthenticatedGatewayConversation;
  const authorization = isInternal
    ? undefined
    : resolveCommandAuthorization({
        ctx,
        cfg,
        commandAuthorized: ctx.CommandAuthorized === true,
      });
  return resolveConversationIdentityMode({
    config: cfg,
    isInternal,
    agentId,
    routeMatchedBy: ctx.AgentRouteMatchedBy,
    chatType: ctx.ChatType,
    groupId: normalizeOptionalString(ctx.ChatId),
    groupChannel: normalizeOptionalString(ctx.GroupChannel ?? ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    senderIsOwner:
      authorization?.stableSenderIsOwner === true || gatewayScopes.includes("operator.admin"),
  });
}
