// Whatsapp plugin module implements broadcast behavior.
import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { resolveWhatsAppAgentRoute } from "../../group-session-key.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { formatError } from "../../session.js";
import { whatsappInboundLog } from "../loggers.js";
import type { GroupHistoryEntry } from "./inbound-context.js";

export async function maybeBroadcastMessage(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  peerId: string;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  processMessage: (
    msg: AdmittedWebInboundMessage,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
      preflightAudioTranscript?: string | null;
      ackAlreadySent?: boolean;
      ackReaction?: AckReactionHandle | null;
    },
  ) => Promise<boolean>;
  preflightAudioTranscript?: string | null;
  ackAlreadySent?: boolean;
  ackReaction?: AckReactionHandle | null;
}) {
  const broadcastAgents = params.cfg.broadcast?.[params.peerId];
  if (!broadcastAgents || !Array.isArray(broadcastAgents)) {
    return false;
  }
  if (broadcastAgents.length === 0) {
    return false;
  }

  const strategy = params.cfg.broadcast?.strategy || "parallel";
  whatsappInboundLog.info(`Broadcasting message to ${broadcastAgents.length} agents (${strategy})`);

  const agentIds = params.cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id));
  const hasKnownAgents = (agentIds?.length ?? 0) > 0;
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const isGroupConversation = admission.conversation.kind === "group";
  const groupHistorySnapshot = isGroupConversation
    ? (params.groupHistories.get(params.groupHistoryKey) ?? [])
    : undefined;

  const processForAgent = async (agentId: string): Promise<boolean> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
      whatsappInboundLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
      return false;
    }
    const agentRoute = resolveWhatsAppAgentRoute({
      cfg: params.cfg,
      route: params.route,
      peerId: params.peerId,
      agentId: normalizedAgentId,
      chatType: admission.conversation.kind,
      matchedBy: "config.agent",
    });

    try {
      const opts: {
        groupHistory?: GroupHistoryEntry[];
        suppressGroupHistoryClear: true;
        preflightAudioTranscript?: string | null;
        ackAlreadySent?: boolean;
        ackReaction?: AckReactionHandle | null;
      } = {
        groupHistory: groupHistorySnapshot,
        suppressGroupHistoryClear: true,
      };
      if (params.preflightAudioTranscript !== undefined) {
        opts.preflightAudioTranscript = params.preflightAudioTranscript;
      }
      if (params.ackAlreadySent === true) {
        opts.ackAlreadySent = true;
      }
      if (params.ackReaction !== undefined) {
        opts.ackReaction = params.ackReaction;
      }
      return await params.processMessage(params.msg, agentRoute, params.groupHistoryKey, opts);
    } catch (err) {
      whatsappInboundLog.error(`Broadcast agent ${agentId} failed: ${formatError(err)}`);
      return false;
    }
  };

  if (strategy === "sequential") {
    for (const agentId of broadcastAgents) {
      await processForAgent(agentId);
    }
  } else {
    await Promise.allSettled(broadcastAgents.map(processForAgent));
  }

  if (isGroupConversation) {
    params.groupHistories.set(params.groupHistoryKey, []);
  }

  return true;
}
