import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import {
  patchSqliteSessionEntry,
  resolveSqliteSessionTranscriptRuntimeTarget,
  type SqliteSessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

/** Identifies a run transcript target without naming the current storage artifact. */
export type AgentRunSessionTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storageKind?: "file" | "sqlite";
  storePath?: string;
  threadId?: string | number;
};

/** Target resolved from storage-neutral run identity for current run internals. */
export type ResolvedAgentRunSessionTarget =
  | SessionTranscriptRuntimeTarget
  | SqliteSessionTranscriptRuntimeTarget;

/** Resolves the active file-backed target used by current run/session internals. */
export async function resolveAgentRunSessionTarget(params: {
  agentId?: string;
  config?: OpenClawConfig;
  sessionFile?: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: AgentRunSessionTarget;
}): Promise<ResolvedAgentRunSessionTarget> {
  const sessionTarget = params.sessionTarget;
  const agentId = normalizeOptionalString(sessionTarget?.agentId) ?? params.agentId;
  const sessionId = normalizeOptionalString(sessionTarget?.sessionId) ?? params.sessionId;
  const sessionKey = normalizeOptionalString(sessionTarget?.sessionKey) ?? params.sessionKey;
  const effectiveAgentId = agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const sessionFile = normalizeOptionalString(params.sessionFile);
  const storePath =
    normalizeOptionalString(sessionTarget?.storePath) ??
    resolveStorePath(params.config?.session?.store, { agentId: effectiveAgentId });
  const useSqliteSessionTarget = shouldUseSqliteSessionTarget({ sessionTarget, storePath });
  if (sessionFile && !useSqliteSessionTarget) {
    return {
      agentId: effectiveAgentId ?? "",
      sessionFile,
      sessionId,
      sessionKey: sessionKey ?? "",
      storageKind: "file",
      targetKind: "active-session-file",
    };
  }
  if (!sessionKey) {
    throw new Error(`Cannot resolve run session target without a session key: ${sessionId}`);
  }
  const scope = {
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
    sessionId,
    sessionKey,
    storePath,
    ...(sessionTarget?.threadId !== undefined ? { threadId: sessionTarget.threadId } : {}),
  };
  if (useSqliteSessionTarget) {
    const target = await resolveSqliteSessionTranscriptRuntimeTarget(scope);
    const activeSessionFile = resolveCurrentSqliteEmbeddedRunSessionFile(
      target.sqlitePath,
      sessionFile,
    );
    return activeSessionFile ? { ...target, sessionFile: activeSessionFile } : target;
  }
  return await resolveSessionTranscriptRuntimeTarget({
    ...scope,
  });
}

/** Persists the current active artifact for storage-neutral run/session targets. */
export async function persistAgentRunSessionTargetIdentity(params: {
  sessionFile: string;
  sessionId: string;
  target: ResolvedAgentRunSessionTarget;
}): Promise<void> {
  if (params.target.storageKind !== "sqlite") {
    return;
  }
  const now = Date.now();
  await patchSqliteSessionEntry(
    {
      agentId: params.target.agentId,
      sessionKey: params.target.sessionKey,
      storePath: params.target.sqlitePath,
    },
    () => ({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      updatedAt: now,
    }),
    {
      fallbackEntry: {
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        updatedAt: now,
      },
    },
  );
}

function shouldUseSqliteSessionTarget(params: {
  sessionTarget?: AgentRunSessionTarget;
  storePath: string;
}): boolean {
  if (params.sessionTarget?.storageKind === "sqlite") {
    return true;
  }
  if (params.sessionTarget?.storageKind === "file") {
    return false;
  }
  return params.storePath.trim().toLowerCase().endsWith(".sqlite");
}

function resolveCurrentSqliteEmbeddedRunSessionFile(
  sqlitePath: string,
  sessionFile: string | undefined,
): string | undefined {
  const trimmed = sessionFile?.trim();
  if (!trimmed) {
    return undefined;
  }
  const artifactDir = path.resolve(path.dirname(sqlitePath), "embedded-run-session-files");
  const candidate = path.resolve(trimmed);
  const relative = path.relative(artifactDir, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? trimmed
    : undefined;
}

/** Applies identity fields from the explicit target before legacy backfills run. */
export function applyAgentRunSessionTargetIdentity<
  T extends {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    sessionTarget?: AgentRunSessionTarget;
  },
>(params: T): T {
  const target = params.sessionTarget;
  if (!target) {
    return params;
  }
  return {
    ...params,
    agentId: normalizeOptionalString(target.agentId) ?? params.agentId,
    sessionId: normalizeOptionalString(target.sessionId) ?? params.sessionId,
    sessionKey: normalizeOptionalString(target.sessionKey) ?? params.sessionKey,
  };
}
