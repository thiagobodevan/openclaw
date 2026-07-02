import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isConversationIdentityPersistedAgentCurrent } from "../routing/conversation-identity.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { getSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { isLiveUnendedSubagentRun } from "./subagent-run-liveness.js";

type SessionTargetRouteEntry = Pick<SessionEntry, "acp" | "parentSessionKey" | "spawnedBy">;

export function isRequesterParentOfNativeSubagentSession(params: {
  entry: SessionTargetRouteEntry | null | undefined;
  acpMeta?: unknown;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
}): boolean {
  if (
    !params.entry ||
    params.acpMeta ||
    params.entry.acp ||
    !isSubagentSessionKey(params.targetSessionKey)
  ) {
    return false;
  }
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
  const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}

export function isLiveOwnedSessionTarget(params: {
  requesterSessionKey?: string;
  targetSessionKey: string;
}): boolean {
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const run = getSubagentRunByChildSessionKey(params.targetSessionKey);
  if (!run || !isLiveUnendedSubagentRun(run)) {
    return false;
  }
  return (
    requester === normalizeOptionalString(run.requesterSessionKey) ||
    requester === normalizeOptionalString(run.controllerSessionKey)
  );
}

export function isConfiguredOrLiveOwnedSessionTarget(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  targetSessionKey: string;
}): boolean {
  const parsed = parseAgentSessionKey(params.targetSessionKey);
  if (!parsed) {
    return true;
  }
  return (
    isConversationIdentityPersistedAgentCurrent({
      config: params.cfg,
      agentId: parsed.agentId,
    }) || isLiveOwnedSessionTarget(params)
  );
}
