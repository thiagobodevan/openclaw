import { describe, expect, it } from "vitest";
import { createNpmTelegramPackageConsumptionReceipt } from "../../scripts/npm-telegram-package-consumption.mjs";

const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const rootSha256 = "c".repeat(64);
const aiSha256 = "d".repeat(64);
const artifactDigest = "e".repeat(64);

function manifest() {
  return {
    version: 1,
    releaseTag: "v2026.7.1-beta.3",
    releaseSha: targetSha,
    npmDistTag: "beta",
    packageName: "openclaw",
    packageVersion: "2026.7.1-beta.3",
    tarballName: "openclaw-2026.7.1-beta.3.tgz",
    tarballSha256: rootSha256,
    dependencyTarballs: [
      {
        packageName: "@openclaw/ai",
        packageVersion: "2026.7.1-beta.3",
        tarballName: "openclaw-ai-2026.7.1-beta.3.tgz",
        tarballSha256: aiSha256,
      },
    ],
  };
}

function environment(overrides: Record<string, string> = {}) {
  return {
    ACTUAL_HARNESS_SHA: workflowSha,
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "456",
    INPUT_SCENARIO: "telegram/text-reply",
    OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: "mock-openai",
    PACKAGE_ARTIFACT_DIGEST: artifactDigest,
    PACKAGE_ARTIFACT_ID: "789",
    PACKAGE_ARTIFACT_NAME: "openclaw-npm-publish-byte-123-4",
    PACKAGE_ARTIFACT_RUN_ATTEMPT: "4",
    PACKAGE_ARTIFACT_RUN_ID: "123",
    PACKAGE_FILE_NAME: "openclaw-2026.7.1-beta.3.tgz",
    PACKAGE_SHA256: rootSha256,
    PACKAGE_SOURCE_SHA: targetSha,
    PACKAGE_VERSION: "2026.7.1-beta.3",
    TRUSTED_WORKFLOW_SHA: workflowSha,
    ...overrides,
  };
}

describe("npm Telegram package consumption receipt", () => {
  it("binds the trusted workflow and complete immutable package artifact tuple", () => {
    expect(
      createNpmTelegramPackageConsumptionReceipt({
        environment: environment(),
        manifest: manifest(),
      }),
    ).toEqual({
      schemaVersion: 1,
      workflow: {
        runId: 456,
        runAttempt: 2,
        path: ".github/workflows/npm-telegram-beta-e2e.yml",
        sha: workflowSha,
      },
      targetSha,
      packageVersion: "2026.7.1-beta.3",
      packageArtifact: {
        runId: 123,
        runAttempt: 4,
        id: 789,
        name: "openclaw-npm-publish-byte-123-4",
        digest: `sha256:${artifactDigest}`,
        root: {
          name: "openclaw-2026.7.1-beta.3.tgz",
          sha256: rootSha256,
        },
        ai: {
          name: "openclaw-ai-2026.7.1-beta.3.tgz",
          sha256: aiSha256,
        },
      },
      qa: {
        providerMode: "mock-openai",
        scenario: "telegram/text-reply",
        conclusion: "success",
      },
    });
  });

  it.each([
    [
      "a moving or unrelated harness checkout",
      { ACTUAL_HARNESS_SHA: "f".repeat(40) },
      "harness does not match the trusted workflow SHA",
    ],
    [
      "a publication alias without the exact producer attempt",
      { PACKAGE_ARTIFACT_NAME: "openclaw-npm-publish-byte-123-3" },
      "PACKAGE_ARTIFACT_NAME must equal openclaw-npm-publish-byte-123-4",
    ],
    [
      "an artifact digest with a sha256 prefix at the input boundary",
      { PACKAGE_ARTIFACT_DIGEST: `sha256:${artifactDigest}` },
      "PACKAGE_ARTIFACT_DIGEST must be a lowercase SHA-256",
    ],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() =>
      createNpmTelegramPackageConsumptionReceipt({
        environment: environment(overrides),
        manifest: manifest(),
      }),
    ).toThrow(message);
  });

  it("rejects manifest identity drift", () => {
    const mismatched = manifest();
    mismatched.releaseSha = "f".repeat(40);

    expect(() =>
      createNpmTelegramPackageConsumptionReceipt({
        environment: environment(),
        manifest: mismatched,
      }),
    ).toThrow("npm Telegram package consumption manifest identity mismatch");
  });
});
