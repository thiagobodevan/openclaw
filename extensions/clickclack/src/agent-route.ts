/** Canonical ClickClack account and binding route resolution. */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  normalizeAgentId,
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type RoutePeer,
} from "openclaw/plugin-sdk/routing";

const CHANNEL_ID = "clickclack" as const;

export function resolveClickClackAgentRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  configuredAgentId?: string;
  target: string;
  isDirect: boolean;
}): ResolvedAgentRoute {
  const peer: RoutePeer = {
    kind: params.isDirect ? "direct" : "channel",
    id: params.target,
  };
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer,
  });
  const configuredAgentId = params.configuredAgentId?.trim();
  if (!configuredAgentId || normalizeAgentId(configuredAgentId) === normalizeAgentId(route.agentId)) {
    return route;
  }
  const agentId = normalizeAgentId(configuredAgentId);
  const sessionKey = buildAgentSessionKey({
    agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer,
  });
  const mainSessionKey = buildAgentMainSessionKey({ agentId, mainKey: "main" });
  return {
    ...route,
    agentId,
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
    matchedBy: "config.agent",
  };
}
