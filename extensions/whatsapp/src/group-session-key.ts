import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Whatsapp plugin module implements group session key behavior.
import {
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MAIN_KEY,
  deriveLastRoutePolicy,
  normalizeAccountId,
  normalizeAgentId,
  resolveThreadSessionKeys,
  type AgentRouteMatch,
  type ResolvedAgentRoute,
} from "openclaw/plugin-sdk/routing";

function resolveWhatsAppGroupAccountThreadId(accountId: string): string {
  return `whatsapp-account-${normalizeAccountId(accountId)}`;
}

export function resolveWhatsAppLegacyGroupSessionKey(params: {
  sessionKey: string;
  accountId?: string | null;
}): string | null {
  const accountId = normalizeAccountId(params.accountId);
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID || !params.sessionKey.includes(":group:")) {
    return null;
  }
  const suffix = `:thread:${resolveWhatsAppGroupAccountThreadId(accountId)}`;
  return params.sessionKey.endsWith(suffix) ? params.sessionKey.slice(0, -suffix.length) : null;
}

export function resolveWhatsAppGroupSessionRoute(route: ResolvedAgentRoute): ResolvedAgentRoute {
  if (route.accountId === DEFAULT_ACCOUNT_ID || !route.sessionKey.includes(":group:")) {
    return route;
  }
  const scopedSession = resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId: resolveWhatsAppGroupAccountThreadId(route.accountId),
  });
  return {
    ...route,
    sessionKey: scopedSession.sessionKey,
  };
}

export function resolveWhatsAppAgentRoute(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  peerId: string;
  chatType: "direct" | "group" | "channel";
  agentId: string;
  matchedBy: AgentRouteMatch;
}): ResolvedAgentRoute {
  const agentId = normalizeAgentId(params.agentId);
  const sessionKey = buildAgentSessionKey({
    agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
    peer: { kind: params.chatType, id: params.peerId },
    dmScope: params.cfg.session?.dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
  const mainSessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey: DEFAULT_MAIN_KEY,
  });
  return resolveWhatsAppGroupSessionRoute({
    ...params.route,
    agentId,
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
    matchedBy: params.matchedBy,
  });
}

export const testing = {
  resolveWhatsAppGroupAccountThreadId,
  resolveWhatsAppLegacyGroupSessionKey,
};
export { testing as __testing };
