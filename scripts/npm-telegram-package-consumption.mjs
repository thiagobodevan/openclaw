#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function requireRecord(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function requireInteger(name, value) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    fail(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${name} must be a safe integer`);
  }
  return parsed;
}

function requireSha256(name, value) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) {
    fail(`${name} must be a lowercase SHA-256`);
  }
  return value;
}

function requireSha(name, value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) {
    fail(`${name} must be a lowercase commit SHA`);
  }
  return value;
}

function requireString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

function requireTarballName(name, value) {
  const tarballName = requireString(name, value);
  if (
    tarballName !== path.basename(tarballName) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(tarballName)
  ) {
    fail(`${name} must be a basename-only npm tarball filename`);
  }
  return tarballName;
}

export function createNpmTelegramPackageConsumptionReceipt({ environment, manifest }) {
  const preflight = requireRecord("npm preflight manifest", manifest);
  const dependencies = Array.isArray(preflight.dependencyTarballs)
    ? preflight.dependencyTarballs
    : [];
  if (dependencies.length !== 1) {
    fail("npm Telegram package consumption requires exactly one dependency tarball");
  }
  const ai = requireRecord("@openclaw/ai dependency tarball", dependencies[0]);
  if (ai.packageName !== "@openclaw/ai") {
    fail("npm Telegram package consumption requires the @openclaw/ai dependency tarball");
  }

  const producerRunId = requireInteger(
    "PACKAGE_ARTIFACT_RUN_ID",
    environment.PACKAGE_ARTIFACT_RUN_ID,
  );
  const producerRunAttempt = requireInteger(
    "PACKAGE_ARTIFACT_RUN_ATTEMPT",
    environment.PACKAGE_ARTIFACT_RUN_ATTEMPT,
  );
  const artifactName = requireString("PACKAGE_ARTIFACT_NAME", environment.PACKAGE_ARTIFACT_NAME);
  const expectedArtifactName = `openclaw-npm-publish-byte-${producerRunId}-${producerRunAttempt}`;
  if (artifactName !== expectedArtifactName) {
    fail(`PACKAGE_ARTIFACT_NAME must equal ${expectedArtifactName}`);
  }

  const targetSha = requireSha("PACKAGE_SOURCE_SHA", environment.PACKAGE_SOURCE_SHA);
  const packageVersion = requireString("PACKAGE_VERSION", environment.PACKAGE_VERSION);
  const rootTarballName = requireTarballName("PACKAGE_FILE_NAME", environment.PACKAGE_FILE_NAME);
  const rootTarballSha256 = requireSha256("PACKAGE_SHA256", environment.PACKAGE_SHA256);
  if (
    preflight.version !== 1 ||
    preflight.packageName !== "openclaw" ||
    preflight.releaseSha !== targetSha ||
    preflight.packageVersion !== packageVersion ||
    preflight.tarballName !== rootTarballName ||
    preflight.tarballSha256 !== rootTarballSha256 ||
    ai.packageVersion !== packageVersion
  ) {
    fail("npm Telegram package consumption manifest identity mismatch");
  }

  const trustedWorkflowSha = requireSha("TRUSTED_WORKFLOW_SHA", environment.TRUSTED_WORKFLOW_SHA);
  const actualHarnessSha = requireSha("ACTUAL_HARNESS_SHA", environment.ACTUAL_HARNESS_SHA);
  if (actualHarnessSha !== trustedWorkflowSha) {
    fail("npm Telegram package consumption harness does not match the trusted workflow SHA");
  }

  const providerMode = requireString(
    "OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE",
    environment.OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE,
  );
  if (providerMode !== "mock-openai" && providerMode !== "live-frontier") {
    fail("OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE must be mock-openai or live-frontier");
  }
  const scenario = environment.INPUT_SCENARIO ?? "";
  if (typeof scenario !== "string") {
    fail("INPUT_SCENARIO must be a string");
  }

  return {
    schemaVersion: 1,
    workflow: {
      runId: requireInteger("GITHUB_RUN_ID", environment.GITHUB_RUN_ID),
      runAttempt: requireInteger("GITHUB_RUN_ATTEMPT", environment.GITHUB_RUN_ATTEMPT),
      path: ".github/workflows/npm-telegram-beta-e2e.yml",
      sha: trustedWorkflowSha,
    },
    targetSha,
    packageVersion,
    packageArtifact: {
      runId: producerRunId,
      runAttempt: producerRunAttempt,
      id: requireInteger("PACKAGE_ARTIFACT_ID", environment.PACKAGE_ARTIFACT_ID),
      name: artifactName,
      digest: `sha256:${requireSha256(
        "PACKAGE_ARTIFACT_DIGEST",
        environment.PACKAGE_ARTIFACT_DIGEST,
      )}`,
      root: {
        name: rootTarballName,
        sha256: rootTarballSha256,
      },
      ai: {
        name: requireTarballName("@openclaw/ai tarball name", ai.tarballName),
        sha256: requireSha256("@openclaw/ai tarball SHA-256", ai.tarballSha256),
      },
    },
    qa: {
      providerMode,
      scenario,
      conclusion: "success",
    },
  };
}

export function writeNpmTelegramPackageConsumptionReceipt({
  environment = process.env,
  manifestPath,
  outputPath,
}) {
  if (path.basename(outputPath) !== "package-consumption.json") {
    fail("npm Telegram package consumption receipt path is invalid");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const receipt = createNpmTelegramPackageConsumptionReceipt({ environment, manifest });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const [manifestPath, outputPath, extra] = argv;
  if (!manifestPath || !outputPath || extra) {
    fail(
      "usage: npm-telegram-package-consumption.mjs <preflight-manifest.json> <package-consumption.json>",
    );
  }
  writeNpmTelegramPackageConsumptionReceipt({ manifestPath, outputPath });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
