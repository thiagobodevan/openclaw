/**
 * Public SDK subpath for session keys, account bindings, and message-channel routing.
 */
export {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentRoute,
  resolveInboundLastRouteSessionKey,
  type AgentRouteMatch,
  type ResolvedAgentRoute,
  type RoutePeer,
  type RoutePeerKind,
} from "../routing/resolve-route.js";
export {
  EXTERNAL_CONVERSATION_IDENTITY_DENIAL,
  isConversationIdentityPersistedAgentCurrent,
  resolveConversationIdentityMode,
  resolveConversationScope,
  resolveStableSenderIsOwner,
  type ConversationCapabilityScope,
  type ConversationIdentityDecision,
  type ConversationIdentityMode,
  type ConversationIdentityParams,
} from "../routing/conversation-identity.js";
export { resolveConversationIdentityAdmission } from "../auto-reply/reply/conversation-identity-admission.js";
export {
  buildAgentMainSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  buildGroupHistoryKey,
  isCronSessionKey,
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAccountId,
  normalizeAgentId,
  normalizeMainKey,
  normalizeOptionalAccountId,
  parseAgentSessionKey,
  parseThreadSessionSuffix,
  resolveAgentIdFromSessionKey,
  resolveThreadSessionKeys,
  sanitizeAgentId,
} from "../routing/session-key.js";
export { resolveAccountEntry } from "../routing/account-lookup.js";
export { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
export {
  formatSetExplicitDefaultInstruction,
  formatSetExplicitDefaultToConfiguredInstruction,
} from "../routing/default-account-warnings.js";
export { buildOutboundBaseSessionKey } from "../infra/outbound/base-session-key.js";
export { normalizeOutboundThreadId } from "../infra/outbound/thread-id.js";
export { normalizeMessageChannel, resolveGatewayMessageChannel } from "../utils/message-channel.js";
