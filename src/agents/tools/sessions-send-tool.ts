/**
 * sessions_send built-in tool.
 *
 * Sends messages to visible sessions, starts embedded runs, and optionally announces replies.
 */
import crypto from "node:crypto";
import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isInterSessionIdentityTransitionAllowed } from "../../routing/conversation-identity.js";
import { resolvePersistedConversationIdentityContext } from "../../routing/persisted-conversation-identity.js";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { listAgentIds } from "../agent-scope.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageOutcome,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "../embedded-agent-runner/runs.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AgentWaitResult,
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../run-wait.js";
import {
  isConfiguredOrLiveOwnedSessionTarget,
  isLiveOwnedSessionTarget,
  isRequesterParentOfNativeSubagentSession,
} from "../session-target-identity.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNonNegativeIntegerParam, readStringParam } from "./common.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;
const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;

type SessionParticipantAdmission =
  | {
      allowed: true;
      access: ReturnType<typeof resolveSessionEntryAccessTarget>;
      liveOwned: boolean;
    }
  | {
      allowed: false;
      reason: "agent_removed" | "stale_route";
    };

type InterSessionAdmission =
  | {
      allowed: true;
      requesterIdentitySessionKey: string;
      targetAccess: ReturnType<typeof resolveSessionEntryAccessTarget>;
      targetIsLiveOwned: boolean;
    }
  | {
      allowed: false;
      reason:
        | "identity_transition"
        | "requester_agent_removed"
        | "requester_stale_route"
        | "target_agent_removed"
        | "target_stale_route";
    };

function describeInterSessionAdmissionDenial(
  reason: Extract<InterSessionAdmission, { allowed: false }>["reason"],
): string {
  if (reason === "requester_agent_removed") {
    return "Requesting agent is no longer configured.";
  }
  if (reason === "requester_stale_route") {
    return "Requesting conversation identity is no longer authorized.";
  }
  if (reason === "target_agent_removed") {
    return "Target agent is no longer configured.";
  }
  if (reason === "identity_transition") {
    return "Inter-session identity transition denied.";
  }
  return "Target conversation identity is no longer authorized.";
}

function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};

  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readStringParam(params, alias);
      if (value) {
        params.message = stripFormattedReasoningMessage(value);
        break;
      }
    }
  }

  for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
    delete params[alias];
  }
  return params;
}

function resolveConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }
  return toAgentStoreSessionKey({
    agentId,
    requestKey: "main",
    mainKey: params.mainKey,
  });
}

function isConfiguredAgentMainSessionKey(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  mainKey: string;
}): boolean {
  if (params.sessionKey === "global" && params.cfg.session?.scope === "global") {
    return true;
  }
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  return (
    params.sessionKey ===
    resolveConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      agentId,
      mainKey: params.mainKey,
    })
  );
}

function resolveAgentMainOwnershipKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string {
  const configuredKey = resolveConfiguredAgentMainSessionKey(params);
  return configuredKey && configuredKey !== "global"
    ? configuredKey
    : `agent:${normalizeAgentId(params.agentId)}:main`;
}

function resolveRequesterIdentitySessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
  sessionKey: string;
}): string {
  if (parseAgentSessionKey(params.sessionKey)) {
    return params.sessionKey;
  }
  if (params.sessionKey === "global") {
    return resolveAgentMainOwnershipKey(params);
  }
  return toAgentStoreSessionKey({
    agentId: params.agentId,
    requestKey: params.sessionKey,
    mainKey: params.mainKey,
  });
}

