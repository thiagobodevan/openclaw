import { describe, expect, it } from "vitest";
import {
  npmPreflightArtifactName,
  resolveNpmPreflightArtifactTuple,
  validateNpmPreflightArtifactFiles,
} from "../../scripts/openclaw-npm-preflight-artifact.mjs";

const repository = "openclaw/openclaw";
const workflowSha = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;

function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    run_attempt: 4,
    name: "OpenClaw NPM Release",
    path: ".github/workflows/openclaw-npm-release.yml",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_branch: "main",
    head_sha: workflowSha,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 789,
    name: "openclaw-npm-publish-byte-123-4",
    size_in_bytes: 1024,
    expired: false,
    digest: artifactDigest,
    workflow_run: { id: 123, head_sha: workflowSha },
    ...overrides,
  };
}

function inventory(artifacts = [artifact()], totalCount = artifacts.length) {
  return { total_count: totalCount, artifacts };
}

function resolveTuple(runOverrides: Record<string, unknown> = {}, artifacts = inventory()) {
  return resolveNpmPreflightArtifactTuple({
    workflowRun: workflowRun(runOverrides),
    artifactInventory: artifacts,
    expectedRepository: repository,
    expectedRunId: "123",
    expectedRunAttempt: "4",
  });
}

function artifactFiles() {
  const files = new Map<string, Buffer>();
  for (const name of [
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
    "openclaw-2026.7.1-beta.3.tgz",
    "openclaw-ai-2026.7.1-beta.3.tgz",
  ]) {
    files.set(name, Buffer.from(name));
  }
  return files;
}

describe("OpenClaw npm preflight artifact", () => {
  it("binds one attempt-qualified artifact to the exact successful producer tuple", () => {
    expect(npmPreflightArtifactName(123, 4)).toBe("openclaw-npm-publish-byte-123-4");
    expect(resolveTuple()).toEqual({
      artifactDigest,
      artifactId: 789,
      artifactName: "openclaw-npm-publish-byte-123-4",
      artifactSizeBytes: 1024,
      repository,
      runAttempt: 4,
      runId: 123,
      workflowHeadBranch: "main",
      workflowSha,
    });
  });

  it.each([
    ["another attempt", { run_attempt: 5 }, inventory(), "approved run tuple"],
    ["an incomplete artifact page", {}, inventory([artifact()], 2), "inventory is incomplete"],
    [
      "duplicate exact-name artifacts",
      {},
      inventory([artifact(), artifact({ id: 790 })]),
      "exactly one openclaw-npm-publish-byte-123-4",
    ],
    [
      "a mutable tag alias",
      {},
      inventory([artifact({ name: "openclaw-npm-preflight-v2026.7.1-beta.3" })]),
      "exactly one openclaw-npm-publish-byte-123-4",
    ],
    [
      "an invalid artifact digest",
      {},
      inventory([artifact({ digest: "b".repeat(64) })]),
      "digest must be sha256",
    ],
  ])("rejects %s", (_label, runOverrides, artifacts, message) => {
    expect(() => resolveTuple(runOverrides, artifacts)).toThrow(message);
  });

  it("accepts only the canonical bounded npm publish inventory", () => {
    expect(validateNpmPreflightArtifactFiles(artifactFiles())).toBeInstanceOf(Map);

    const missing = artifactFiles();
    missing.delete("preflight-manifest.json");
    expect(() => validateNpmPreflightArtifactFiles(missing)).toThrow("exactly 17 files");

    const extra = artifactFiles();
    extra.delete("release-tag.txt");
    extra.set("unexpected.txt", Buffer.from("unexpected"));
    expect(() => validateNpmPreflightArtifactFiles(extra)).toThrow("missing release-tag.txt");
  });
});
