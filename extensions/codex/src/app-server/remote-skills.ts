/** Materializes OpenClaw skills for Codex app-servers running on a remote workspace mirror. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { syncSkillsToWorkspace } from "openclaw/plugin-sdk/skills-runtime";
import { mapCodexAppServerRemoteWorkspacePath } from "./dynamic-tool-build.js";

const CODEX_REMOTE_SKILLS_DIR = path.join(".openclaw", "codex");

type SkillsSnapshot = EmbeddedRunAttemptParams["skillsSnapshot"];

type MaterializedSkillsCacheEntry = {
  fingerprint: string;
  prompt: Promise<string>;
};

const materializedSkillsByWorkspace = new Map<string, MaterializedSkillsCacheEntry>();

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function skillsSnapshotFingerprint(
  snapshot: NonNullable<SkillsSnapshot>,
  remoteWorkspaceRoot: string,
): string {
  return JSON.stringify({
    remoteWorkspaceRoot,
    version: snapshot.version ?? null,
    promptFormatVersion: snapshot.promptFormatVersion ?? null,
    prompt: snapshot.prompt,
    skills: snapshot.resolvedSkills?.map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
    })),
  });
}

async function makeSkillDirectoriesWritable(root: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return;
  }
  await fs.chmod(root, 0o755);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeSkillDirectoriesWritable(path.join(root, entry.name));
    }
  }
}

async function makeSkillTreeReadOnly(root: string): Promise<void> {
  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink()) {
    return;
  }
  if (!stats.isDirectory()) {
    const executable = (stats.mode & 0o111) !== 0;
    await fs.chmod(root, executable ? 0o555 : 0o444);
    return;
  }
  for (const entry of await fs.readdir(root)) {
    await makeSkillTreeReadOnly(path.join(root, entry));
  }
  await fs.chmod(root, 0o555);
}

function rewriteSkillLocations(
  prompt: string,
  paths: Array<{ skillName: string; remoteReadPath: string }>,
): string {
  const pathByEscapedName = new Map(
    paths.map((entry) => [escapeXml(entry.skillName), escapeXml(entry.remoteReadPath)]),
  );
  return prompt.replace(/<skill>[\s\S]*?<\/skill>/giu, (block) => {
    const name = block.match(/<name>([\s\S]*?)<\/name>/iu)?.[1];
    const remoteReadPath = name ? pathByEscapedName.get(name) : undefined;
    return remoteReadPath
      ? block.replace(/<location>[\s\S]*?<\/location>/iu, `<location>${remoteReadPath}</location>`)
      : block;
  });
}

async function materializeCodexRemoteSkills(params: {
  snapshot: NonNullable<SkillsSnapshot>;
  localWorkspaceRoot: string;
  remoteWorkspaceRoot: string;
  config: EmbeddedRunAttemptParams["config"];
  agentId: string;
}): Promise<string> {
  const targetWorkspaceDir = path.join(params.localWorkspaceRoot, CODEX_REMOTE_SKILLS_DIR);
  const targetSkillsDir = path.join(targetWorkspaceDir, "skills");
  await makeSkillDirectoriesWritable(targetSkillsDir);
  const paths = await syncSkillsToWorkspace({
    sourceWorkspaceDir: params.localWorkspaceRoot,
    targetWorkspaceDir,
    config: params.config,
    skillFilter: params.snapshot.resolvedSkills?.map((skill) => skill.name),
    agentId: params.agentId,
  });
  await makeSkillTreeReadOnly(targetSkillsDir);
  return rewriteSkillLocations(
    params.snapshot.prompt,
    paths.map((entry) => ({
      skillName: entry.skillName,
      remoteReadPath: mapCodexAppServerRemoteWorkspacePath({
        value: entry.readPath,
        localWorkspaceRoot: params.localWorkspaceRoot,
        remoteWorkspaceRoot: params.remoteWorkspaceRoot,
      }),
    })),
  );
}

export async function resolveCodexRemoteSkillsPrompt(params: {
  attempt: EmbeddedRunAttemptParams;
  localWorkspaceRoot: string;
  remoteWorkspaceRoot?: string;
  agentId: string;
}): Promise<string | undefined> {
  const snapshot = params.attempt.skillsSnapshot;
  if (!snapshot?.prompt?.trim() || !params.remoteWorkspaceRoot) {
    return snapshot?.prompt;
  }

  const fingerprint = skillsSnapshotFingerprint(snapshot, params.remoteWorkspaceRoot);
  const existing = materializedSkillsByWorkspace.get(params.localWorkspaceRoot);
  if (existing?.fingerprint === fingerprint) {
    return await existing.prompt;
  }

  const prompt = materializeCodexRemoteSkills({
    snapshot,
    localWorkspaceRoot: params.localWorkspaceRoot,
    remoteWorkspaceRoot: params.remoteWorkspaceRoot,
    config: params.attempt.config,
    agentId: params.agentId,
  }).catch((error: unknown) => {
    const current = materializedSkillsByWorkspace.get(params.localWorkspaceRoot);
    if (current?.fingerprint === fingerprint) {
      materializedSkillsByWorkspace.delete(params.localWorkspaceRoot);
    }
    embeddedAgentLog.warn("failed to materialize skills for remote Codex app-server", {
      workspaceDir: params.localWorkspaceRoot,
      error: error instanceof Error ? error.message : String(error),
    });
    return snapshot.prompt;
  });
  materializedSkillsByWorkspace.set(params.localWorkspaceRoot, { fingerprint, prompt });
  return await prompt;
}

export const testing = {
  makeSkillDirectoriesWritable,
  makeSkillTreeReadOnly,
  rewriteSkillLocations,
};