async function resolveCurrentSessionParticipantAdmission(params: {
  cfg: OpenClawConfig;
  mainKey: string;
  requesterSessionKey: string;
  agentId?: string;
  sessionKey: string;
}): Promise<SessionParticipantAdmission> {
  const normalizedSessionKey = params.sessionKey.trim().toLowerCase();
  const isPerSenderMainAlias =
    params.sessionKey !== "global" &&
    !parseAgentSessionKey(params.sessionKey) &&
    (normalizedSessionKey === "main" || normalizedSessionKey === params.mainKey.toLowerCase());
  const accessSessionKey =
    isPerSenderMainAlias && params.agentId
      ? resolveAgentMainOwnershipKey({
          cfg: params.cfg,
          agentId: params.agentId,
          mainKey: params.mainKey,
        })
      : params.sessionKey;
  const access = resolveSessionEntryAccessTarget({
    cfg: params.cfg,
    sessionKey: accessSessionKey,
    agentId: params.agentId,
  });
  if (params.agentId && access.agentId !== normalizeAgentId(params.agentId)) {
    return { allowed: false, reason: "agent_removed" };
  }
  const ownershipKey =
    access.canonicalKey === "global" && params.agentId
      ? resolveAgentMainOwnershipKey({
          cfg: params.cfg,
          agentId: params.agentId,
          mainKey: params.mainKey,
        })
      : access.canonicalKey;
  if (
    !isConfiguredOrLiveOwnedSessionTarget({
      cfg: params.cfg,
      requesterSessionKey: params.requesterSessionKey,
      targetSessionKey: ownershipKey,
    })
  ) {
    return { allowed: false, reason: "agent_removed" };
  }
  const liveOwned = isLiveOwnedSessionTarget({
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: ownershipKey,
  });
  if (!liveOwned) {
    const identitySessionKey = resolveRunScopedIdentitySessionKey(access.canonicalKey);
    const identityAccess =
      identitySessionKey === access.canonicalKey
        ? access
        : resolveSessionEntryAccessTarget({
            cfg: params.cfg,
            sessionKey: identitySessionKey,
            agentId: access.agentId,
          });
    const identity = await resolvePersistedConversationIdentityContext({
      cfg: params.cfg,
      agentId: identityAccess.agentId,
      sessionKey: identityAccess.canonicalKey,
      sessionEntry: identityAccess.entry,
      // Audienceless agent/main sessions are internal tool targets. Persisted
      // channel audiences must still match their current service route.
      audienceless: "internal",
      requireAgentSessionKey: identityAccess.canonicalKey !== "global",
    });
    if (!identity.decision.allowed) {
      return { allowed: false, reason: "stale_route" };
    }
  }
  return { allowed: true, access, liveOwned };
}

async function resolveCurrentInterSessionAdmission(params: {
  cfg: OpenClawConfig;
  mainKey: string;
  requesterAgentId: string;
  requesterSessionKey: string;
  targetAgentId?: string;
  targetSessionKey: string;
}): Promise<InterSessionAdmission> {
  const requester = await resolveCurrentSessionParticipantAdmission({
    cfg: params.cfg,
    mainKey: params.mainKey,
    requesterSessionKey: params.requesterSessionKey,
    agentId: params.requesterAgentId,
    sessionKey: params.requesterSessionKey,
  });
  if (!requester.allowed) {
    return {
      allowed: false,
      reason:
        requester.reason === "agent_removed" ? "requester_agent_removed" : "requester_stale_route",
    };
  }
  const requesterIdentitySessionKey = resolveRequesterIdentitySessionKey({
    cfg: params.cfg,
    agentId: requester.access.agentId,
    mainKey: params.mainKey,
    sessionKey: requester.access.canonicalKey,
  });
  const target = await resolveCurrentSessionParticipantAdmission({
    cfg: params.cfg,
    mainKey: params.mainKey,
    requesterSessionKey: params.requesterSessionKey,
    agentId: params.targetAgentId,
    sessionKey: params.targetSessionKey,
  });
  if (!target.allowed) {
    return {
      allowed: false,
      reason: target.reason === "agent_removed" ? "target_agent_removed" : "target_stale_route",
    };
  }
  if (
    !isInterSessionIdentityTransitionAllowed({
      config: params.cfg,
      sourceSessionKey: requesterIdentitySessionKey,
      sourceTool: "sessions_send",
      targetAgentId: target.access.agentId,
      targetIsLiveOwnedChild: target.liveOwned,
    })
  ) {
    return { allowed: false, reason: "identity_transition" };
  }
  return {
    allowed: true,
    requesterIdentitySessionKey,
    targetAccess: target.access,
    targetIsLiveOwned: target.liveOwned,
  };
}

