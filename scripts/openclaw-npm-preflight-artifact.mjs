#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES,
  DEFAULT_MAX_ACTIONS_ARTIFACT_EXPANDED_BYTES,
  readPublicationArtifactArchive,
} from "./lib/actions-artifact-archive.mjs";

const WORKFLOW_NAME = "OpenClaw NPM Release";
const WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";
const ARTIFACT_PREFIX = "openclaw-npm-publish-byte";
const SHA_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ROOT_TARBALL_RE = /^openclaw-(?!ai-)[0-9A-Za-z][0-9A-Za-z._-]*\.tgz$/u;
const AI_TARBALL_RE = /^openclaw-ai-[0-9A-Za-z][0-9A-Za-z._-]*\.tgz$/u;
const FIXED_FILES = new Set([
  "ai-runtime-SHA256SUMS",
  "preflight-manifest.json",
  "release-npm-dist-tag.txt",
  "release-sha.txt",
  "release-tag.txt",
  "dependency-evidence/dependency-changes-report.json",
  "dependency-evidence/dependency-changes-report.md",
  "dependency-evidence/dependency-evidence-manifest.json",
  "dependency-evidence/dependency-evidence-summary.md",
  "dependency-evidence/dependency-ownership-surface-report.json",
  "dependency-evidence/dependency-ownership-surface-report.md",
  "dependency-evidence/dependency-vulnerability-gate.json",
  "dependency-evidence/dependency-vulnerability-gate.md",
  "dependency-evidence/transitive-manifest-risk-report.json",
  "dependency-evidence/transitive-manifest-risk-report.md",
]);
const EXPECTED_FILE_COUNT = FIXED_FILES.size + 2;

function fail(message) {
  throw new Error(message);
}

