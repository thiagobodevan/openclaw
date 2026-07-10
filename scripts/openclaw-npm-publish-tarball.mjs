#!/usr/bin/env node

import { createReadStream, lstatSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { Parser } from "tar";

const MAX_ENTRY_COUNT = 50_000;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024 * 1024;
const MAX_TARBALL_BYTES = 256 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function canonicalEntryPath(entry, target) {
  const rawPath = entry.path;
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.startsWith("/") ||
    rawPath.includes("\\") ||
    hasControlCharacter(rawPath)
  ) {
    fail(`npm publish tarball has an unsafe entry path: ${target}`);
  }

  const isDirectory = entry.type === "Directory";
  if (entry.type !== "File" && !isDirectory) {
    fail(`npm publish tarball has an unsupported entry type: ${target}`);
  }
  if ((entry.linkpath ?? "") !== "") {
    fail(`npm publish tarball has an unsupported linked entry: ${target}`);
  }
  if (!isDirectory && rawPath.endsWith("/")) {
    fail(`npm publish tarball has an unsafe entry path: ${target}`);
  }

  const entryPath = isDirectory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  const parts = entryPath.split("/");
  if (
    entryPath.length === 0 ||
    parts[0] !== "package" ||
    parts.some((part) => part.length === 0 || part === "." || part === "..") ||
    (entryPath === "package" && !isDirectory)
  ) {
    fail(`npm publish tarball entries must stay under one canonical package/ tree: ${target}`);
  }
  return entryPath;
}

export async function readCanonicalNpmPackageManifest(target) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    throw new Error(`npm publish tarball not found: ${target}`);
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TARBALL_BYTES) {
    fail(`npm publish tarball must be a bounded regular file: ${target}`);
  }

  let entryCount = 0;
  let manifestBytes;
  let pathBytes = 0;
  const seenPaths = new Set();
  const parser = new Parser({
    file: target,
    maxMetaEntrySize: -1,
    strict: true,
    onReadEntry(entry) {
      try {
        entryCount += 1;
        if (entryCount > MAX_ENTRY_COUNT) {
          fail(`npm publish tarball has too many entries: ${target}`);
        }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          fail(`npm publish tarball has an invalid entry size: ${target}`);
        }
        const entryPath = canonicalEntryPath(entry, target);
        pathBytes += Buffer.byteLength(entryPath, "utf8");
        if (pathBytes > MAX_PATH_BYTES) {
          fail(`npm publish tarball entry paths are too large: ${target}`);
        }
        if (seenPaths.has(entryPath)) {
          fail(`npm publish tarball has a duplicate entry path: ${target}`);
        }
        seenPaths.add(entryPath);

        if (entryPath !== "package/package.json") {
          return;
        }
        if (entry.type !== "File" || entry.size <= 0 || entry.size > MAX_MANIFEST_BYTES) {
          fail(`npm publish tarball has an invalid package/package.json entry: ${target}`);
        }
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        entry.on("end", () => {
          manifestBytes = Buffer.concat(chunks);
        });
      } catch (error) {
        parser.abort(error instanceof Error ? error : new Error(String(error)));
      } finally {
        entry.resume();
      }
    },
  });
  const rejectMetadata = () => {
    parser.abort(
      new Error(`npm publish tarball must not contain PAX or GNU metadata entries: ${target}`),
    );
  };
  parser.on("ignoredEntry", (entry) => {
    if (entry.meta) {
      rejectMetadata();
      return;
    }
    parser.abort(new Error(`npm publish tarball has an unsupported ignored entry: ${target}`));
  });
  parser.on("meta", rejectMetadata);

  try {
    let expandedBytes = 0;
    const expandedSizeLimiter = new Transform({
      transform(chunk, _encoding, callback) {
        expandedBytes += chunk.length;
        if (expandedBytes > MAX_EXPANDED_BYTES) {
          callback(new Error(`npm publish tarball expands beyond the allowed size: ${target}`));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(createReadStream(target), createGunzip(), expandedSizeLimiter, parser);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("npm publish tarball")) {
      throw error;
    }
    throw new Error(`npm publish tarball is not a readable npm-pack archive: ${target}`, {
      cause: error,
    });
  }

  if (!manifestBytes) {
    fail(`npm publish tarball is missing a readable package/package.json: ${target}`);
  }
  try {
    return JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error(`npm publish tarball package/package.json is malformed: ${target}`);
  }
}

export async function validateNpmPublishTarball({ expectedName, expectedVersion, target }) {
  const pkg = await readCanonicalNpmPackageManifest(target);
  if (
    !pkg ||
    typeof pkg !== "object" ||
    Array.isArray(pkg) ||
    typeof pkg.name !== "string" ||
    pkg.name.trim() === ""
  ) {
    fail(`npm publish tarball package/package.json has no valid name: ${target}`);
  }
  if (pkg.name !== expectedName) {
    fail(`npm publish tarball package name mismatch: expected ${expectedName}, got ${pkg.name}`);
  }

  // libnpmpublish prefers manifest.tag over the CLI's requested --tag.
  // A prepared tarball must not be able to redirect a beta publish to latest.
  if (pkg.tag !== undefined) {
    fail(`npm publish tarball top-level tag is not allowed: ${target}`);
  }

  // npm treats publishConfig as arbitrary config before its OIDC exchange.
  // Only the scoped AI package ships the exact public-access declaration.
  if (expectedName === "openclaw" && pkg.publishConfig !== undefined) {
    fail(`npm publish tarball publishConfig is not allowed: ${target}`);
  }
  if (expectedName === "@openclaw/ai") {
    const publishConfig = pkg.publishConfig;
    const keys =
      publishConfig && typeof publishConfig === "object" && !Array.isArray(publishConfig)
        ? Object.keys(publishConfig)
        : [];
    if (keys.length !== 1 || keys[0] !== "access" || publishConfig.access !== "public") {
      fail(`npm publish tarball publishConfig may only contain access=public: ${target}`);
    }
  }

  if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
    fail(`npm publish tarball package/package.json has no valid version: ${target}`);
  }
  if (pkg.version !== expectedVersion) {
    fail(`npm publish tarball version mismatch: expected ${expectedVersion}, got ${pkg.version}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const [target, expectedName, expectedVersion, extra] = argv;
  if (!target || !expectedName || !expectedVersion || extra) {
    fail("usage: openclaw-npm-publish-tarball.mjs <tarball> <expected-name> <expected-version>");
  }
  await validateNpmPublishTarball({ expectedName, expectedVersion, target });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