async function ensureConfiguredAgentMainSession(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  callGateway: GatewayCaller;
  revalidateAdmission: () => Promise<boolean>;
  sessionKey: string;
  mainKey: string;
}): Promise<{ ok: true } | { ok: false; error: string; status: "error" | "forbidden" }> {
  if (
    !isConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      mainKey: params.mainKey,
    })
  ) {
    return { ok: true };
  }

  try {
    await params.callGateway({
      method: "sessions.resolve",
      params: {
        key: params.sessionKey,
        ...(params.sessionKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
      },
      timeoutMs: 10_000,
    });
    return { ok: true };
  } catch {
    if (!(await params.revalidateAdmission())) {
      return {
        ok: false,
        status: "forbidden",
        error: "Conversation identity is no longer authorized.",
      };
    }
    try {
      await params.callGateway({
        method: "sessions.create",
        params: {
          key: params.sessionKey,
          agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
        },
        timeoutMs: 10_000,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, status: "error", error: formatErrorMessage(err) };
    }
  }
}

function isTerminalAgentWaitTimeout(result: AgentWaitResult): boolean {
  return result.endedAt !== undefined || Boolean(result.stopReason || result.livenessState);
}

function isPendingErrorAgentWaitTimeout(result: AgentWaitResult): boolean {
  return (
    result.pendingError === true && typeof result.error === "string" && result.error.trim() !== ""
  );
}

function isRunScopedAgentSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));
  return Boolean(parsed && /(?:^|:)run:[^:]+(?::|$)/.test(parsed.rest));
}

function resolveRunScopedIdentitySessionKey(sessionKey: string): string {
  const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));
  if (!parsed) {
    return sessionKey;
  }
  const runMarker = ":run:";
  const runMarkerIndex = parsed.rest.lastIndexOf(runMarker);
  if (runMarkerIndex <= 0) {
    return sessionKey;
  }
  const runId = parsed.rest.slice(runMarkerIndex + runMarker.length);
  if (!runId || runId.includes(":")) {
    return sessionKey;
  }
  // Active runs inherit the audience admitted for their durable parent. Keep
  // the run key for dispatch, but never treat `:run:<id>` as part of a peer id.
  return `agent:${parsed.agentId}:${parsed.rest.slice(0, runMarkerIndex)}`;
}

function resolveCronRunScopedFallbackSessionKey(sessionKey: string): string | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !isCronRunSessionKey(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed) {
    return undefined;
  }
  const runMarker = ":run:";
  const runMarkerIndex = parsed.rest.lastIndexOf(runMarker);
  if (runMarkerIndex <= 0) {
    return undefined;
  }
  const runId = parsed.rest.slice(runMarkerIndex + runMarker.length);
  if (!runId || runId.includes(":")) {
    return undefined;
  }
  const fallbackRest = parsed.rest.slice(0, runMarkerIndex);
  if (!fallbackRest) {
    return undefined;
  }
  return `agent:${parsed.agentId}:${fallbackRest}`;
}

function shouldFallbackCronRunScopedActiveDelivery(
  outcome: EmbeddedAgentQueueMessageOutcome,
): boolean {
  return (
    !outcome.queued && (outcome.reason === "not_streaming" || outcome.reason === "no_active_run")
  );
}

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
  revalidateAdmission: (targetSessionKey: string) => Promise<boolean>;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
}): Promise<
  | {
      ok: true;
      runId: string;
      activeRunQueue?: boolean;
      a2aSessionKey?: string;
      a2aDisplayKey?: string;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> }
