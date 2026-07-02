/**
 * sessions_send agent-to-agent reply flow.
 *
 * Runs bounded ping-pong delivery, waits for target replies, and suppresses control-token messages.
 */
import crypto from "node:crypto";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AssistantReplySnapshot,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
} from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  type AnnounceTarget,
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isNonDeliverableSessionsReply,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

type GatewayCaller = <T = unknown>(opts: CallGatewayOptions) => Promise<T>;

const defaultSessionsSendA2ADeps = {
  callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
    const { callGateway } = await import("../../gateway/call.js");
    return callGateway<T>(opts);
  },
};

let sessionsSendA2ADeps: {
  callGateway: GatewayCaller;
} = defaultSessionsSendA2ADeps;

function isSameAnnounceAudience(left: AnnounceTarget, right: AnnounceTarget): boolean {
  return (
    left.channel === right.channel &&
    left.to === right.to &&
    left.accountId === right.accountId &&
    left.threadId === right.threadId
  );
}

async function deliverAnnounceReply(params: {
  announceTarget: AnnounceTarget;
  message: string;
  runContextId: string;
}) {
  const message = params.message.trim();
  if (!message) {
    return;
  }
  try {
    await sessionsSendA2ADeps.callGateway({
      method: "send",
      params: {
        to: params.announceTarget.to,
        message,
        channel: params.announceTarget.channel,
        accountId: params.announceTarget.accountId,
        threadId: params.announceTarget.threadId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send announce delivery failed", {
      runId: params.runContextId,
      channel: params.announceTarget.channel,
      to: params.announceTarget.to,
      error: formatErrorMessage(err),
    });
  }
}

export async function runSessionsSendA2AFlow(params: {
  targetGatewayAgentId?: string;
  targetSessionKey: string;
  targetIdentitySessionKey?: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterIdentitySessionKey?: string;
  requesterGatewayAgentId?: string;
  requesterChannel?: GatewayMessageChannel;
  revalidateAdmission: () => Promise<boolean>;
  baseline?: AssistantReplySnapshot;
  roundOneReply?: string;
  waitRunId?: string;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRun({
        runId: params.waitRunId,
        timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
        callGateway: sessionsSendA2ADeps.callGateway,
      });
      if (wait.status === "ok") {
        if (!(await params.revalidateAdmission())) {
          return;
        }
        const latestSnapshot = await readLatestAssistantReplySnapshot({
          sessionKey: params.targetSessionKey,
          agentId: params.targetGatewayAgentId,
          callGateway: sessionsSendA2ADeps.callGateway,
        });
        const baselineFingerprint = params.baseline?.fingerprint;
        primaryReply =
          latestSnapshot.text &&
          (!baselineFingerprint || latestSnapshot.fingerprint !== baselineFingerprint)
            ? latestSnapshot.text
            : undefined;
        latestReply = primaryReply;
      }
    }
    if (!latestReply) {
      return;
    }
    if (isNonDeliverableSessionsReply(latestReply)) {
      return;
    }

    if (!(await params.revalidateAdmission())) {
      return;
    }
    let announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
      agentId: params.targetGatewayAgentId,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";
    const requesterIdentitySessionKey =
      params.requesterIdentitySessionKey ?? params.requesterSessionKey;
    const targetIdentitySessionKey = params.targetIdentitySessionKey ?? params.targetSessionKey;
    const sameSession =
      Boolean(requesterIdentitySessionKey) &&
      requesterIdentitySessionKey === targetIdentitySessionKey;

    // A same-session send is a human-facing source-channel reply, not a true
    // agent-to-agent announcement. Asking the same session to decide whether to
    // announce can learn stale ANNOUNCE_SKIP patterns from its own history and
    // silently drop a normal channel response.
    if (announceTarget && sameSession && params.requesterChannel === announceTarget.channel) {
      if (params.waitRunId && !params.roundOneReply && !params.baseline) {
        return;
      }
      if (!(await params.revalidateAdmission())) {
        return;
      }
      const currentAnnounceTarget = await resolveAnnounceTarget({
        sessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
        agentId: params.targetGatewayAgentId,
      });
      if (
        !currentAnnounceTarget ||
        !isSameAnnounceAudience(announceTarget, currentAnnounceTarget)
      ) {
        return;
      }
      if (!(await params.revalidateAdmission())) {
        return;
      }
      await deliverAnnounceReply({
        announceTarget: currentAnnounceTarget,
        message: latestReply,
        runContextId,
      });
      return;
    }

    if (params.maxPingPongTurns > 0 && params.requesterSessionKey && !sameSession) {
      let currentRole: "requester" | "target" = "requester";
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentSessionKey =
          currentRole === "requester" ? params.requesterSessionKey : params.targetSessionKey;
        const currentAgentId =
          currentRole === "requester"
            ? params.requesterGatewayAgentId
            : params.targetGatewayAgentId;
        const sourceSessionKey =
          currentRole === "requester" ? targetIdentitySessionKey : requesterIdentitySessionKey;
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: requesterIdentitySessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.maxPingPongTurns,
        });
        // Either side can execute this turn. Revalidate the pair immediately
        // before work so a removed or rebound requester cannot resume later.
        if (!(await params.revalidateAdmission())) {
          return;
        }
        const replyText = await runAgentStep({
          agentId: currentAgentId,
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: resolveNestedAgentLaneForSession(currentSessionKey),
          sourceSessionKey,
          sourceChannel: currentRole === "target" ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });
        if (!replyText || isReplySkip(replyText) || isNonDeliverableSessionsReply(replyText)) {
          break;
        }
        latestReply = replyText;
        incomingMessage = replyText;
        currentRole = currentRole === "requester" ? "target" : "requester";
      }
    }

    const announcePrompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: requesterIdentitySessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel,
      originalMessage: params.message,
      roundOneReply: primaryReply,
      latestReply,
    });
    if (!(await params.revalidateAdmission())) {
      return;
    }
    const announceReply = await runAgentStep({
      agentId: params.targetGatewayAgentId,
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: resolveNestedAgentLaneForSession(params.targetSessionKey),
      transcriptMessage: "",
      sourceSessionKey: requesterIdentitySessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
    });
    if (
      announceTarget &&
      announceReply &&
      announceReply.trim() &&
      !isAnnounceSkip(announceReply) &&
      !isNonDeliverableSessionsReply(announceReply)
    ) {
      if (!(await params.revalidateAdmission())) {
        return;
      }
      const currentAnnounceTarget = await resolveAnnounceTarget({
        sessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
        agentId: params.targetGatewayAgentId,
      });
      if (
        !currentAnnounceTarget ||
        !isSameAnnounceAudience(announceTarget, currentAnnounceTarget)
      ) {
        return;
      }
      if (!(await params.revalidateAdmission())) {
        return;
      }
      await deliverAnnounceReply({
        announceTarget: currentAnnounceTarget,
        message: announceReply,
        runContextId,
      });
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}

export const testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};
export { testing as __testing };