function requirePositiveInteger(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    fail(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireRepository(value) {
  const repository = requireString(value, "GitHub repository");
  if (!REPOSITORY_RE.test(repository)) {
    fail("GitHub repository must be owner/name");
  }
  return repository;
}

function requireSha(value, label) {
  const sha = requireString(value, label);
  if (!SHA_RE.test(sha)) {
    fail(`${label} must be a full lowercase commit SHA`);
  }
  return sha;
}

export function npmPreflightArtifactName(runId, runAttempt) {
  return `${ARTIFACT_PREFIX}-${requirePositiveInteger(runId, "preflight run ID")}-${requirePositiveInteger(runAttempt, "preflight run attempt")}`;
}

export function resolveNpmPreflightArtifactTuple({
  workflowRun,
  artifactInventory,
  expectedRepository,
  expectedRunId,
  expectedRunAttempt,
}) {
  const repository = requireRepository(expectedRepository);
  const runId = requirePositiveInteger(expectedRunId, "preflight run ID");
  const runAttempt = requirePositiveInteger(expectedRunAttempt, "preflight run attempt");
  const workflowSha = requireSha(workflowRun?.head_sha, "preflight workflow SHA");
  const workflowHeadBranch = requireString(
    workflowRun?.head_branch,
    "preflight workflow head branch",
  );
  if (
    workflowRun?.id !== runId ||
    workflowRun?.run_attempt !== runAttempt ||
    workflowRun?.name !== WORKFLOW_NAME ||
    workflowRun?.path !== WORKFLOW_PATH ||
    workflowRun?.repository?.full_name !== repository ||
    workflowRun?.head_repository?.full_name !== repository ||
    workflowRun?.event !== "workflow_dispatch" ||
    workflowRun?.status !== "completed" ||
    workflowRun?.conclusion !== "success"
  ) {
    fail("npm preflight workflow attempt does not match the approved run tuple");
  }
  if (
    !artifactInventory ||
    typeof artifactInventory !== "object" ||
    Array.isArray(artifactInventory) ||
    !Number.isSafeInteger(artifactInventory.total_count) ||
    artifactInventory.total_count < 0 ||
    !Array.isArray(artifactInventory.artifacts) ||
    artifactInventory.total_count !== artifactInventory.artifacts.length
  ) {
    fail("npm preflight artifact inventory is incomplete");
  }

  const artifactName = npmPreflightArtifactName(runId, runAttempt);
  const matches = artifactInventory.artifacts.filter(
    (artifact) => artifact?.name === artifactName && artifact?.expired === false,
  );
  if (matches.length !== 1) {
    fail(`npm preflight attempt must contain exactly one ${artifactName} artifact`);
  }
  const [artifact] = matches;
  const artifactId = requirePositiveInteger(artifact.id, "npm preflight artifact ID");
  const artifactSizeBytes = requirePositiveInteger(
    artifact.size_in_bytes,
    "npm preflight artifact size",
  );
  if (artifactSizeBytes > DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES) {
    fail("npm preflight artifact exceeds the approved archive byte limit");
  }
  const artifactDigest = requireString(artifact.digest, "npm preflight artifact digest");
  if (!DIGEST_RE.test(artifactDigest)) {
    fail("npm preflight artifact digest must be sha256:<64 lowercase hex>");
  }
  if (artifact.workflow_run?.id !== runId || artifact.workflow_run?.head_sha !== workflowSha) {
    fail("npm preflight artifact metadata does not match its workflow attempt");
  }

  return {
    artifactDigest,
    artifactId,
    artifactName,
    artifactSizeBytes,
    repository,
    runAttempt,
    runId,
    workflowHeadBranch,
    workflowSha,
  };
}

function isAllowedFile(name) {
  return FIXED_FILES.has(name) || ROOT_TARBALL_RE.test(name) || AI_TARBALL_RE.test(name);
}

function maxEntryBytes(name) {
  return name.endsWith(".tgz") ? DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES : 16 * 1024 * 1024;
}

export function validateNpmPreflightArtifactFiles(files) {
  if (!(files instanceof Map) || files.size !== EXPECTED_FILE_COUNT) {
    fail(`npm preflight artifact must contain exactly ${EXPECTED_FILE_COUNT} files`);
  }
  for (const name of FIXED_FILES) {
    if (!files.has(name)) {
      fail(`npm preflight artifact is missing ${name}`);
    }
  }
  const names = [...files.keys()];
  if (
    names.filter((name) => ROOT_TARBALL_RE.test(name)).length !== 1 ||
    names.filter((name) => AI_TARBALL_RE.test(name)).length !== 1 ||
    names.some((name) => !isAllowedFile(name))
  ) {
    fail("npm preflight artifact file inventory is invalid");
  }
  return files;
}

export function writeNpmPreflightArtifactFiles(files, outputDir) {
  validateNpmPreflightArtifactFiles(files);
  const destination = resolve(requireString(outputDir, "npm preflight artifact output directory"));
  if (destination === parse(destination).root) {
    fail("npm preflight artifact output directory must not be a filesystem root");
  }
  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of files) {
    const target = resolve(destination, name);
    if (!target.startsWith(`${destination}/`)) {
      fail(`npm preflight artifact path escapes output directory: ${name}`);
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
  return destination;
}

export async function downloadNpmPreflightArtifact({ token, tuple, outputDir, fetchImpl }) {
  const downloaded = await readPublicationArtifactArchive({
    token,
    fetchImpl,
    expected: {
      ...tuple,
      runStatePolicy: "completed-success",
      workflowEvent: "workflow_dispatch",
      workflowPath: WORKFLOW_PATH,
    },
    archivePolicy: {
      minEntries: EXPECTED_FILE_COUNT,
      maxEntries: EXPECTED_FILE_COUNT,
      maxArchiveBytes: DEFAULT_MAX_ACTIONS_ARTIFACT_BYTES,
      maxExpandedBytes: DEFAULT_MAX_ACTIONS_ARTIFACT_EXPANDED_BYTES,
      allowPath: isAllowedFile,
      maxCompressedEntryBytes: maxEntryBytes,
      maxEntryBytes,
    },
  });
  writeNpmPreflightArtifactFiles(downloaded.files, outputDir);
  return downloaded;
}

function tupleFromEnvironment(environment) {
  return {
    artifactDigest: requireString(
      environment.PREFLIGHT_ARTIFACT_DIGEST,
      "PREFLIGHT_ARTIFACT_DIGEST",
    ),
    artifactId: requirePositiveInteger(environment.PREFLIGHT_ARTIFACT_ID, "PREFLIGHT_ARTIFACT_ID"),
    artifactName: requireString(environment.PREFLIGHT_ARTIFACT_NAME, "PREFLIGHT_ARTIFACT_NAME"),
    artifactSizeBytes: requirePositiveInteger(
      environment.PREFLIGHT_ARTIFACT_SIZE_BYTES,
      "PREFLIGHT_ARTIFACT_SIZE_BYTES",
    ),
    repository: requireRepository(environment.GITHUB_REPOSITORY),
    runAttempt: requirePositiveInteger(environment.PREFLIGHT_RUN_ATTEMPT, "PREFLIGHT_RUN_ATTEMPT"),
    runId: requirePositiveInteger(environment.PREFLIGHT_RUN_ID, "PREFLIGHT_RUN_ID"),
    workflowHeadBranch: requireString(
      environment.PREFLIGHT_WORKFLOW_HEAD_BRANCH,
      "PREFLIGHT_WORKFLOW_HEAD_BRANCH",
    ),
    workflowSha: requireSha(environment.PREFLIGHT_WORKFLOW_SHA, "PREFLIGHT_WORKFLOW_SHA"),
  };
}

function writeGithubOutputs(path, tuple) {
  const lines = [
    ["artifact_digest", tuple.artifactDigest],
    ["artifact_id", tuple.artifactId],
    ["artifact_name", tuple.artifactName],
    ["artifact_size_bytes", tuple.artifactSizeBytes],
    ["run_attempt", tuple.runAttempt],
    ["run_id", tuple.runId],
    ["workflow_head_branch", tuple.workflowHeadBranch],
    ["workflow_sha", tuple.workflowSha],
  ];
  appendFileSync(path, `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...args] = argv;
  if (command === "resolve" && args.length === 3) {
    const [runPath, inventoryPath, githubOutput] = args;
    const tuple = resolveNpmPreflightArtifactTuple({
      workflowRun: JSON.parse(readFileSync(runPath, "utf8")),
      artifactInventory: JSON.parse(readFileSync(inventoryPath, "utf8")),
      expectedRepository: environment.GITHUB_REPOSITORY,
      expectedRunId: environment.PREFLIGHT_RUN_ID,
      expectedRunAttempt: environment.PREFLIGHT_RUN_ATTEMPT,
    });
    writeGithubOutputs(githubOutput, tuple);
    return;
  }
  if (command === "download" && args.length === 1) {
    await downloadNpmPreflightArtifact({
      token: requireString(environment.GH_TOKEN, "GH_TOKEN"),
      tuple: tupleFromEnvironment(environment),
      outputDir: args[0],
    });
    return;
  }
  fail(
    "usage: openclaw-npm-preflight-artifact.mjs resolve <run.json> <artifacts.json> <github-output> | download <output-dir>",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