> {
  const revalidate = async (targetSessionKey: string) => {
    if (await params.revalidateAdmission(targetSessionKey)) {
      return null;
    }
    return {
      ok: false as const,
      result: jsonResult({
        runId: params.runId,
        status: "forbidden",
        error: "Conversation identity is no longer authorized.",
        sessionKey: params.sessionKey,
      }),
    };
  };
  try {
    const primaryTargetSessionKey =
      typeof params.sendParams.sessionKey === "string"
        ? params.sendParams.sessionKey
        : params.sessionKey;
    const initialDenial = await revalidate(primaryTargetSessionKey);
    if (initialDenial) {
      return initialDenial;
    }
    const activeRunSessionId =
      params.allowActiveRunQueueDelivery && isRunScopedAgentSessionKey(params.sessionKey)
        ? resolveActiveEmbeddedRunSessionId(params.sessionKey)
        : undefined;
    const messageText =
      typeof params.sendParams.message === "string" ? params.sendParams.message : undefined;
    if (activeRunSessionId && messageText) {
      const sourceReplyDeliveryMode =
        params.sendParams.sourceReplyDeliveryMode === "automatic" ||
        params.sendParams.sourceReplyDeliveryMode === "message_tool_only"
          ? params.sendParams.sourceReplyDeliveryMode
          : undefined;
      const queueOptions: EmbeddedAgentQueueMessageOptions = {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: params.deliveryTimeoutMs,
        waitForTranscriptCommit: true,
        ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
      };
      let queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        activeRunSessionId,
        messageText,
        queueOptions,
      );
      if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
        const retryDenial = await revalidate(primaryTargetSessionKey);
        if (retryDenial) {
          return retryDenial;
        }
        const bestEffortQueueOptions = { ...queueOptions };
        delete bestEffortQueueOptions.waitForTranscriptCommit;
        queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
          activeRunSessionId,
          messageText,
          bestEffortQueueOptions,
        );
      }
      if (queueOutcome.queued) {
        return { ok: true, runId: params.runId, activeRunQueue: true };
      }
      const fallbackSessionKey = resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (fallbackSessionKey && shouldFallbackCronRunScopedActiveDelivery(queueOutcome)) {
        const fallbackDenial = await revalidate(fallbackSessionKey);
        if (fallbackDenial) {
          return fallbackDenial;
        }
        const response = await params.callGateway<{ runId: string }>({
          method: "agent",
          params: {
            ...params.sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
        return {
          ok: true,
          runId:
            typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
          a2aSessionKey: fallbackSessionKey,
          a2aDisplayKey: fallbackSessionKey,
        };
      }
      const queueSummary =
        formatEmbeddedAgentQueueFailureSummary(queueOutcome) ?? "active run queue rejected";
      throw new Error(queueSummary);
    }
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentId?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    prepareArguments: normalizeSessionsSendArguments,
    execute: async (_toolCallId, args) => {
      const params = normalizeSessionsSendArguments(args);
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const timeoutSeconds = readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30;
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);
      const requesterAgentId = normalizeAgentId(
        opts?.agentId ?? resolveAgentIdFromSessionKey(effectiveRequesterKey),
      );
      const requesterAdmission = await resolveCurrentSessionParticipantAdmission({
        cfg,
        mainKey,
        requesterSessionKey: effectiveRequesterKey,
        agentId: requesterAgentId,
        sessionKey: effectiveRequesterKey,
      });
      if (!requesterAdmission.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error:
            requesterAdmission.reason === "agent_removed"
              ? "Requesting agent is no longer configured."
              : "Requesting conversation identity is no longer authorized.",
        });
      }

      const a2aPolicy = createAgentToAgentPolicy(cfg);

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readStringParam(params, "label"));
      const labelAgentIdParam = normalizeOptionalString(readStringParam(params, "agentId"));
      const explicitAgentId = labelAgentIdParam ? normalizeAgentId(labelAgentIdParam) : undefined;
      const resolvedByLabel = !sessionKeyParam && Boolean(labelParam);

      let sessionKey = sessionKeyParam;
      if (!sessionKey && !labelParam && labelAgentIdParam) {
        const agentMainKey = resolveConfiguredAgentMainSessionKey({
          cfg,
          agentId: labelAgentIdParam,
          mainKey,
        });
        if (!agentMainKey) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `agent not found: ${labelAgentIdParam}`,
          });
        }
        sessionKey = agentMainKey;
      }
      if (!sessionKey && labelParam) {
        const requestedAgentId = explicitAgentId;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey;
        try {
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
        } catch (err) {
          const msg = formatErrorMessage(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: msg || `No session found with label: ${labelParam}`,
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: `No session found with label: ${labelParam}`,
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }
      const qualifiedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
      if (qualifiedAgentId && explicitAgentId && qualifiedAgentId !== explicitAgentId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: `agentId "${explicitAgentId}" does not match session key agent "${qualifiedAgentId}".`,
        });
      }
      const normalizedSessionKey = sessionKey.trim().toLowerCase();
      if (
        explicitAgentId &&
        !qualifiedAgentId &&
        (normalizedSessionKey === "main" || normalizedSessionKey === mainKey.toLowerCase())
      ) {
        sessionKey = toAgentStoreSessionKey({
          agentId: explicitAgentId,
          requestKey: sessionKey,
          mainKey,
        });
      }
      const selectedInputAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? explicitAgentId;
      const inputOwnershipKey =
        sessionKey === "global" && selectedInputAgentId
          ? resolveAgentMainOwnershipKey({ cfg, agentId: selectedInputAgentId, mainKey })
          : sessionKey;
      if (
        !isConfiguredOrLiveOwnedSessionTarget({
          cfg,
          requesterSessionKey: effectiveRequesterKey,
          targetSessionKey: inputOwnershipKey,
        })
      ) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: "Target agent is no longer configured.",
          sessionKey,
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      if (
        resolvedSession.key.trim().toLowerCase() === "global" &&
        (resolvedByLabel || resolvedSession.resolvedViaSessionId) &&
        !explicitAgentId
      ) {
        // Global storage does not encode its owning agent. Indirect selectors
        // must carry the owner so a lookup cannot redirect to the requester.
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: "Global session targets resolved by label or session ID require agentId.",
          ...(sessionKeyParam ? { sessionKey: sessionKeyParam } : {}),
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      const unresolvedDisplayKey = sessionKey;
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: unresolvedDisplayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const normalizedResolvedKey = resolvedKey.trim().toLowerCase();
      const resolvedIsMainAlias =
        normalizedResolvedKey === "global" ||
        normalizedResolvedKey === "main" ||
        normalizedResolvedKey === mainKey.toLowerCase() ||
        normalizedResolvedKey === alias.toLowerCase();
      const explicitTargetAgentId =
        parseAgentSessionKey(unresolvedDisplayKey)?.agentId ??
        parseAgentSessionKey(resolvedKey)?.agentId ??
        selectedInputAgentId ??
        (resolvedIsMainAlias ? requesterAgentId : undefined);
      const admissionCfg = opts?.config ?? getRuntimeConfig();
      const { mainKey: admissionMainKey, effectiveRequesterKey: admissionRequesterKey } =
        resolveSessionToolContext({
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
          config: admissionCfg,
        });
      const visibilityTargetAgentId =
        explicitTargetAgentId ?? resolveAgentIdFromSessionKey(resolvedKey);
      const visibilityTargetIdentityKey =
        resolvedKey === "global"
          ? resolveAgentMainOwnershipKey({
              cfg: admissionCfg,
              agentId: visibilityTargetAgentId,
              mainKey: admissionMainKey,
            })
          : resolvedKey;
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: admissionRequesterKey,
        requesterAgentId,
        visibility: resolveEffectiveSessionToolsVisibility({
          cfg: admissionCfg,
          sandboxed: opts?.sandboxed === true,
        }),
        a2aPolicy: createAgentToAgentPolicy(admissionCfg),
      });
      const visibilityTargetKey =
        resolvedKey === "global" &&
        admissionRequesterKey.trim().toLowerCase() === "global" &&
        visibilityTargetAgentId === requesterAgentId
          ? admissionRequesterKey
          : visibilityTargetIdentityKey;
      const visibilityAccess = visibilityGuard.check(visibilityTargetKey);
      if (!visibilityAccess.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibilityAccess.status,
          error: visibilityAccess.error,
          sessionKey: unresolvedDisplayKey,
        });
      }
      if (parseSessionThreadInfoFast(resolvedKey).threadId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error:
            "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const targetAdmission = await resolveCurrentInterSessionAdmission({
        cfg: admissionCfg,
        mainKey: admissionMainKey,
        requesterAgentId,
        requesterSessionKey: admissionRequesterKey,
        targetAgentId: explicitTargetAgentId,
        targetSessionKey: resolvedKey,
      });
      if (!targetAdmission.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: describeInterSessionAdmissionDenial(targetAdmission.reason),
          sessionKey: unresolvedDisplayKey,
        });
      }
      const targetAccess = targetAdmission.targetAccess;
      const targetAgentId = targetAccess.agentId;
      const targetSessionKey = targetAccess.canonicalKey;
      const revalidateBoundaryAdmission = async (params: {
        targetAgentId: string;
        targetSessionKey: string;
      }): Promise<boolean> => {
        const currentConfig = opts?.config ?? getRuntimeConfig();
        const currentContext = resolveSessionToolContext({
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
          config: currentConfig,
        });
        return (
          await resolveCurrentInterSessionAdmission({
            cfg: currentConfig,
            mainKey: currentContext.mainKey,
            requesterAgentId,
            requesterSessionKey: currentContext.effectiveRequesterKey,
            targetAgentId: params.targetAgentId,
            targetSessionKey: params.targetSessionKey,
          })
        ).allowed;
      };
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;

      const ensureConfig = opts?.config ?? getRuntimeConfig();
      const ensureContext = resolveSessionToolContext({
        agentSessionKey: opts?.agentSessionKey,
        sandboxed: opts?.sandboxed,
        config: ensureConfig,
      });
      const ensureAdmission = await resolveCurrentInterSessionAdmission({
        cfg: ensureConfig,
        mainKey: ensureContext.mainKey,
        requesterAgentId,
        requesterSessionKey: ensureContext.effectiveRequesterKey,
        targetAgentId,
        targetSessionKey,
      });
      if (!ensureAdmission.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: describeInterSessionAdmissionDenial(ensureAdmission.reason),
          sessionKey: unresolvedDisplayKey,
        });
      }
      const ensuredTargetSessionKey = ensureAdmission.targetAccess.canonicalKey;
      const ensuredTargetAgentId = ensureAdmission.targetAccess.agentId;
      const ensuredTargetGatewayAgentId =
        ensuredTargetSessionKey === "global" ? ensuredTargetAgentId : undefined;
      const ensuredTargetIdentitySessionKey =
        ensuredTargetSessionKey === "global"
          ? resolveAgentMainOwnershipKey({
              cfg: ensureConfig,
              agentId: ensuredTargetAgentId,
              mainKey: ensureContext.mainKey,
            })
          : ensuredTargetSessionKey;

      const ensuredSession = await ensureConfiguredAgentMainSession({
        agentId: ensuredTargetGatewayAgentId,
        cfg: ensureConfig,
        callGateway: gatewayCall,
        revalidateAdmission: () =>
          revalidateBoundaryAdmission({
            targetAgentId: ensuredTargetAgentId,
            targetSessionKey: ensuredTargetSessionKey,
          }),
        sessionKey: ensuredTargetSessionKey,
        mainKey: ensureContext.mainKey,
      });
      if (!ensuredSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: ensuredSession.status,
          error: ensuredSession.error,
          sessionKey: displayKey,
        });
      }

      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const sameSessionA2A =
        ensureAdmission.requesterIdentitySessionKey === ensuredTargetIdentitySessionKey;
      const isIsolatedCronRequester = isCronRunSessionKey(requesterSessionKey);
      const fallbackA2ASessionKey =
        timeoutSeconds === 0 && isIsolatedCronRequester
          ? resolveCronRunScopedFallbackSessionKey(displayKey)
          : undefined;

      // Capture the pre-run assistant snapshot before starting the nested run.
      // Fast in-process test doubles and short-circuit agent paths can finish
      // before we reach the post-run read, which would otherwise make the new
      // reply look like the baseline and hide it from the caller.
      // Fire-and-forget same-session sends still need this baseline because the
      // A2A follow-up may deliver directly to the source channel. Isolated cron
      // requesters also need it to avoid attributing a stale target reply.
      const baselineReply =
        timeoutSeconds !== 0
          ? await readLatestAssistantReplySnapshot({
              agentId: ensuredTargetGatewayAgentId,
              sessionKey: ensuredTargetSessionKey,
              limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
              callGateway: gatewayCall,
            })
          : sameSessionA2A || isIsolatedCronRequester
            ? await readLatestAssistantReplySnapshot({
                agentId: ensuredTargetGatewayAgentId,
                sessionKey: ensuredTargetSessionKey,
                limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                callGateway: gatewayCall,
              }).catch(() => undefined)
            : undefined;
      // Active-run delivery can fall back to the durable cron parent. Snapshot
      // that target before dispatch so a fast reply cannot become its baseline.
      const fallbackBaselineReply =
        fallbackA2ASessionKey && fallbackA2ASessionKey !== ensuredTargetSessionKey
          ? await readLatestAssistantReplySnapshot({
              sessionKey: fallbackA2ASessionKey,
              limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
              callGateway: gatewayCall,
            }).catch(() => undefined)
          : undefined;

      const maxPingPongTurns = resolvePingPongTurns(admissionCfg);

      const dispatchConfig = opts?.config ?? getRuntimeConfig();
      const dispatchContext = resolveSessionToolContext({
        agentSessionKey: opts?.agentSessionKey,
        sandboxed: opts?.sandboxed,
        config: dispatchConfig,
      });
      const dispatchAdmission = await resolveCurrentInterSessionAdmission({
        cfg: dispatchConfig,
        mainKey: dispatchContext.mainKey,
        requesterAgentId,
        requesterSessionKey: dispatchContext.effectiveRequesterKey,
        targetAgentId,
        targetSessionKey,
      });
      if (!dispatchAdmission.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error: describeInterSessionAdmissionDenial(dispatchAdmission.reason),
          sessionKey: unresolvedDisplayKey,
        });
      }
      const dispatchedRequesterIdentitySessionKey = dispatchAdmission.requesterIdentitySessionKey;
      const dispatchedTargetSessionKey = dispatchAdmission.targetAccess.canonicalKey;
      const dispatchedTargetAgentId = dispatchAdmission.targetAccess.agentId;
      const dispatchedTargetIdentitySessionKey =
        dispatchedTargetSessionKey === "global"
          ? resolveAgentMainOwnershipKey({
              cfg: dispatchConfig,
              agentId: dispatchedTargetAgentId,
              mainKey: dispatchContext.mainKey,
            })
          : dispatchedTargetSessionKey;
      const dispatchedTargetGatewayAgentId =
        dispatchedTargetSessionKey === "global" ? dispatchedTargetAgentId : undefined;
      // Parent-owned background children report through an existing result
      // path. Re-evaluate that skip from the same admission used for dispatch.
      const dispatchedTargetEntry = dispatchAdmission.targetAccess.entry;
      const dispatchedTargetAcpMeta = readAcpSessionMeta({
        sessionKey: dispatchedTargetSessionKey,
      });
      const dispatchedTargetEntryWithAcp =
        dispatchedTargetAcpMeta && dispatchedTargetEntry
          ? { ...dispatchedTargetEntry, acp: dispatchedTargetAcpMeta }
          : dispatchedTargetEntry;
      const skipAcpA2AFlow = isRequesterParentOfBackgroundAcpSession(
        dispatchedTargetEntryWithAcp,
        dispatchContext.effectiveRequesterKey,
      );
      const skipNativeParentA2AFlow =
        timeoutSeconds !== 0 &&
        isRequesterParentOfNativeSubagentSession({
          entry: dispatchedTargetEntry,
          acpMeta: dispatchedTargetAcpMeta,
          requesterSessionKey: dispatchContext.effectiveRequesterKey,
          targetSessionKey: dispatchedTargetSessionKey,
        });
      const skipA2AFlow = skipAcpA2AFlow || skipNativeParentA2AFlow;
      const delivery = skipA2AFlow
        ? ({ status: "skipped", mode: "announce" } as const)
        : ({ status: "pending", mode: "announce" } as const);
      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: dispatchedRequesterIdentitySessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
      });
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceSessionKey: dispatchAdmission.targetIsLiveOwned
          ? dispatchContext.effectiveRequesterKey
          : dispatchedRequesterIdentitySessionKey,
        sourceChannel: opts?.agentChannel,
        sourceTool: "sessions_send",
      };
      const sendParams = {
        message: annotateInterSessionPromptText(message, inputProvenance),
        ...(dispatchedTargetGatewayAgentId ? { agentId: dispatchedTargetGatewayAgentId } : {}),
        sessionKey: dispatchedTargetSessionKey,
        idempotencyKey,
        deliver: false,
        sourceReplyDeliveryMode: "message_tool_only" as const,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: resolveNestedAgentLaneForSession(dispatchedTargetSessionKey),
        extraSystemPrompt: agentMessageContext,
        inputProvenance,
      };
      const startA2AFlow = (
        roundOneReply?: string,
        waitRunId?: string,
        flowTargetSessionKey = dispatchedTargetSessionKey,
        flowDisplayKey = displayKey,
      ) => {
        if (skipA2AFlow) {
          return;
        }
        const flowBaseline =
          flowTargetSessionKey === fallbackA2ASessionKey ? fallbackBaselineReply : baselineReply;
        void runSessionsSendA2AFlow({
          targetGatewayAgentId: dispatchedTargetGatewayAgentId,
          targetSessionKey: flowTargetSessionKey,
          targetIdentitySessionKey:
            flowTargetSessionKey === dispatchedTargetSessionKey
              ? dispatchedTargetIdentitySessionKey
              : flowTargetSessionKey,
          displayKey: flowDisplayKey,
          message,
          announceTimeoutMs,
          // Cron runs are isolated jobs; target replies must not become new
          // requester turns, but the target-side announce still runs.
          maxPingPongTurns: isIsolatedCronRequester ? 0 : maxPingPongTurns,
          requesterSessionKey,
          requesterIdentitySessionKey: dispatchedRequesterIdentitySessionKey,
          requesterGatewayAgentId: requesterSessionKey === "global" ? requesterAgentId : undefined,
          requesterChannel,
          revalidateAdmission: async () => {
            const currentCfg = getRuntimeConfig();
            const currentContext = resolveSessionToolContext({
              agentSessionKey: opts?.agentSessionKey,
              sandboxed: opts?.sandboxed,
              config: currentCfg,
            });
            return (
              await resolveCurrentInterSessionAdmission({
                cfg: currentCfg,
                mainKey: currentContext.mainKey,
                requesterAgentId,
                requesterSessionKey: currentContext.effectiveRequesterKey,
                targetAgentId: dispatchedTargetAgentId,
                targetSessionKey: flowTargetSessionKey,
              })
            ).allowed;
          },
          baseline: flowBaseline,
          roundOneReply,
          waitRunId,
        });
      };

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
          revalidateAdmission: (currentTargetSessionKey) =>
            revalidateBoundaryAdmission({
              targetAgentId: dispatchedTargetAgentId,
              targetSessionKey: currentTargetSessionKey,
            }),
          deliveryTimeoutMs: announceTimeoutMs,
          allowActiveRunQueueDelivery: true,
        });
        if (!start.ok) {
          return start.result;
        }
        runId = start.runId;
        if (!start.activeRunQueue) {
          startA2AFlow(undefined, runId, start.a2aSessionKey, start.a2aDisplayKey);
        }
        return jsonResult({
          runId,
          status: "accepted",
          sessionKey: displayKey,
          delivery,
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
        revalidateAdmission: (currentTargetSessionKey) =>
          revalidateBoundaryAdmission({
            targetAgentId: dispatchedTargetAgentId,
            targetSessionKey: currentTargetSessionKey,
          }),
        deliveryTimeoutMs: announceTimeoutMs,
      });
      if (!start.ok) {
        return start.result;
      }
      runId = start.runId;
      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        runId,
        agentId: dispatchedTargetGatewayAgentId,
        sessionKey: dispatchedTargetSessionKey,
        timeoutMs,
        limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
        baseline: baselineReply,
        callGateway: gatewayCall,
      });

      if (result.status === "timeout") {
        if (isPendingErrorAgentWaitTimeout(result)) {
          startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "timeout",
            error: result.error,
            sentBeforeError: true,
            sessionKey: displayKey,
            delivery,
          });
        }
        if (!isTerminalAgentWaitTimeout(result)) {
          startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
            delivery,
          });
        }
        return jsonResult({
          runId,
          status: "timeout",
          error: result.error,
          sentBeforeError: true,
          sessionKey: displayKey,
        });
      }
      if (result.status === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: result.error ?? "agent error",
          sentBeforeError: true,
          sessionKey: displayKey,
        });
      }
      const reply = result.replyText;
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        delivery,
      });
    },
  };
}
