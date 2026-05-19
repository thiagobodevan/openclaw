import "./fs-safe-defaults.js";
import fs from "node:fs";
import path from "node:path";
import { tryReadJson, tryReadJsonSync as rawTryReadJsonSync } from "@openclaw/fs-safe/json";
import { writeJsonSync } from "./json-files.js";

export { tryReadJson, writeJsonSync };
export const readJsonFile = tryReadJson;

function resolveJsonSymlinkTarget(pathname: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return undefined;
  }

  return path.resolve(path.dirname(pathname), fs.readlinkSync(pathname));
}

function resolveJsonSaveTarget(pathname: string): string {
  const target = resolveJsonSymlinkTarget(pathname);
  if (!target) {
    return pathname;
  }
  fs.statSync(path.dirname(target));
  return target;
}

export function saveJsonFile(pathname: string, data: unknown): void {
  writeJsonSync(resolveJsonSaveTarget(pathname), data);
}

// oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- legacy typed JSON loader alias.
export function loadJsonFile<T = unknown>(pathname: string): T | undefined {
  const direct = rawTryReadJsonSync<T>(pathname);
  if (direct !== null) {
    return direct;
  }
  const target = resolveJsonSymlinkTarget(pathname);
  return target ? (rawTryReadJsonSync<T>(target) ?? undefined) : undefined;
}
