// Provides stricter filesystem helpers for canonical path and symlink-sensitive operations.
import "./fs-safe-defaults.js";
import fs from "node:fs/promises";

// Advanced fs-safe helpers for symlink, hardlink, and sibling-temp protections.
export {
  assertNoHardlinkedFinalPath,
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  sameFileIdentity,
  sanitizeUntrustedFileName,
  writeSiblingTempFile,
  writeViaSiblingTempPath,
  type AssertNoSymlinkParentsOptions,
  type FileIdentityStat,
} from "@openclaw/fs-safe/advanced";

/** Returns true when stat follows the path to a regular file. */
export async function pathIsFile(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

/** Returns true when stat follows the path to a directory. */
export async function pathIsDirectory(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    (stat) => stat.isDirectory(),
    () => false,
  );
}
