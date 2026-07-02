import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isConversationIdentityPersistedAgentCurrent,
  resolveConversationIdentityMode,
  type ConversationIdentityDecision,
} from "openclaw/plugin-sdk/routing";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveVoiceCallEffectiveConfig, type VoiceCallConfig } from "./config.js";
import type { VoiceCallInboundIdentity } from "./types.js";

function resolveInboundIdentityFacts(params: {
  config: VoiceCallConfig;
  from?: string;
  to?: string;
}) {
  const effectiveConfig = resolveVoiceCallEffectiveConfig(params.config, params.to).config;
  const normalizedCaller = params.from?.trim() ? normalizeE164(params.from) : undefined;
  return { effectiveConfig, normalizedCaller };
}

export function resolveVoiceCallInboundIdentity(params: {
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
  from?: string;
  to?: string;
}): ConversationIdentityDecision {
  const { effectiveConfig } = resolveInboundIdentityFacts(params);

  return resolveConversationIdentityMode({
    config: params.coreConfig,
    agentId: effectiveConfig.agentId,
    routeMatchedBy: effectiveConfig.agentId ? "config.agent" : "default",
    chatType: "direct",
    // Carrier caller ID and allowlists are admission filters, not owner authentication.
    senderIsOwner: false,
  });
}

export function resolveVoiceCallInboundAdmission(params: {
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
  from?: string;
  to?: string;
}): VoiceCallInboundIdentity | undefined {
  const decision = resolveVoiceCallInboundIdentity(params);
  const { effectiveConfig, normalizedCaller } = resolveInboundIdentityFacts(params);
  const agentId = effectiveConfig.agentId?.trim();
  if (!decision.allowed || !agentId) {
    return undefined;
  }
  return {
    agentId,
    routeMatchedBy: "config.agent",
    chatType: "direct",
    ...(normalizedCaller ? { senderId: normalizedCaller, senderE164: normalizedCaller } : {}),
    senderIsOwner: false,
    responsePolicy: {
      model: effectiveConfig.responseModel ?? null,
      systemPrompt: effectiveConfig.responseSystemPrompt ?? null,
      timeoutMs: effectiveConfig.responseTimeoutMs,
    },
  };
}

export function applyVoiceCallInboundResponsePolicy(params: {
  config: VoiceCallConfig;
  identity: VoiceCallInboundIdentity;
}): VoiceCallConfig {
  return {
    ...params.config,
    agentId: params.identity.agentId,
    responseModel: params.identity.responsePolicy.model ?? undefined,
    responseSystemPrompt: params.identity.responsePolicy.systemPrompt ?? undefined,
    responseTimeoutMs: params.identity.responsePolicy.timeoutMs,
  };
}

export function isVoiceCallInboundIdentityCurrent(params: {
  coreConfig: OpenClawConfig;
  identity: VoiceCallInboundIdentity;
}): boolean {
  // An admitted active call keeps its service identity across number reassignment.
  // Registry removal revokes it; silently switching an in-flight session would mix identities.
  return isConversationIdentityPersistedAgentCurrent({
    config: params.coreConfig,
    agentId: params.identity.agentId,
  });
}
